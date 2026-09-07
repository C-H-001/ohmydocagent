// 向量化服务契约：任何实现都返回
// 统一结构。与 ParserClient 同模式（见 parser/parser-client.interface.ts）：
// 接口是 TS 类型，运行时需显式 DI 令牌（Symbol 防字符串撞名）；接入真实模型
// 时只需实现本接口并在 ModelModule 替换 provider，向量化管线（EmbedProcessor）
// 与检索（VectorService）零改动。
export interface EmbeddingService {
  /**
   * 批量文本向量化。调用方保证 texts 非空；实现须对每个文本返回
   * 对应模型配置的向量；知识库的新入库与检索使用 EmbeddingProfileService。
   */
  embed(texts: string[], userId?: string): Promise<number[][]>;

  /** 向量化 + 实际 token 消耗（供应商 embed 响应 usage.total_tokens；
   *   不支持/无 usage 时返回 0——调用方回退估算，见 embed.processor 注释）。
   *  BYOK：userId 归属用户——用户私有 embedding 模型优先，全局兜底 */
  embedWithUsage(
    texts: string[],
    userId?: string,
  ): Promise<{ vectors: number[][]; totalTokens: number }>;
}

/** EmbeddingService 的 DI 令牌：Symbol 防字符串撞名（同 PARSER_CLIENT 约定） */
export const EMBEDDING_SERVICE = Symbol('EMBEDDING_SERVICE');
