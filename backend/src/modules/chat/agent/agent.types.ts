// Agent 循环共享类型（Task 2.8）：工具调用记录（tool_call 事件载荷 + 前端
// 「工具调用树」渲染数据源）+ Agent 运行选项。
//
// 设计决策（见任务书与 agent-orchestrator.service.ts 文件头）：
// - ToolCallRecord 是 SSE 协议类型（chat-event.types.ts 复用）与前端契约——
//   单事件语义：工具**执行完成后**发一次（携带 result/status），前端按节点
//   渲染；不做 running/done 双事件（简化协议面，前端如需「执行中」动画可用
//   阶段事件近似）
// - 树形深度简化：parentId 恒 null——当前 ReAct 循环每轮的工具调用是平级
//   列表（工具间无嵌套/并行），前端「工具调用树」渲染为列表即可；字段保留
//   为树形扩展预留（未来并行工具/子任务/Agent 嵌套时填充）
// - result 截断：TOOL_RESULT_MAX_LENGTH=2000 字符（工具返回全文仍回填 LLM
//   消息——截断只作用于事件载荷，防超长结果撑爆 SSE 事件体积）
import type { RagReference } from '../pipeline/rag.types.js';
import type { ToolExecutionResult } from './tools/tool.interface.js';

/** 工具执行结果文本截断长度（字符）：tool_call 事件 result 的载荷上限。
 * 与引用内容截断（REFERENCE_CONTENT_MAX_LENGTH=200）不同——这里防的是事件
 * 体积，LLM 回填消息（role:'tool'）不截断（模型需要完整上下文） */
export const TOOL_RESULT_MAX_LENGTH = 2000;

/** 真实错误与中止竞态时挂到错误对象上的累积部分（Task 2.10 质量审查整改）：
 * 管线抛真实错误（工具 DB 故障等）与 stop/断连（共用同一 abort 信号）同时
 * 发生时，Agent 把已流式转发的 delta 累积（正文/思考/引用）挂到错误对象上
 * 再抛（agent-orchestrator run catch），编排器 catch 据此落库 partial——已
 * 生成内容不丢（见 chat-orchestrator.service.ts runStream catch 注释）。
 * 字符串键（非 Symbol）：错误可能被序列化/跨进程传递，字符串键可读可排查；
 * 错误对象额外属性不影响 logger/mapError 的 instanceof/name 判定。 */
export const PARTIAL_ON_ERROR_KEY = '__ohmydocagentPartial';

/** 错误对象上挂载的累积生成部分（值结构，见 PARTIAL_ON_ERROR_KEY 注释） */
export interface PartialOnError {
  /** 已流式转发的正文累积（delta 拼接；可能为空串——中止早于首个 delta） */
  content: string;
  /** 已流式转发的深度思考累积（reasoning_delta 拼接；无思考输出则 null） */
  reasoning: string | null;
  /** 已执行工具返回的引用（落库来源，与正常路径同一语义，见
   * agent-orchestrator run 注释） */
  references: RagReference[];
}

/** 纯提及消息的占位文案（质量审查整改 #5b）：消息仅含 @kb:/@file: 提及
 * （cleanedText 为空）时，user 消息内容用此占位——provider 可能拒绝空
 * content 的 user 消息（检索范围已由 search_kb 按 mention scope 承担，占位
 * 仅防空串）。落库（chat-orchestrator）与 LLM 内容组装（agent-orchestrator）
 * 双通道共用同一占位，保证 DB 与历史回放一致（无空串） */
export const MENTION_ONLY_PLACEHOLDER = '请根据上述知识库内容回答';

/** 工具调用记录（tool_call 事件载荷；前端「工具调用树」数据源，见文件头
 * 设计决策）。id 与上游 tool_call id 对齐（OpenAI 兼容流式 id / Ollama 本地
 * 生成），LLM 回填消息（role:'tool' 的 tool_call_id）引用同一 id */
export interface ToolCallRecord {
  /** 工具调用 id（与上游 tool_call id 对齐；Ollama 无 id 时本地生成） */
  id: string;
  /** 父节点 id（树形深度预留：当前简化恒 null，前端渲染为列表，见文件头） */
  parentId: string | null;
  /** 工具名（search_kb） */
  name: string;
  /** 工具入参（JSON 对象；流式分片由 provider 累积后解析） */
  arguments: Record<string, unknown>;
  /** 工具返回（截断 TOOL_RESULT_MAX_LENGTH；status=error 时为错误文案） */
  result: string;
  /** 执行状态：running（预留，当前不发）/ done（成功）/ error（工具内部失败——
   * 对话不中断，错误文本回填 LLM 自行处理） */
  status: 'running' | 'done' | 'error';
}

/** Agent 运行选项（POST /chat/sessions/:id/messages 透传，见
 * send-message.dto.ts） */
export interface AgentRunOptions {
  /** 附件 id 列表（Task 2.9）：发送消息引用的已上传附件（图片/文件）——
   * user 消息上下文追加「[图片附件]/[附件] 文件名：xxx」占位（图片多模态
   * P2 先文本降级，见 agent-orchestrator.service.ts buildAttachmentHint 注释） */
  attachmentIds?: string[];
  /** @提及知识库范围（Task 2.9，前端 @选择器生成）：与 content 内嵌 @kb:xxx
   * 解析结果合并去重（双通道），见 agent-orchestrator.service.ts run 注释 */
  mentionKbIds?: string[];
  /** @提及文档范围（Task 2.9，knowledgeId）：与 content 内嵌 @file:xxx
   * 解析结果合并去重（双通道） */
  mentionKnowledgeIds?: string[];
}

/** Agent 内部执行记录（工具执行结果暂存：事件发出 + 消息回填共用） */
export interface ToolInvocation {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: ToolExecutionResult;
}
