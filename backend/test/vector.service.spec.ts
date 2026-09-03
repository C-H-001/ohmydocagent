// VectorService 单元测试（Task 1.6）：
// - searchVector / searchKeyword：SQL 形状与参数（参数化防注入；列名 camelCase
//   必须加引号——本项目未配置 snake_case 策略，见 parse.processor.ts 注释）
// - hybridSearch 融合逻辑：两路 min-max 归一化 + 0.6/0.4 加权、按 chunkId 去重、
//   topK 截断、关键词路为空时退化为纯向量分、向量相似度低于阈值（无匹配）
//   返回空数组
// - upsertEmbeddings（质量审查整改补测）：rowCount 累计校验——reparse 竞态下
//   全部 UPDATE 命中 0 行时返回 { embedded: 0 }（调用方据此不追加 done 阶段，
//   见 embed.processor.ts process() 注释）
// 用 mock DataSource + mock EmbeddingService 直接实例化（不连真实 DB）——
// dataSource.query 按 SQL 特征（是否含 <=>）分发向量路 / 关键词路返回。
import { describe, expect, it, vi } from 'vitest';
import { VectorService } from '../src/modules/vector/vector.service.js';
import type { EmbeddingService } from '../src/modules/model/embedding.interface.js';

interface SearchRow {
  id: string;
  content: string;
  knowledgeId: string;
  score: number | string;
}

/** 组装 mock 依赖：query 按 SQL 特征分发（向量路含 '<=>'，关键词路用 ts_rank） */
function buildService(options: {
  vectorRows?: SearchRow[];
  keywordRows?: SearchRow[];
  queryVector?: number[];
}) {
  const {
    vectorRows = [],
    keywordRows = [],
    queryVector = [0.1, 0.2, 0.3],
  } = options;
  const query = vi
    .fn()
    .mockImplementation((sql: string, _params: unknown[]) => {
      if (sql.includes('<=>')) return Promise.resolve(vectorRows);
      return Promise.resolve(keywordRows);
    });
  const dataSource = { query };
  const embedding = {
    dimension: 1024,
    embed: vi.fn().mockResolvedValue([queryVector]),
    embedWithUsage: vi.fn().mockResolvedValue({ vectors: [queryVector], totalTokens: 0 }),
  } satisfies EmbeddingService;
  const service = new VectorService(dataSource as never, embedding as never);
  return { service, query, embedding };
}

describe('VectorService.searchVector', () => {
  it('SQL 形状：余弦距离 + kbId 数组 + indexStatus=ready 过滤 + LIMIT 参数化', async () => {
    const { service, query } = buildService({});
    await service.searchVector(['kb-1'], [0.1, 0.2, 0.3], 5);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    // 向量列 camelCase 加引号；余弦距离 <=>；相似度 = 1 - 距离
    expect(sql).toContain('c.embedding <=> $1::vector');
    expect(sql).toContain('1 - (c.embedding <=> $1::vector) AS score');
    expect(sql).toContain('"kbId" = ANY($2::uuid[])');
    expect(sql).toContain('"indexStatus" = \'ready\'');
    expect(sql).toContain('LIMIT $3');
    // 参数：查询向量文本化（pgvector 文本 '[0.1,0.2,0.3]'）、kbIds 数组、topK
    expect(params).toEqual(['[0.1,0.2,0.3]', ['kb-1'], 5]);
  });
});

describe('VectorService.searchKeyword', () => {
  it('SQL 形状：jieba 词粒度检索（keywords 数组交集 + content ILIKE 兜底）', async () => {
    const { service, query } = buildService({});
    await service.searchKeyword(['kb-1'], '知识管理', 5);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    // BM25 化：tsvector（jieba 词空格连接）+ ts_rank_cd 打分（对齐 ES BM25 语义）
    expect(sql).toContain("to_tsvector('simple', c.\"keywordText\")");
    expect(sql).toContain('ts_rank_cd');
    expect(sql).toContain('c.content ILIKE');
    expect(sql).toContain('"kbId" = ANY(');
    // 与向量路对齐：未向量化/失败的块（processing/failed）不参与关键词检索
    expect(sql).toContain("'ready'");
    expect(sql).toContain('ORDER BY score DESC');
    expect(sql).toContain('LIMIT ');
    // 参数：tsquery 字符串（空格分词 AND）+ 各词（ILIKE 兜底）+ kbIds + topK
    expect(typeof params[0]).toBe('string');
    expect(params.length).toBeGreaterThanOrEqual(4);
  });
});

