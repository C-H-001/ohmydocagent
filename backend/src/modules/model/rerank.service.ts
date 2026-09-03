// RerankService.ts
// 重排服务（接入真实 rerank 模型，参考 WeKnora PluginRerank）：
// 检索三路融合后，若有默认 rerank 模型 → 对候选 documents 精排，
// 返回 topK 下标 + 相关性分数；无模型/调用失败 → null（调用方回退分数截断）。
//
// 端点约定：rerank 模型 baseUrl 为供应商原生重排端点（dashscope：
// /api/v1/services/rerank/text-rerank/text-rerank），请求体
// { model, input: { query, documents } }，响应 results: [{ index, relevance_score }]。
import { Injectable, Logger } from '@nestjs/common';
import { ModelService } from './model.service.js';
import { CryptoService } from './crypto.service.js';

export interface RerankResult {
  /** 原 documents 下标（按相关性降序） */
  index: number;
  score: number;
}

const REQUEST_TIMEOUT_MS = 15000;
const MAX_DOCUMENTS = 50;

@Injectable()
export class RerankService {
  private readonly logger = new Logger(RerankService.name);

  constructor(
    private readonly modelService: ModelService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * 重排候选文档。无默认 rerank 模型 / 文档为空 / 调用失败 → null
   * （调用方保持原有分数截断语义——重排是增强而非必需路径）。
   */
  async rerank(
    query: string,
    documents: string[],
    topK: number,
    userId?: string,
  ): Promise<RerankResult[] | null> {
    // BYOK：用户私有 rerank 优先，全局兜底
    const model = await this.modelService.getDefault('rerank', userId);
    if (!model || !model.baseUrl || documents.length === 0) {
      return null;
    }
    const docs = documents.slice(0, MAX_DOCUMENTS);
    try {
      const apiKey = model.apiKeyEncrypted
        ? this.crypto.decrypt(model.apiKeyEncrypted)
        : '';
      const res = await fetch(model.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: model.modelName,
          input: { query, documents: docs },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        this.logger.warn(
          `重排请求失败（HTTP ${res.status}）: ${detail.slice(0, 200)}`,
        );
        return null;
      }
      const data = (await res.json()) as {
        results?: Array<{ index?: number; relevance_score?: number }>;
      };
      if (!Array.isArray(data.results) || data.results.length === 0) {
        return null;
      }
      return data.results
        .filter((r) => typeof r.index === 'number')
        .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
        .slice(0, Math.max(1, Math.min(topK, docs.length)))
        .map((r) => ({ index: r.index!, score: r.relevance_score ?? 0 }));
    } catch (err) {
      // 重排失败：静默降级（分数截断兜底），仅日志
      this.logger.warn(
        `重排调用失败，回退分数截断: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
