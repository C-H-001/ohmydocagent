// backend/src/modules/model/providers/llm-provider.factory.ts
// LLMProvider 工厂（Task 2.3）：按模型配置创建绑定实例。
// 设计决策：DI map 注入两种 provider 实现（而非内部 switch + new）——
// 与 NestJS 容器一致（provider 可被测试 override / 生命周期钩子生效），
// 新增供应商只需在 ModelModule 注册新实现 + 本工厂加一个分支。
//
// create(model)：解密 API Key → 按 provider 类型 withConfig 绑定——
// 返回的实例已带连接配置，调用方（ChatModelService/EmbeddingService）只传
// 业务参数（见 llm-provider.interface.ts 注释）。
// getRaw(providerType)：无绑定实例（连通性测试 POST /models/test 用——
// 直接传完整连接配置，不落库）。
import { Injectable } from '@nestjs/common';
import { CryptoService } from '../crypto.service.js';
import type { Model, ModelProvider } from '../model.entity.js';
import { OpenAICompatibleProvider } from './openai-compatible.provider.js';
import { OllamaProvider } from './ollama.provider.js';
import type {
  LLMProvider,
  ProviderConnectionConfig,
} from './llm-provider.interface.js';

@Injectable()
export class LLMProviderFactory {
  constructor(
    private readonly openAICompatible: OpenAICompatibleProvider,
    private readonly ollama: OllamaProvider,
    private readonly crypto: CryptoService,
  ) {}

  /** 按模型创建绑定实例：解密 key + withConfig（chat/embed 不需再传连接参数） */
  create(model: Model): LLMProvider {
    // 模型无 key（本地 Ollama / 无需鉴权端点）→ 空串（provider 相应不带鉴权头）
    const apiKey = model.apiKeyEncrypted
      ? this.crypto.decrypt(model.apiKeyEncrypted)
      : '';
    const config: ProviderConnectionConfig = {
      baseUrl: model.baseUrl,
      apiKey,
      modelName: model.modelName,
    };
    switch (model.provider) {
      case 'ollama':
        return this.ollama.withConfig(config);
      case 'openai-compatible':
        return this.openAICompatible.withConfig(config);
      default: {
        // provider 枚举扩展后此处需同步；防御性兜底（DB 数据损坏/手改）
        const never: never = model.provider;
        throw new Error(`未知供应商类型: ${String(never)}`);
      }
    }
  }

  /** 无绑定实例（连通性测试 POST /models/test 用：config 由请求体直传） */
  getRaw(provider: ModelProvider): LLMProvider {
    switch (provider) {
      case 'ollama':
        return this.ollama.withConfig({
          baseUrl: '',
          apiKey: '',
          modelName: '',
        });
      case 'openai-compatible':
        return this.openAICompatible.withConfig({
          baseUrl: '',
          apiKey: '',
          modelName: '',
        });
      default: {
        const never: never = provider;
        throw new Error(`未知供应商类型: ${String(never)}`);
      }
    }
  }
}
