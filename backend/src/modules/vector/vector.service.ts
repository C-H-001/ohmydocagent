// 向量/关键词/混合检索服务（Task 1.6）：pgvector 读写 + 三路检索。
// 全部走原生 SQL（DataSource.query）——原因：
// 1. pgvector 运算符（<=> 余弦距离）与 tsvector 全文检索（to_tsvector/ts_rank）
//    不在 TypeORM QueryBuilder 的抽象范围内，用原生 SQL 最直接；
// 2. embedding 列 select:false（见 chunk.entity.ts 注释），实体查询不会加载
//    大向量——检索按需原生读取。
//
// 列名约束（重要）：本项目未配置 snake_case 命名策略，实体列名即属性名
// （camelCase：kbId/knowledgeId/indexStatus），PG 会把未加引号的标识符小写化
// ——原生 SQL 中所有 camelCase 列必须加双引号（"kbId" 等），否则撞「列不存在」
// 错误。既有先例：KnowledgeService.list 的标签筛选 Raw SQL。
//
// 检索语义（设计决策，见方法注释与 e2e 文档）：
// - 向量路：余弦相似度 = 1 - (embedding <=> query)，只查 indexStatus='ready'
//   的块（文档 status=ready ≠ 全部块已嵌入，检索以块级向量状态为准）；
// - 关键词路：to_tsvector('simple', content) @@ plainto_tsquery('simple', q)——
//   'simple' 分词器不做中文分词（标点分隔的连续 CJK 串是一个 token，已实测），
//   P1 占位语义；Task 2.3 接真实模型时评估 zhparser 等中文分词方案；
// - 混合路：两路各取 topK×2 → 按 chunkId 合并去重 → 各路 min-max 归一化 →
//   score = 0.6*向量分 + 0.4*关键词分（权重参考 WeKnora 的 0.6/0.4 惯例，
//   向量语义为主、关键词精确匹配为辅）→ 排序取 topK。
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EMBEDDING_SERVICE } from '../model/embedding.interface.js';
import type { EmbeddingService } from '../model/embedding.interface.js';
import { segmentQuery } from '../../common/utils/chinese-seg.js';
import { HYBRID_SEARCH_TOP_K_MAX } from './dto/hybrid-search.dto.js';

/** 混合检索权重：向量分 0.6 / 关键词分 0.4（参考 WeKnora 惯例，见文件头注释） */
export const VECTOR_WEIGHT = 0.6;
export const KEYWORD_WEIGHT = 0.4;

/**
 * 向量相似度下限（混合检索无匹配判定）：余弦相似度 < 该值的向量结果视为
 * 无关（「无匹配时返回空数组」语义，见 vector.e2e-spec 的对应用例）。
 * 取值说明：该阈值针对 MockEmbeddingService（n-gram 特征哈希）调参——
 * 相关文本余弦 ≈ 0.3+（查询与目标 chunk 共享多个 n-gram），无关文本
 * 余弦 ≈ 0（随机桶碰撞 ±0.03 内），0.05 有足够余量（e2e 实测，见任务报告）。
 * Task 2.3 换真实模型后需按真实模型分数分布重新评估（真实语义模型对无关
 * 文本的余弦通常更低，阈值可保持或收紧）。
 */
export const MIN_VECTOR_SCORE = 0.05;

/** 混合检索单项（对外响应结构：chunkId/content/knowledgeId/三路分数）。
 * 多模态（Task: 对齐 WeKnora 引用带图）：type='image' 的块为图片 caption 块
 * （content=VLM 描述），imageInfo 携带图元数据（url/caption/page）——引用
 * 富化（ReferencesService）据此聚合 images */
export interface HybridSearchItem {
  chunkId: string;
  content: string;
  /** 所属知识库 id（引用「打开文档」跳转 KB 详情用） */
  kbId: string;
  knowledgeId: string;
  /** 融合分（0.6*归一向量分 + 0.4*归一关键词分） */
  score: number;
  /** 归一化后的向量相似度（仅向量路命中时有值；仅关键词路命中时为 0） */
  vectorScore: number;
  /** 归一化后的关键词相关度（仅关键词路命中时有值；仅向量路命中时为 0） */
  keywordScore: number;
  /** 块类型：'text' | 'image'（图片 caption 块） */
  type?: string;
  /** image 块的 parser asset 键 */
  assetKey?: string;
  /** image 块的图片元数据（url/caption/page/mimeType） */
  imageInfo?: {
    url: string;
    caption?: string;
    page?: number;
    mimeType?: string;
    assetKey?: string;
  } | null;
}

