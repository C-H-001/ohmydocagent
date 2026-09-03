// backend/src/modules/model/embedding.service.ts
// 真实 EmbeddingService 实现（Task 2.3，替换 Task 1.6 的 MockEmbeddingService）：
// 按「默认 embedding 模型」配置路由到对应供应商（openai-compatible / ollama）。
// 无默认模型 → ServiceUnavailableException 503「未配置默认向量模型」（语义同
// ChatModelServiceImpl，见 chat-model.service.ts 注释）。
//
// Mock 的去留：MockEmbeddingService 保留在 mock/ 目录供测试 overrideProvider
// 注入（vector/chunk-revision 等既有 e2e 依赖 n-gram 特征哈希的确定性向量，
// 见各文件 override 注释；本文件不再包含 mock）。
//
// dimension：**读取 EMBEDDING_DIMENSION（1024）**——与 chunk.entity embedding vector(1024)
// 列一致（pgvector 列维度在 DDL 定死，改列要 migration）。真实模型维度
// 若不同（如 OpenAI text-embedding-3-large=3072），需同步改列维度 + 本常量
// （Task 后续按需加 dimension 配置项，见任务书决策）。
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { EmbeddingService } from './embedding.interface.js';
import { EMBEDDING_DIMENSION } from './embedding.interface.js';
import { ModelService } from './model.service.js';
import { LLMProviderFactory } from './providers/llm-provider.factory.js';

@Injectable()
export class EmbeddingServiceImpl implements EmbeddingService {
  /** 向量维度：与 chunk.entity embedding vector(1024) 列一致（见文件头注释） */
  readonly dimension = EMBEDDING_DIMENSION;

  constructor(
    private readonly modelService: ModelService,
    private readonly factory: LLMProviderFactory,
  ) {}

  async embed(texts: string[], userId?: string): Promise<number[][]> {
    const { vectors } = await this.embedWithUsage(texts, userId);
    return vectors;
  }

  async embedWithUsage(
    texts: string[],
    userId?: string,
  ): Promise<{ vectors: number[][]; totalTokens: number }> {
    // BYOK：用户私有 embedding 优先，全局兜底
    const model = await this.modelService.getDefault('embedding', userId);
    if (!model) {
      throw new ServiceUnavailableException(
        '未配置默认向量模型（请先在模型管理中设置）',
      );
    }
    const provider = this.factory.create(model) as unknown as {
      embedWithUsage?: (
        texts: string[],
        model?: string,
      ) => Promise<{ vectors: number[][]; totalTokens: number }>;
      embed: (texts: string[], model?: string) => Promise<number[][]>;
    };
    // 供应商支持 embedWithUsage（OpenAI 兼容 embed 响应带 usage）→ 用真实
    // token；不支持（如 Ollama）→ 回退 embed + totalTokens=0
    if (provider.embedWithUsage) {
      return provider.embedWithUsage(texts, model.modelName);
    }
    return { vectors: await provider.embed(texts, model.modelName), totalTokens: 0 };
  }
}
