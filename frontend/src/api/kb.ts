// 知识库/文档/分块 API 类型化封装（frontend/src/api/kb.ts）
// 轻量模式：把 Task 5.3-5.5 用到的后端端点收敛为带类型的函数，
// 视图层不再直接拼 path/query。所有错误统一抛 ApiError（message 为后端中文文案）。
// 后端路由速查：
//   KB：POST/GET /kbs、GET/PUT/DELETE /kbs/:id、PUT :id/pin|favorite、POST :id/duplicate
//   文档：GET/PUT/DELETE /kbs/:kbId/knowledge[/:kid]、POST :kbId/file|url|manual、
//     批量 batch-delete|batch-reparse|batch-tags|batch-move、:kid/stages|reparse|regenerate-summary
//   文件夹：GET/POST /kbs/:kbId/folders、PUT/DELETE /kbs/:kbId/folders/:folderId
//   标签：GET/POST /kbs/:kbId/tags、PUT/DELETE /kbs/:kbId/tags/:tagId、PUT :kid/tags
//   分块：GET /kbs/:kbId/knowledge/:kid/chunks、PUT /chunks/:chunkId、
//     GET /chunks/:chunkId/revisions、POST /chunks/:chunkId/revert

import { api } from "./client"
import type {
  Chunk,
  Knowledge,
  KnowledgeBase,
  KnowledgeFolder,
  Paginated,
  Tag,
} from "./types"

// ---------------------------------------------------------------------------
// 扩展类型（列表投影/端点专属响应）
// ---------------------------------------------------------------------------

/** KB 列表项：KB 实体 + 当前用户标记 + 聚合计数（kb.service.list 装配） */
export interface KbListItem extends KnowledgeBase {
  pinned: boolean
  favorite: boolean
  docCount: number
  chunkCount: number
}

/** 解析阶段记录（knowledge-progress.service：stage 追加时间线） */
export interface ParserStage {
  stage: string
  status: "running" | "done" | "failed"
  at: string
  detail?: string
}

/** GET /kbs/:kbId/knowledge/:kid/stages 响应 */
export interface StagesResult {
  stages: ParserStage[]
  status: string
  chunkCount: number
  summary: string | null
  updatedAt: string
}

/** 分块版本记录（chunk-revision.entity.ts，revision 升序） */
export interface ChunkRevision {
  id: string
  chunkId: string
  content: string
  revision: number
  editorId: string | null
  createdAt: string
}

/** 文档列表查询参数（与 ListKnowledgeDto 对齐；pageSize ≤ 100） */
export interface KnowledgeListQuery {
  page?: number
  pageSize?: number
  keyword?: string
  type?: "file" | "url" | "manual"
  status?: "pending" | "parsing" | "ready" | "failed"
  /** 逗号分隔的 tagIds（后端字符串参数） */
  tagIds?: string
  folderId?: string
}

// ---------------------------------------------------------------------------
// KB 级
// ---------------------------------------------------------------------------

export const kbApi = {
  /** GET /kbs?view=&page=&pageSize=（view=all|mine|favorite|recent） */
  listKbs(view: string, page = 1, pageSize = 24): Promise<Paginated<KbListItem>> {
    return api.get("/kbs", { query: { view, page, pageSize } })
  },

  /** POST /kbs 创建（name 必填；chunkingConfig/extractConfig 可选） */
  createKb(body: {
    name: string
    description?: string
    chunkingConfig?: Record<string, unknown>
    extractConfig?: { enabled: boolean }
  }): Promise<KnowledgeBase> {
    return api.post("/kbs", body)
  },

  /** GET /kbs/:id 详情（后端自动记录最近访问） */
  getKb(id: string): Promise<KnowledgeBase> {
    return api.get(`/kbs/${id}`)
  },

  /** PUT /kbs/:id/pin 置顶开关（toggle）→ { pinned } */
  togglePin(id: string): Promise<{ pinned: boolean }> {
    return api.put(`/kbs/${id}/pin`)
  },

  /** PUT /kbs/:id/favorite 收藏开关（toggle）→ { favorite } */
  toggleFavorite(id: string): Promise<{ favorite: boolean }> {
    return api.put(`/kbs/${id}/favorite`)
  },

  /** POST /kbs/:id/duplicate 复制（name 可选，缺省「原名（副本）」） */
  duplicateKb(id: string, name?: string): Promise<KnowledgeBase> {
    return api.post(`/kbs/${id}/duplicate`, name ? { name } : {})
  },

  /** DELETE /kbs/:id 硬删除（204） */
  deleteKb(id: string): Promise<void> {
    return api.del(`/kbs/${id}`)
  },
}

