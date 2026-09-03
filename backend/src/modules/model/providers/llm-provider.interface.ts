// backend/src/modules/model/providers/llm-provider.interface.ts
// 模型供应商抽象（Task 2.3）：任何供应商（OpenAI 兼容 / Ollama / 未来扩展）
// 实现本接口，ModelService/ChatModelService/EmbeddingService 只依赖接口——
// 接入新供应商 = 新增一个实现类 + factory 分支，消费方零改动。
//
// 接口形态决策：
// - chat()/embed() 不接收连接参数（baseUrl/apiKey/modelName）——连接配置在
//   「实例构造时绑定」（withConfig 返回绑定新配置的实例），调用侧（真实
//   ChatModelService）拿到的已绑定实例只传业务参数（messages/options），
//   避免每个调用点都重复传连接信息；
// - testConnection(config) 例外：连通性测试「直接传完整配置、不落库」，
//   与实例绑定解耦（POST /models/test 的 body 就是完整配置）。
// - 流式接口 chatStream（Task 2.4）：与 chat() 同入参（messages/options），
//   返回增量块异步可迭代对象——调用方 for await 逐块消费；错误（连接/HTTP/
//   流式错误行）在迭代过程中抛出（与 chat() 的 Promise 拒绝同语义，友好化）。
import type { ChatMessage, ToolDefinition } from '../chat-model.interface.js';

/** 供应商连接配置：testConnection 直传 / withConfig 绑定到实例 */
export interface ProviderConnectionConfig {
  /** API 端点（Ollama 默认 http://127.0.0.1:11434，见 model.service.ts 默认值） */
  baseUrl: string;
  /** API Key（Ollama 本地无需鉴权，传空串） */
  apiKey: string;
  /** 上游模型 ID（如 deepseek-chat / qwen2.5:7b） */
  modelName: string;
}

/** chat() 业务选项：采样参数（透传给供应商）+ 可选覆盖模型 ID */
export interface ChatProviderOptions {
  temperature?: number;
  maxTokens?: number;
  /** 覆盖实例绑定的模型 ID（一般场景不传；debug/testConnection 特殊场景用） */
  model?: string;
  /** 取消信号（Task 2.4 质量审查整改）：聊天 SSE 编排器把客户端断连的
   * AbortController.signal 传到 chatStream——供应商 fetch 把它与内部超时组合
   * （AbortSignal.any），断连即中止上游生成（烧 token 止损），见
   * openai-compatible.provider.ts / ollama.provider.ts 的 signal 组合注释 */
  signal?: AbortSignal;
  /** ReAct 工具定义（Task 2.8）：透传给供应商 tools 参数（chatStream 用——
   * 聊天 Agent 循环；chat() 无工具场景缺省） */
  tools?: ToolDefinition[];
}

/** 连通性测试结果：成功 { ok: true }；失败 { ok: false, error }（不抛异常——
 * 测试语义：把错误作为结果返回给前端展示，而非中断请求） */
export type TestConnectionResult = { ok: true } | { ok: false; error: string };

/** 流式输出块（Task 2.4）：text 为对话正文增量（可能为空串——纯 reasoning/
 * usage 尾块）；reasoning 为深度思考增量（OpenAI 兼容 provider 把
 * delta.reasoning_content 映射到这里，Task 2.8 前端展示；无思考能力的模型/
 * 供应商缺省该字段）；toolCalls 为工具调用（Task 2.8：流式分片由 provider
 * 累积完整后一次 yield——OpenAI 兼容 delta.tool_calls 按 index 拼接、Ollama
 * message.tool_calls 完整出现；无工具调用缺省）；usage 为 token 用量（供应商
 * 在流末尾返回统计时携带，供 done 事件展示；无则缺省） */
export interface ChatStreamChunk {
  text: string;
  reasoning?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  usage?: { inputTokens?: number; outputTokens?: number; cacheHitTokens?: number };
}

export interface LLMProvider {
  /** 绑定连接配置的新实例（不可变：chat/embed 按该配置路由） */
  withConfig(config: ProviderConnectionConfig): LLMProvider;
  /** 非流式对话（摘要/连通性测试场景一次性拿完整文本）：返回完整回复文本 */
  chat(messages: ChatMessage[], options?: ChatProviderOptions): Promise<string>;
  /** 流式对话（Task 2.4，对话/流式输出场景）：返回增量块异步可迭代对象——
   * 调用方 for await 逐块消费（text/reasoning/usage，见 ChatStreamChunk）；
   * 错误在迭代过程中抛出（友好化，与 chat() 同语义） */
  chatStream(
    messages: ChatMessage[],
    options?: ChatProviderOptions,
  ): AsyncIterable<ChatStreamChunk>;
  /** 批量文本向量化：每个文本返回 model 对应维度的向量 */
  embed(texts: string[], model?: string): Promise<number[][]>;
  /** 连通性测试：最小请求探活（不落库），返回结果而非异常 */
  testConnection(
    config: ProviderConnectionConfig,
    type?: string,
  ): Promise<TestConnectionResult>;
}
