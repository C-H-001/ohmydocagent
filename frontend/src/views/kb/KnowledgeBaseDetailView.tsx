// 知识库详情-文档管理（frontend/src/views/kb/KnowledgeBaseDetailView.tsx）
// Task 5.4 + 5.5：真实 API 对接——
// - 文档列表 GET /kbs/:id/knowledge（keyword/type/status/tagIds/folderId 筛选，
//   筛选变化即重新拉取；keyword 300ms 防抖）
// - 文件夹树 GET /kbs/:id/folders；新建/重命名/删除（POST/PUT/DELETE）；
//   拖拽移动简化：原生 HTML5 拖拽（文档行 → 文件夹树拖放 = 批量移动），
//   另提供「移动到文件夹」菜单（见 batch-move 注释）
// - 上传 POST /kbs/:id/file（XHR 简单进度条）；手动创建 POST :id/manual
//   （URL 导入已下线：原占位符功能，仅存量 type=url 文档保留展示）
// - 批量：batch-delete / batch-reparse / batch-tags / batch-move
// - 标签：GET/POST /kbs/:id/tags + 文档打标 PUT :kid/tags
// - 预览抽屉：详情 GET :kid（文本类直接展示 parsedText/manualContent；
//   PDF 等二进制仅提示「下载端点未提供」——后端无预览/下载端点，登记）；
//   解析时间线 GET :kid/stages；分块列表 GET :kid/chunks + 编辑 PUT /chunks/:id
//   + 版本历史 GET /chunks/:id/revisions + 回滚 POST /chunks/:id/revert
//   （diff 简化：并排展示新旧文本）
// - 知识图谱 tab：本任务范围外（Task 5.4 仅文档管理），保留占位说明

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import {
  ChevronRight, Info, Settings, MessageSquare, Search,
  Upload, LayoutGrid, List, FileText, FileImage, UserPlus,
  FolderOpen, Folder, Trash2, RefreshCw,
  Tag as TagIcon, X, Network, Eye, AlertCircle,
  Loader2, Clock, Check, Plus, ChevronDown, ChevronUp, Link,
  RotateCcw, Edit3, History, FolderPlus, Pencil, ExternalLink,
  User as UserIcon
} from "lucide-react"
import { cn, toast } from "../../components/ui"
import PdfReader from "../../components/PdfReader"
import { api, ApiError, BASE_URL, getAccessToken } from "../../api/client"
import {
  chunkApi, folderApi, kbApi, knowledgeApi, tagApi, shareApi,
  type KbShare, type ParserStage,
} from "../../api/kb"
import { graphApi, type EntityDetailResponse, type GraphCoverageStats } from "../../api/graph"
import GraphCanvas, { type GraphEdgeData, type GraphNodeData } from "../../components/graph/GraphCanvas"
import type { Chunk, Knowledge, KnowledgeBase, KnowledgeFolder, Tag } from "../../api/types"
import {
  CHUNK_INDEX_META, KNOWLEDGE_STATUS_META, KNOWLEDGE_TYPE_LABEL,
  PARSER_STAGE_LABEL, formatDateTime, formatFileSize,
} from "../../utils/format"

/** 文件夹树节点（后端返回 children 嵌套） */
interface FolderNode extends KnowledgeFolder {
  children: FolderNode[]
}

