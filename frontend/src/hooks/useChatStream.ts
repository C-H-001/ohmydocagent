// 聊天流式发送（frontend/src/hooks/useChatStream.ts，Task 5.6 核心）
// SSE 事件协议（硬契约，见 backend sse/chat-event.types.ts）：
//   event: <type>\ndata: <JSON>\n\n（SSE 规范行格式，空行分隔；心跳注释行
//   ': heartbeat' 被解析器忽略）
// 事件序列：stage(generate start) → [reasoning_delta | tool_call | delta | references]*
//   → stage(generate done) → done（或任意阶段出错 → error）
// 职责分层：
//   - parseSseStream：纯函数解析器（fetch 返回的 Response → ReadableStream →
//     逐行拆事件 → 按 event 名分派 handlers），不依赖 React，可直接单测；
//   - useChatStream：React hook 包装（fetch POST + AbortController 停止 +
//     generating 状态），发送体与 DTO 对齐（mention/attachment）。

import { useCallback, useRef, useState } from "react"
import { ApiError, BASE_URL, getAccessToken } from "../api/client"
import type { RagReference } from "../api/chat"

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 工具调用记录（后端 tool_call 事件载荷，agent/agent.types.ts） */
export interface ToolCallRecord {
  id: string
  parentId: string | null
  name: string
  arguments: Record<string, unknown>
  result: string
  status: "running" | "done" | "error"
}

/** RAG 检索阶段名（与协议一致；query_understand 已并入工具调用，协议移除） */
export type RagStageName = "search" | "rerank" | "merge" | "generate"

/** SSE 事件分派回调（按 event 名路由，见协议注释） */
export interface ChatStreamHandlers {
  onStage?: (stage: RagStageName, status: "start" | "done" | "error", detail?: string) => void
  onToolCall?: (call: ToolCallRecord) => void
  onReasoningStart?: () => void
  onReasoningDelta?: (text: string) => void
  onReasoningEnd?: () => void
  onDelta?: (text: string) => void
  onReferences?: (references: RagReference[]) => void
  onDone?: (payload: {
    messageId: string
    usage?: { inputTokens?: number; outputTokens?: number; cacheHitTokens?: number }
    interrupted?: boolean
  }) => void
  onError?: (code: string, message: string) => void
}

/** 发送体（与 SendMessageDto 对齐） */
export interface ChatSendBody {
  content: string
  attachmentIds?: string[]
  mentionKbIds?: string[]
  mentionKnowledgeIds?: string[]
}

// ---------------------------------------------------------------------------
// 错误码 → 中文文案（协议 error.code 映射；兜底用后端 message）
// ---------------------------------------------------------------------------

const ERROR_CODE_MESSAGES: Record<string, string> = {
  chat_model_error: "模型服务异常，请检查模型配置",
  no_default_model: "未配置默认对话模型，请到设置中心配置",
  chat_timeout: "生成超时，请重试",
  chat_network_error: "连接模型供应商失败，请检查网络",
  persist_failed: "消息保存失败，请重试",
  generation_stopped: "已停止生成",
}

/** 将 SSE error.code 归一化为可展示中文文案 */
export function mapErrorCode(code: string, fallbackMessage?: string): string {
  return ERROR_CODE_MESSAGES[code] ?? fallbackMessage ?? "生成失败，请重试"
}

// ---------------------------------------------------------------------------
// SSE 流解析（纯函数，可单测）
// ---------------------------------------------------------------------------

/**
 * 逐行解析 SSE 响应流并按 event 名分派 handlers。
 * 处理：事件跨 chunk 边界（行缓冲）、\r\n 行尾、心跳注释行（: 开头）忽略、
 * data 行 JSON 解析失败 → 跳过该事件（协议要求 data 恒为 JSON）。
 * 流结束（done）时刷新未闭合事件（兜底，正常后端每个事件都以空行收尾）。
 */
