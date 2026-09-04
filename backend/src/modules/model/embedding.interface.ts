// 向量化服务契约：任何实现都返回
// 统一结构。与 ParserClient 同模式（见 parser/parser-client.interface.ts）：
// 接口是 TS 类型，运行时需显式 DI 令牌（Symbol 防字符串撞名）；接入真实模型
// 时只需实现本接口并在 ModelModule 替换 provider，向量化管线（EmbedProcessor）
// 与检索（VectorService）零改动。
export interface EmbeddingService {
  /**
   * 批量文本向量化。调用方保证 texts 非空；实现须对每个文本返回
   * dimension 维向量（超出/不足维度会撞 PG vector(1024) 列约束 → 500，
   * 真实模型接入时须与 embedding 列维度一致，见 chunk.entity.ts 注释）。
   */
  embed(texts: string[], userId?: string): Promise<number[][]>;

  /** 向量化 + 实际 token 消耗（供应商 embed 响应 usage.total_tokens；
   *   不支持/无 usage 时返回 0——调用方回退估算，见 embed.processor 注释）。
   *  BYOK：userId 归属用户——用户私有 embedding 模型优先，全局兜底 */
  embedWithUsage(
    texts: string[],
    userId?: string,
  ): Promise<{ vectors: number[][]; totalTokens: number }>;

  /** 向量维度（与 chunk.embedding 列的 vector(1024) 保持一致） */
  readonly dimension: number;
}

/** 向量维度常量：与 chunk.entity embedding vector(1024) 列一致（见该列注释）。
 * 放在接口文件——dimension 是 EmbeddingService 契约的一部分（真实实现
 * 见 embedding.service.ts。
 *
 * 2026-08-29 调整为 1024：真实默认 embedding 模型「通义千问 qwen3.7-text-embedding」
 * 返回 1024 维（实测）。**维度必须与默认 embedding 模型匹配**——更换默认模型为
 * 不同维度时需 ALTER chunks.embedding 列 + 全量重新向量化（见 vector.service 注释）。 */
export const EMBEDDING_DIMENSION = 1024;

/** EmbeddingService 的 DI 令牌：Symbol 防字符串撞名（同 PARSER_CLIENT 约定） */
export const EMBEDDING_SERVICE = Symbol('EMBEDDING_SERVICE');