describe('VectorService.hybridSearch（融合逻辑）', () => {
  it('两路归一化 + 加权融合：score = 0.6*vector + 0.4*kw，按分排序返回', async () => {
    // 向量路：chunk-a 0.9 / chunk-b 0.5 → min-max 归一后 a=1.0, b=0.0
    // 关键词路：chunk-a 0.8 / chunk-c 0.6 / chunk-d 0.4 → 归一后 a=1.0, c=0.5, d=0.0
    // 融合：a = 0.6*1 + 0.4*1 = 1.0；c = 0.6*0 + 0.4*0.5 = 0.2；b = 0；d = 0
    const { service, embedding } = buildService({
      vectorRows: [
        { id: 'chunk-a', content: 'A', knowledgeId: 'doc-1', score: 0.9 },
        { id: 'chunk-b', content: 'B', knowledgeId: 'doc-1', score: 0.5 },
      ],
      keywordRows: [
        { id: 'chunk-a', content: 'A', knowledgeId: 'doc-1', score: 0.8 },
        { id: 'chunk-c', content: 'C', knowledgeId: 'doc-1', score: 0.6 },
        { id: 'chunk-d', content: 'D', knowledgeId: 'doc-1', score: 0.4 },
      ],
    });
    const items = await service.hybridSearch(['kb-1'], '知识管理', 3);
    // 查询先经 EmbeddingService 向量化（一次调用，单文本）
    expect(embedding.embed).toHaveBeenCalledWith(['知识管理'], undefined);
    // 排序：a(1.0) > c(0.2) > b(0.0)；d 与 b 同分 0，稳定排序 b 在前（topK=3 截断 d）
    expect(items.map((i) => i.chunkId)).toEqual([
      'chunk-a',
      'chunk-c',
      'chunk-b',
    ]);
    expect(items[0].score).toBeCloseTo(1.0, 10);
    expect(items[0].vectorScore).toBeCloseTo(1.0, 10);
    expect(items[0].keywordScore).toBeCloseTo(1.0, 10);
    expect(items[1].score).toBeCloseTo(0.2, 10);
    expect(items[1].keywordScore).toBeCloseTo(0.5, 10);
    expect(items[1].vectorScore).toBe(0); // 仅关键词路命中 → 向量分 0
    expect(items[2].score).toBeCloseTo(0.0, 10);
  });

  it('两路命中同一 chunk → 合并去重（不出现重复 chunkId）', async () => {
    const { service } = buildService({
      vectorRows: [
        { id: 'chunk-a', content: 'A', knowledgeId: 'doc-1', score: 0.9 },
      ],
      keywordRows: [
        { id: 'chunk-a', content: 'A', knowledgeId: 'doc-1', score: 0.7 },
      ],
    });
    const items = await service.hybridSearch(['kb-1'], '知识管理', 5);
    expect(items).toHaveLength(1);
    expect(items[0].chunkId).toBe('chunk-a');
    expect(items[0].vectorScore).toBe(1.0); // 单值通道 min-max 归一 → 1
    expect(items[0].keywordScore).toBe(1.0);
    expect(items[0].score).toBeCloseTo(1.0, 10);
  });

  it('topK 截断：融合排序后只返回前 topK 条', async () => {
    const { service } = buildService({
      vectorRows: Array.from({ length: 8 }, (_, i) => ({
        id: `chunk-${i}`,
        content: `C${i}`,
        knowledgeId: 'doc-1',
        score: 0.9 - i * 0.05, // 递减 → 排序后前 3 条是 chunk-0/1/2
      })),
      keywordRows: [],
    });
    const items = await service.hybridSearch(['kb-1'], '知识管理', 3);
    expect(items).toHaveLength(3);
    expect(items[0].chunkId).toBe('chunk-0');
  });

  it('关键词路无命中 → 纯向量分（keywordScore=0，score=0.6*归一向量分）', async () => {
    const { service } = buildService({
      vectorRows: [
        { id: 'chunk-a', content: 'A', knowledgeId: 'doc-1', score: 0.9 },
        { id: 'chunk-b', content: 'B', knowledgeId: 'doc-1', score: 0.5 },
      ],
      keywordRows: [],
    });
    const items = await service.hybridSearch(['kb-1'], '知识管理', 5);
    // 两行向量分 0.9/0.5 → 归一 a=1, b=0 → a.score = 0.6*1 + 0 = 0.6
    expect(items[0].chunkId).toBe('chunk-a');
    expect(items[0].keywordScore).toBe(0);
    expect(items[0].score).toBeCloseTo(0.6, 10);
    expect(items[1].score).toBeCloseTo(0, 10);
  });

  it('向量相似度低于阈值（无匹配）→ 返回空数组（不报错）', async () => {
    const { service } = buildService({
      vectorRows: [
        { id: 'chunk-a', content: 'A', knowledgeId: 'doc-1', score: 0.01 },
      ],
      keywordRows: [],
    });
    const items = await service.hybridSearch(['kb-1'], '完全不相关的内容', 5);
    expect(items).toEqual([]);
  });

  it('topK 防御：非法值（0/负数/NaN/超大）收敛为 [1,50] 内整数（防 RAG 直调）', async () => {
    // 8 行向量分 0.9~0.55（均 > MIN_VECTOR_SCORE 阈值）——topK 截断语义可测
    const { service } = buildService({
      vectorRows: Array.from({ length: 8 }, (_, i) => ({
        id: `chunk-${i}`,
        content: `C${i}`,
        knowledgeId: 'doc-1',
        score: 0.9 - i * 0.05,
      })),
      keywordRows: [],
    });
    // 0 → 收敛 1；负数 → 收敛 1（防 slice 负数索引）
    expect(await service.hybridSearch(['kb-1'], '查询', 0)).toHaveLength(1);
    expect(await service.hybridSearch(['kb-1'], '查询', -5)).toHaveLength(1);
    // NaN → 默认 10（防 NaN 进 LIMIT）→ 8 行全量
    expect(
      await service.hybridSearch(['kb-1'], '查询', Number.NaN),
    ).toHaveLength(8);
    // 超大 → 上限 50 → 8 行全量
    expect(await service.hybridSearch(['kb-1'], '查询', 999)).toHaveLength(8);
  });

  it('空结果（两路都无命中）→ 空数组', async () => {
    const { service } = buildService({ vectorRows: [], keywordRows: [] });
    const items = await service.hybridSearch(['kb-1'], '空查询', 5);
    expect(items).toEqual([]);
  });
});