export async function parseSseStream(
  response: Response,
  handlers: ChatStreamHandlers,
): Promise<void> {
  if (!response.body) {
    handlers.onError?.("no_stream", "服务端未返回流式响应")
    return
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder("utf-8")
  let buffer = ""
  let eventName: string | null = null
  const dataLines: string[] = []

  /** 当前事件收尾（空行/流结束触发）→ 按 eventName 分派 */
  const dispatch = () => {
    if (!eventName || dataLines.length === 0) return
    let payload: unknown = null
    try {
      payload = JSON.parse(dataLines.join("\n"))
    } catch {
      // data 不是合法 JSON：跳过该事件（协议要求 data 恒为 JSON）
      eventName = null
      dataLines.length = 0
      return
    }
    const obj = payload as Record<string, unknown>
    switch (eventName) {
      case "stage":
        handlers.onStage?.(
          obj.stage as RagStageName,
          obj.status as "start" | "done" | "error",
          typeof obj.detail === "string" ? obj.detail : undefined,
        )
        break
      case "tool_call":
        handlers.onToolCall?.(obj.call as ToolCallRecord)
        break
      case "reasoning_start":
        handlers.onReasoningStart?.()
        break
      case "reasoning_delta":
        if (typeof obj.text === "string") handlers.onReasoningDelta?.(obj.text)
        break
      case "reasoning_end":
        handlers.onReasoningEnd?.()
        break
      case "delta":
        if (typeof obj.text === "string") handlers.onDelta?.(obj.text)
        break
      case "references":
        handlers.onReferences?.(obj.references as RagReference[])
        break
      case "done":
        handlers.onDone?.({
          messageId: String(obj.messageId ?? ""),
          usage: obj.usage as { inputTokens?: number; outputTokens?: number; cacheHitTokens?: number } | undefined,
          interrupted: obj.interrupted === true,
        })
        break
      case "error":
        handlers.onError?.(
          String(obj.code ?? "unknown"),
          typeof obj.message === "string" ? obj.message : "生成失败，请重试",
        )
        break
      default:
        // 未知事件类型：协议扩展预留，忽略
        break
    }
    eventName = null
    dataLines.length = 0
  }

  const processLine = (line: string) => {
    if (line.length === 0) {
      // 空行 = 事件分隔
      dispatch()
    } else if (line.startsWith(":")) {
      // 注释/心跳行（': heartbeat'）：忽略
    } else if (line.startsWith("event:")) {
      eventName = line.slice(6).trim()
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim())
    }
    // 其他行忽略
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // 归一化 \r\n → \n，按行切分（保留最后一段不完整的行在 buffer）
    buffer = buffer.replace(/\r\n/g, "\n")
    let nlIndex: number
    while ((nlIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nlIndex)
      buffer = buffer.slice(nlIndex + 1)
      processLine(line)
    }
  }
  // 流结束：处理残余缓冲（无结尾空行的最后一行 + 未闭合事件兜底）
  if (buffer.length > 0) {
    buffer = buffer.replace(/\r\n/g, "\n")
    buffer.split("\n").forEach(processLine)
  }
  dispatch()
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * 对话生成发送：send(sessionId, body, handlers) 发起 SSE 请求并按事件分派；
 * stop(sessionId) 同时 abort 本地 fetch 与调用后端 POST /:id/stop（后端
 * 经 GenerationRegistry abort 上游生成 → 事件流收尾 done(interrupted)，
 * 前端本地 abort 保证 UI 立即停止渲染）。
 */
export function useChatStream() {
  const [generating, setGenerating] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const send = useCallback(
    async (
      sessionId: string,
      body: ChatSendBody,
      handlers: ChatStreamHandlers,
    ): Promise<void> => {
      const controller = new AbortController()
      abortRef.current = controller
      setGenerating(true)
      try {
        const token = getAccessToken()
        const res = await fetch(`${BASE_URL}/chat/sessions/${sessionId}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (!res.ok) {
          // SSE 未开始的错误（400/401/403/404）→ 后端 JSON 错误体
          let message = `请求失败（HTTP ${res.status}）`
          try {
            const data = (await res.json()) as { message?: unknown }
            if (typeof data.message === "string") message = data.message
          } catch {
            // 响应体非 JSON，忽略
          }
          handlers.onError?.("request_failed", message)
          return
        }
        await parseSseStream(res, handlers)
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // 手动停止：本地 abort 触发，不当作错误（后端已收到断连/stop）
        } else {
          handlers.onError?.("network_error", "网络错误，请检查后端服务是否可用")
        }
      } finally {
        abortRef.current = null
        setGenerating(false)
      }
    },
    [],
  )

  const stop = useCallback((sessionId: string) => {
    abortRef.current?.abort()
    abortRef.current = null
    // 通知后端 abort 上游生成（烧 token 止损；失败静默——本地已停止）
    void fetch(`${BASE_URL}/chat/sessions/${sessionId}/stop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {}),
      },
    }).catch(() => {})
    setGenerating(false)
  }, [])

  return { send, stop, generating }
}
