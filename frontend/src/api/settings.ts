// 设置中心 API 类型化封装（frontend/src/api/settings.ts，Task 5.8）
// 12 子页数据源收敛为带类型函数。路由速查：
//   个人资料：GET/PUT /settings/profile、POST /settings/change-password
//   用户：GET /users、PUT /users/:id/role、POST /users/transfer-ownership
//   邀请：GET/POST/DELETE /invitations
//   模型：GET/POST/PUT/DELETE /models、PUT /models/:id/default、
//     POST /models/test、POST /models/:id/test、POST /models/:id/debug
//   Web 搜索：GET/POST/PUT/DELETE /web-search/providers、
//     PUT /web-search/providers/:id/default、POST /web-search/providers/test、
//     POST /web-search/providers/:id/test
//   聊天历史：GET /chat/history?keyword=、GET /chat/history/stats、DELETE /chat/history
//   API Keys：GET/POST/DELETE /admin/api-keys
//   队列：GET /admin/queues、GET /admin/queues/:name/jobs、
//     POST /admin/queues/:name/jobs/:id/retry|cancel
//   审计：GET /admin/audit-logs（分页筛选）
//   全局设置：GET/PUT /admin/settings；系统信息：GET /system/info

import { api } from "./client"
import type {
  AuditLog,
  Model,
  Paginated,
  PlatformApiKey,
  QueueJobInfo,
  SystemSetting,
  User,
} from "./types"

// ---------------------------------------------------------------------------
// 个人资料
// ---------------------------------------------------------------------------

export const profileApi = {
  /** GET /settings/profile 当前用户资料 */
  get(): Promise<User> {
    return api.get("/settings/profile")
  },

  /** PUT /settings/profile 更新昵称/头像（只更新传入字段） */
  update(body: { name?: string; avatarUrl?: string }): Promise<User> {
    return api.put("/settings/profile", body)
  },

  /** POST /settings/change-password 修改密码 → { changed: true } */
  changePassword(oldPassword: string, newPassword: string): Promise<{ changed: boolean }> {
    return api.post("/settings/change-password", { oldPassword, newPassword })
  },
}

// ---------------------------------------------------------------------------
// 工作区 / 成员 / 邀请
// ---------------------------------------------------------------------------

export const workspaceApi = {
  /** GET /users 用户分页列表 */
  listUsers(page = 1, pageSize = 100): Promise<Paginated<User>> {
    return api.get("/users", { query: { page, pageSize } })
  },

  /** PUT /users/:id/role 角色调整（仅 owner；role ∈ owner|admin） */
  updateRole(id: string, role: "super" | "member"): Promise<User> {
    return api.put(`/users/${id}/role`, { role })
  },

  /** POST /users/transfer-ownership 所有权转移 → { previousOwner, newOwner } */
  transferOwnership(targetUserId: string): Promise<{ previousOwner: User; newOwner: User }> {
    return api.post("/users/transfer-ownership", { targetUserId })
  },

  /** GET /invitations 邀请分页列表（token 脱敏 tokenPreview） */
  listInvitations(page = 1, pageSize = 100): Promise<Paginated<Record<string, unknown>>> {
    return api.get("/invitations", { query: { page, pageSize } })
  },

  /** POST /invitations 创建邀请（返回完整 token，仅此一次） */
  createInvitation(email: string, role: string): Promise<Record<string, unknown>> {
    return api.post("/invitations", { email, role })
  },

  /** DELETE /invitations/:id 撤销邀请（204） */
  revokeInvitation(id: string): Promise<void> {
    return api.del(`/invitations/${id}`)
  },
}

// ---------------------------------------------------------------------------
// 模型管理
// ---------------------------------------------------------------------------

/** 新增/测试用模型表单（与 CreateModelDto 对齐；apiKey 可选） */
export interface ModelForm {
  name: string
  provider: "openai-compatible" | "ollama"
  baseUrl?: string
  apiKey?: string
  modelName: string
  type: "chat" | "embedding" | "rerank"
  enabled?: boolean
}

export const modelApi = {
  /** GET /models 列表（?type= 筛选） */
  list(type?: "chat" | "embedding" | "rerank"): Promise<Model[]> {
    return api.get("/models", { query: { type } })
  },

  /** POST /models 新增（201） */
  create(body: ModelForm): Promise<Model> {
    return api.post("/models", body)
  },

  /** PUT /models/:id 更新（PATCH 语义） */
  update(id: string, body: Partial<ModelForm>): Promise<Model> {
    return api.put(`/models/${id}`, body)
  },

  /** DELETE /models/:id（204） */
  remove(id: string): Promise<void> {
    return api.del(`/models/${id}`)
  },

  /** PUT /models/:id/default 设为默认 */
  setDefault(id: string): Promise<Model> {
    return api.put(`/models/${id}/default`)
  },

  /** POST /models/test 连通性测试（完整配置不保存）→ { ok } | { ok:false, error } */
  testConnection(body: ModelForm): Promise<{ ok: boolean; error?: string }> {
    return api.post("/models/test", body)
  },

  /** POST /models/:id/test 已保存模型连通性测试 */
  testSaved(id: string): Promise<{ ok: boolean; error?: string }> {
    return api.post(`/models/${id}/test`)
  },

  /** POST /models/:id/debug 模型调试（返回生成文本） */
  debug(id: string, message = "你好，请简单介绍一下自己。"): Promise<{ response: string }> {
    return api.post(`/models/${id}/debug`, { message })
  },
}

