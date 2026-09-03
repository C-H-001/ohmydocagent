// backend/src/modules/chat/sse/chat-event.types.ts
// 聊天 SSE 事件协议（Task 2.4 落代码；前端 P5.6 依赖——本文件是前后端契约，
// 改动需同步前端文档/类型定义）。POST /chat/sessions/:id/messages 的响应流
// 由 SseService 按「event: <type>\ndata: <JSON>\n\n」行格式写出（SSE 规范），
// 每个事件体的 type 字段与 event 名一致（前端按 event 名路由解析）。
//
// 事件序列（基础回路 Task 2.4）：
//   stage(generate start) → [delta | reasoning_delta]* → stage(generate done)
//   → done（或任意阶段出错 → error）
// Task 2.5 在 stage 前插入 query_understand/search/rerank/merge 检索阶段事件；
// Task 2.6 references 携带引用来源；Task 2.8 起 Agent 接管生成回路：检索阶段
// 事件改由 search_kb 工具执行时发出（query_understand 取消——职责并入 LLM
// 工具调用参数），工具执行完成后发 tool_call 事件（含 result，前端工具树）。

import type { ToolCallRecord } from '../agent/agent.types.js';
import type { RagReference } from '../pipeline/rag.types.js';

/** RAG 检索阶段名（Task 2.8 起由 search_kb 工具执行时发出；generate 由
 * Agent 循环发出——见 agent-orchestrator.service.ts 文件头注释。质量审查
 * 整改：query_understand 职责已并入 LLM 工具调用参数，从协议移除） */
export type RagStageName = 'search' | 'rerank' | 'merge' | 'generate';

/** 聊天 SSE 事件联合（新增事件类型 = 在协议中追加成员 + 前端同步） */
export type ChatEvent =
  /** 生成阶段状态：start（开始）/ done（完成）/ error（该阶段失败，detail 说明） */
  | {
      type: 'stage';
      stage: RagStageName;
      status: 'start' | 'done' | 'error';
      detail?: string;
    }
  /** 工具调用（Task 2.8：执行完成后单事件发出，携带 result/status——前端
   * 工具树渲染节点；结构定义见 agent/agent.types.ts） */
  | { type: 'tool_call'; call: ToolCallRecord }
  /** 深度思考开始（Task 2.8 细分；本任务不发送） */
  | { type: 'reasoning_start' }
  /** 深度思考增量文本（reasoning_content 流式透传） */
  | { type: 'reasoning_delta'; text: string }
  /** 深度思考结束（Task 2.8 细分；本任务不发送） */
  | { type: 'reasoning_end' }
  /** 回复正文增量（前端追加到消息气泡） */
  | { type: 'delta'; text: string }
  /** 引用来源（Task 2.6 定结构：[{ knowledgeId, chunkId, ... }]；质量审查
   * 整改：事件载荷类型收紧为 RagReference[]——与落库/对齐后的引用同一份） */
  | { type: 'references'; references: RagReference[] }
  /** 流结束：messageId 定位落库的 assistant 消息；usage 为 token 用量（可选）。
   * interrupted（Task 2.10 停止生成）：生成被中断（stop/断连）→ true（前端
   * 展示「已停止」+ partial 内容）；正常完成缺省/省略（false）。 */
  | {
      type: 'done';
      messageId: string;
      usage?: { inputTokens?: number; outputTokens?: number; cacheHitTokens?: number };
      interrupted?: boolean;
    }
  /** 生成失败（HTTP 保持 200——SSE 已开始状态码不可改；前端按 code 处理文案/重试） */
  | { type: 'error'; code: string; message: string };