type DocTab = "docs" | "graph"
type ViewMode = "list" | "grid"

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export default function KnowledgeBaseDetailView() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  // 列表页「知识库设置」菜单 → 跳详情并自动打开设置（state.openSettings）；
  // settingsTab 指定初始页签（默认 info，邀请入口传 shares）
  const [settingsTab, setSettingsTab] = useState<"info" | "shares">("info")
  useEffect(() => {
    const st = location.state as { openSettings?: boolean; settingsTab?: "info" | "shares" } | null
    if (st?.openSettings) {
      setSettingsTab(st.settingsTab ?? "info")
      setShowSettings(true)
      // 消费后清除，避免返回/刷新重复弹出
      window.history.replaceState({}, "")
    }
  }, [location.state])

  const [kb, setKb] = useState<KnowledgeBase | null>(null)
  const [kbLoading, setKbLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<DocTab>("docs")
  const [showInfoPopover, setShowInfoPopover] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  // 加载 KB 详情（此前从未加载 → kb 恒 null：设置弹窗打不开、myPermission
  // 无法生效。详情响应含 myPermission（view/edit/admin/full），设置弹窗据此
  // 条件渲染「共享管理」页签——仅 full（KB Owner/系统 super）可见）
  useEffect(() => {
    let alive = true
    kbApi.getKb(id).then((res) => {
      if (!alive) return
      setKb(res)
      setKbLoading(false)
    }).catch(() => {
      if (!alive) return
      setKbLoading(false)
    })
    return () => { alive = false }
  }, [id])

  return (
    <div className="flex flex-col h-full overflow-hidden relative">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card flex-shrink-0">
        <div className="flex items-center gap-2 text-sm">
          <button onClick={() => navigate("/kb")} className="text-muted-foreground hover:text-foreground transition-colors">知识库</button>
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
          {kbLoading ? (
            <span className="h-4 w-24 bg-muted rounded animate-pulse" />
          ) : (
            <span className="font-semibold">{kb?.name ?? "知识库"}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              onClick={() => setShowInfoPopover(!showInfoPopover)}
              className="w-8 h-8 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <Info className="w-4 h-4" />
            </button>
            {showInfoPopover && kb && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowInfoPopover(false)} />
                <div className="absolute right-0 top-10 z-20 w-72 bg-card border border-border rounded-lg shadow-xl p-4">
                  <h4 className="text-sm font-semibold mb-3">知识库概览</h4>
                  <div className="space-y-2 text-xs">
                    {[
                      ["名称", kb.name],
                      ["类型", kb.type === "document" ? "文档知识库" : kb.type],
                      ["创建时间", formatDateTime(kb.createdAt)],
                      ["更新时间", formatDateTime(kb.updatedAt)],
                      ["图谱抽取", (kb.extractConfig as { enabled?: boolean })?.enabled ? "已启用" : "已关闭"],
                    ].map(([k, v]) => (
                      <div key={String(k)} className="flex justify-between gap-3">
                        <span className="text-muted-foreground flex-shrink-0">{k}</span>
                        <span className="font-mono font-medium truncate">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
          {kb?.myPermission === "full" && (
            <button
              onClick={() => { setSettingsTab("shares"); setShowSettings(true) }}
              className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium rounded-md border border-border text-foreground hover:bg-muted transition-colors"
              title="邀请成员（成员管理）"
            >
              <UserPlus className="w-3.5 h-3.5" />
              邀请成员
            </button>
          )}
          <button
            onClick={() => setShowSettings(true)}
            className="w-8 h-8 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="知识库设置"
          >
            <Settings className="w-4 h-4" />
          </button>
          <button
            onClick={() => navigate("/chat")}
            className="inline-flex items-center gap-2 h-8 px-3 bg-accent text-accent-foreground text-xs font-medium rounded-md hover:bg-accent/90 transition-colors"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            开始对话
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-0 px-6 border-b border-border bg-card flex-shrink-0">
        {([
          { key: "docs", label: "文档", icon: <FileText className="w-3.5 h-3.5" /> },
          { key: "graph", label: "知识图谱", icon: <Network className="w-3.5 h-3.5" /> },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors",
              activeTab === tab.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === "docs" ? (
        <DocTab kbId={id} />
      ) : (
        <GraphTab kbId={id} />
      )}

      {/* KB Settings Modal（基本信息编辑 → PUT /kbs/:id） */}
      {showSettings && kb && (
        <KbSettingsModal kb={kb} initialTab={settingsTab} onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}

// ─── 知识图谱 Tab（Task 5.9：GET /graphs/kbs/:id 力导向图 + 实体搜索/详情） ─
function GraphTab({ kbId }: { kbId: string }) {
  const [vis, setVis] = useState<{ nodes: GraphNodeData[]; edges: GraphEdgeData[] } | null>(null)
  const [coverage, setCoverage] = useState<GraphCoverageStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState("")
  const [searchResults, setSearchResults] = useState<string[]>([])
  const [selectedEntity, setSelectedEntity] = useState<EntityDetailResponse | null>(null)
  const [entityLoading, setEntityLoading] = useState(false)

  const loadGraph = useCallback(async () => {
    setLoading(true)
    try {
      const [visRes, covRes] = await Promise.all([
        graphApi.getVisualization(kbId),
        graphApi.getCoverage(kbId),
      ])
      setVis(visRes)
      setCoverage(covRes)
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setLoading(false)
    }
  }, [kbId])

  useEffect(() => { void loadGraph() }, [loadGraph])

  // 实体搜索（防抖 300ms）→ 高亮命中节点
  useEffect(() => {
    if (!keyword.trim()) {
      setSearchResults([])
      return
    }
    const timer = setTimeout(() => {
      void graphApi.searchEntities(kbId, keyword.trim()).then(res => {
        setSearchResults(res.map(r => r.name))
      }).catch(() => setSearchResults([]))
    }, 300)
    return () => clearTimeout(timer)
  }, [keyword, kbId])

  const handleSelectEntity = useCallback(async (name: string) => {
    setEntityLoading(true)
    try {
      const detail = await graphApi.getEntityDetail(kbId, name)
      setSelectedEntity(detail)
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setEntityLoading(false)
    }
  }, [kbId])

  const highlightIds = useMemo(() => {
    const set = new Set<string>()
    // 搜索命中按 name 高亮；实体点击按 name 定位
    for (const n of searchResults) set.add(n)
    if (selectedEntity) set.add(selectedEntity.name)
    return set
  }, [searchResults, selectedEntity])

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 工具栏：覆盖统计 + 搜索 */}
      <div className="flex items-center gap-4 px-6 py-3 border-b border-border bg-card/50 flex-shrink-0 flex-wrap">
        {coverage && (
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1"><FileText className="w-3 h-3" />覆盖 {coverage.coveredKnowledge}/{coverage.totalKnowledge} 文档</span>
            <span className="flex items-center gap-1"><Network className="w-3 h-3" />实体 {coverage.entities}</span>
            <span className="flex items-center gap-1"><Link className="w-3 h-3" />关系 {coverage.relationships}</span>
          </div>
        )}
        <div className="relative ml-auto w-60">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder="搜索实体（如：PostgreSQL）…"
            className="h-8 w-full pl-8 pr-3 text-xs border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-accent bg-background"
          />
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* 画布 */}
        <div className="flex-1 min-w-0">
          {loading ? (
            <div className="h-full flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <GraphCanvas
              nodes={vis?.nodes ?? []}
              edges={vis?.edges ?? []}
              highlightIds={highlightIds}
              onSelectEntity={(name) => void handleSelectEntity(name)}
            />
          )}
        </div>

        {/* 实体详情面板 */}
        <aside className={cn(
          "w-80 border-l border-border bg-card flex flex-col transition-all overflow-hidden flex-shrink-0",
          selectedEntity ? "" : "w-0 border-l-0",
        )}>
          {selectedEntity && (
            <>
              <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30 flex-shrink-0">
                <div className="min-w-0">
                  <h4 className="text-sm font-semibold truncate">{selectedEntity.name}</h4>
                  {selectedEntity.attributes.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {selectedEntity.attributes.map(a => (
                        <span key={a} className="text-[9px] px-1.5 py-0.5 bg-violet-50 text-violet-700 rounded-full border border-violet-100">{a}</span>
                      ))}
                    </div>
                  )}
                </div>
                <button onClick={() => setSelectedEntity(null)} className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted flex-shrink-0">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {entityLoading && (
                  <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
                )}
                {/* 关联实体 */}
                {selectedEntity.relatedEntities.length > 0 && (
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">关联实体</div>
                    <div className="space-y-1">
                      {selectedEntity.relatedEntities.map((rel, i) => (
                        <button
                          key={i}
                          onClick={() => void handleSelectEntity(rel.name)}
                          className="w-full flex items-center gap-2 px-2.5 py-2 border border-border rounded-md hover:bg-muted/60 text-left transition-colors"
                        >
                          <Network className="w-3.5 h-3.5 text-violet-500 flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-medium truncate">{rel.name}</div>
                            <div className="text-[10px] text-muted-foreground">{rel.type} · {rel.direction === "out" ? "出" : "入"} · w={rel.weight}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {/* 反查文档 */}
                {selectedEntity.relatedKnowledge.length > 0 && (
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">来源文档</div>
                    <div className="space-y-2">
                      {selectedEntity.relatedKnowledge.map(doc => (
                        <div key={doc.knowledgeId} className="border border-border rounded-md overflow-hidden">
                          <button
                            onClick={() => toast(`已在知识库中打开：${doc.knowledgeTitle}`, "info")}
                            className="w-full flex items-center gap-2 px-2.5 py-2 bg-muted/40 hover:bg-muted/70 text-left transition-colors"
                          >
                            <FileText className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                            <span className="text-xs font-medium truncate">{doc.knowledgeTitle}</span>
                          </button>
                          {doc.chunkSnippets.map((snip, i) => (
                            <p key={i} className="px-2.5 py-1.5 text-[10px] text-muted-foreground leading-relaxed border-t border-border">
                              {snip}
                            </p>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {!entityLoading && selectedEntity.relatedEntities.length === 0 && selectedEntity.relatedKnowledge.length === 0 && (
                  <p className="text-xs text-muted-foreground">暂无关联实体与来源文档</p>
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

// ─── 文档管理 Tab ────────────────────────────────────────────────────────────
function DocTab({ kbId }: { kbId: string }) {
  const [loading, setLoading] = useState(true)
  const [docs, setDocs] = useState<Knowledge[]>([])
  const [total, setTotal] = useState(0)
  const [folders, setFolders] = useState<FolderNode[]>([])
  const [tags, setTags] = useState<Tag[]>([])

  // 筛选状态
  const [keyword, setKeyword] = useState("")
  const [debouncedKeyword, setDebouncedKeyword] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [typeFilter, setTypeFilter] = useState("all")
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)
  const [showTagPanel, setShowTagPanel] = useState(false)

  const [viewMode, setViewMode] = useState<ViewMode>("list")
  const [selectedDocs, setSelectedDocs] = useState<string[]>([])
  const [page, setPage] = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)

  const [previewDoc, setPreviewDoc] = useState<Knowledge | null>(null)
  const [showUploadMenu, setShowUploadMenu] = useState(false)
  const [uploadModal, setUploadModal] = useState<"file" | "manual" | null>(null)
  const [folderModal, setFolderModal] = useState<{ mode: "create" | "rename"; folder?: FolderNode } | null>(null)
  const [moveModal, setMoveModal] = useState<{ ids: string[] } | null>(null)
  const [tagModal, setTagModal] = useState<{ ids: string[] } | null>(null)
  const [createTagName, setCreateTagName] = useState("")

  // keyword 防抖（300ms），避免每次击键都打后端
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKeyword(keyword), 300)
    return () => clearTimeout(t)
  }, [keyword])

  // 文件夹树 + 标签列表（一次拉取缓存）
  const loadMeta = useCallback(async () => {
    try {
      const [folderRes, tagRes] = await Promise.all([
        folderApi.list(kbId),
        tagApi.list(kbId),
      ])
      setFolders(folderRes as FolderNode[])
      setTags(tagRes)
    } catch (err) {
      toast(err instanceof Error ? err.message : "加载文件夹/标签失败", "error")
    }
  }, [kbId])

  useEffect(() => {
    void loadMeta()
  }, [loadMeta])

  // 文档列表：筛选/翻页变化触发
  /** 加载文档：targetPage=1 全量刷新，>1 追加（筛选变化由 useEffect 触发） */
  const loadDocs = useCallback(async (targetPage: number) => {
    if (targetPage === 1) setLoading(true)
    else setLoadingMore(true)
    try {
      const res = await knowledgeApi.list(kbId, {
        page: targetPage,
        pageSize: 50,
        keyword: debouncedKeyword || undefined,
        type: typeFilter === "all" ? undefined : (typeFilter as "file" | "url" | "manual"),
        status: statusFilter === "all" ? undefined : (statusFilter as "pending" | "parsing" | "ready" | "failed"),
        tagIds: tagFilter.length ? tagFilter.join(",") : undefined,
        folderId: selectedFolder ?? undefined,
      })
      setDocs((prev) => (targetPage === 1 ? res.items : [...prev, ...res.items]))
      setTotal(res.total)
    } catch (err) {
      toast(err instanceof Error ? err.message : "加载文档失败", "error")
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [kbId, debouncedKeyword, typeFilter, statusFilter, tagFilter, selectedFolder])

  // 筛选/目录变化 → 回到第一页重新拉取
  useEffect(() => {
    setPage(1)
    void loadDocs(1)
  }, [loadDocs])

  // 从聊天引用「打开文档」跳转（?preview=<kid>）：文档列表加载后匹配并打开
  // DocPreviewDrawer（一次：previewConsumedRef 防重复；preview 参数清掉防刷新重开）
  const previewConsumedRef = useRef(false)
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const kid = params.get("preview")
    if (!kid || previewConsumedRef.current) return
    if (loading) return
    const doc = docs.find((d) => d.id === kid)
    if (!doc) return
    previewConsumedRef.current = true
    setPreviewDoc(doc)
    // 清理 URL 参数（刷新不重开）
    const clean = location.pathname + location.search.replace(/[?&]preview=[^&]*/, "")
    window.history.replaceState(null, "", clean)
  }, [docs, loading, location])

  const hasMore = docs.length < total

  const toggleDoc = (docId: string) => {
    setSelectedDocs((prev) =>
      prev.includes(docId) ? prev.filter((d) => d !== docId) : [...prev, docId]
    )
  }

  // ── 文件夹操作 ──
  const handleCreateFolder = async (name: string, parentId?: string) => {
    try {
      await folderApi.create(kbId, name, parentId)
      toast("文件夹已创建")
      await loadMeta()
    } catch (err) {
      toast(err instanceof Error ? err.message : "创建失败", "error")
    }
  }

  const handleRenameFolder = async (folderId: string, name: string) => {
    try {
      await folderApi.rename(kbId, folderId, name)
      toast("已重命名")
      await loadMeta()
    } catch (err) {
      toast(err instanceof Error ? err.message : "重命名失败", "error")
    }
  }

  const handleDeleteFolder = async (folderId: string) => {
    try {
      await folderApi.remove(kbId, folderId)
      toast("文件夹已删除（文档移回根目录）")
      if (selectedFolder === folderId) setSelectedFolder(null)
      await loadMeta()
      void loadDocs(1)
    } catch (err) {
      toast(err instanceof Error ? err.message : "删除失败", "error")
    }
  }

  // 原生拖拽：文档行 draggable → 拖到文件夹树节点 drop = 移动到该文件夹
  const handleDropToFolder = async (folderId: string | null, e: React.DragEvent) => {
    e.preventDefault()
    const raw = e.dataTransfer.getData("text/plain")
    if (!raw) return
    const ids = raw.split(",").filter(Boolean)
    if (!ids.length) return
    try {
      const res = await knowledgeApi.batchMove(kbId, ids, folderId)
      toast(`已移动 ${res.moved} 个文档`)
      await loadMeta()
      void loadDocs(1)
    } catch (err) {
      toast(err instanceof Error ? err.message : "移动失败", "error")
    }
  }

  // ── 批量操作 ──
  const handleBatchDelete = async () => {
    if (!selectedDocs.length) return
    try {
      const res = await knowledgeApi.batchDelete(kbId, selectedDocs)
      toast(`已删除 ${res.deleted} 个文档`)
      setSelectedDocs([])
      void loadDocs(1)
    } catch (err) {
      toast(err instanceof Error ? err.message : "删除失败", "error")
    }
  }

  const handleBatchReparse = async () => {
    if (!selectedDocs.length) return
    try {
      const res = await knowledgeApi.batchReparse(kbId, selectedDocs)
      toast(`已入队 ${res.queued} 个文档重新解析${res.skipped ? `（跳过处理中 ${res.skipped} 个）` : ""}`)
      setSelectedDocs([])
    } catch (err) {
      toast(err instanceof Error ? err.message : "重新解析失败", "error")
    }
  }

  const handleBatchTags = async (tagIds: string[]) => {
    if (!tagModal) return
    try {
      const res = await knowledgeApi.batchTags(kbId, tagModal.ids, tagIds)
      toast(`已更新 ${res.updated} 个文档的标签`)
      setTagModal(null)
      setSelectedDocs([])
    } catch (err) {
      toast(err instanceof Error ? err.message : "打标失败", "error")
    }
  }

  const handleBatchMove = async (folderId: string | null) => {
    if (!moveModal) return
    try {
      const res = await knowledgeApi.batchMove(kbId, moveModal.ids, folderId)
      toast(`已移动 ${res.moved} 个文档`)
      setMoveModal(null)
      setSelectedDocs([])
    } catch (err) {
      toast(err instanceof Error ? err.message : "移动失败", "error")
    }
  }

  const handleCreateTag = async () => {
    const name = createTagName.trim()
    if (!name) return
    try {
      await tagApi.create(kbId, name)
      setCreateTagName("")
      toast("标签已创建")
      await loadMeta()
    } catch (err) {
      toast(err instanceof Error ? err.message : "创建标签失败", "error")
    }
  }

  // 单文档操作
  const handleReparseOne = async (kid: string) => {
    try {
      await knowledgeApi.reparse(kbId, kid)
      toast("已重新解析（处理中）")
      setTimeout(() => void loadDocs(1), 800)
    } catch (err) {
      toast(err instanceof Error ? err.message : "重新解析失败", "error")
    }
  }

  const handleDeleteOne = async (kid: string) => {
    try {
      await knowledgeApi.remove(kbId, kid)
      toast("文档已删除")
      if (previewDoc?.id === kid) setPreviewDoc(null)
      void loadDocs(1)
    } catch (err) {
      toast(err instanceof Error ? err.message : "删除失败", "error")
    }
  }

  const flattenFolders = useMemo(() => {
    const out: FolderNode[] = []
    const walk = (nodes: FolderNode[], depth: number) => {
      for (const n of nodes) {
        out.push({ ...n, children: [] })
        walk(n.children ?? [], depth + 1)
      }
    }
    walk(folders, 0)
    return out
  }, [folders])

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* 文件夹树 */}
      <div className="w-52 border-r border-border bg-card/50 flex-shrink-0 p-3 overflow-y-auto">
        <div className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-2 px-2 flex items-center justify-between">
          文件夹
          <button
            onClick={() => setFolderModal({ mode: "create" })}
            className="w-5 h-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted"
            title="新建文件夹"
          >
            <FolderPlus className="w-3 h-3" />
          </button>
        </div>
        <button
          onClick={() => setSelectedFolder(null)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => handleDropToFolder(null, e)}
          className={cn(
            "w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors text-left",
            !selectedFolder ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"
          )}
        >
          <FolderOpen className="w-3.5 h-3.5" />
          <span>全部文档</span>
        </button>
        <FolderTree
          nodes={folders}
          depth={0}
          selectedFolder={selectedFolder}
          onSelect={setSelectedFolder}
          onRename={(f) => setFolderModal({ mode: "rename", folder: f })}
          onDelete={handleDeleteFolder}
          onDrop={handleDropToFolder}
        />
      </div>

      {/* 主内容区 */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* 工具栏 */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border flex-shrink-0 flex-wrap">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索文档标题..."
              className="h-8 pl-8 pr-3 text-xs w-52 bg-muted/50 border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-8 px-2 text-xs border border-border rounded-md bg-background appearance-none"
          >
            <option value="all">全部状态</option>
            <option value="pending">排队中</option>
            <option value="parsing">解析中</option>
            <option value="ready">就绪</option>
            <option value="failed">失败</option>
          </select>

          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="h-8 px-2 text-xs border border-border rounded-md bg-background appearance-none"
          >
            <option value="all">全部来源</option>
            <option value="file">上传</option>
            <option value="manual">手动创建</option>
          </select>

          {/* 标签筛选 */}
          <div className="relative">
            <button
              onClick={() => setShowTagPanel(!showTagPanel)}
              className={cn(
                "h-8 px-2.5 text-xs border rounded-md flex items-center gap-1.5 transition-colors",
                tagFilter.length > 0 ? "border-accent/40 bg-accent/10 text-accent" : "border-border bg-background text-muted-foreground hover:text-foreground"
              )}
            >
              <TagIcon className="w-3.5 h-3.5" />
              标签
              {tagFilter.length > 0 && <span className="font-mono">({tagFilter.length})</span>}
              <ChevronDown className="w-3 h-3" />
            </button>
            {showTagPanel && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowTagPanel(false)} />
                <div className="absolute left-0 top-9 z-20 w-64 bg-card border border-border rounded-lg shadow-xl p-3">
                  <div className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-2">按标签筛选（并集）</div>
                  <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
                    {tags.map((t) => (
                      <button
                        key={t.id}
                        onClick={() =>
                          setTagFilter((prev) =>
                            prev.includes(t.id) ? prev.filter((x) => x !== t.id) : [...prev, t.id]
                          )
                        }
                        className={cn(
                          "text-[11px] px-2 py-1 rounded-full border transition-colors",
                          tagFilter.includes(t.id)
                            ? "bg-accent/10 border-accent/40 text-accent"
                            : "border-border text-muted-foreground hover:bg-muted"
                        )}
                        style={tagFilter.includes(t.id) ? { borderColor: t.color, color: t.color } : undefined}
                      >
                        {t.name}
                      </button>
                    ))}
                    {tags.length === 0 && (
                      <div className="text-[11px] text-muted-foreground w-full">暂无标签，可在下方创建</div>
                    )}
                  </div>
                  <div className="flex gap-1.5 mt-2">
                    <input
                      value={createTagName}
                      onChange={(e) => setCreateTagName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleCreateTag()}
                      placeholder="新标签名，回车创建"
                      className="flex-1 h-7 px-2 text-[11px] border border-border rounded focus:outline-none focus:ring-1 focus:ring-accent bg-background"
                    />
                    <button
                      onClick={handleCreateTag}
                      className="h-7 px-2 text-[11px] bg-primary text-primary-foreground rounded hover:bg-primary/90"
                    >
                      创建
                    </button>
                  </div>
                  {tagFilter.length > 0 && (
                    <button
                      onClick={() => setTagFilter([])}
                      className="mt-2 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      清除全部标签
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="flex rounded-md border border-border overflow-hidden">
              <button
                onClick={() => setViewMode("list")}
                className={cn("w-8 h-8 flex items-center justify-center transition-colors", viewMode === "list" ? "bg-muted" : "hover:bg-muted/50")}
                title="列表视图"
              >
                <List className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setViewMode("grid")}
                className={cn("w-8 h-8 flex items-center justify-center transition-colors", viewMode === "grid" ? "bg-muted" : "hover:bg-muted/50")}
                title="网格视图"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="relative">
              <button
                onClick={() => setShowUploadMenu(!showUploadMenu)}
                className="inline-flex items-center gap-1.5 h-8 px-3 bg-primary text-primary-foreground text-xs font-medium rounded-md hover:bg-primary/90 transition-colors"
              >
                <Upload className="w-3.5 h-3.5" />
                上传
                <ChevronDown className="w-3 h-3" />
              </button>
              {showUploadMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowUploadMenu(false)} />
                  <div className="absolute right-0 top-10 z-20 w-44 bg-card border border-border rounded-lg shadow-xl py-1 text-xs">
                    <button
                      onClick={() => { setShowUploadMenu(false); setUploadModal("file") }}
                      className="w-full px-3 py-2 text-left hover:bg-muted flex items-center gap-2"
                    >
                      <Upload className="w-3.5 h-3.5" />上传文件
                    </button>
                    <button
                      onClick={() => { setShowUploadMenu(false); setUploadModal("manual") }}
                      className="w-full px-3 py-2 text-left hover:bg-muted flex items-center gap-2"
                    >
                      <Edit3 className="w-3.5 h-3.5" />手动创建
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* 批量操作栏 */}
        {selectedDocs.length > 0 && (
          <div className="flex items-center gap-3 px-4 py-2 bg-accent/10 border-b border-accent/20 text-xs flex-shrink-0">
            <span className="font-medium text-accent">已选 {selectedDocs.length} 项</span>
            <button onClick={handleBatchDelete} className="flex items-center gap-1 hover:text-foreground text-muted-foreground">
              <Trash2 className="w-3.5 h-3.5" />删除
            </button>
            <button onClick={handleBatchReparse} className="flex items-center gap-1 hover:text-foreground text-muted-foreground">
              <RefreshCw className="w-3.5 h-3.5" />重新解析
            </button>
            <button onClick={() => setTagModal({ ids: selectedDocs })} className="flex items-center gap-1 hover:text-foreground text-muted-foreground">
              <TagIcon className="w-3.5 h-3.5" />打标签
            </button>
            <button onClick={() => setMoveModal({ ids: selectedDocs })} className="flex items-center gap-1 hover:text-foreground text-muted-foreground">
              <Folder className="w-3.5 h-3.5" />移动
            </button>
            <button className="ml-auto" onClick={() => setSelectedDocs([])}><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        {/* 文档列表 */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <DocSkeleton />
          ) : docs.length === 0 ? (
            <DocEmptyState onUpload={() => setUploadModal("file")} />
          ) : viewMode === "list" ? (
            <DocListView
              docs={docs}
              selectedDocs={selectedDocs}
              onToggle={toggleDoc}
              onPreview={setPreviewDoc}
              onReparse={handleReparseOne}
              onDelete={handleDeleteOne}
            />
          ) : (
            <DocGridView
              docs={docs}
              selectedDocs={selectedDocs}
              onToggle={toggleDoc}
              onPreview={setPreviewDoc}
            />
          )}
          {!loading && hasMore && (
            <div className="flex justify-center py-4">
              <button
                onClick={() => { const next = page + 1; setPage(next); void loadDocs(next) }}
                disabled={loadingMore}
                className="h-8 px-4 text-xs border border-border rounded-md hover:bg-muted transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {loadingMore && <Loader2 className="w-3 h-3 animate-spin" />}
                加载更多（{docs.length}/{total}）
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 预览抽屉 */}
      {previewDoc && (
        <DocPreviewDrawer
          kbId={kbId}
          doc={previewDoc}
          onClose={() => setPreviewDoc(null)}
          onDeleted={() => { setPreviewDoc(null); void loadDocs(1) }}
        />
      )}

      {/* 上传/导入/创建弹窗 */}
      {uploadModal === "file" && (
        <UploadFileModal kbId={kbId} onClose={() => setUploadModal(null)} onDone={() => { setUploadModal(null); void loadDocs(1) }} />
      )}
      {uploadModal === "manual" && (
        <ManualCreateModal kbId={kbId} onClose={() => setUploadModal(null)} onDone={() => { setUploadModal(null); void loadDocs(1) }} />
      )}
      {folderModal && (
        <FolderModal
          mode={folderModal.mode}
          folder={folderModal.folder}
          onClose={() => setFolderModal(null)}
          onSubmit={(name, parentId) => {
            if (folderModal.mode === "create") void handleCreateFolder(name, parentId)
            else if (folderModal.folder) void handleRenameFolder(folderModal.folder.id, name)
            setFolderModal(null)
          }}
          folders={flattenFolders}
        />
      )}
      {moveModal && (
        <MoveFolderModal
          folders={flattenFolders}
          onClose={() => setMoveModal(null)}
          onSubmit={(folderId) => void handleBatchMove(folderId)}
        />
      )}
      {tagModal && (
        <BatchTagModal
          tags={tags}
          currentIds={[]}
          onClose={() => setTagModal(null)}
          onSubmit={(ids) => void handleBatchTags(ids)}
        />
      )}
    </div>
  )
}

// ─── 文件夹树递归渲染 ─────────────────────────────────────────────────────────
function FolderTree({
  nodes, depth, selectedFolder, onSelect, onRename, onDelete, onDrop,
}: {
  nodes: FolderNode[]
  depth: number
  selectedFolder: string | null
  onSelect: (id: string | null) => void
  onRename: (f: FolderNode) => void
  onDelete: (id: string) => void
  onDrop: (folderId: string | null, e: React.DragEvent) => void
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  return (
    <>
      {nodes.map((node) => {
        const hasChildren = (node.children ?? []).length > 0
        const isOpen = open[node.id] ?? hasChildren
        return (
          <div key={node.id}>
            <div
              className={cn(
                "group flex items-center gap-1 px-2 py-1.5 rounded text-sm transition-colors cursor-pointer",
                selectedFolder === node.id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"
              )}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => onSelect(node.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onDrop(node.id, e)}
            >
              {hasChildren ? (
                <button
                  onClick={(e) => { e.stopPropagation(); setOpen((o) => ({ ...o, [node.id]: !isOpen })) }}
                  className="w-3.5 h-3.5 flex items-center justify-center text-muted-foreground"
                >
                  <ChevronRight className={cn("w-3 h-3 transition-transform", isOpen && "rotate-90")} />
                </button>
              ) : (
                <span className="w-3.5" />
              )}
              <Folder className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="truncate flex-1">{node.name}</span>
              <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
                <button
                  onClick={(e) => { e.stopPropagation(); onRename(node) }}
                  className="w-5 h-5 rounded flex items-center justify-center hover:bg-muted text-muted-foreground"
                  title="重命名"
                >
                  <Pencil className="w-2.5 h-2.5" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(node.id) }}
                  className="w-5 h-5 rounded flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-red-600"
                  title="删除"
                >
                  <Trash2 className="w-2.5 h-2.5" />
                </button>
              </div>
            </div>
            {hasChildren && isOpen && (
              <FolderTree
                nodes={node.children}
                depth={depth + 1}
                selectedFolder={selectedFolder}
                onSelect={onSelect}
                onRename={onRename}
                onDelete={onDelete}
                onDrop={onDrop}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

// ─── 文档列表/网格 ────────────────────────────────────────────────────────────
function DocIcon({ type, fileType }: { type: string; fileType: string }) {
  if (type === "manual") return <FileText className="w-4 h-4 text-violet-500" />
  if (type === "url") return <ExternalLink className="w-4 h-4 text-blue-500" />
  if (fileType && ["png", "jpg", "jpeg", "gif", "webp"].includes(fileType.toLowerCase()))
    return <FileImage className="w-4 h-4 text-green-500" />
  return <FileText className="w-4 h-4 text-muted-foreground" />
}

function StatusBadge({ status }: { status: string }) {
  const meta = KNOWLEDGE_STATUS_META[status] ?? { label: status, cls: "bg-muted text-muted-foreground border-border" }
  return (
    <span className={cn(
      "inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full border",
      meta.cls
    )}>
      {meta.loading && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
      {meta.label}
    </span>
  )
}

function DocListView({
  docs, selectedDocs, onToggle, onPreview, onReparse, onDelete,
}: {
  docs: Knowledge[]
  selectedDocs: string[]
  onToggle: (id: string) => void
  onPreview: (doc: Knowledge) => void
  onReparse: (id: string) => void
  onDelete: (id: string) => void
}) {
  const [allChecked, setAllChecked] = useState(false)
  useEffect(() => {
    setAllChecked(docs.length > 0 && docs.every((d) => selectedDocs.includes(d.id)))
  }, [docs, selectedDocs])

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
          <th className="w-8 px-4 py-2 text-left">
            <input
              type="checkbox"
              className="accent-primary"
              checked={allChecked}
              onChange={() => onToggle(allChecked ? "" : docs[0]?.id ?? "")}
            />
          </th>
          <th className="px-4 py-2 text-left">文件名</th>
          <th className="px-4 py-2 text-left hidden md:table-cell">来源</th>
          <th className="px-4 py-2 text-left hidden lg:table-cell">大小</th>
          <th className="px-4 py-2 text-left">状态</th>
          <th className="px-4 py-2 text-left hidden lg:table-cell">分块</th>
          <th className="px-4 py-2 text-left hidden lg:table-cell">消耗 Token</th>
          <th className="px-4 py-2 text-left hidden lg:table-cell">更新时间</th>
          <th className="px-4 py-2 text-right">操作</th>
        </tr>
      </thead>
      <tbody>
        {docs.map((doc) => (
          <tr
            key={doc.id}
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/plain", doc.id)}
            className={cn(
              "border-b border-border hover:bg-muted/30 transition-colors cursor-pointer",
              selectedDocs.includes(doc.id) && "bg-accent/5"
            )}
            onClick={() => onPreview(doc)}
          >
            <td className="px-4 py-2.5">
              <input
                type="checkbox"
                checked={selectedDocs.includes(doc.id)}
                onChange={(e) => { e.stopPropagation(); onToggle(doc.id) }}
                className="accent-primary"
              />
            </td>
            <td className="px-4 py-2.5">
              <div className="flex items-center gap-2">
                <DocIcon type={doc.type} fileType={doc.fileType} />
                <span className="font-medium text-sm truncate max-w-xs">{doc.title}</span>
              </div>
            </td>
            <td className="px-4 py-2.5 hidden md:table-cell text-xs text-muted-foreground">
              {KNOWLEDGE_TYPE_LABEL[doc.type] ?? doc.type}
              {doc.fileType && doc.type === "file" && (
                <span className="ml-1 font-mono uppercase text-[10px] opacity-60">{doc.fileType}</span>
              )}
            </td>
            <td className="px-4 py-2.5 hidden lg:table-cell font-mono text-xs text-muted-foreground">
              {formatFileSize(doc.fileSize)}
            </td>
            <td className="px-4 py-2.5"><StatusBadge status={doc.status} /></td>
            <td className="px-4 py-2.5 hidden lg:table-cell font-mono text-xs text-muted-foreground">{doc.chunkCount}</td>
            <td className="px-4 py-2.5 hidden lg:table-cell font-mono text-xs text-muted-foreground">
              {doc.tokenCost ? doc.tokenCost.toLocaleString("zh-CN") : "—"}
            </td>
            <td className="px-4 py-2.5 hidden lg:table-cell text-xs text-muted-foreground font-mono">
              {formatDateTime(doc.updatedAt)}
            </td>
            <td className="px-4 py-2.5 text-right">
              <div className="flex items-center gap-1 justify-end" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => onPreview(doc)}
                  className="inline-flex items-center gap-1 h-7 px-2 text-xs font-medium rounded-md border border-border text-foreground hover:bg-muted transition-colors"
                  title="预览（解析结果 / 原文）"
                >
                  <Eye className="w-3.5 h-3.5" />
                  预览
                </button>
                <button
                  onClick={() => onReparse(doc.id)}
                  disabled={doc.status === "parsing" || doc.status === "pending"}
                  className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40"
                  title="重新解析"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => onDelete(doc.id)}
                  className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-red-600 hover:bg-red-50 transition-colors"
                  title="删除"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function DocGridView({
  docs, selectedDocs, onToggle, onPreview,
}: {
  docs: Knowledge[]
  selectedDocs: string[]
  onToggle: (id: string) => void
  onPreview: (doc: Knowledge) => void
}) {
  return (
    <div className="grid grid-cols-3 gap-4 p-4">
      {docs.map((doc) => (
        <div
          key={doc.id}
          draggable
          onDragStart={(e) => e.dataTransfer.setData("text/plain", doc.id)}
          onClick={() => onPreview(doc)}
          className={cn(
            "bg-card border border-border rounded-lg p-4 cursor-pointer hover:border-foreground/20 hover:shadow-sm transition-all",
            selectedDocs.includes(doc.id) && "border-accent bg-accent/5"
          )}
        >
          <div className="flex items-start justify-between mb-3">
            <DocIcon type={doc.type} fileType={doc.fileType} />
            <input
              type="checkbox"
              checked={selectedDocs.includes(doc.id)}
              onChange={(e) => { e.stopPropagation(); onToggle(doc.id) }}
              className="accent-primary"
            />
          </div>
          <p className="text-xs font-medium leading-tight mb-2 line-clamp-2">{doc.title}</p>
          <div className="flex items-center justify-between">
            <StatusBadge status={doc.status} />
            <span className="font-mono text-[10px] text-muted-foreground">
              {doc.chunkCount} 分块
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function DocSkeleton() {
  return (
    <div className="divide-y divide-border">
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3.5 animate-pulse">
          <div className="w-4 h-4 rounded border border-border" />
          <div className="w-4 h-4 rounded bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-1/3 bg-muted rounded" />
            <div className="h-2 w-1/5 bg-muted/70 rounded" />
          </div>
          <div className="h-5 w-16 bg-muted rounded-full" />
          <div className="h-3 w-20 bg-muted rounded hidden lg:block" />
        </div>
      ))}
    </div>
  )
}

function DocEmptyState({ onUpload }: { onUpload: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full py-24 text-center">
      <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center mb-4">
        <FileText className="w-6 h-6 text-muted-foreground" />
      </div>
      <h3 className="text-sm font-semibold mb-1">还没有文档</h3>
      <p className="text-xs text-muted-foreground max-w-xs mb-6">
        上传 PDF、Word、图片或 Markdown 文件开始构建知识库；也可以手动创建
      </p>
      <button
        onClick={onUpload}
        className="inline-flex items-center gap-2 h-9 px-4 bg-primary text-primary-foreground text-sm font-medium rounded-md hover:bg-primary/90 transition-colors"
      >
        <Upload className="w-4 h-4" />
        上传文件
      </button>
    </div>
  )
}

// ─── 文档预览抽屉（Task 5.5） ────────────────────────────────────────────────
function DocPreviewDrawer({
  kbId, doc, onClose, onDeleted,
}: {
  kbId: string
  doc: Knowledge
  onClose: () => void
  onDeleted: () => void
}) {
  const [detail, setDetail] = useState<Knowledge | null>(null)
  const [stages, setStages] = useState<ParserStage[]>([])
  const [chunks, setChunks] = useState<Chunk[]>([])
  const [chunkTotal, setChunkTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [showTimeline, setShowTimeline] = useState(true)
  const [editingChunk, setEditingChunk] = useState<string | null>(null)
  const [editText, setEditText] = useState("")
  const [savingChunk, setSavingChunk] = useState(false)
  const [versionChunk, setVersionChunk] = useState<Chunk | null>(null)
  const [revisions, setRevisions] = useState<import("../../api/kb").ChunkRevision[]>([])
  const [diffTarget, setDiffTarget] = useState<{ old: string; new: string; revision: number } | null>(null)
  // 抽屉宽度（默认 1080，左边缘拖拽调整 720~1440）
  const [width, setWidth] = useState(1080)
  // 原文右栏宽度（百分比，分隔条拖拽调整 30%~70%）
  const [rightPct, setRightPct] = useState(46)
  const rightDrag = useRef<{ startX: number; startPct: number; baseW: number } | null>(null)
  const onRightDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    rightDrag.current = { startX: e.clientX, startPct: rightPct, baseW: width }
    document.body.style.userSelect = "none"
    document.body.style.cursor = "col-resize"
    const onMove = (ev: MouseEvent) => {
      const d = rightDrag.current
      if (!d) return
      // 跟手语义：分隔条随鼠标移动（左移 → 左栏变窄 → 右栏变宽）
      const pct = d.startPct + (d.startX - ev.clientX) / d.baseW * 100
      setRightPct(Math.min(70, Math.max(30, pct)))
    }
    const onUp = () => {
      rightDrag.current = null
      document.body.style.userSelect = ""
      document.body.style.cursor = ""
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: width }
    document.body.style.userSelect = "none"
    document.body.style.cursor = "col-resize"
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      setWidth(Math.min(1440, Math.max(720, d.startW + d.startX - ev.clientX)))
    }
    const onUp = () => {
      dragRef.current = null
      document.body.style.userSelect = ""
      document.body.style.cursor = ""
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  // 原文（右侧栏）：file 类型打开即加载原文件（fetch blob → blob URL 供 iframe/img）
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [originalErr, setOriginalErr] = useState("")
  useEffect(() => {
    if (!detail || detail.type !== "file") return
    let alive = true
    const token = getAccessToken()
    fetch(`${BASE_URL}/kbs/${kbId}/knowledge/${doc.id}/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (res) => {
        if (!res.ok) { if (alive) setOriginalErr(`原文件加载失败（${res.status}）`); return }
        const blob = await res.blob()
        if (!alive) return
        setOriginalUrl(URL.createObjectURL(blob))
        setOriginalErr("")
      })
      .catch(() => { if (alive) setOriginalErr("原文件加载失败，请稍后重试") })
    return () => { alive = false }
  }, [detail, kbId, doc.id])

  useEffect(() => () => { if (originalUrl) URL.revokeObjectURL(originalUrl) }, [originalUrl])

  // 打开即拉取详情 + 时间线 + 分块
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const [d, s, c] = await Promise.all([
          knowledgeApi.get(kbId, doc.id),
          knowledgeApi.stages(kbId, doc.id),
          chunkApi.list(kbId, doc.id, 1, 50),
        ])
        if (cancelled) return
        setDetail(d)
        setStages(s.stages ?? [])
        setChunks(c.items)
        setChunkTotal(c.total)
      } catch (err) {
        if (!cancelled) toast(err instanceof Error ? err.message : "加载预览失败", "error")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [kbId, doc.id])

  // 时间线合并：同阶段只显示最新状态一条（解析进行中 → 已完成流转，
  // 用户需求——不再同时出现「进度中」与「已完成」两个时间戳）
  const mergedStages = useMemo(() => {
    const map = new Map<string, import("../../api/kb").ParserStage>()
    for (const st of stages) map.set(st.stage, st) // 后者覆盖 = 取最新状态
    return [...map.values()]
  }, [stages])

  // 文本类内容可直接展示：manual 用 manualContent；file 用 parsedText
  const textContent = useMemo(() => {
    if (!detail) return null
    if (detail.type === "manual") return detail.manualContent || "（无正文）"
    if (detail.type === "url") return null
    if (detail.type === "file" && detail.parsedText) return detail.parsedText
    return null
  }, [detail])

  const isBinaryFile = detail?.type === "file" && !textContent && detail.status !== "pending"

  const openEdit = (chunk: Chunk) => {
    setEditingChunk(chunk.id)
    setEditText(chunk.content)
  }

  const saveChunk = async (chunkId: string) => {
    if (savingChunk) return
    setSavingChunk(true)
    try {
      const updated = await chunkApi.update(chunkId, editText)
      setChunks((prev) => prev.map((c) => (c.id === chunkId ? updated : c)))
      setEditingChunk(null)
      toast("分块已保存并重新向量化")
    } catch (err) {
      toast(err instanceof Error ? err.message : "保存失败", "error")
    } finally {
      setSavingChunk(false)
    }
  }

  const openVersions = async (chunk: Chunk) => {
    try {
      const res = await chunkApi.revisions(chunk.id)
      setRevisions(res)
      setVersionChunk(chunk)
    } catch (err) {
      toast(err instanceof Error ? err.message : "加载版本历史失败", "error")
    }
  }

  // 回滚：记录目标 chunkId 后展示新旧文本对比（diff 简化），确认后调用 revert
  const [diffTargetRevisionChunkId, setDiffTargetChunkId] = useState("")
  const openRevertConfirm = (chunk: Chunk, revision: number, oldContent: string) => {
    setDiffTargetChunkId(chunk.id)
    setDiffTarget({ old: oldContent, new: chunk.content, revision })
    setVersionChunk(null)
  }

  const doRevert = async () => {
    if (!diffTarget) return
    const chunkId = diffTargetRevisionChunkId
    try {
      const updated = await chunkApi.revert(chunkId, diffTarget.revision)
      setChunks((prev) => prev.map((c) => (c.id === chunkId ? updated : c)))
      setDiffTarget(null)
      setDiffTargetChunkId("")
      toast(`已回滚到版本 v${diffTarget.revision}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : "回滚失败", "error")
    }
  }

  const handleRegenerateSummary = async () => {
    try {
      await knowledgeApi.regenerateSummary(kbId, doc.id)
      toast("摘要已排队重新生成")
      setTimeout(async () => {
        try {
          const d = await knowledgeApi.get(kbId, doc.id)
          setDetail(d)
        } catch { /* 忽略轮询失败 */ }
      }, 1500)
    } catch (err) {
      toast(err instanceof Error ? err.message : "操作失败", "error")
    }
  }

  const handleDelete = async () => {
    try {
      await knowledgeApi.remove(kbId, doc.id)
      toast("文档已删除")
      onDeleted()
    } catch (err) {
      toast(err instanceof Error ? err.message : "删除失败", "error")
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div style={{ width }} className="relative z-50 flex h-full flex-col border-l border-border bg-card shadow-2xl">
        {/* 左边缘拖拽手柄：调整抽屉宽度 */}
        <div
          onMouseDown={onDragStart}
          className="absolute -left-1.5 top-0 bottom-0 w-3 cursor-col-resize hover:bg-primary/15 active:bg-primary/25 transition-colors z-20 flex items-center justify-center"
          title="拖拽调整宽度"
        >
          <div className="w-0.5 h-10 rounded bg-border/60" />
        </div>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <DocIcon type={doc.type} fileType={doc.fileType} />
            <h2 className="text-sm font-semibold truncate">{doc.title}</h2>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={handleDelete} className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-red-600 hover:bg-red-50 transition-colors" title="删除文档">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            <button onClick={onClose} className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex flex-1 min-h-0">
            {/* 左栏：解析结果（元数据 + 时间线 + 文本 + 分块） */}
            <div className="flex-1 overflow-y-auto min-w-0">
            {/* 元数据 */}
            <div className="px-5 py-4 border-b border-border space-y-2">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                <div className="text-muted-foreground">来源</div>
                <div className="text-foreground">{KNOWLEDGE_TYPE_LABEL[doc.type] ?? doc.type}</div>
                <div className="text-muted-foreground">文件类型</div>
                <div className="font-mono uppercase text-foreground">{doc.fileType || "—"}</div>
                <div className="text-muted-foreground">大小</div>
                <div className="font-mono text-foreground">{formatFileSize(doc.fileSize)}</div>
                <div className="text-muted-foreground">分块数</div>
                <div className="font-mono text-foreground">{chunkTotal}</div>
                <div className="text-muted-foreground">更新时间</div>
                <div className="font-mono text-foreground">{formatDateTime(detail?.updatedAt ?? doc.updatedAt)}</div>
                <div className="text-muted-foreground">状态</div>
                <div><StatusBadge status={detail?.status ?? doc.status} /></div>
              </div>
              {doc.type === "url" && detail?.sourceUrl && (
                <a
                  href={detail.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-xs text-blue-600 hover:underline truncate"
                >
                  <ExternalLink className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{detail.sourceUrl}</span>
                </a>
              )}
              {detail?.error && (
                <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                  解析错误：{detail.error}
                </div>
              )}
            </div>

            {/* 摘要 */}
            {detail?.summary && (
              <div className="px-5 py-4 border-b border-border">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">摘要</div>
                  <button
                    onClick={handleRegenerateSummary}
                    className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                  >
                    <RefreshCw className="w-3 h-3" />重新生成
                  </button>
                </div>
                <p className="text-xs leading-relaxed text-foreground/90">{detail.summary}</p>
              </div>
            )}

            {/* 解析时间线 */}
            <div className="px-5 py-3 border-b border-border">
              <button
                onClick={() => setShowTimeline(!showTimeline)}
                className="flex items-center gap-2 text-xs font-medium hover:text-foreground text-muted-foreground transition-colors w-full"
              >
                <Clock className="w-3.5 h-3.5" />
                解析时间线
                {showTimeline ? <ChevronUp className="w-3.5 h-3.5 ml-auto" /> : <ChevronDown className="w-3.5 h-3.5 ml-auto" />}
              </button>
              {showTimeline && (
                <div className="mt-3 space-y-2">
                  {stages.length === 0 && (
                    <div className="text-xs text-muted-foreground">暂无解析记录</div>
                  )}
                  {mergedStages.map((step, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <div className={cn(
                        "w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0",
                        step.status === "done" ? "bg-emerald-500 border-emerald-500" :
                        step.status === "failed" ? "bg-red-500 border-red-500" :
                        "bg-background border-border"
                      )}>
                        {step.status === "done" && <Check className="w-2.5 h-2.5 text-white" />}
                        {step.status === "failed" && <X className="w-2.5 h-2.5 text-white" />}
                      </div>
                      <div className="flex-1">
                        <div className="text-xs font-medium">
                          {PARSER_STAGE_LABEL[step.stage] ?? step.stage}
                          {step.status === "running" && <Loader2 className="w-2.5 h-2.5 animate-spin inline ml-1 text-amber-500" />}
                        </div>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          {formatDateTime(step.at)}
                          {step.detail && ` · ${step.detail}`}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 内容预览 / 分块（左栏：解析结果） */}
            <div className="px-5 py-4">
              {/* 文本内容直出（manual / 已解析文本） */}
              {textContent && (
                <div className="mb-5">
                  <div className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-2">
                    {doc.type === "manual" ? "正文内容" : "解析文本"}
                  </div>
                  <div className="text-xs leading-relaxed text-foreground/90 font-mono whitespace-pre-wrap bg-muted/30 border border-border rounded-md p-3 max-h-72 overflow-y-auto">
                    {textContent}
                  </div>
                </div>
              )}

              {/* 二进制文件：后端无预览/下载端点，提示登记 */}
              {isBinaryFile && (
                <div className="mb-5 text-xs text-muted-foreground bg-muted/30 border border-border rounded-md p-3 flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <div>
                    该文件为二进制格式（{doc.fileType || "未知"}），后端暂未提供预览/下载端点（登记），
                    无法在线预览。已解析的分块文本可在下方查看。
                  </div>
                </div>
              )}
              {doc.type === "url" && !textContent && (
                <div className="mb-5 text-xs text-muted-foreground bg-muted/30 border border-border rounded-md p-3 flex items-start gap-2">
                  <ExternalLink className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <div>URL 来源文档为历史存量（正文已在解析时抓取）；新文档请用上传或手动创建。</div>
                </div>
              )}

              {/* 分块列表 */}
              <div className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                分块列表
                <span className="font-mono text-[10px] opacity-60">({chunkTotal})</span>
              </div>
              {chunks.length === 0 ? (
                <div className="text-xs text-muted-foreground py-4 text-center">
                  {doc.status === "ready" ? "暂无分块（文本为空？）" : "文档尚未解析完成，分块生成后显示"}
                </div>
              ) : (
                <div className="space-y-3">
                  {chunks.map((chunk) => (
                    <div key={chunk.id} className="border border-border rounded-md overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/50 border-b border-border">
                        <span className="text-[10px] font-mono text-muted-foreground">
                          chunk #{chunk.chunkIndex + 1}
                          <span className="ml-2">v{chunk.contentRevision}</span>
                          <span className="ml-2">({CHUNK_INDEX_META[chunk.indexStatus] ?? chunk.indexStatus})</span>
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => openEdit(chunk)}
                            className="w-5 h-5 rounded flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground"
                            title="编辑"
                          >
                            <Edit3 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => openVersions(chunk)}
                            className="w-5 h-5 rounded flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground"
                            title="版本历史"
                          >
                            <History className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      {editingChunk === chunk.id ? (
                        <div className="p-3">
                          <textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            rows={4}
                            className="w-full text-xs border border-border rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent bg-background resize-none font-mono"
                          />
                          <div className="flex justify-end gap-2 mt-2">
                            <button onClick={() => setEditingChunk(null)} className="h-7 px-2.5 text-xs border border-border rounded hover:bg-muted">取消</button>
                            <button
                              onClick={() => saveChunk(chunk.id)}
                              disabled={savingChunk}
                              className="h-7 px-2.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1"
                            >
                              {savingChunk && <Loader2 className="w-3 h-3 animate-spin" />}
                              保存并重新向量化
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="px-3 py-2.5 text-xs leading-relaxed text-foreground/90 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
                          {chunk.content}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            </div>

          {/* 右栏：原文（file 类型；PDF 用自研阅读器、图片内嵌、md/txt 直出） */}
          {detail?.type === "file" && (
            <>
              {/* 左右分栏分隔条（拖拽调整原文栏宽度） */}
              <div
                onMouseDown={onRightDragStart}
                className="w-2 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors flex-shrink-0 border-l border-border flex items-center justify-center"
                title="拖拽调整原文栏宽度"
              >
                <div className="w-px h-10 bg-border/60" />
              </div>
              <div style={{ width: `${rightPct}%` }} className="min-w-[300px] overflow-y-auto flex-shrink-0 bg-card h-full">
                <div className="px-5 py-4 h-full">
                  <div className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-2">
                    原文 · {doc.fileType || "未知格式"}
                  </div>
                  {originalErr ? (
                    <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md p-3">{originalErr}</div>
                  ) : originalUrl ? (
                    <div className="rounded-md overflow-hidden border border-border bg-muted/20 h-[calc(100vh-180px)]">
                      {(doc.fileType === "pdf") ? (
                        <PdfReader url={originalUrl} />
                      ) : (doc.fileType === "png" || doc.fileType === "jpg" || doc.fileType === "jpeg" || doc.fileType === "webp" || doc.fileType === "gif") ? (
                        <img src={originalUrl} alt="原图" className="w-full object-contain max-h-[calc(100vh-140px)]" />
                      ) : (doc.fileType === "md" || doc.fileType === "markdown" || doc.fileType === "txt") ? (
                        <div className="text-xs leading-relaxed text-foreground/90 font-mono whitespace-pre-wrap bg-muted/30 border border-border rounded-md p-3 max-h-[calc(100vh-140px)] overflow-y-auto">
                          <OriginalTextPreview url={originalUrl} />
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground p-4">
                          {doc.fileType?.toUpperCase() || "二进制"} 文件不支持内嵌预览（可下载到本地查看）
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground py-6 text-center">加载中…</div>
                  )}
                </div>
              </div>
            </>
          )}
          </div>
        )}

        {/* 版本历史 overlay */}
        {versionChunk && (
          <div className="absolute inset-0 bg-card z-10 flex flex-col">
            <div className="flex items-center gap-2 px-5 py-4 border-b border-border">
              <button onClick={() => setVersionChunk(null)} className="text-muted-foreground hover:text-foreground">
                <ChevronRight className="w-4 h-4 rotate-180" />
              </button>
              <h3 className="text-sm font-semibold">版本历史</h3>
              <span className="text-[10px] text-muted-foreground font-mono ml-auto">当前 v{versionChunk.contentRevision}</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {revisions.length === 0 && (
                <div className="text-xs text-muted-foreground text-center py-8">暂无版本记录（编辑分块后生成）</div>
              )}
              {revisions.map((v) => (
                <div key={v.id} className="flex items-start justify-between p-3 rounded-md border border-border hover:bg-muted/50 transition-colors">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold font-mono">v{v.revision}</div>
                    <div className="text-[11px] text-muted-foreground font-mono mt-0.5">{formatDateTime(v.createdAt)}</div>
                    <div className="text-[11px] text-muted-foreground mt-1 truncate max-w-[260px]">{v.content.slice(0, 60)}</div>
                  </div>
                  <button
                    onClick={() => openRevertConfirm(versionChunk, v.revision, v.content)}
                    disabled={v.revision === versionChunk.contentRevision}
                    className="h-6 px-2 text-[10px] border border-border rounded hover:bg-muted flex items-center gap-1 disabled:opacity-40 flex-shrink-0"
                  >
                    <RotateCcw className="w-2.5 h-2.5" />回滚
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 回滚确认（diff 简化：并排新旧文本） */}
        {diffTarget && (
          <div className="absolute inset-0 bg-card z-10 flex flex-col">
            <div className="flex items-center gap-2 px-5 py-4 border-b border-border">
              <button onClick={() => setDiffTarget(null)} className="text-muted-foreground hover:text-foreground">
                <X className="w-4 h-4" />
              </button>
              <h3 className="text-sm font-semibold">回滚确认 · v{diffTarget.revision}</h3>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <p className="text-xs text-muted-foreground mb-3">
                回滚将创建新版本（v{diffTarget.revision} 的内容），当前内容保留在历史中。新旧对比：
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[11px] font-bold text-emerald-600 mb-1.5">目标版本（v{diffTarget.revision}）</div>
                  <div className="text-xs font-mono whitespace-pre-wrap bg-emerald-50 border border-emerald-100 rounded-md p-3 max-h-64 overflow-y-auto">
                    {diffTarget.old}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-bold text-muted-foreground mb-1.5">当前内容</div>
                  <div className="text-xs font-mono whitespace-pre-wrap bg-muted/30 border border-border rounded-md p-3 max-h-64 overflow-y-auto">
                    {diffTarget.new}
                  </div>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
              <button onClick={() => setDiffTarget(null)} className="h-8 px-4 text-xs border border-border rounded hover:bg-muted">取消</button>
              <button onClick={() => doRevert()} className="h-8 px-4 text-xs bg-accent text-accent-foreground rounded hover:bg-accent/90">
                确认回滚
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── 原文文本预览（md/txt：blob URL → 文本直出） ─────────────────────────────
function OriginalTextPreview({ url }: { url: string }) {
  const [text, setText] = useState("")
  useEffect(() => {
    let alive = true
    fetch(url).then((r) => r.text()).then((t) => { if (alive) setText(t) }).catch(() => {})
    return () => { alive = false }
  }, [url])
  return <span className="whitespace-pre-wrap">{text || "加载中…"}</span>
}

// ─── 上传 / 导入 / 手动创建 弹窗 ─────────────────────────────────────────────
function UploadFileModal({ kbId, onClose, onDone }: { kbId: string; onClose: () => void; onDone: () => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState(0)
  const [uploading, setUploading] = useState(false)
  // 文档级分块配置（覆盖 KB 级；缺省跟随知识库）
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [docStrategy, setDocStrategy] = useState("")
  const [docChunkSize, setDocChunkSize] = useState("")
  const [docChunkOverlap, setDocChunkOverlap] = useState("")
  // 文档级解析引擎（参考 WeKnora 引擎注册表；留空自动：复杂格式默认 mineru）
  const [docEngine, setDocEngine] = useState("")

  const doUpload = async () => {
    if (!file || uploading) return
    setUploading(true)
    try {
      // 文档级分块配置：仅填写时携带（覆盖 KB 级；空 → 跟随 KB）
      let docCfgJson = ""
      if (showAdvanced && (docStrategy || docChunkSize || docChunkOverlap)) {
        docCfgJson = JSON.stringify({
          ...(docStrategy === "recursive" || docStrategy === "header" ? { strategy: docStrategy } : {}),
          ...(docChunkSize ? { chunkSize: Number(docChunkSize) } : {}),
          ...(docChunkOverlap ? { chunkOverlap: Number(docChunkOverlap) } : {}),
        })
      }
      await uploadWithProgress(file, kbId, setProgress, docCfgJson, docEngine)
      toast("上传成功，已进入解析队列")
      onDone()
    } catch (err) {
      toast(err instanceof Error ? err.message : "上传失败", "error")
      setUploading(false)
    }
  }

  return (
    <ModalShell title="上传文件" onClose={onClose}>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <div
        onClick={() => fileInputRef.current?.click()}
        className="border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
      >
        {file ? (
          <div className="text-sm">
            <div className="font-medium">{file.name}</div>
            <div className="text-xs text-muted-foreground mt-1">{formatFileSize(file.size)}</div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            <Upload className="w-6 h-6 mx-auto mb-2 text-muted-foreground" />
            点击选择文件（PDF / Word / Markdown / 图片，≤50MB）
          </div>
        )}
      </div>
      {uploading && (
        <div className="mt-3">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
          <div className="text-[11px] text-muted-foreground font-mono mt-1 text-right">{progress}%</div>
        </div>
      )}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="h-9 px-4 text-sm border border-border rounded-md hover:bg-muted transition-colors">取消</button>
        <button
          onClick={doUpload}
          disabled={!file || uploading}
          className="h-9 px-4 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {uploading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          开始上传
        </button>
      </div>

      {/* 文档级分块配置（可选，覆盖知识库） */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
      >
        <ChevronDown className={`w-3 h-3 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
        {showAdvanced ? "收起高级配置" : "高级：文档分块配置（覆盖知识库）"}
      </button>
      {showAdvanced && (
        <div className="mt-2 space-y-2 border border-border rounded-md p-3 bg-muted/20">
          <p className="text-[11px] text-muted-foreground">留空项跟随知识库分块配置；填写项在解析时覆盖。</p>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={docEngine}
              onChange={(e) => setDocEngine(e.target.value)}
              className="h-8 px-2 text-xs border border-border rounded bg-background"
            >
              <option value="">解析引擎（自动）</option>
              <option value="mineru">MinerU（PDF/Word，版式还原）</option>
            </select>
            <select
              value={docStrategy}
              onChange={(e) => setDocStrategy(e.target.value)}
              className="h-8 px-2 text-xs border border-border rounded bg-background"
            >
              <option value="">策略（默认）</option>
              <option value="token">固定大小</option>
              <option value="recursive">递归分块</option>
              <option value="header">标题分块</option>
            </select>
            <input
              type="number" value={docChunkSize}
              onChange={(e) => setDocChunkSize(e.target.value)}
              placeholder="大小（默认）"
              className="h-8 px-2 text-xs border border-border rounded bg-background font-mono"
            />
            <input
              type="number" value={docChunkOverlap}
              onChange={(e) => setDocChunkOverlap(e.target.value)}
              placeholder="重叠（默认）"
              className="h-8 px-2 text-xs border border-border rounded bg-background font-mono"
            />
          </div>
        </div>
      )}
    </ModalShell>
  )
}

/** 文件上传：XHR 简单进度（fetch 无上传进度事件；后端 POST /kbs/:kbId/file multipart） */
function uploadWithProgress(
  file: File,
  kbId: string,
  onProgress: (pct: number) => void,
  chunkingConfigJson = "",
  parserEngine = "",
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const formData = new FormData()
    formData.append("file", file)
    if (chunkingConfigJson) formData.append("chunkingConfig", chunkingConfigJson)
    if (parserEngine) formData.append("parserEngine", parserEngine)
    xhr.open("POST", `${BASE_URL}/kbs/${kbId}/file`)
    const token = getAccessToken()
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      let data: unknown = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch { /* 非 JSON 响应 */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data)
      } else {
        const msg =
          data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string"
            ? (data as { message: string }).message
            : `上传失败（HTTP ${xhr.status}）`
        reject(new ApiError(msg, xhr.status))
      }
    }
    xhr.onerror = () => reject(new ApiError("网络错误，上传失败", 0))
    xhr.send(formData)
  })
}

function ManualCreateModal({ kbId, onClose, onDone }: { kbId: string; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (submitting || !title || !content) return
    setSubmitting(true)
    try {
      await knowledgeApi.createManual(kbId, title, content)
      toast("文档已创建")
      onDone()
    } catch (err) {
      toast(err instanceof Error ? err.message : "创建失败", "error")
      setSubmitting(false)
    }
  }

  return (
    <ModalShell title="手动创建文档" onClose={onClose}>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium">标题</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="文档标题"
            className="w-full h-9 px-3 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent bg-background"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium">正文（Markdown 支持）</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            placeholder="在此输入文档内容…"
            className="w-full px-3 py-2 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent bg-background resize-none"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="h-9 px-4 text-sm border border-border rounded-md hover:bg-muted transition-colors">取消</button>
        <button
          onClick={submit}
          disabled={!title || !content || submitting}
          className="h-9 px-4 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          创建
        </button>
      </div>
    </ModalShell>
  )
}

function FolderModal({
  mode, folder, folders, onClose, onSubmit,
}: {
  mode: "create" | "rename"
  folder?: FolderNode
  folders: FolderNode[]
  onClose: () => void
  onSubmit: (name: string, parentId?: string) => void
}) {
  const [name, setName] = useState(folder?.name ?? "")
  const [parentId, setParentId] = useState("")
  return (
    <ModalShell title={mode === "create" ? "新建文件夹" : "重命名文件夹"} onClose={onClose}>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium">名称</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="文件夹名称"
            autoFocus
            className="w-full h-9 px-3 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent bg-background"
          />
        </div>
        {mode === "create" && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium">父级（可选，缺省为根目录）</label>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="w-full h-9 px-2 text-sm border border-border rounded-md bg-background appearance-none"
            >
              <option value="">根目录</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="h-9 px-4 text-sm border border-border rounded-md hover:bg-muted transition-colors">取消</button>
        <button
          onClick={() => onSubmit(name.trim(), parentId || undefined)}
          disabled={!name.trim()}
          className="h-9 px-4 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          确定
        </button>
      </div>
    </ModalShell>
  )
}

function MoveFolderModal({ folders, onClose, onSubmit }: {
  folders: FolderNode[]
  onClose: () => void
  onSubmit: (folderId: string | null) => void
}) {
  const [folderId, setFolderId] = useState("")
  return (
    <ModalShell title="移动到文件夹" onClose={onClose}>
      <p className="text-xs text-muted-foreground mb-3">选择目标文件夹；留空 = 移回根目录。也可直接拖拽文档行到左侧文件夹树。</p>
      <select
        value={folderId}
        onChange={(e) => setFolderId(e.target.value)}
        className="w-full h-9 px-2 text-sm border border-border rounded-md bg-background appearance-none"
      >
        <option value="">根目录</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>{f.name}</option>
        ))}
      </select>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="h-9 px-4 text-sm border border-border rounded-md hover:bg-muted transition-colors">取消</button>
        <button onClick={() => onSubmit(folderId || null)} className="h-9 px-4 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors">
          移动
        </button>
      </div>
    </ModalShell>
  )
}

function BatchTagModal({ tags, onClose, onSubmit }: {
  tags: Tag[]
  currentIds: string[]
  onClose: () => void
  onSubmit: (tagIds: string[]) => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  return (
    <ModalShell title="批量打标签" onClose={onClose}>
      <p className="text-xs text-muted-foreground mb-3">勾选标签（全量替换：未勾选 = 清除文档标签）</p>
      <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto">
        {tags.length === 0 && <div className="text-xs text-muted-foreground">暂无标签，请先在筛选面板创建</div>}
        {tags.map((t) => (
          <button
            key={t.id}
            onClick={() =>
              setSelected((prev) => (prev.includes(t.id) ? prev.filter((x) => x !== t.id) : [...prev, t.id]))
            }
            className={cn(
              "text-[11px] px-2 py-1 rounded-full border transition-colors",
              selected.includes(t.id) ? "bg-accent/10 border-accent/40 text-accent" : "border-border text-muted-foreground hover:bg-muted"
            )}
          >
            {t.name}
          </button>
        ))}
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="h-9 px-4 text-sm border border-border rounded-md hover:bg-muted transition-colors">取消</button>
        <button onClick={() => onSubmit(selected)} className="h-9 px-4 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors">
          确定
        </button>
      </div>
    </ModalShell>
  )
}

/** 通用弹窗壳 */
function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-[480px] p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ─── KB 设置（基本信息 → PUT /kbs/:id） ─────────────────────────────────────
type SettingsTabKey = "info" | "chunking" | "retrieval" | "shares"
const SETTINGS_TABS = (kb: KnowledgeBase): { key: SettingsTabKey; label: string }[] => [
  { key: "info", label: "基本信息" },
  ...(kb.myPermission === "full"
    ? [
        { key: "chunking" as SettingsTabKey, label: "分块配置" },
        { key: "retrieval" as SettingsTabKey, label: "检索配置" },
        { key: "shares" as SettingsTabKey, label: "共享管理" },
      ]
    : []),
]

function KbSettingsModal({ kb, initialTab, onClose }: { kb: KnowledgeBase; initialTab?: SettingsTabKey; onClose: () => void }) {
  const [name, setName] = useState(kb.name)
  const [description, setDescription] = useState(kb.description)
  // 分块配置（chunkingConfig：chunkSize/chunkOverlap/separators——对应后端
  // ChunkingConfig；解析时消费，修改后已有文档需重新解析生效）
  const cfg = kb.chunkingConfig as { strategy?: string; chunkSize?: number; chunkOverlap?: number; separators?: string[] }
  const [chunkStrategy, setChunkStrategy] = useState<string>(cfg.strategy === "recursive" || cfg.strategy === "header" ? cfg.strategy : "token")
  const [chunkSize, setChunkSize] = useState(String(cfg.chunkSize ?? 800))
  const [chunkOverlap, setChunkOverlap] = useState(String(cfg.chunkOverlap ?? 100))
  const [separators, setSeparators] = useState((cfg.separators ?? ["\n\n", "\n", "。", "！", "？", ".", " ", ""]).join(","))
  // 检索配置（参考 WeKnora RetrievalConfig：RRF 权重 + 向量阈值）
  const rcfg = kb.retrievalConfig as { vectorWeight?: number; keywordWeight?: number; graphWeight?: number; k?: number; vectorThreshold?: number }
  const [vecW, setVecW] = useState(String(rcfg.vectorWeight ?? 0.5))
  const [kwW, setKwW] = useState(String(rcfg.keywordWeight ?? 0.3))
  const [graphW, setGraphW] = useState(String(rcfg.graphWeight ?? 0.6))
  const [rrfK, setRrfK] = useState(String(rcfg.k ?? 60))
  const [vecThr, setVecThr] = useState(String(rcfg.vectorThreshold ?? 0.05))
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState<SettingsTabKey>(initialTab ?? "info")

  const save = async () => {
    if (saving || !name.trim()) return
    setSaving(true)
    try {
      await kbApi.getKb(kb.id) // 预热：详情路由权限（无实际副作用）
      const payload: Record<string, unknown> = { name: name.trim(), description: description.trim() }
      if (activeTab === "chunking") {
        payload.chunkingConfig = {
          strategy: chunkStrategy === "recursive" || chunkStrategy === "header" ? chunkStrategy : "token",
          chunkSize: Number(chunkSize) || 800,
          chunkOverlap: Math.min(Number(chunkOverlap) || 100, Number(chunkSize) || 800),
          separators: separators.split(",").map((x) => x.trim()).filter(Boolean),
        }
      }
      if (activeTab === "retrieval") {
        payload.retrievalConfig = {
          vectorWeight: Math.max(0, Number(vecW) || 0.5),
          keywordWeight: Math.max(0, Number(kwW) || 0.3),
          graphWeight: Math.max(0, Number(graphW) || 0.6),
          k: Math.max(1, Number(rrfK) || 60),
          vectorThreshold: Math.max(0, Number(vecThr) || 0.05),
        }
      }
      await api.put(`/kbs/${kb.id}`, payload)
      toast("已保存")
      onClose()
    } catch (err) {
      toast(err instanceof Error ? err.message : "保存失败", "error")
      setSaving(false)
    }
  }

  return (
    <ModalShell title={`知识库设置 · ${kb.name}`} onClose={onClose}>
      {/* 设置页签：基本信息 / 共享管理（成员管理仅 KB Owner/系统 super 可见，
      普通成员 view/edit/admin 不展示该入口——用户需求，避免点击后 403） */}
      <div className="flex gap-0 border-b border-border -mx-5 px-5 mb-4">
        {SETTINGS_TABS(kb).map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "px-3 py-2 text-sm font-medium border-b-2 transition-colors",
              activeTab === tab.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "info" && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">名称</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full h-9 px-3 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent bg-background"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">描述</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent bg-background resize-none"
            />
          </div>
        </div>
      )}

      {activeTab === "chunking" && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            分块配置在文档解析时生效——修改后<b>已有文档需重新解析</b>（文档操作 → 重新解析）才会按新配置分块。
          </p>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">分块策略</label>
            <select
              value={chunkStrategy}
              onChange={(e) => setChunkStrategy(e.target.value)}
              className="w-full h-9 px-3 text-sm border border-border rounded-md bg-background"
            >
              <option value="token">固定大小分块（窗口 + 分隔符边界）</option>
              <option value="recursive">递归分块（多级分隔符递归降级）</option>
              <option value="header">标题分块（Markdown 标题分节）</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">分块大小</label>
              <input
                type="number" value={chunkSize}
                onChange={(e) => setChunkSize(e.target.value)}
                className="w-full h-9 px-3 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent bg-background font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">重叠 (tokens)</label>
              <input
                type="number" value={chunkOverlap}
                onChange={(e) => setChunkOverlap(e.target.value)}
                className="w-full h-9 px-3 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent bg-background font-mono"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">分隔符（逗号分隔）</label>
            <input
              value={separators}
              onChange={(e) => setSeparators(e.target.value)}
              placeholder="\n\n,\n,。，！？.空格"
              className="w-full h-9 px-3 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent bg-background font-mono"
            />
          </div>
        </div>
      )}

      {activeTab === "retrieval" && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            检索配置影响问答检索的召回与排序（参考 WeKnora RetrievalConfig）。
            权重为 RRF 融合各路的贡献（图谱实体命中默认最强）；向量阈值过滤低相关结果。
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">向量权重</label>
              <input type="number" step="0.1" value={vecW} onChange={(e) => setVecW(e.target.value)} className="w-full h-9 px-3 text-sm border border-border rounded-md bg-background font-mono" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">关键词权重</label>
              <input type="number" step="0.1" value={kwW} onChange={(e) => setKwW(e.target.value)} className="w-full h-9 px-3 text-sm border border-border rounded-md bg-background font-mono" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">图谱权重</label>
              <input type="number" step="0.1" value={graphW} onChange={(e) => setGraphW(e.target.value)} className="w-full h-9 px-3 text-sm border border-border rounded-md bg-background font-mono" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">RRF k（平滑常数）</label>
              <input type="number" value={rrfK} onChange={(e) => setRrfK(e.target.value)} className="w-full h-9 px-3 text-sm border border-border rounded-md bg-background font-mono" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">向量相似度阈值</label>
              <input type="number" step="0.01" value={vecThr} onChange={(e) => setVecThr(e.target.value)} className="w-full h-9 px-3 text-sm border border-border rounded-md bg-background font-mono" />
            </div>
          </div>
        </div>
      )}

      {activeTab === "shares" && <KbSharesPanel kbId={kb.id} />}

      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="h-9 px-4 text-sm border border-border rounded-md hover:bg-muted transition-colors">取消</button>
        <button
          onClick={save}
          disabled={saving || !name.trim() || activeTab === "shares"}
          className="h-9 px-4 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          保存
        </button>
      </div>
    </ModalShell>
  )
}

function KbSharesPanel({ kbId }: { kbId: string }) {
  const [shares, setShares] = useState<KbShare[]>([])
  const [loading, setLoading] = useState(true)
  const [inviteEmail, setInviteEmail] = useState("")
  const [permission, setPermission] = useState<"view" | "edit" | "admin">("view")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setShares(await shareApi.list(kbId))
    } catch (err) {
      toast(err instanceof Error ? err.message : "加载共享失败", "error")
    } finally {
      setLoading(false)
    }
  }, [kbId])

  useEffect(() => { void load() }, [load])

  const handleAdd = async () => {
    if (busy || !inviteEmail.trim()) return
    setBusy(true)
    try {
      await shareApi.create(kbId, { email: inviteEmail.trim() }, permission)
      toast("已邀请该成员")
      setInviteEmail("")
      void load()
    } catch (err) {
      toast(err instanceof Error ? err.message : "共享失败", "error")
    } finally {
      setBusy(false)
    }
  }

  const handlePermission = async (shareId: string, perm: "view" | "edit" | "admin") => {
    try {
      await shareApi.update(kbId, shareId, perm)
      void load()
    } catch (err) {
      toast(err instanceof Error ? err.message : "更新失败", "error")
    }
  }

  const handleRemove = async (shareId: string) => {
    if (!window.confirm("确定移除该成员对该知识库的访问？")) return
    try {
      await shareApi.remove(kbId, shareId)
      toast("已移除")
      void load()
    } catch (err) {
      toast(err instanceof Error ? err.message : "移除失败", "error")
    }
  }

  if (loading) {
    return <div className="flex justify-center py-8"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">只有被邀请（共享）的人才能查看此知识库；成员管理仅创建者可操作。</p>

      {/* 新增共享：按邮箱邀请成员 */}
      <div className="flex gap-2">
        <input
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
          placeholder="输入成员邮箱（需已注册）"
          className="flex-1 h-8 px-2 text-xs border border-border rounded bg-background"
        />
        <select
          value={permission}
          onChange={(e) => setPermission(e.target.value as "view" | "edit" | "admin")}
          className="h-8 px-2 text-xs border border-border rounded bg-background"
        >
          <option value="view">查看</option>
          <option value="edit">编辑</option>
          <option value="admin">管理员</option>
        </select>
        <button
          onClick={() => void handleAdd()}
          disabled={!inviteEmail.trim() || busy}
          className="h-8 px-3 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-40 flex items-center gap-1"
        >
          <Plus className="w-3 h-3" />添加
        </button>
      </div>

      {/* 共享列表 */}
      <div className="border border-border rounded-md divide-y divide-border overflow-hidden">
        {shares.length === 0 ? (
          <div className="text-xs text-muted-foreground py-6 text-center">暂未邀请任何成员</div>
        ) : shares.map(s => (
          <div key={s.id} className="flex items-center gap-3 px-3 py-2.5">
            <UserIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{s.userName ?? "成员"}</div>
              <div className="text-[10px] text-muted-foreground font-mono">{new Date(s.createdAt).toLocaleDateString("zh-CN")}</div>
            </div>
            <select
              value={s.permission}
              onChange={(e) => void handlePermission(s.id, e.target.value as "view" | "edit" | "admin")}
              className="h-7 px-2 text-xs border border-border rounded bg-background"
            >
              <option value="view">查看</option>
              <option value="edit">编辑</option>
              <option value="admin">管理员</option>
            </select>
            <button
              onClick={() => void handleRemove(s.id)}
              className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-red-600 hover:bg-red-50 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