// ---------------------------------------------------------------------------
// 文档级
// ---------------------------------------------------------------------------

export const knowledgeApi = {
  /** GET /kbs/:kbId/knowledge 分页列表（keyword/type/status/tagIds/folderId 筛选） */
  list(kbId: string, query: KnowledgeListQuery = {}): Promise<Paginated<Knowledge>> {
    return api.get(`/kbs/${kbId}/knowledge`, {
      query: { ...query, tagIds: query.tagIds || undefined },
    })
  },

  /** GET /kbs/:kbId/knowledge/:kid 详情（含 parsedText/manualContent 大字段） */
  get(kbId: string, kid: string): Promise<Knowledge> {
    return api.get(`/kbs/${kbId}/knowledge/${kid}`)
  },

  /** PUT /kbs/:kbId/knowledge/:kid 更新（仅标题重命名） */
  rename(kbId: string, kid: string, title: string): Promise<Knowledge> {
    return api.put(`/kbs/${kbId}/knowledge/${kid}`, { title })
  },

  /** DELETE /kbs/:kbId/knowledge/:kid（204） */
  remove(kbId: string, kid: string): Promise<void> {
    return api.del(`/kbs/${kbId}/knowledge/${kid}`)
  },

  /** POST /kbs/:kbId/file multipart 上传（FormData 字段名 file） */
  uploadFile(kbId: string, file: File): Promise<Knowledge> {
    const formData = new FormData()
    formData.append("file", file)
    return api.upload(`/kbs/${kbId}/file`, formData)
  },

  /** POST /kbs/:kbId/manual 手动创建 */
  createManual(kbId: string, title: string, content: string): Promise<Knowledge> {
    return api.post(`/kbs/${kbId}/manual`, { title, content })
  },

  /** GET /kbs/:kbId/knowledge/:kid/stages 解析时间线 */
  stages(kbId: string, kid: string): Promise<StagesResult> {
    return api.get(`/kbs/${kbId}/knowledge/${kid}/stages`)
  },

  /** POST /kbs/:kbId/knowledge/:kid/reparse 重新解析（202 入队） */
  reparse(kbId: string, kid: string): Promise<{ queued: true }> {
    return api.post(`/kbs/${kbId}/knowledge/${kid}/reparse`)
  },

  /** POST /kbs/:kbId/knowledge/:kid/regenerate-summary 重新生成摘要（202） */
  regenerateSummary(kbId: string, kid: string): Promise<{ queued: true }> {
    return api.post(`/kbs/${kbId}/knowledge/${kid}/regenerate-summary`)
  },

  /** POST batch-delete → { deleted } */
  batchDelete(kbId: string, ids: string[]): Promise<{ deleted: number }> {
    return api.post(`/kbs/${kbId}/knowledge/batch-delete`, { ids })
  },

  /** POST batch-reparse（202）→ { queued, skipped, failed } */
  batchReparse(kbId: string, ids: string[]): Promise<{ queued: number; skipped: number; failed: number }> {
    return api.post(`/kbs/${kbId}/knowledge/batch-reparse`, { ids })
  },

  /** PUT batch-tags（tagIds 空数组 = 批量去标）→ { updated, failed } */
  batchTags(kbId: string, ids: string[], tagIds: string[]): Promise<{ updated: number; failed: number }> {
    return api.put(`/kbs/${kbId}/knowledge/batch-tags`, { ids, tagIds })
  },

  /** POST batch-move（folderId null = 移回根）→ { moved } */
  batchMove(kbId: string, ids: string[], folderId: string | null): Promise<{ moved: number }> {
    return api.post(`/kbs/${kbId}/knowledge/batch-move`, { ids, folderId })
  },

  /** PUT /kbs/:kbId/knowledge/:kid/tags 全量替换文档标签 */
  setTags(kbId: string, kid: string, tagIds: string[]): Promise<{ tagIds: string[] }> {
    return api.put(`/kbs/${kbId}/knowledge/${kid}/tags`, { tagIds })
  },
}

// ---------------------------------------------------------------------------
// 文件夹 / 标签
// ---------------------------------------------------------------------------

