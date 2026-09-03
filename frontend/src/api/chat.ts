// 聊天 API 类型化封装（frontend/src/api/chat.ts，Task 5.6）
// 会话/消息/附件/模型/@提及数据源。SSE 流式发送走 hooks/useChatStream.ts
// （fetch POST + ReadableStream 解析），本文件只做标准 JSON 端点。
// 后端路由速查：
//   会话：POST/GET /chat/sessions、GET/PUT/DELETE /chat/sessions/:id、
//     DELETE /chat/sessions/batch、DELETE /chat/sessions/:id/messages、
//     GET /chat/sessions/:id/messages、POST :id/stop
//   模型：GET /models?type=chat（对话模型选择器）
//   知识库：GET /kbs、GET /kbs/:id/knowledge（@选择器数据源）

import { api } from "./client"
import type {
  Knowledge,
  KnowledgeBase,
  Model,
  Paginated,
  Session,
} from "./types"

// ---------------------------------------------------------------------------
// 扩展类型（后端响应装配）
// ---------------------------------------------------------------------------

/** 会话列表项：Session + messageCount 聚合（session.service.list 装配） */
export interface SessionListItem extends Session {
  messageCount: number
}

/** 会话附件（attachment.entity.ts；前端预览/发送引用用） */
/** 引用来源（SSE references 事件载荷，后端 RagReference；正文 [n] 编号对齐） */
export interface RagReference {
  /** [n] 编号：回答中 [1]/[2]… 引用的映射键 */
  index: number
  chunkId: string
  /** 所属知识库 id（「打开文档」跳 KB 详情） */
  kbId?: string
  knowledgeId: string
  knowledgeTitle: string
  content: string
  score: number
  chunks?: { chunkId: string; score: number }[]
  url?: string
  /** 主块类型：'image' = 图片描述块（content 即 VLM 描述） */
  type?: "text" | "image"
  /** 图片相关页（type=image 的主块） */
  page?: number
  /** 引用聚合图片（对齐 WeKnora：url 为签名图片 URL，可直接 <img>） */
  images?: { url: string; caption?: string; assetKey?: string }[]
}

/** POST /chat/sessions/:id/messages 发送体（与 SendMessageDto 对齐） */
export interface SendMessageBody {
  content: string
    attachmentIds?: string[]
  mentionKbIds?: string[]
  mentionKnowledgeIds?: string[]
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export const chatApi = {
  /** POST /chat/sessions 创建（默认标题「新会话」） */
  createSession(title?: string, kbIds?: string[]): Promise<Session> {
    return api.post("/chat/sessions", {
      title: title || undefined,
      kbIds: kbIds || undefined,
    })
  },

  /** GET /chat/sessions 分页列表（置顶优先 + messageCount 聚合） */
  listSessions(page = 1, pageSize = 50): Promise<Paginated<SessionListItem>> {
    return api.get("/chat/sessions", { query: { page, pageSize } })
  },

  /** PUT /chat/sessions/:id 重命名/置顶/更新 kbIds（只更新传入字段） */
  updateSession(
    id: string,
    body: { title?: string; pinned?: boolean; kbIds?: string[] },
  ): Promise<Session> {
    return api.put(`/chat/sessions/${id}`, body)
  },

  /** DELETE /chat/sessions/:id 删除（级联消息+附件，204） */
  deleteSession(id: string): Promise<void> {
    return api.del(`/chat/sessions/${id}`)
  },

  /** DELETE /chat/sessions/batch 批量删除 → { deleted } */
  deleteSessions(ids: string[]): Promise<{ deleted: number }> {
    return api.del("/chat/sessions/batch", { body: { ids } })
  },

  /** DELETE /chat/sessions/:id/messages 清空消息（会话保留，204） */
  clearSessionMessages(id: string): Promise<void> {
    return api.del(`/chat/sessions/${id}/messages`)
  },

  /** GET /chat/sessions/:id/messages 历史消息（createdAt 升序分页） */
  listMessages(
    id: string,
    page = 1,
    pageSize = 100,
  ): Promise<Paginated<import("./types").Message>> {
    return api.get(`/chat/sessions/${id}/messages`, {
      query: { page, pageSize },
    })
  },

  /** POST /chat/sessions/:id/stop 停止生成（幂等 200） */
  stopGeneration(
    id: string,
  ): Promise<{ stopped: boolean; reason?: string }> {
    return api.post(`/chat/sessions/${id}/stop`)
  },
}

// ---------------------------------------------------------------------------
// 附件
// ---------------------------------------------------------------------------


export function listChatModels(): Promise<Model[]> {
  return api.get("/models", { query: { type: "chat" } })
}

// ---------------------------------------------------------------------------
// @提及选择器数据源
// ---------------------------------------------------------------------------

/** GET /kbs 知识库列表（@kb: 提及） */
export function listKbsForMention(): Promise<Paginated<KnowledgeBase>> {
  return api.get("/kbs", { query: { page: 1, pageSize: 100 } })
}

/** GET /kbs/:kbId/knowledge 文档列表（@file: 提及） */
export function listKnowledgeForMention(
  kbId: string,
): Promise<Paginated<Knowledge>> {
  return api.get(`/kbs/${kbId}/knowledge`, {
    query: { page: 1, pageSize: 100 },
  })
}
