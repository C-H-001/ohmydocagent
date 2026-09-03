// 前端 API 类型定义（frontend/src/api/types.ts）
// 与后端 TypeORM 实体/DTO 对齐：字段来源以注释标注 backend 实体文件路径。
// 日期字段后端序列化为 ISO 字符串，前端统一用 string 表示（需要 Date 时自行 parse）。
// 说明：本文件只收录核心字段（轻量模式），完整字段随各任务按需补充。

/** 分页结构：后端列表接口统一返回 { items, total, page, pageSize }（如 kb.service / session.service） */
export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  /** 各视图计数（/kbs 列表返回：全部/我的/收藏/最近——KB 页 tab 徽标用） */
  counts?: { all: number; mine: number; favorite: number; recent: number }
}

/** 用户角色（backend: modules/users/user.entity.ts — Role 枚举） */
export type UserRole = 'super' | 'member'

/**
 * 用户（backend: modules/users/user.entity.ts）
 * passwordHash 列 select:false 不返回；接口响应 = toPublicUser（去掉 passwordHash）
 */
export interface User {
  id: string
  email: string
  name: string
  avatarUrl: string
  role: UserRole
  createdAt: string
  updatedAt: string
}

/** 认证响应（backend: modules/auth/auth.service.ts — buildAuthResponse：POST /auth/login、/auth/refresh） */
export interface AuthResponse {
  accessToken: string
  refreshToken: string
  user: User
}

/** 初始化状态（backend: modules/auth/auth.controller.ts — GET /auth/init-status） */
export interface InitStatus {
  initialized: boolean
}

/** 知识库（backend: modules/kb/kb.entity.ts；type 当前仅 'document'） */
export interface KnowledgeBase {
  id: string
  name: string
  description: string
  type: string
  creatorId: string
  chunkingConfig: Record<string, unknown>
  embeddingModelId: string | null
  /** 图谱抽取配置：{ enabled: boolean } */
  extractConfig: Record<string, unknown>
  createdAt: string
  updatedAt: string
  /** 当前用户对 KB 的权限档（详情响应附加；view<edit<admin<full） */
  myPermission?: "view" | "edit" | "admin" | "full"
  /** 检索配置（RRF 权重/阈值，参考 WeKnora RetrievalConfig） */
  retrievalConfig?: Record<string, unknown>
}

/** 知识文档类型（backend: modules/knowledge/knowledge.entity.ts — type 枚举） */
export type KnowledgeType = 'file' | 'url' | 'manual'
/** 解析状态机（backend: modules/knowledge/knowledge.entity.ts — status 枚举） */
export type KnowledgeStatus = 'pending' | 'parsing' | 'ready' | 'failed'

/** 知识文档（backend: modules/knowledge/knowledge.entity.ts；列表投影不含 parsedText/manualContent 大字段） */
export interface Knowledge {
  id: string
  kbId: string
  folderId: string | null
  title: string
  type: KnowledgeType
  filePath: string
  fileType: string
  fileSize: number
  sourceUrl: string
  manualContent: string | null
  parsedText: string | null
  status: KnowledgeStatus
  error: string
  summary: string | null
  chunkCount: number
  /** 文档入库到完成消耗的 token 数量（嵌入 + 图谱抽取 + 摘要） */
  tokenCost: number
  parserStages: unknown[]
  createdAt: string
  updatedAt: string
}