/** 检索行（searchVector/searchKeyword 的原生 SQL 行结构） */
interface SearchRow {
  id: string;
  content: string;
  kbId: string;
  knowledgeId: string;
  type: string;
  assetKey: string | null;
  imageInfo: {
    url: string;
    caption?: string;
    page?: number;
    mimeType?: string;
    assetKey?: string;
  } | null;
  score: number | string;
}

/** 向量转 pgvector 文本：'[0.1,0.2,...]'（与 pgvector 的文本输入格式一致） */
function toVectorText(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/** min-max 归一化：把通道内原始分数映射到 [0,1]（最大 1 / 最小 0）。
 * 通道全等（max===min，如单值通道）→ 全部映射为 1（该通道无区分度，视为
 * 全部命中满分——保证「仅一路命中」的 chunk 融合分不被零分拖垮）。 */
function minMaxNormalize(scores: number[]): Map<number, number> {
  if (scores.length === 0) return new Map();
  let min = Infinity;
  let max = -Infinity;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  if (max === min) {
    return new Map(scores.map((s) => [s, 1]));
  }
  const range = max - min;
  return new Map(scores.map((s) => [s, (s - min) / range]));
}

@Injectable()
export class VectorService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(EMBEDDING_SERVICE) private readonly embedding: EmbeddingService,
  ) {}

  /**
   * 单块向量 upsert：写入 pgvector 列 + 置 indexStatus=ready。
   * embedding 文本化（[x,y,...]）后 ::vector 显式转型（参数化防注入；
   * 列名 camelCase 加引号，见文件头注释）。被 EmbedProcessor 批量循环调用，
   * 或供测试/后续 reparse 单块更新使用。
   * rowCount 校验：TypeORM postgres 驱动对 UPDATE 返回 [rows, rowCount]
   * （见 PostgresQueryRunner.query 的 result.raw 结构）——chunk 不存在
   * （id 错误/已被删除/级联清理）时更新 0 行，静默成功会让调用方误以为
   * 已写入；Task 1.9 reparse 复用前抛错暴露问题（防静默）。
   */
  async upsertEmbedding(chunkId: string, vector: number[]): Promise<void> {
    const [, rowCount] = (await this.dataSource.query(
      `UPDATE chunks SET embedding = $2::vector, "indexStatus" = 'ready' WHERE id = $1`,
      [chunkId, toVectorText(vector)],
    )) as [unknown[], number];
    if (rowCount === 0) {
      throw new Error(`向量写入失败：chunk 不存在 ${chunkId}`);
    }
  }

  /**
   * 批量向量 upsert（同一文档的块，单事务原子化）：任一块失败整体回滚——
   * 与 EmbedProcessor 的失败语义一致（失败置 failed 而非部分 ready，避免
   * 文档内「一半块已嵌入、一半待重试」的中间态，Task 1.9 重试语义更清晰）。
   *
   * 返回 { embedded }：实际写入（UPDATE 命中）的行数累计——逐条 UPDATE 都
   * 检查 rowCount（与单条版 upsertEmbedding 对齐，见其 rowCount 注释）。
   * 竞态语义（质量审查整改）：reparse 在飞时本批块可能已被并发「删旧建新」
   * 清掉（旧块被删、新块 indexStatus=processing 由新 embed job 处理）——
   * 全部 UPDATE 命中 0 行属合法竞态而非 bug（与单条版的抛错不同：批量场景
   * 由 EmbedProcessor 依据返回计数决定是否追加 done 阶段，不把竞态误报成
   * 写入失败触发重试）；调用方须按 embedded === 0 处理（见 embed.processor.ts
   * 的 done 阶段条件）。
   */
  async upsertEmbeddings(
    items: Array<{ chunkId: string; vector: number[] }>,
  ): Promise<{ embedded: number }> {
    if (items.length === 0) return { embedded: 0 };
    let embedded = 0;
    await this.dataSource.transaction(async (manager) => {
      for (const { chunkId, vector } of items) {
        // 逐条 UPDATE + rowCount 累计（与单条版同 SQL 形状；TypeORM postgres
        // 驱动返回 [rows, rowCount]，见 upsertEmbedding 注释）
        const [, rowCount] = (await manager.query(
          `UPDATE chunks SET embedding = $2::vector, "indexStatus" = 'ready' WHERE id = $1`,
          [chunkId, toVectorText(vector)],
        )) as [unknown[], number];
        embedded += rowCount;
      }
    });
    return { embedded };
  }

  /**
   * 向量检索（余弦相似度 topK）：kbIds 支持多 KB（未来工作区级检索/对话 RAG
   * 复用；当前端点传单 KB）。只查 indexStatus='ready'（向量化的块），
   * 未向量化/失败的块不参与检索。$2 参数显式 ::uuid[] 转型（node-postgres
   * 发送 JS 字符串数组为 text[]，不转型会撞「uuid = text[]」无运算符错误）。
   * Task 2.9：可选 knowledgeIds 过滤维度（@file:F 提及限定文件 chunks）——
   * 与 kbIds 并集（检索范围 = 提及 KB 的块 ∪ 提及文件的块），SQL 用 OR 连接；
   * 参数从 $2 起顺序追加，既有调用（无 knowledgeIds）SQL 形状不变。
   * 索引策略（决策记录，Task 1.6 质量整改）：P1 规模（单 KB 块数 < 1 万）
   * 不建检索索引——chunks 表行数小，顺序扫描 + Sort 代价可接受，且嵌入列
   * 未建索引时 pgvector 的索引（hnsw）反而需要额外维护成本。触发线：单 KB
   * 块数 > 1 万或检索延迟超标（如 P95 > 100ms）时——向量路建 hnsw（余弦
   * 距离、m=16 / ef_construction=64，查询 ef_search 按延迟调）；关键词路建
   * to_tsvector('simple', content) 表达式 GIN 索引（表达式必须与下方检索 SQL
   * 的 to_tsvector('simple', c.content) 完全一致才能命中）。
   */
  async searchVector(
    kbIds: string[],
    queryVector: number[],
    topK: number,
    knowledgeIds?: string[],
    vectorThreshold?: number,
    userId?: string,
  ): Promise<SearchRow[]> {
    // 动态条件组装：基础过滤（向量非空 + ready）恒有；kbIds/knowledgeIds 按
    // 传入追加（并集语义 OR——Task 2.9 @提及范围；两者都空时调用方已保证
    // 不触发检索，此处兜底不加条件）。参数顺序：查询向量 $1 → 范围过滤 →
    // LIMIT 末尾（与既有调用参数序一致，见方法头注释）
    const conditions: string[] = [
      'c.embedding IS NOT NULL',
      `c."indexStatus" = 'ready'`,
    ];
    const params: unknown[] = [toVectorText(queryVector)];
    const scopeParts: string[] = [];
    if (kbIds.length > 0) {
      params.push(kbIds);
      scopeParts.push(`c."kbId" = ANY($${params.length}::uuid[])`);
    }
    if (knowledgeIds && knowledgeIds.length > 0) {
      params.push(knowledgeIds);
      scopeParts.push(`c."knowledgeId" = ANY($${params.length}::uuid[])`);
    }
    if (scopeParts.length > 0) {
      conditions.push(`(${scopeParts.join(' OR ')})`);
    }
    return this.dataSource.query(
      `SELECT c.id, c.content, c."kbId", c."knowledgeId", c.type, c."assetKey", c."imageInfo",
              1 - (c.embedding <=> $1::vector) AS score
       FROM chunks c
       WHERE ${conditions.join(' AND ')}
       ORDER BY c.embedding <=> $1::vector
       LIMIT $${params.length + 1}`,
      [...params, topK],
    );
  }

  /**
   * 关键词检索（中文分词 topK）：应用侧 jieba 分词（见 common/utils/chinese-seg
   * 的决策记录）——PG 'simple' 分词器不切中文（整段一个 token，词面检索是错
   * 的），故入库时按词粒度写入 chunks.keywords（text[]，GIN 索引），检索时
   * 查询串同样 jieba 分词后按数组交集匹配。
   * - 匹配：keywords 与查询词交集（OR 语义，任一命中即候选）
   * - 打分：命中查询词数（多词命中排序靠前）；全词命中（@>）额外加权
   * - 兼容：旧数据 keywords 为空（未回填）时退化为 content ILIKE 词面匹配
   * - 只查 indexStatus='ready' 的块（与向量路对齐，见文件头检索语义）
   * 索引策略：chunks.keywords 建 GIN（gin array ops）——见部署迁移脚本。
   */
  async searchKeyword(
    kbIds: string[],
    query: string,
    topK: number,
    knowledgeIds?: string[],
  ): Promise<SearchRow[]> {
    const terms = segmentQuery(query);
    if (terms.length === 0) return []; // 查询无可检索词（纯标点等）
    // BM25 近似（对齐 WeKnora ES BM25 语义）：
    // - jieba 分词 → 空格连接 → to_tsvector('simple')（simple 按空格分词，
    //   中文词位正确）→ GIN 表达式索引
    // - 打分 ts_rank_cd（cover density，TF·IDF 加权——PG 的 BM25 变体）
    // - plainto_tsquery 自动转义（词间空格 = AND 全词命中）
    // 前缀 tsquery（对齐 ES BM25 词干/词形语义）：英文词形变化（plaintiffs vs
    // plaintiff）jieba 不还原——用 `词:*` 前缀匹配复数/派生词；中文词尾变化少，
    // 前缀同样安全。to_tsquery 需转义特殊字符（& | ! ( ) : '）
    const escapeTs = (t: string) =>
      t.replace(/[&|!():'*]/g, ' ').trim();
    const tsQuery = terms.map((t) => `${escapeTs(t)}:*`).join(' & ');
    const conditions: string[] = [
      `c."indexStatus" = 'ready'`,
      // tsvector 前缀命中（BM25 打分源）OR content ILIKE 词面兜底（旧数据无 keywords）
      `(to_tsvector('simple', c."keywordText") @@ to_tsquery('simple', $1)
        OR ${terms
          .map((_: string, i: number) => `c.content ILIKE '%' || $${i + 2} || '%'`)
          .join(' OR ')})`,
    ];
    const params: unknown[] = [tsQuery];
    for (const t of terms) params.push(t);
    const scopeParts: string[] = [];
    if (kbIds.length > 0) {
      params.push(kbIds);
      scopeParts.push(`c."kbId" = ANY($${params.length}::uuid[])`);
    }
    if (knowledgeIds && knowledgeIds.length > 0) {
      params.push(knowledgeIds);
      scopeParts.push(`c."knowledgeId" = ANY($${params.length}::uuid[])`);
    }
    if (scopeParts.length > 0) {
      conditions.push(`(${scopeParts.join(' OR ')})`);
    }
    // 打分：ts_rank_cd（BM25 变体：词频/逆文档频率/覆盖密度——对齐 WeKnora
    // ES BM25 的相关度语义，优于此前「命中词数计数」）
    return this.dataSource.query(
      `SELECT c.id, c.content, c."kbId", c."knowledgeId", c.type, c."assetKey", c."imageInfo",
              ts_rank_cd(to_tsvector('simple', c."keywordText"),
                         to_tsquery('simple', $1)) AS score
       FROM chunks c
       WHERE ${conditions.join(' AND ')}
       ORDER BY score DESC, c."chunkIndex" ASC
       LIMIT $${params.length + 1}`,
      [...params, topK],
    );
  }

  /**
   * 混合检索（对外主入口）：embed 查询 → 两路检索（各取 topK×2，防止融合后
   * 单路前 topK 之外的 chunk 因另一路高分被挤掉）→ 按 chunkId 合并去重 →
   * 各路 min-max 归一化 → 加权融合（0.6 向量 + 0.4 关键词）→ 排序取 topK。
   *
   * 边界语义：
   * - 向量相似度 < MIN_VECTOR_SCORE 的向量结果视为无关（过滤，配合关键词路
   *   为空实现「无匹配 → 空数组」，见 MIN_VECTOR_SCORE 注释）；
   * - 关键词路无命中：keywordScore=0，结果纯向量分（score=0.6*归一向量分，
   *   排序与纯向量检索一致，仅分数整体缩放——语义正确，注释见测试）；
   * - 仅一路命中的 chunk：另一路分记 0（融合分 = 命中路的加权分）。
   *
   * score 为融合后的相对排序分（min-max 归一化后的加权和），绝对值无跨库
   * 可比性（归一化随查询结果集变化）——对外文档标注「仅用于排序」。
   */
  async hybridSearch(
    kbIds: string[],
    query: string,
    topK: number,
    // Task 2.9：@file:F 提及限定文件 chunks（与 kbIds 并集，SQL OR 语义）——
    // 无提及缺省（既有调用不变，见 searchVector 注释）
    knowledgeIds?: string[],
    // KB 级向量阈值覆盖（参考 WeKnora RetrievalConfig.VectorThreshold；
    // 缺省 MIN_VECTOR_SCORE，见文件头注释）
    vectorThreshold?: number,
    userId?: string,
  ): Promise<HybridSearchItem[]> {
    // topK 防御（服务层兜底）：DTO 层已校验 1~50，但未来 RAG 直调可能传
    // 0/负数/NaN/小数——统一收敛为 [1, HYBRID_SEARCH_TOP_K_MAX] 内整数
    // （防 slice 负数索引/NaN 进 LIMIT 等异常；NaN 时取默认 10）
    const k = Math.min(
      Math.max(Number.isFinite(topK) ? Math.floor(topK) : 10, 1),
      HYBRID_SEARCH_TOP_K_MAX,
    );
    // BYOK：向量化用用户私有 embedding 模型（未配置 → 抛 503 提示配置）
    const [queryVector] = await this.embedding.embed([query], userId);
    // 两路各取 topK×2（融合缓冲，见方法头注释）
    const fetchK = Math.max(k * 2, 1);
    const [vectorRows, keywordRows] = await Promise.all([
      this.searchVector(kbIds, queryVector, fetchK, knowledgeIds, vectorThreshold, userId),
      this.searchKeyword(kbIds, query, fetchK, knowledgeIds),
    ]);
    // 按 chunkId 合并（两路去重，见 e2e「混合检索结果去重」用例）
    const merged = new Map<
      string,
      {
        content: string;
        kbId: string;
        knowledgeId: string;
        type?: string | null;
        assetKey?: string | null;
        imageInfo?: {
          url: string;
          caption?: string;
          page?: number;
          mimeType?: string;
          assetKey?: string;
        } | null;
        vector?: number;
        keyword?: number;
      }
    >();
    for (const row of vectorRows) {
      const score = Number(row.score);
      if (score < (vectorThreshold ?? MIN_VECTOR_SCORE)) continue; // 无匹配过滤（见 MIN_VECTOR_SCORE 注释）
      merged.set(row.id, {
        content: row.content,
        kbId: row.kbId,
        knowledgeId: row.knowledgeId,
        type: row.type,
        assetKey: row.assetKey,
        imageInfo: row.imageInfo,
        vector: score,
      });
    }
    for (const row of keywordRows) {
      const item = merged.get(row.id) ?? {
        content: row.content,
        kbId: row.kbId,
        knowledgeId: row.knowledgeId,
        type: row.type,
        assetKey: row.assetKey,
        imageInfo: row.imageInfo,
      };
      item.keyword = Number(row.score);
      merged.set(row.id, item);
    }
    if (merged.size === 0) return [];
    // 各路 min-max 归一化（通道内相对分，保证两路量纲可比再加权）
    const vectorNorm = minMaxNormalize(
      [...merged.values()].flatMap((i) =>
        i.vector !== undefined ? [i.vector] : [],
      ),
    );
    const keywordNorm = minMaxNormalize(
      [...merged.values()].flatMap((i) =>
        i.keyword !== undefined ? [i.keyword] : [],
      ),
    );
    const items: HybridSearchItem[] = [...merged.entries()].map(
      ([chunkId, item]) => {
        const vectorScore =
          item.vector !== undefined ? vectorNorm.get(item.vector)! : 0;
        const keywordScore =
          item.keyword !== undefined ? keywordNorm.get(item.keyword)! : 0;
        return {
          chunkId,
          content: item.content,
          kbId: item.kbId,
          knowledgeId: item.knowledgeId,
          ...(item.type === 'image' ? { type: item.type, assetKey: item.assetKey ?? undefined, imageInfo: item.imageInfo ?? undefined } : {}),
          vectorScore,
          keywordScore,
          score: VECTOR_WEIGHT * vectorScore + KEYWORD_WEIGHT * keywordScore,
        };
      },
    );
    items.sort((a, b) => b.score - a.score);
    return items.slice(0, k);
  }
}
