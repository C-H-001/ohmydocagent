// EmbedProcessor 单元测试（Task 1.6 质量修复）：
// 1. 失败标记语义：失败时仅将「本次读取」的 chunk id 集合置 failed——
//    UPDATE 按 id = ANY($1::uuid[]) AND indexStatus='processing'（与读取
//    同快照，见 embed.processor.ts process() catch 注释），不按 knowledgeId
//    误伤其他批次/并发已 ready 的块/reparse 后新插入的块
// 2. 幂等：同 knowledgeId 重试（重放）时已 ready 的块不在 processing 集合
//    → 读取为空 → no-op（不触碰任何块、不重复 embed、不写失败标记）
// 3. 文档已删除 → 跳过 no-op（不抛错不重试，见 embed.processor.ts 文件头）
// 4. reparse 竞态（质量审查整改）：批量 UPDATE 全部命中 0 行（本批块已被并发
//    「删旧建新」清掉）→ 不追加 embed done 阶段（孤立 done 阶段是时间线外观
//    污染；running 悬挂如实反映「尝试过但无事可做」）
// 用 mock 依赖直接实例化（@Processor 装饰器仅影响 DI 元数据，与
// parse-processor.spec.ts 同模式）。
import { describe, expect, it, vi } from 'vitest';
import { EmbedProcessor } from '../src/modules/parse/embed.processor.js';

interface MockChunk {
  id: string;
  content: string;
}

/**
 * 组装 mock 依赖：repo.findOne 返回 knowledge（null = 文档已删）；
 * dataSource.query 按 SQL 特征分发（SELECT=读块 / UPDATE=失败标记，
 * 返回 [rows, rowCount]）；VectorService 与 EmbeddingService 全 mock。
 * chunks 数组以引用持有——测试可在多次 process 之间变更返回值
 * （模拟块状态从 processing → ready）。
 */
function buildProcessor(options: {
  knowledge?: object | null;
  chunks?: MockChunk[];
  embedImpl?: () => Promise<number[][]>;
}) {
  const { knowledge = { id: 'doc-1' }, chunks = [], embedImpl } = options;
  const repo = { findOne: vi.fn().mockResolvedValue(knowledge) };
  const query = vi
    .fn()
    .mockImplementation((sql: string, _params: unknown[]) => {
      // knowledgeOwnerId（BYOK 归属查询）→ 空（无归属 → 全局兜底）；
      // 其余 SELECT（读待向量化块）→ chunks
      if (sql.includes('creatorId')) return Promise.resolve([]);
      if (sql.startsWith('SELECT')) return Promise.resolve(chunks);
      return Promise.resolve([[], 1]); // UPDATE → [rows, rowCount]
    });
  const dataSource = { query };
  const vectorService = {
    // 默认返回 { embedded: chunks.length }（全部命中）；竞态用例覆盖为
    // { embedded: 0 }（质量审查整改后 process() 依据返回值决定是否追加 done
    // 阶段，见 embed.processor.ts process() 注释）
    upsertEmbeddings: vi
      .fn()
      .mockImplementation(async () => ({ embedded: chunks.length })),
    // 单块路径（Task 1.9 编辑/回滚，payload { chunkId }）用的单条 upsert
    upsertEmbedding: vi.fn().mockResolvedValue(undefined),
  };
  const embedding = {
    dimension: 1024,
    embed: vi.fn(embedImpl ?? (() => Promise.resolve(chunks.map(() => [0.1])))),
    // 批量路径（文档 tokenCost）：返回真实向量 + usage（默认 0，测试可覆盖）
    embedWithUsage: vi.fn().mockImplementation(async () => ({
      vectors: await (embedImpl ?? (() => Promise.resolve(chunks.map(() => [0.1]))))(),
      totalTokens: 0,
    })),
  };
  // 时间线写回 mock（Task 1.7）：embed running/done/failed 阶段追加
  const progress = { updateProgress: vi.fn().mockResolvedValue(undefined) };
  const processor = new EmbedProcessor(
    repo as never,
    dataSource as never,
    vectorService as never,
    embedding as never,
    progress as never,
  );
  return { processor, repo, dataSource, vectorService, embedding, progress };
}