// ---------------------------------------------------------------------------
// Web 搜索供应商
// ---------------------------------------------------------------------------


export interface HistoryHit {
  messageId: string
  sessionId: string
  sessionTitle: string
  role: string
  content: string
  createdAt: string
}

/** GET /chat/history/stats 按知识库统计条目 */
export interface HistoryStat {
  kbId: string
  kbName: string | null
  messageCount: number
  citationCount: number
}

export const historyApi = {
  /** GET /chat/history?keyword= 历史搜索（keyword 必填） */
  search(keyword: string, page = 1, pageSize = 20): Promise<Paginated<HistoryHit>> {
    return api.get("/chat/history", { query: { keyword, page, pageSize } })
  },

  /** GET /chat/history/stats 按知识库统计（days 缺省 30） */
  stats(days = 30): Promise<HistoryStat[]> {
    return api.get("/chat/history/stats", { query: { days } })
  },

  /** DELETE /chat/history 清空全部会话 → { deleted } */
  clearAll(): Promise<{ deleted: number }> {
    return api.del("/chat/history")
  },
}

// ---------------------------------------------------------------------------
// 平台 API Keys
// ---------------------------------------------------------------------------

export const apiKeyApi = {
  /** GET /admin/api-keys 列表（脱敏） */
  list(): Promise<PlatformApiKey[]> {
    return api.get("/admin/api-keys")
  },

  /** POST /admin/api-keys 创建 → apiKey 明文（仅此一次） */
  create(name: string, scopes?: string[]): Promise<{ id: string; name: string; apiKey: string; createdAt: string }> {
    return api.post("/admin/api-keys", { name, scopes: scopes || undefined })
  },

  /** DELETE /admin/api-keys/:id 吊销 */
  remove(id: string): Promise<void> {
    return api.del(`/admin/api-keys/${id}`)
  },
}

// ---------------------------------------------------------------------------
// 任务队列
// ---------------------------------------------------------------------------

/** GET /admin/queues 概览条目（后端返回 { name, counts }） */
export interface QueueOverviewItem {
  name: string
  counts: {
    waiting: number
    active: number
    completed: number
    failed: number
    delayed: number
    paused?: number
  }
}

export const queueApi = {
  /** GET /admin/queues 五队列概览 */
  overview(): Promise<QueueOverviewItem[]> {
    return api.get("/admin/queues")
  },

  /** GET /admin/queues/:name/jobs 任务列表（?state=&page=&pageSize=） */
  jobs(name: string, state?: string, page = 1, pageSize = 20): Promise<Paginated<QueueJobInfo>> {
    return api.get(`/admin/queues/${name}/jobs`, { query: { state, page, pageSize } })
  },

  /** POST /admin/queues/:name/jobs/:id/retry 重试（200） */
  retry(name: string, id: string | number): Promise<{ ok: boolean }> {
    return api.post(`/admin/queues/${name}/jobs/${id}/retry`)
  },

  /** POST /admin/queues/:name/jobs/:id/cancel 取消（200） */
  cancel(name: string, id: string | number): Promise<{ ok: boolean }> {
    return api.post(`/admin/queues/${name}/jobs/${id}/cancel`)
  },
}

// ---------------------------------------------------------------------------
// 审计 / 全局设置 / 系统信息
// ---------------------------------------------------------------------------

export const auditApi = {
  /** GET /admin/audit-logs 分页筛选（?action=&userId=） */
  list(action?: string, userId?: string, page = 1, pageSize = 20): Promise<Paginated<AuditLog>> {
    return api.get("/admin/audit-logs", { query: { action, userId, page, pageSize } })
  },
}

export const systemApi = {
  /** GET /admin/settings 全部配置（DB 值合并注册表默认值）→ { key: value } */
  getSettings(): Promise<Record<string, unknown>> {
    return api.get("/admin/settings")
  },

  /** PUT /admin/settings 部分更新（values 逐 key 校验） */
  updateSettings(values: Record<string, unknown>): Promise<Record<string, unknown>> {
    return api.put("/admin/settings", { values })
  },

  /** GET /system/info 版本 + PG/Redis/Neo4j 健康 */
  info(): Promise<{
    version: string
    services?: Record<string, { ok?: boolean; latencyMs?: number; detail?: string }>
    timestamp?: string
  }> {
    return api.get("/system/info")
  },
}

// 保留类型导出（部分页面直接 import type）
export type { SystemSetting }

/** 模型用量（GET /me/model-usage——当前用户自己的用量） */
export interface ModelUsageRow {
  modelId: string
  modelName: string
  type: string
  calls: number
  inputTokens: number
  outputTokens: number
}

export const usageApi = {
  /** GET /me/model-usage 当前用户自己的模型用量 */
  listMine(): Promise<{ items: ModelUsageRow[]; totalTokens: number; totalCalls: number }> {
    return api.get("/me/model-usage")
  },
}
