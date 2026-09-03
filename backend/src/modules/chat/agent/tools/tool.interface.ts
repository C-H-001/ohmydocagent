// 工具抽象（Task 2.8）：Agent 循环的工具定义（LLM 可见的 JSON Schema）与
// 执行接口。内置工具（KbSearchTool）实现本接口：
// - definition：透传供应商 tools 参数（OpenAI 兼容 / Ollama 同构的
//   function calling 形态，见 chat-model.interface.ts 的 ToolDefinition）
// - execute：执行工具逻辑 → 返回回填文本（role:'tool' 消息）+ 附加数据
//   （search_kb 的 references 供落库）
//
// 设计决策：
// - ToolDefinition 的 canonical 定义在 model 模块（chat-model.interface.ts）
//   ——供应商（openai-compatible/ollama）是 tools 参数的消费方，避免
//   model → chat 的模块依赖；本文件 re-export 供 Agent 侧使用
// - 执行上下文 ToolExecutionContext：sse（工具内部阶段事件）/signal（断连
//   取消）/kbIds（search_kb 的检索范围——会话级，每请求透传，工具保持
//   无状态单例，「每次直传配置」形态）
// - 失败语义：工具内部失败 → status='error' + 友好文本（不抛错）——Agent
//   循环把错误文本回填 LLM（模型可据此降级回答），对话不中断（区别于 Task
//   2.5 管线检索失败 → SSE error 事件中断整个生成）
import type { ToolDefinition } from '../../../model/chat-model.interface.js';
import type { RagReference } from '../../pipeline/rag.types.js';
import type { SseService } from '../../sse/sse.service.js';

/** Re-export：LLM 工具定义（canonical 在 model 模块——供应商消费方） */
export type { ToolDefinition } from '../../../model/chat-model.interface.js';

/** @提及检索范围（Task 2.9）：@kb:X / @file:F 对 search_kb 的检索范围限定——
 * 有提及时覆盖会话 kbIds（用户显式指定，即使 X 不在会话 kbIds 也按 X 检索）；
 * 无提及时工具用 ctx.kbIds（会话范围，既有语义）。语义细节见
 * agent-orchestrator.service.ts run 的检索范围注释。 */
export interface MentionScope {
  /** 提及的知识库 id（@kb:X）——覆盖会话 kbIds */
  kbIds?: string[];
  /** 提及的文档 id（@file:F，即 chunks.knowledgeId）——限定该文件的 chunks */
  knowledgeIds?: string[];
}

/** 工具执行上下文（Agent 循环每次 execute 传入） */
export interface ToolExecutionContext {
  /** SSE 写入器：工具内部阶段事件（search/rerank/merge）由工具发出——
   * 前端仍能看到 Task 2.5 的检索阶段语义（search_kb 执行 = search/rerank/
   * merge 阶段，见 agent-orchestrator.service.ts 文件头注释） */
  sse: SseService;
  /** 断连取消信号（工具在阶段间检查：已 abort → 返回已算结果，Agent 循环
   * 据此落库 partial，断连不丢已生成部分） */
  signal: AbortSignal;
  /** 会话关联的知识库范围（session.kbIds；search_kb 的检索范围限定——
   * web_search 忽略此字段） */
  kbIds: string[];
  /** 归属用户（BYOK：检索/向量化用用户私有模型——embedding 按用户路由） */
  userId?: string;
  /** @提及检索范围（Task 2.9）：有提及时覆盖会话 kbIds（@kb:X / @file:F，
   * 见 MentionScope 注释）；无提及缺省——工具退回 ctx.kbIds（会话范围） */
  scope?: MentionScope;
}

/** 工具执行结果：content 回填 LLM（role:'tool' 消息全文，不截断）；references
 * 为 search_kb 附加的引用数据（Agent 累积后随 assistant 落库）；status 标记
 * 成功/失败（失败不中断对话——LLM 看到错误文本自行处理，见文件头设计决策） */
export interface ToolExecutionResult {
  content: string;
  status: 'done' | 'error';
  references?: RagReference[];
}

/** 工具接口：execute 执行工具逻辑（参数已按 JSON Schema 校验/默认值填充） */
export interface Tool {
  /** 工具定义（透传供应商 tools 参数） */
  readonly definition: ToolDefinition;

  /**
   * 执行工具：返回回填文本与附加数据。实现约定：
   * - 入参宽松处理（LLM 可能传类型不匹配的值——query 非字符串/缺省按空串或
   *   默认值兜底，不抛错）；
   * - 内部失败 → { status:'error', content: 友好中文文案 }（不抛错）；
   * - 阶段事件（search/rerank/merge）经 ctx.sse 发出，断连检查点见各工具。
   */
  execute(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}
