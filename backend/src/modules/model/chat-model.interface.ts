// LLM 对话抽象（Task 1.7）：ChatModelService 是摘要等 LLM 能力的统一入口。
// P1 用 MockChatModelService（固定中文文本，见 chat-model.service.ts 注释），
// Task 2.3 接入真实供应商（OpenAI 兼容端点等）时实现本接口并在 ModelModule
// 替换 provider 绑定——消费方（SummaryProcessor）零改动。
// 流式接口 chatStream（Task 2.4）：对话/流式输出场景的增量变体，与 chat()
// 同入参，返回增量块异步可迭代对象（ChatStreamChunk：text/reasoning/usage）。
// Task 2.8 扩展：ChatMessage 支持 tool_calls/tool_call_id（ReAct 工具循环的
// 消息回填）；ChatOptions 支持 tools（工具定义透传）；ChatStreamChunk 支持
// toolCalls（流式 tool_calls 由 provider 累积完整后一次 yield）。

/** 工具定义（Task 2.8）：供应商 tools 参数的标准形态——OpenAI function
 * calling 的 function 字段（{ name, description, parameters }），供应商在
 * 请求体包装为 { type:'function', function }（OpenAI 兼容）/ { type:
 * 'function', function }（Ollama 同构）。canonical 定义在本文件（供应商
 * 是消费方）；Agent 侧 re-export 见 agent/tools/tool.interface.ts */
export interface ToolDefinition {
  /** 工具名（如 search_kb / web_search） */
  name: string;
  /** 工具说明（LLM 决策是否调用/如何调用的依据） */
  description: string;
  /** 参数 JSON Schema（{ type:'object', properties, required }） */
  parameters: Record<string, unknown>;
}

/** 工具调用（Task 2.8）：assistant 消息携带的完整工具调用（OpenAI 协议形态
 * ——id/type/function；Ollama 在请求映射时剥 id/type，见 ollama.provider.ts） */
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 工具调用（assistant 消息：ReAct 循环把上一轮 LLM 输出的工具调用原样回填，
   * 供应商按各自协议映射——OpenAI 兼容透传、Ollama 剥 id/type，见 providers） */
  tool_calls?: ChatToolCall[];
  /** 工具结果回填（tool 消息：指向 assistant 消息的 tool_call id——OpenAI 协议
   * 必需；Ollama 请求映射时剥除，见 ollama.provider.ts） */
  tool_call_id?: string;
  /** 深度思考回传（Task 2.8 质量审查整改：DeepSeek R1 工具模式要求把 assistant
   * 的 reasoning_content 传回，否则第二轮思考上下文断裂）。OpenAI 兼容请求体
   * messages 透传该字段（见 openai-compatible.provider.ts）；Ollama 协议无此
   * 概念——请求映射时剥除（见 ollama.provider.ts）。编排器回填 assistant 消息
   * 时携带本轮累积的 reasoning，见 agent-orchestrator.service.ts */
  reasoning_content?: string;
  /** 图片多模态内容（Task 2.9 预留）：openai-compatible provider 支持
   * image_url content 块（{ type:'image_url', image_url:{ url: dataURI } }）
   * 时消费本字段。P2 先文本占位降级——编排器不填充本字段（user 消息内容
   * 只加「[图片附件] 文件名」占位，见 agent-orchestrator.service.ts
   * buildAttachmentHint 注释），真实多模态对接（P5）由编排器读取附件
   * dataURI 填充、供应商消费 */
  images?: { dataUri: string }[];
}

export interface ChatOptions {
  /** BYOK：请求归属用户（用户私有模型优先，全局兜底） */
  userId?: string;
  /** 采样温度（真实实现透传供应商参数；mock 忽略） */
  temperature?: number;
  /** 最大生成 token 数（真实实现透传；mock 忽略） */
  maxTokens?: number;
  /** 取消信号（Task 2.4 质量审查整改：客户端断连时编排器 abort，供应商 fetch
   * 传该 signal 停止上游生成——烧 token 止损；真实供应商实现把它与内部超时
   * 组合（AbortSignal.any），见 openai-compatible.provider.ts 注释） */
  signal?: AbortSignal;
  /** ReAct 工具定义（Task 2.8）：透传给供应商 tools 参数（无工具场景缺省——
   * 如摘要/标题生成的 chat() 调用） */
  tools?: ToolDefinition[];
}

/** 流式输出块（Task 2.4）：text 为正文增量；reasoning 为深度思考增量
 * （Task 2.8：OpenAI 兼容 provider 把 reasoning_content 映射到这里，
 * 无则缺省）；toolCalls 为工具调用（Task 2.8：流式分片由 provider 累积完整
 * 后一次 yield——OpenAI 兼容 delta.tool_calls 按 index 拼接 arguments 分片、
 * Ollama message.tool_calls 完整出现；无工具调用缺省）；usage 为 token 用量
 * （供应商流末尾统计，供 done 事件；无则缺省） */
export interface ChatStreamChunk {
  text: string;
  reasoning?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  usage?: { inputTokens?: number; outputTokens?: number; cacheHitTokens?: number };
}

export interface ChatModelService {
  /**
   * 非流式对话：输入消息列表（含 system 提示），返回完整回复文本。
   * 摘要/标题生成等一次性拿全文的场景用；消费方见 SummaryProcessor 等。
   */
  chat(messages: ChatMessage[], options?: ChatOptions, userId?: string): Promise<string>;
  /**
   * 流式对话（Task 2.4）：返回增量块异步可迭代对象——调用方 for await
   * 逐块消费（见 ChatStreamChunk）；错误（无默认模型 503 / 上游失败）在
   * 迭代过程中抛出（聊天 SSE 编排器捕获后转 error 事件，见
   * chat-orchestrator.service.ts）。实现为 async generator（延迟执行：
   * 首个 next() 才做默认模型路由与上游请求）。
   */
  chatStream(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<ChatStreamChunk>;
}

/** ChatModelService 的 DI 令牌：Symbol 防字符串撞名（与 EMBEDDING_SERVICE 同约定）。
 * 注：TS interface 是编译期类型、运行时被擦除，不能直接作为 provider token——
 * 故用 Symbol 令牌 + useClass 绑定（见 ModelModule），Task 2.3 换真实实现时
 * 只改 ModelModule 的 useClass，管线与消费方零改动 */
export const CHAT_MODEL_SERVICE = Symbol('CHAT_MODEL_SERVICE');