describe('VectorService.upsertEmbeddings（质量审查整改：rowCount 累计校验）', () => {
  /** upsertEmbeddings 专用 mock：批量写入走 dataSource.transaction 内的
   * manager.query（与检索路径的 dataSource.query 不同）；rowCounts 依次作为
   * 每条 UPDATE 的 [rows, rowCount] 返回值 */
  function buildUpsertService(rowCounts: number[]) {
    let call = 0;
    const manager = {
      query: vi.fn(
        async (
          _sql: string,
          _params: unknown[],
        ): Promise<[unknown[], number]> => [[], rowCounts[call++] ?? 0],
      ),
    };
    const dataSource = {
      transaction: vi.fn(async (cb: (m: unknown) => unknown) => cb(manager)),
      query: vi.fn(),
    };
    const embedding = { dimension: 1024, embed: vi.fn() } as never;
    const service = new VectorService(dataSource as never, embedding);
    return { service, dataSource, manager };
  }

  it('逐条 UPDATE（参数化 + ::vector 转型 + 置 ready），累计返回实际写入行数', async () => {
    const { service, manager } = buildUpsertService([1, 1]);
    const result = await service.upsertEmbeddings([
      { chunkId: 'c1', vector: [0.1, 0.2] },
      { chunkId: 'c2', vector: [0.3, 0.4] },
    ]);
    expect(result).toEqual({ embedded: 2 });
    expect(manager.query).toHaveBeenCalledTimes(2);
    // 与单条版 upsertEmbedding 同 SQL 形状（向量文本化 + ::vector 转型防注入；
    // camelCase 列名加引号）
    const [sql, params] = manager.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE chunks SET embedding = $2::vector');
    expect(sql).toContain('"indexStatus" = \'ready\'');
    expect(params).toEqual(['c1', '[0.1,0.2]']);
  });

  it('全部 UPDATE 命中 0 行（reparse 竞态：本批块已被并发删旧建新）→ 返回 { embedded: 0 }（调用方不追加 done 阶段）', async () => {
    const { service } = buildUpsertService([0, 0]);
    const result = await service.upsertEmbeddings([
      { chunkId: 'gone-1', vector: [0.1] },
      { chunkId: 'gone-2', vector: [0.2] },
    ]);
    // 竞态语义：0 行是合法竞态而非写入失败（批量场景不抛错——由 EmbedProcessor
    // 依据返回计数决定是否追加 done 阶段，见 vector.service.ts upsertEmbeddings
    // 注释与 embed.processor.ts process() 注释）
    expect(result).toEqual({ embedded: 0 });
  });

  it('空数组 → 直接返回 { embedded: 0 }（不开启事务）', async () => {
    const { service, dataSource } = buildUpsertService([]);
    const result = await service.upsertEmbeddings([]);
    expect(result).toEqual({ embedded: 0 });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
