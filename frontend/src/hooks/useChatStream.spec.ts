// useChatStream SSE 解析单测（frontend/src/hooks/useChatStream.spec.ts）
// 覆盖：多事件序列 → 状态分派（stage/tool_call/reasoning_delta/delta/references/
// done）、事件跨 chunk 边界（ReadableStream 分片写入）、心跳注释行忽略、
// error 事件 + 中文 code 文案映射、data 非 JSON 事件跳过。

import { describe, expect, it, vi } from "vitest"
import {
  mapErrorCode,
  parseSseStream,
  type ChatStreamHandlers,
} from "./useChatStream"

/** 用文本分片构造 SSE Response（模拟网络层任意分块） */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  return { body: stream } as unknown as Response
}

/** 组装一条 SSE 事件（event: + data: + 空行） */
function event(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}

function makeHandlers() {
  const calls: string[] = []
  const handlers: ChatStreamHandlers = {
    onStage: (stage, status) => calls.push(`stage:${stage}:${status}`),
    onToolCall: (call) => calls.push(`tool_call:${call.name}:${call.status}`),
    onReasoningStart: () => calls.push("reasoning_start"),
    onReasoningDelta: (text) => calls.push(`reasoning_delta:${text}`),
    onReasoningEnd: () => calls.push("reasoning_end"),
    onDelta: (text) => calls.push(`delta:${text}`),
    onReferences: (refs) => calls.push(`references:${refs.length}:${refs[0]?.knowledgeTitle}`),
    onDone: (p) => calls.push(`done:${p.messageId}:${p.interrupted ? "interrupted" : "ok"}`),
    onError: (code, message) => calls.push(`error:${code}:${message}`),
  }
  return { calls, handlers }
}

describe("parseSseStream", () => {
  it("多事件序列按序分派：stage → reasoning_delta → tool_call → delta → references → done", async () => {
    const { calls, handlers } = makeHandlers()
    const body =
      event("stage", { type: "stage", stage: "generate", status: "start" }) +
      event("reasoning_delta", { type: "reasoning_delta", text: "思考中" }) +
      event("tool_call", {
        type: "tool_call",
        call: { id: "t1", parentId: null, name: "search_kb", arguments: { q: "x" }, result: "{}", status: "done" },
      }) +
      event("delta", { type: "delta", text: "你好，" }) +
      event("delta", { type: "delta", text: "世界" }) +
      event("references", {
        type: "references",
        references: [{ index: 1, chunkId: "c1", knowledgeId: "k1", knowledgeTitle: "文档A", content: "片段", score: 0.9 }],
      }) +
      event("done", { type: "done", messageId: "m-1", usage: { inputTokens: 10, outputTokens: 5 } })

    await parseSseStream(sseResponse([body]), handlers)
    expect(calls).toEqual([
      "stage:generate:start",
      "reasoning_delta:思考中",
      "tool_call:search_kb:done",
      "delta:你好，",
      "delta:世界",
      "references:1:文档A",
      "done:m-1:ok",
    ])
  })

  it("事件跨 chunk 边界（任意分片写入）仍完整解析", async () => {
    const { calls, handlers } = makeHandlers()
    const body =
      event("stage", { type: "stage", stage: "generate", status: "start" }) +
      event("delta", { type: "delta", text: "跨块文本" }) +
      event("done", { type: "done", messageId: "m-2" })
    // 按字符随机切碎（包括切断 event:/data: 前缀与 JSON 中间）
    const fragments: string[] = []
    let i = 0
    while (i < body.length) {
      const len = 1 + Math.floor(Math.random() * 6)
      fragments.push(body.slice(i, i + len))
      i += len
    }
    await parseSseStream(sseResponse(fragments), handlers)
    expect(calls).toEqual(["stage:generate:start", "delta:跨块文本", "done:m-2:ok"])
  })

  it("心跳注释行与未知事件类型被忽略", async () => {
    const { calls, handlers } = makeHandlers()
    const body = ": heartbeat\n\n" + event("delta", { type: "delta", text: "a" }) + ": heartbeat\n\n" + event("unknown_type", { foo: 1 }) + "\n\n"
    await parseSseStream(sseResponse([body]), handlers)
    expect(calls).toEqual(["delta:a"])
  })

  it("error 事件分派 code，mapErrorCode 映射中文文案（含兜底）", async () => {
    const { calls, handlers } = makeHandlers()
    const body = event("error", { type: "error", code: "no_default_model", message: "未配置默认对话模型" })
    await parseSseStream(sseResponse([body]), handlers)
    expect(calls).toEqual(["error:no_default_model:未配置默认对话模型"])
    expect(mapErrorCode("no_default_model")).toBe("未配置默认对话模型，请到设置中心配置")
    expect(mapErrorCode("unknown_code")).toBe("生成失败，请重试")
    expect(mapErrorCode("unknown_code", "后端说：失败")).toBe("后端说：失败")
    expect(mapErrorCode("generation_stopped")).toBe("已停止生成")
  })

  it("data 行非合法 JSON 的事件被跳过（不崩溃）", async () => {
    const { calls, handlers } = makeHandlers()
    const body = "event: delta\ndata: 不是JSON\n\n" + event("done", { type: "done", messageId: "m-3" })
    await parseSseStream(sseResponse([body]), handlers)
    expect(calls).toEqual(["done:m-3:ok"])
  })

  it("CRLF 行尾（\\r\\n）与无结尾空行（流结束 flush）", async () => {
    const { calls, handlers } = makeHandlers()
    const body = "event: delta\r\ndata: {\"type\":\"delta\",\"text\":\"CRLF\"}\r\n\r\nevent: done\r\ndata: {\"type\":\"done\",\"messageId\":\"m-4\"}"
    await parseSseStream(sseResponse([body]), handlers)
    expect(calls).toEqual(["delta:CRLF", "done:m-4:ok"])
  })

  it("无 body 的响应 → onError no_stream", async () => {
    const { calls, handlers } = makeHandlers()
    await parseSseStream({ body: null } as unknown as Response, handlers)
    expect(calls).toEqual(["error:no_stream:服务端未返回流式响应"])
  })
})