describe('EmbedProcessor 失败标记语义（Task 1.6 质量修复）', () => {
  it('失败 → 仅本次读取的 id 集合被标 failed（不按 knowledgeId，带 processing 守卫）', async () => {
    const { processor, dataSource, embedding, progress } = buildProcessor({
      chunks: [
        { id: 'c1', content: '内容一' },
        { id: 'c2', content: '内容二' },
      ],
      embedImpl: () => Promise.reject(new Error('embed 失败')),
    });
    const job = { data: { knowledgeId: 'doc-1' } } as never;
    await expect(processor.process(job)).rejects.toThrow('embed 失败');
    // 时间线（Task 1.7）：失败路径追加 embed failed 阶段（detail=失败原因）
    expect(progress.updateProgress).toHaveBeenCalledWith(
      'doc-1',
      expect.objectContaining({
        stage: expect.objectContaining({ stage: 'embed', status: 'failed' }),
      }),
    );
    // 读取 SQL（快照）：按 knowledgeId + processing（BYOK knowledgeOwnerId
    // 查询插入调用序列——用过滤后的调用）
    const nonOwner = dataSource.query.mock.calls.filter(
      ((call: unknown[]) => !String(call[0]).includes('creatorId')),
    );
    const [readSql, readParams] = nonOwner[0] as [string, unknown[]];
    expect(readSql).toContain('"knowledgeId" = $1');
    expect(readSql).toContain("'processing'");
    expect(readParams).toEqual(['doc-1']);
    // 失败标记 SQL：按本次读取的 id 集合（同一快照）+ processing 守卫，
    // 不含 knowledgeId（不误伤其他批次/并发已 ready 的块/新插入的块）
    const [markSql, markParams] = nonOwner[1] as [string, unknown[]];
    expect(markSql).toContain('id = ANY($1::uuid[])');
    expect(markSql).toContain('"indexStatus" = \'processing\'');
    expect(markSql).not.toContain('"knowledgeId"');
    expect(markParams).toEqual([['c1', 'c2']]);
    // 批量向量化只对本次读取的块调用一次
    expect(embedding.embedWithUsage).toHaveBeenCalledWith(['内容一', '内容二'], undefined);
    expect(embedding.embedWithUsage).toHaveBeenCalledTimes(1);
  });

  it('失败标记的 processing 守卫：标记 SQL 不会把已 ready 的块降级为 failed', async () => {
    const { processor, dataSource } = buildProcessor({
      chunks: [{ id: 'c1', content: '内容' }],
      embedImpl: () => Promise.reject(new Error('embed 失败')),
    });
    const job = { data: { knowledgeId: 'doc-1' } } as never;
    await expect(processor.process(job)).rejects.toThrow('embed 失败');
    // 并发场景：c1 若已被另一 job 置 ready，WHERE ... AND indexStatus='processing'
    // 保证 UPDATE 不触碰它——SQL 形状断言即该守卫（参数仅本次读取的 id）
    const nonOwner = dataSource.query.mock.calls.filter(
      ((call: unknown[]) => !String(call[0]).includes('creatorId')),
    );
    const [markSql, markParams] = nonOwner[1] as [string, unknown[]];
    expect(markSql).toContain('"indexStatus" = \'processing\'');
    expect(markParams).toEqual([['c1']]);
  });

  it('同 knowledgeId 重试：已 ready 块不在 processing 集合 → 读取为空 → no-op', async () => {
    const chunkRows: MockChunk[] = [{ id: 'c1', content: '内容' }];
    const { processor, dataSource, embedding, vectorService, progress } =
      buildProcessor({ chunks: chunkRows });
    const job = { data: { knowledgeId: 'doc-1' } } as never;
    // 第一轮：读取 [c1] → 成功（embed + upsert）
    await expect(processor.process(job)).resolves.toEqual({ embedded: 1 });
    expect(embedding.embedWithUsage).toHaveBeenCalledTimes(1);
    expect(vectorService.upsertEmbeddings).toHaveBeenCalledTimes(1);
    // 时间线（Task 1.7）：成功路径追加 embed running + done 阶段（成对出现）
    const stages = progress.updateProgress.mock.calls.map(
      (call: unknown[]) =>
        (call[1] as { stage: { status: string } }).stage.status,
    );
    expect(stages).toEqual(['running', 'done']);
    // 第二轮（重试/重放）：c1 已 ready → 读取为空 → no-op，
    // 不重复 embed、不写失败标记、不触碰任何块（也不追加时间线阶段）
    chunkRows.length = 0;
    await expect(processor.process(job)).resolves.toEqual({ embedded: 0 });
    expect(embedding.embedWithUsage).toHaveBeenCalledTimes(1);
    expect(vectorService.upsertEmbeddings).toHaveBeenCalledTimes(1);
    const updateCalls = dataSource.query.mock.calls.filter(
      ([sql]) => !String(sql).startsWith('SELECT'),
    );
    expect(updateCalls).toHaveLength(0);
  });

  it('reparse 竞态：批量 UPDATE 全部命中 0 行 → 返回 { embedded: 0 }，不追加 embed done 阶段', async () => {
    const { processor, progress, vectorService } = buildProcessor({
      chunks: [
        { id: 'c1', content: '内容一' },
        { id: 'c2', content: '内容二' },
      ],
    });
    // 模拟 reparse 并发「删旧建新」：本批块已被清掉（旧块被删、新块由新
    // embed job 处理），批量 UPDATE 全部命中 0 行（竞态而非失败，不抛错）
    vectorService.upsertEmbeddings.mockResolvedValue({ embedded: 0 });
    const job = { data: { knowledgeId: 'doc-1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ embedded: 0 });
    // 时间线只追加 running（如实反映「尝试过但无事可做」），done 不追加——
    // 孤立的 done 阶段是时间线外观污染（质量审查整改，见 process() 注释）
    const stages = progress.updateProgress.mock.calls.map(
      (call: unknown[]) =>
        (call[1] as { stage: { status: string } }).stage.status,
    );
    expect(stages).toEqual(['running']);
  });

  it('文档已删除 → 跳过 no-op（不查询块、不 embed、不抛错）', async () => {
    const { processor, dataSource, embedding, progress } = buildProcessor({
      knowledge: null,
    });
    const job = { data: { knowledgeId: 'doc-1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ embedded: 0 });
    expect(dataSource.query).not.toHaveBeenCalled();
    expect(embedding.embedWithUsage).not.toHaveBeenCalled();
    expect(progress.updateProgress).not.toHaveBeenCalled();
  });

  it('单块载荷（{ chunkId }，Task 1.9 编辑/回滚）：读取单块 → embed → 单条 upsert → { embedded: 1 }，不触碰时间线', async () => {
    const { processor, dataSource, embedding, vectorService, progress } =
      buildProcessor({
        chunks: [{ id: 'c1', content: '编辑后的内容' }],
      });
    const job = { data: { chunkId: 'c1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ embedded: 1 });
    // 单块读取 SQL：按 id（不按 knowledgeId、不校验 indexStatus——单块 job
    // 由编辑显式触发，直接处理当前内容，见 processSingleChunk 注释）
    const [readSql, readParams] = dataSource.query.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(readSql).toContain('FROM chunks WHERE id = $1');
    expect(readParams).toEqual(['c1']);
    // 单条向量化：embed 该块内容 + upsertEmbedding（非批量 upsertEmbeddings）
    expect(embedding.embed).toHaveBeenCalledWith(['编辑后的内容']);
    expect(vectorService.upsertEmbedding).toHaveBeenCalledWith('c1', [0.1]);
    expect(vectorService.upsertEmbeddings).not.toHaveBeenCalled();
    // 不追加知识级时间线阶段（单块编辑是块级操作，文档时间线不变，见注释）
    expect(progress.updateProgress).not.toHaveBeenCalled();
  });

  it('单块载荷：块不存在（编辑后块被删除/级联清理）→ no-op { embedded: 0 }', async () => {
    const { processor, embedding, vectorService, progress } = buildProcessor({
      chunks: [],
    });
    const job = { data: { chunkId: 'c1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ embedded: 0 });
    expect(embedding.embedWithUsage).not.toHaveBeenCalled();
    expect(vectorService.upsertEmbedding).not.toHaveBeenCalled();
    expect(progress.updateProgress).not.toHaveBeenCalled();
  });

  it('单块载荷：embed 失败 → 仅该块置 failed（id=$1 + processing 守卫）后抛错（重试仍会处理该块）', async () => {
    const { processor, dataSource, vectorService, progress } = buildProcessor({
      chunks: [{ id: 'c1', content: '编辑后的内容' }],
      embedImpl: () => Promise.reject(new Error('embed 失败')),
    });
    const job = { data: { chunkId: 'c1' } } as never;
    await expect(processor.process(job)).rejects.toThrow('embed 失败');
    // 失败标记 SQL：按单块 id + processing 守卫（并发已 ready 不降级）
    const nonOwner = dataSource.query.mock.calls.filter(
      ((call: unknown[]) => !String(call[0]).includes('creatorId')),
    );
    const [markSql, markParams] = nonOwner[1] as [string, unknown[]];
    expect(markSql).toContain('id = $1');
    expect(markSql).toContain('"indexStatus" = \'processing\'');
    expect(markSql).not.toContain('"knowledgeId"');
    expect(markParams).toEqual(['c1']);
    // 不追加时间线阶段（与批量路径的 embed failed 阶段语义区分）
    expect(progress.updateProgress).not.toHaveBeenCalled();
    expect(vectorService.upsertEmbedding).not.toHaveBeenCalled();
  });

  it('无待向量化块（空文本/已全部 ready）→ no-op（不追加时间线阶段）', async () => {
    const { processor, dataSource, embedding, progress } = buildProcessor({
      chunks: [],
    });
    const job = { data: { knowledgeId: 'doc-1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ embedded: 0 });
    expect(embedding.embedWithUsage).not.toHaveBeenCalled();
    // 仅一次读取查询，无任何 UPDATE（失败标记）与时间线写回
    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(progress.updateProgress).not.toHaveBeenCalled();
    const [readSql] = dataSource.query.mock.calls[0] as [string];
    expect(readSql).toContain('"knowledgeId" = $1');
  });
});
