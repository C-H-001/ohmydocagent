// backend/src/modules/model/chat-model.service.ts
// ChatModelService 实现（按默认对话模型配置路由到供应商）：
// 按「默认 chat 模型」配置路由到对应供应商（openai-compatible / ollama）。
// 无默认模型 → ServiceUnavailableException 503「未配置默认对话模型」——
// 语义：摘要/标题等 LLM 管线在未配置模型时显式失败（而不是静默返回空或
// 用错误的模型），配置层通过「模型管理 → 设为默认」补齐（Task 2.3 端点）。
//
// 消费方（SummaryProcessor/TitleProcessor）零改动——只换 ModelModule 的
// provider 绑定（见 model.module.ts）。
//
// 
// 注入（既有 e2e——title/knowledge-status——依赖确定性固定文本，见各文件
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type {
  ChatMessage,
  ChatModelService,
  ChatOptions,
  ChatStreamChunk,
} from './chat-model.interface.js';
import { ModelService } from './model.service.js';
import { LLMProviderFactory } from './providers/llm-provider.factory.js';

@Injectable()
export class ChatModelServiceImpl implements ChatModelService {
  constructor(
    private readonly modelService: ModelService,
    private readonly factory: LLMProviderFactory,
  ) {}

  async chat(messages: ChatMessage[], options?: ChatOptions, userId?: string): Promise<string> {
    // BYOK：用户私有模型优先，全局兜底（getDefault 解析顺序）
    const model = await this.modelService.getDefault('chat', userId);
    if (!model) {
      throw new ServiceUnavailableException(
        '未配置默认对话模型（请先在模型管理中设置）',
      );
    }
    // 模型级默认参数（extraConfig，如 temperature）优先；调用方显式传参覆盖
    const provider = this.factory.create(model);
    return provider.chat(messages, {
      ...(model.extraConfig as object),
      model: model.modelName,
      ...(options?.temperature !== undefined
        ? { temperature: options.temperature }
        : {}),
      ...(options?.maxTokens !== undefined
        ? { maxTokens: options.maxTokens }
        : {}),
    });
  }

  /**
   * 流式对话（Task 2.4）：按默认 chat 模型路由到供应商 chatStream。
   * 实现为 async generator：首个 next() 才执行默认模型路由与上游请求——
   * 无默认模型的 503 在迭代开始抛出（聊天编排器捕获后转 SSE error 事件，
   * code=no_default_model，见 chat-orchestrator.service.ts）。
   * 参数合并规则与 chat() 一致（模型级 extraConfig 优先、显式传参覆盖）。
   */
  async *chatStream(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<ChatStreamChunk> {
    // BYOK：用户私有模型优先，全局兜底
    const model = await this.modelService.getDefault('chat', options?.userId);
    if (!model) {
      throw new ServiceUnavailableException(
        '未配置默认对话模型（请先在模型管理中设置）',
      );
    }
    const provider = this.factory.create(model);
    // yield* 委托给供应商的异步可迭代对象（增量块原样透传）；signal（断连
    // 取消信号）与 tools（Task 2.8 ReAct 工具定义）一并透传——供应商把
    // signal 与内部超时组合、tools 包装进请求体，见 providers 注释
    yield* provider.chatStream(messages, {
      ...(model.extraConfig as object),
      model: model.modelName,
      ...(options?.temperature !== undefined
        ? { temperature: options.temperature }
        : {}),
      ...(options?.maxTokens !== undefined
        ? { maxTokens: options.maxTokens }
        : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(options?.tools !== undefined ? { tools: options.tools } : {}),
    });
  }
}