/** 知识库文件夹（backend: modules/knowledge/folder.entity.ts；parentId 自引用树，null=根级） */
export interface KnowledgeFolder {
  id: string
  kbId: string
  parentId: string | null
  name: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

/** 标签（backend: modules/knowledge/tag.entity.ts；color 为 #RRGGBB） */
export interface Tag {
  id: string
  kbId: string
  name: string
  color: string
  createdAt: string
}

/** 分块（backend: modules/chunk/chunk.entity.ts；embedding 向量列 select:false 不返回） */
export interface Chunk {
  id: string
  kbId: string
  knowledgeId: string
  content: string
  sourceContent: string
  contentRevision: number
  /** 向量化状态：processing | ready | failed */
  indexStatus: string
  chunkIndex: number
  startAt: number
  endAt: number
  preChunkId: string | null
  nextChunkId: string | null
  createdAt: string
  updatedAt: string
}

/** 会话（backend: modules/chat/session.entity.ts；kbIds 为对话上下文的知识库范围） */
export interface Session {
  id: string
  userId: string
  title: string
  kbIds: string[]
  pinned: boolean
  pinnedAt: string | null
  createdAt: string
  updatedAt: string
}

/** 消息角色（backend: modules/chat/message.entity.ts — role 枚举） */
export type MessageRole = 'user' | 'assistant' | 'system'

/** 消息（backend: modules/chat/message.entity.ts；references/toolCalls/ragStages/attachments 由 Task 2.4-2.6 填充） */
export interface Message {
  id: string
  sessionId: string
  role: MessageRole
  content: string
  reasoning: string | null
  references: unknown[]
  toolCalls: unknown[]
  ragStages: unknown[]
  attachments: unknown[]
  interrupted: boolean
  /** assistant 消息 token 用量（顶栏恢复展示） */
  usage?: { inputTokens?: number; outputTokens?: number; cacheHitTokens?: number } | null
  createdAt: string
}

/** 模型供应商（backend: modules/model/model.entity.ts — MODEL_PROVIDERS） */
export type ModelProvider = 'openai-compatible' | 'ollama'
/** 模型用途（backend: modules/model/model.entity.ts — MODEL_TYPES） */
export type ModelType = 'chat' | 'embedding' | 'rerank'

/** LLM 模型配置（backend: modules/model/model.entity.ts；apiKeyEncrypted 响应层脱敏为密文） */
export interface Model {
  id: string
  name: string
  provider: ModelProvider
  baseUrl: string
  apiKeyEncrypted: string
  modelName: string
  type: ModelType
  enabled: boolean
  isDefault: boolean
  extraConfig: Record<string, unknown>
  createdAt: string
  updatedAt: string

  userId: string | null
}

/** 共享权限（backend: modules/kb-share/kb-share.entity.ts — SharePermission 枚举） */
export type SharePermission = 'view' | 'edit'

/** 知识库共享（backend: modules/kb-share/kb-share.entity.ts） */
export interface KnowledgeBaseShare {
  id: string
  kbId: string
  orgId: string
  permission: SharePermission
  createdById: string
  createdAt: string
}

/** 审计日志（backend: modules/admin/audit/audit-log.entity.ts） */
export interface AuditLog {
  id: string
  userId: string | null
  action: string
  resourceType: string
  resourceId: string | null
  detail: Record<string, unknown>
  ip: string
  createdAt: string
}

/** 平台 API Key（backend: modules/admin/api-key/platform-api-key.entity.ts；keyHash 不返回） */
export interface PlatformApiKey {
  id: string
  name: string
  scopes: string[]
  enabled: boolean
  lastUsedAt: string | null
  createdAt: string
}

/** 系统设置（backend: modules/admin/settings/system-setting.entity.ts） */
export interface SystemSetting {
  id: string
  key: string
  value: unknown
  updatedBy: string | null
  updatedAt: string
}

/** 队列任务概览（backend: modules/admin/queue/queue-admin.controller.ts 返回的 BullMQ 任务形态） */
export interface QueueJobInfo {
  id: string | number
  name: string
  /** 任务状态：waiting | active | completed | failed | delayed | paused */
  state: string
  data: Record<string, unknown> | null
  attemptsMade: number
  failedReason: string | null
  processedOn: number | null
  finishedOn: number | null
  timestamp: number
}

/** 队列仪表盘（backend: modules/admin/queue/queue-admin.controller.ts） */
export interface QueueOverview {
  queue: string
  counts: {
    waiting: number
    active: number
    completed: number
    failed: number
    delayed: number
  }
}