export const folderApi = {
  /** GET /kbs/:kbId/folders 文件夹树（children 嵌套，根级为顶层数组） */
  list(kbId: string): Promise<KnowledgeFolder[]> {
    return api.get(`/kbs/${kbId}/folders`)
  },

  /** POST /kbs/:kbId/folders 新建（parentId 缺省 = 根级） */
  create(kbId: string, name: string, parentId?: string): Promise<KnowledgeFolder> {
    return api.post(`/kbs/${kbId}/folders`, { name, parentId: parentId || undefined })
  },

  /** PUT /kbs/:kbId/folders/:folderId 重命名 */
  rename(kbId: string, folderId: string, name: string): Promise<KnowledgeFolder> {
    return api.put(`/kbs/${kbId}/folders/${folderId}`, { name })
  },

  /** DELETE /kbs/:kbId/folders/:folderId（文档归根 + 级联删子树，204） */
  remove(kbId: string, folderId: string): Promise<void> {
    return api.del(`/kbs/${kbId}/folders/${folderId}`)
  },
}

export const tagApi = {
  /** GET /kbs/:kbId/tags 标签列表 */
  list(kbId: string): Promise<Tag[]> {
    return api.get(`/kbs/${kbId}/tags`)
  },

  /** POST /kbs/:kbId/tags 创建（name + color 可选） */
  create(kbId: string, name: string, color?: string): Promise<Tag> {
    return api.post(`/kbs/${kbId}/tags`, { name, color: color || undefined })
  },

  /** DELETE /kbs/:kbId/tags/:tagId（解除全部关联，204） */
  remove(kbId: string, tagId: string): Promise<void> {
    return api.del(`/kbs/${kbId}/tags/${tagId}`)
  },
}

/** KB 共享（backend: kb-share/kb-share.entity.ts；列表含 orgName 装配） */
export interface KbShare {
  id: string
  kbId: string
  orgId: string | null
  orgName?: string
  userId: string | null
  userName?: string
  permission: "view" | "edit" | "admin"
  createdById: string
  createdAt: string
}

export type ShareTarget =
  | { orgId: string }
  | { email: string }

export const shareApi = {
  /** GET /kbs/:id/shares 共享列表（含 orgName/userName，admin 及以上可看） */
  list(kbId: string): Promise<KbShare[]> {
    return api.get(`/kbs/${kbId}/shares`)
  },

  /** POST /kbs/:id/shares 创建共享（个人邀请 {email}） */
  create(kbId: string, target: ShareTarget, permission: "view" | "edit" | "admin"): Promise<KbShare> {
    return api.post(`/kbs/${kbId}/shares`, { ...target, permission })
  },

  /** PUT /kbs/:id/shares/:shareId 改权限（view/edit/admin） */
  update(kbId: string, shareId: string, permission: "view" | "edit" | "admin"): Promise<KbShare> {
    return api.put(`/kbs/${kbId}/shares/${shareId}`, { permission })
  },

  /** DELETE /kbs/:id/shares/:shareId 撤销共享（204） */
  remove(kbId: string, shareId: string): Promise<void> {
    return api.del(`/kbs/${kbId}/shares/${shareId}`)
  },
}

// ---------------------------------------------------------------------------
// 分块
// ---------------------------------------------------------------------------

export const chunkApi = {
  /** GET /kbs/:kbId/knowledge/:kid/chunks 分块列表（chunkIndex 升序） */
  list(kbId: string, kid: string, page = 1, pageSize = 50): Promise<Paginated<Chunk>> {
    return api.get(`/kbs/${kbId}/knowledge/${kid}/chunks`, { query: { page, pageSize } })
  },

  /** PUT /chunks/:chunkId 编辑内容（contentRevision 自增 + 触发重新向量化） */
  update(chunkId: string, content: string): Promise<Chunk> {
    return api.put(`/chunks/${chunkId}`, { content })
  },

  /** GET /chunks/:chunkId/revisions 版本历史（revision 升序） */
  revisions(chunkId: string): Promise<ChunkRevision[]> {
    return api.get(`/chunks/${chunkId}/revisions`)
  },

  /** POST /chunks/:chunkId/revert 回滚到指定版本（追加式新版本）→ 更新后的 chunk */
  revert(chunkId: string, revision: number): Promise<Chunk> {
    return api.post(`/chunks/${chunkId}/revert`, { revision })
  },
}
