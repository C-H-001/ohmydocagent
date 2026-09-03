// 知识库列表（frontend/src/views/kb/KnowledgeBasesView.tsx）
// Task 5.3：真实 API 对接——
// - 数据源 GET /kbs?view=all|mine|favorite|recent&page=&pageSize=（项含
//   pinned/favorite/docCount/chunkCount）
// - 视图 tabs 切换 → 重新拉取对应 view；搜索为前端过滤（后端列表无 keyword
//   参数，登记：如需服务端搜索可后续在 ListKbDto 增加 keyword）
// - 卡片操作：收藏 PUT :id/favorite、置顶 PUT :id/pin、复制 POST :id/duplicate、
//   删除 DELETE :id（确认弹窗）
// - 新建向导 5 步 → POST /kbs（name/description/chunkingConfig/extractConfig）
// - 进入详情跳 /kb/:id

import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  Plus, Star, MoreHorizontal, Network, FileText,
  Bookmark, Copy, Settings, Trash2, ChevronRight, X,
  Check, Loader2, BookOpen, Cpu, Sliders, GitBranch, Search, Pin
} from "lucide-react"
import { cn, toast } from "../../components/ui"
import { kbApi, type KbListItem } from "../../api/kb"
import { formatDateTime } from "../../utils/format"
import { useAuth } from "../../store/auth"

type FilterTab = "all" | "mine" | "favorite" | "recent"
type WizardStep = 1 | 2 | 3 | 4 | 5

const TAB_LABELS: Record<FilterTab, string> = {
  all: "全部",
  mine: "我的",
  favorite: "收藏",
  recent: "最近",
}

// ─── Wizard 步骤定义（复用原型 UI） ─────────────────────────────────────────
const WIZARD_STEPS = [
  { step: 1, label: "基本信息", icon: <BookOpen className="w-4 h-4" /> },
  { step: 2, label: "索引策略", icon: <Network className="w-4 h-4" /> },
  { step: 3, label: "模型配置", icon: <Cpu className="w-4 h-4" /> },
  { step: 4, label: "分块配置", icon: <Sliders className="w-4 h-4" /> },
  { step: 5, label: "解析引擎", icon: <GitBranch className="w-4 h-4" /> },
]

export default function KnowledgeBasesView() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [filter, setFilter] = useState<FilterTab>("all")
  const [search, setSearch] = useState("")
  const [kbList, setKbList] = useState<KbListItem[]>([])
  const [total, setTotal] = useState(0)
  // 各视图计数（后端一次返回：全部/我的/收藏/最近——避免点击切换时跳动/近似不准）
  const [kbCounts, setKbCounts] = useState<{ all: number; mine: number; favorite: number; recent: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [showWizard, setShowWizard] = useState(false)
  const [wizardStep, setWizardStep] = useState<WizardStep>(1)
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const [wizardForm, setWizardForm] = useState({
    name: "", description: "",
    vectorSearch: true, graphExtract: false,
    embeddingModel: "text-embedding-3-large", summaryModel: "gpt-4o-mini",
    chunkSize: "512", overlap: "64", chunkStrategy: "token",
    parserPDF: "mineru", parserWord: "mineru", parserImage: "mineru", parserMd: "native",
  })

  // 拉取列表（view 切换触发；搜索为前端过滤）
  const loadKbs = useCallback(async (view: FilterTab) => {
    setLoading(true)
    try {
      const res = await kbApi.listKbs(view, 1, 100)
      setKbList(res.items)
      setTotal(res.total)
      if (res.counts) setKbCounts(res.counts)
    } catch (err) {
      toast(err instanceof Error ? err.message : "加载知识库失败", "error")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadKbs(filter)
  }, [filter, loadKbs])

  // 搜索：前端过滤（后端 /kbs 无 keyword 参数，登记见文件头注释）
  const filteredKbs = useMemo(() => {
    if (!search) return kbList
    const kw = search.toLowerCase()
    return kbList.filter((kb) => kb.name.toLowerCase().includes(kw))
  }, [kbList, search])

  const pinnedKbs = filteredKbs.filter((kb) => kb.pinned)
  const normalKbs = filteredKbs.filter((kb) => !kb.pinned)

  // 各 tab 计数：优先后端真实 counts（一次给全、不随点击变）；加载前/无 counts
  // 降级为当前视图 total + 本地近似（收藏标记/creatorId 比对——仅过渡显示）
  const counts = useMemo(() => {
    if (kbCounts) return kbCounts
    const mine = user ? kbList.filter((k) => k.creatorId === user.id).length : kbList.length
    const favorite = kbList.filter((k) => k.favorite).length
    return { all: total, mine, favorite, recent: total }
  }, [kbCounts, total, kbList, user])

  // 本地乐观更新单条 KB 标记（收藏/置顶），失败回滚由 catch 内重新拉取兜底
  const patchLocal = (id: string, patch: Partial<KbListItem>) =>
    setKbList((prev) => prev.map((kb) => (kb.id === id ? { ...kb, ...patch } : kb)))

  const handleStar = async (id: string) => {
    try {
      const res = await kbApi.toggleFavorite(id)
      patchLocal(id, { favorite: res.favorite })
      setKbCounts((prev) => (prev ? { ...prev, favorite: prev.favorite + (res.favorite ? 1 : -1) } : prev))
      toast(res.favorite ? "已收藏" : "已取消收藏")
    } catch (err) {
      toast(err instanceof Error ? err.message : "操作失败", "error")
    }
  }

  const handlePin = async (id: string) => {
    try {
      const res = await kbApi.togglePin(id)
      patchLocal(id, { pinned: res.pinned })
      toast(res.pinned ? "已置顶" : "已取消置顶")
    } catch (err) {
      toast(err instanceof Error ? err.message : "操作失败", "error")
    }
  }

  const handleDuplicate = async (id: string) => {
    try {
      const res = await kbApi.duplicateKb(id)
      setKbList((prev) => [res as KbListItem, ...prev])
      toast("复制成功")
    } catch (err) {
      toast(err instanceof Error ? err.message : "复制失败", "error")
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await kbApi.deleteKb(id)
      setKbList((prev) => prev.filter((kb) => kb.id !== id))
      void loadKbs(filter) // 重拉——服务端 counts/列表权威（避免删除后徽标数字滞后）
      toast("已删除知识库")
    } catch (err) {
      toast(err instanceof Error ? err.message : "删除失败", "error")
    }
    setDeleteConfirm(null)
  }

  const handleCreateKb = async () => {
    if (creating) return
    setCreating(true)
    try {
      const res = await kbApi.createKb({
        name: wizardForm.name,
        description: wizardForm.description || undefined,
        chunkingConfig: {
          strategy: wizardForm.chunkStrategy === "recursive" || wizardForm.chunkStrategy === "header" ? wizardForm.chunkStrategy : "token",
          chunkSize: Number(wizardForm.chunkSize) || 800,
          chunkOverlap: Number(wizardForm.overlap) || 100,
          separators: ["\n\n", "\n", "。", "！", "？", ".", " ", ""],
        },
        extractConfig: { enabled: wizardForm.graphExtract },
      })
      toast("知识库创建成功")
      setShowWizard(false)
      navigate(`/kb/${res.id}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : "创建失败", "error")
      setCreating(false)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-8 py-5 border-b border-border bg-card">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">知识库</h1>
          <p className="text-xs text-muted-foreground mt-0.5">管理和检索你的知识资产</p>
        </div>
        <button
          onClick={() => { setShowWizard(true); setWizardStep(1) }}
          className="inline-flex items-center gap-2 h-9 px-4 bg-primary text-primary-foreground text-sm font-medium rounded-md hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" />
          新建知识库
        </button>
      </div>

      {/* Filter + Search bar */}
      <div className="flex items-center gap-3 px-8 py-3 border-b border-border bg-background">
        <div className="flex items-center gap-0.5 bg-muted rounded-md p-0.5">
          {(["all", "mine", "favorite", "recent"] as FilterTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded transition-colors",
                filter === tab
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {TAB_LABELS[tab]}
              <span className="ml-1.5 font-mono text-[10px] opacity-60">{counts[tab]}</span>
            </button>
          ))}
        </div>
        <div className="flex-1 max-w-xs relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索知识库..."
            className="w-full h-8 pl-8 pr-3 text-sm bg-muted/50 border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {loading ? (
          <SkeletonGrid />
        ) : filteredKbs.length === 0 ? (
          <EmptyState onNew={() => setShowWizard(true)} search={search} />
        ) : (
          <>
            {pinnedKbs.length > 0 && (
              <KbSection
                title="置顶"
                icon={<Pin className="w-3 h-3" />}
                kbs={pinnedKbs}
                menuOpen={menuOpen}
                onMenuToggle={setMenuOpen}
                onStar={handleStar}
                onPin={handlePin}
                onDuplicate={handleDuplicate}
                onDelete={(id) => setDeleteConfirm(id)}
                onOpen={(id) => navigate(`/kb/${id}`)}
                onOpenSettings={(id) => navigate(`/kb/${id}`, { state: { openSettings: true } })}
              />
            )}
            {normalKbs.length > 0 && (
              <KbSection
                title="全部知识库"
                icon={<BookOpen className="w-3 h-3" />}
                kbs={normalKbs}
                menuOpen={menuOpen}
                onMenuToggle={setMenuOpen}
                onStar={handleStar}
                onPin={handlePin}
                onDuplicate={handleDuplicate}
                onDelete={(id) => setDeleteConfirm(id)}
                onOpen={(id) => navigate(`/kb/${id}`)}
                onOpenSettings={(id) => navigate(`/kb/${id}`, { state: { openSettings: true } })}
              />
            )}
          </>
        )}
      </div>

      {/* Close menu on click outside */}
      {menuOpen && (
        <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(null)} />
      )}

      {/* Delete Confirm Dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-lg shadow-xl p-6 w-96">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-8 h-8 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0">
                <Trash2 className="w-4 h-4 text-red-600" />
              </div>
              <div>
                <h3 className="font-semibold text-sm">删除知识库</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  此操作不可撤销。知识库内的所有文档、向量索引和知识图谱数据将被永久删除。
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="h-9 px-4 text-sm border border-border rounded-md hover:bg-muted transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                className="h-9 px-4 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New KB Wizard */}
      {showWizard && (
        <NewKbWizard
          step={wizardStep}
          form={wizardForm}
          onChange={(f) => setWizardForm((prev) => ({ ...prev, ...f }))}
          onNext={() => setWizardStep((prev) => Math.min(5, prev + 1) as WizardStep)}
          onPrev={() => setWizardStep((prev) => Math.max(1, prev - 1) as WizardStep)}
          onClose={() => setShowWizard(false)}
          onCreate={handleCreateKb}
          creating={creating}
        />
      )}
    </div>
  )
}

// ─── 分组区块 ────────────────────────────────────────────────────────────────
function KbSection({
  title, icon, kbs, menuOpen, onMenuToggle, onStar, onPin, onDuplicate, onDelete, onOpen, onOpenSettings,
}: {
  title: string
  icon: React.ReactNode
  kbs: KbListItem[]
  menuOpen: string | null
  onMenuToggle: (id: string | null) => void
  onStar: (id: string) => void
  onPin: (id: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onOpen: (id: string) => void
  onOpenSettings: (id: string) => void
}) {
  return (
    <div className="mb-6">
      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
        <div className="w-3 h-px bg-border" />
        {icon}
        {title}
        <span className="font-mono text-[10px]">({kbs.length})</span>
        <div className="flex-1 h-px bg-border" />
      </div>
      <div className="grid grid-cols-3 gap-4">
        {kbs.map((kb) => (
          <KbCard
            key={kb.id}
            kb={kb}
            onStar={() => onStar(kb.id)}
            onPin={() => onPin(kb.id)}
            onDuplicate={() => onDuplicate(kb.id)}
            onDelete={() => onDelete(kb.id)}
            menuOpen={menuOpen === kb.id}
            onMenuToggle={() => onMenuToggle(menuOpen === kb.id ? null : kb.id)}
            onClick={() => onOpen(kb.id)}
            onOpenSettings={() => onOpenSettings(kb.id)}
          />
        ))}
      </div>
    </div>
  )
}

// ─── KB Card ──────────────────────────────────────────────────────────────────
function KbCard({
  kb, onStar, onPin, onDuplicate, onDelete, menuOpen, onMenuToggle, onClick, onOpenSettings,
}: {
  kb: KbListItem
  onStar: () => void
  onPin: () => void
  onDuplicate: () => void
  onDelete: () => void
  menuOpen: boolean
  onMenuToggle: () => void
  onClick: () => void
  onOpenSettings: () => void
}) {
  return (
    <div
      className="group relative bg-card border border-border rounded-lg p-5 cursor-pointer hover:border-foreground/20 hover:shadow-sm transition-all"
      onClick={onClick}
    >
      {/* Top row */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center flex-shrink-0">
            <BookOpen className="w-4 h-4 text-primary-foreground" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold leading-tight truncate">{kb.name}</h3>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onStar() }}
            className={cn(
              "w-7 h-7 rounded flex items-center justify-center transition-colors",
              kb.favorite
                ? "text-amber-500 hover:text-amber-400"
                : "text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100"
            )}
            title={kb.favorite ? "取消收藏" : "收藏"}
          >
            <Star className={cn("w-3.5 h-3.5", kb.favorite && "fill-current")} />
          </button>
          <div className="relative">
            <button
              onClick={(e) => { e.stopPropagation(); onMenuToggle() }}
              className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors opacity-0 group-hover:opacity-100"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-8 z-20 w-44 bg-card border border-border rounded-lg shadow-xl py-1 text-sm">
                <MenuItem
                  icon={<Bookmark className="w-3.5 h-3.5" />}
                  label={kb.pinned ? "取消置顶" : "置顶"}
                  onClick={(e) => { e.stopPropagation(); onPin() }}
                />
                <MenuItem
                  icon={<Copy className="w-3.5 h-3.5" />}
                  label="复制知识库"
                  onClick={(e) => { e.stopPropagation(); onDuplicate() }}
                />
                <MenuItem
                  icon={<Settings className="w-3.5 h-3.5" />}
                  label="知识库设置"
                  onClick={(e) => { e.stopPropagation(); onOpenSettings() }}
                />
                <div className="border-t border-border my-1" />
                <MenuItem
                  icon={<Trash2 className="w-3.5 h-3.5" />}
                  label="删除"
                  className="text-red-600"
                  onClick={(e) => { e.stopPropagation(); onDelete() }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Description */}
      <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2 mb-4">
        {kb.description || "暂无描述"}
      </p>

      {/* Footer */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground font-mono">
            <FileText className="w-3 h-3" />
            {kb.docCount} 文档
          </span>
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground font-mono">
            <Network className="w-3 h-3" />
            {kb.chunkCount} 分块
          </span>
          {kb.pinned && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-accent/10 text-accent border border-accent/20">
              <Pin className="w-2.5 h-2.5" />
              置顶
            </span>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground font-mono">
          {formatDateTime(kb.updatedAt, "—")}
        </span>
      </div>
    </div>
  )
}

function MenuItem({ icon, label, className, onClick }: {
  icon: React.ReactNode; label: string; className?: string; onClick?: (e: React.MouseEvent) => void
}) {
  return (
    <button
      className={cn("w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-muted transition-colors", className)}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  )
}

// ─── Skeleton / Empty ─────────────────────────────────────────────────────────
function SkeletonGrid() {
  return (
    <div className="grid grid-cols-3 gap-4">
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <div key={i} className="bg-card border border-border rounded-lg p-5 animate-pulse">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 bg-muted rounded-md" />
            <div className="h-4 bg-muted rounded w-28" />
          </div>
          <div className="space-y-2 mb-4">
            <div className="h-3 bg-muted rounded w-full" />
            <div className="h-3 bg-muted rounded w-3/4" />
          </div>
          <div className="flex justify-between">
            <div className="h-3 bg-muted rounded w-12" />
            <div className="h-4 bg-muted rounded w-10" />
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyState({ onNew, search }: { onNew: () => void; search: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-14 h-14 rounded-xl bg-muted flex items-center justify-center mb-4">
        <BookOpen className="w-7 h-7 text-muted-foreground" />
      </div>
      <h3 className="text-sm font-semibold mb-1">
        {search ? "未找到匹配的知识库" : "还没有知识库"}
      </h3>
      <p className="text-xs text-muted-foreground max-w-xs mb-6">
        {search
          ? `没有名称包含"${search}"的知识库，请尝试其他关键词`
          : "创建第一个知识库，开始上传文档并启用 AI 问答与知识图谱"}
      </p>
      {!search && (
        <button
          onClick={onNew}
          className="inline-flex items-center gap-2 h-9 px-4 bg-primary text-primary-foreground text-sm font-medium rounded-md hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" />
          新建知识库
        </button>
      )}
    </div>
  )
}

// ─── New KB Wizard（5 步，复用原型 UI；最终 POST /kbs） ─────────────────────
function NewKbWizard({
  step, form, onChange, onNext, onPrev, onClose, onCreate, creating,
}: {
  step: WizardStep
  form: Record<string, string | boolean>
  onChange: (f: Partial<Record<string, string | boolean>>) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
  onCreate: () => void
  creating: boolean
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-[680px] flex flex-col max-h-[85vh]">
        {/* Wizard header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold">新建知识库</h2>
            <p className="text-xs text-muted-foreground mt-0.5">步骤 {step} / 5</p>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Step indicators */}
        <div className="flex items-center px-6 py-3 gap-1 border-b border-border">
          {WIZARD_STEPS.map((s, i) => (
            <div key={s.step} className="flex items-center">
              <div className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                step === s.step ? "bg-primary text-primary-foreground" :
                step > s.step ? "text-emerald-600 bg-emerald-50" :
                "text-muted-foreground"
              )}>
                {step > s.step ? <Check className="w-3 h-3" /> : s.icon}
                <span className="hidden sm:inline">{s.label}</span>
              </div>
              {i < 4 && <ChevronRight className="w-3 h-3 text-muted-foreground mx-0.5" />}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {step === 1 && <WizardStep1 form={form} onChange={onChange} />}
          {step === 2 && <WizardStep2 form={form} onChange={onChange} />}
          {step === 3 && <WizardStep3 form={form} onChange={onChange} />}
          {step === 4 && <WizardStep4 form={form} onChange={onChange} />}
          {step === 5 && <WizardStep5 form={form} onChange={onChange} />}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border">
          <button
            onClick={onPrev}
            disabled={step === 1}
            className="h-9 px-4 text-sm border border-border rounded-md hover:bg-muted transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            上一步
          </button>
          {step < 5 ? (
            <button
              onClick={onNext}
              disabled={step === 1 && !form.name}
              className="h-9 px-4 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              下一步
            </button>
          ) : (
            <button
              onClick={onCreate}
              disabled={creating}
              className="h-9 px-4 text-sm bg-accent text-accent-foreground rounded-md hover:bg-accent/90 transition-colors disabled:opacity-60 flex items-center gap-2"
            >
              {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              创建知识库
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function FormRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  )
}

function WizardStep1({ form, onChange }: { form: Record<string, string | boolean>; onChange: (f: any) => void }) {
  return (
    <div className="space-y-5">
      <FormRow label="知识库名称" hint="简洁描述知识库的内容领域">
        <input
          value={form.name as string}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="例如：技术文档库 / 产品需求库"
          className="w-full h-10 px-3 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent bg-background"
        />
      </FormRow>
      <FormRow label="描述（可选）">
        <textarea
          value={form.description as string}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="描述知识库的用途、受众与内容范围"
          rows={3}
          className="w-full px-3 py-2 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent bg-background resize-none placeholder:text-muted-foreground"
        />
      </FormRow>
    </div>
  )
}

function WizardStep2({ form, onChange }: { form: Record<string, string | boolean>; onChange: (f: any) => void }) {
  return (
    <div className="space-y-5">
      {/* 普通 RAG（向量搜索）是知识库基础能力，恒开启（用户需求：不可关闭） */}
      <div className="flex items-center gap-3 bg-muted/40 border border-border rounded-md px-3 py-2.5">
        <span className="w-4 h-4 rounded bg-primary flex items-center justify-center flex-shrink-0">
          <Check className="w-3 h-3 text-primary-foreground" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">向量搜索（普通 RAG）</div>
          <div className="text-[11px] text-muted-foreground">将文档分块后生成向量嵌入，支持语义相似度检索——知识库问答的基础能力，默认开启</div>
        </div>
      </div>
      <ToggleOption
        label="知识图谱抽取（GraphRAG）"
        desc="上传文档时由 LLM 自动识别实体与关系，构建可视化知识图谱，增强多跳问答检索（可选）"
        checked={form.graphExtract as boolean}
        onToggle={() => onChange({ graphExtract: !form.graphExtract })}
        badge="可选"
        badgeColor="violet"
      />
    </div>
  )
}

function ToggleOption({ label, desc, checked, onToggle, badge, badgeColor }: {
  label: string; desc: string; checked: boolean; onToggle: () => void; badge?: string; badgeColor?: string
}) {
  return (
    <div
      onClick={onToggle}
      className={cn(
        "flex items-start gap-4 p-4 rounded-lg border-2 cursor-pointer transition-all",
        checked ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30"
      )}
    >
      <div className={cn(
        "w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors",
        checked ? "bg-primary border-primary" : "border-muted-foreground/40"
      )}>
        {checked && <Check className="w-3 h-3 text-primary-foreground" />}
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          {badge && (
            <span className={cn(
              "text-[10px] font-semibold px-1.5 py-0.5 rounded",
              badgeColor === "violet" ? "bg-violet-50 text-violet-600" : "bg-accent/10 text-accent"
            )}>{badge}</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
      </div>
    </div>
  )
}

function WizardStep3({ form, onChange }: { form: Record<string, string | boolean>; onChange: (f: any) => void }) {
  const models = [
    { value: "text-embedding-3-large", label: "text-embedding-3-large", provider: "OpenAI", dim: 3072 },
    { value: "text-embedding-3-small", label: "text-embedding-3-small", provider: "OpenAI", dim: 1536 },
    { value: "bge-m3", label: "BAAI/bge-m3", provider: "本地", dim: 1024 },
  ]
  return (
    <div className="space-y-5">
      <FormRow label="Embedding 模型" hint="模型选择记录在 KB 配置中（当前后端未强绑定，仅作展示与预留）">
        <div className="space-y-2">
          {models.map((m) => (
            <label key={m.value} className={cn(
              "flex items-center gap-3 p-3 rounded-md border cursor-pointer transition-all",
              form.embeddingModel === m.value ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30"
            )}>
              <input type="radio" name="embedding" value={m.value}
                checked={form.embeddingModel === m.value}
                onChange={() => onChange({ embeddingModel: m.value })}
                className="accent-primary"
              />
              <div className="flex-1">
                <div className="text-sm font-medium font-mono">{m.label}</div>
                <div className="text-xs text-muted-foreground">{m.provider} · dim={m.dim}</div>
              </div>
            </label>
          ))}
        </div>
      </FormRow>
    </div>
  )
}

function WizardStep4({ form, onChange }: { form: Record<string, string | boolean>; onChange: (f: any) => void }) {
  return (
    <div className="space-y-5">
      <FormRow label="分块策略">
        <div className="grid grid-cols-3 gap-2">
          {[
            { value: "token", label: "固定大小分块", desc: "按大小窗口 + 分隔符边界切割（默认）" },
            { value: "recursive", label: "递归分块", desc: "多级分隔符递归降级（段落→行→句子），结构保留更完整" },
            { value: "header", label: "标题分块", desc: "按 Markdown 标题层级分节，每节自带标题上下文" },
          ].map((s) => (
            <div
              key={s.value}
              onClick={() => onChange({ chunkStrategy: s.value })}
              className={cn(
                "p-3 rounded-md border cursor-pointer transition-all text-center",
                form.chunkStrategy === s.value ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30"
              )}
            >
              <div className="text-sm font-medium mb-1">{s.label}</div>
              <div className="text-[11px] text-muted-foreground">{s.desc}</div>
            </div>
          ))}
        </div>
      </FormRow>
      <div className="grid grid-cols-2 gap-4">
        <FormRow label="分块大小 (tokens)" hint="对应后端 chunkSize">
          <input
            type="number" value={form.chunkSize as string}
            onChange={(e) => onChange({ chunkSize: e.target.value })}
            className="w-full h-10 px-3 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent bg-background font-mono"
          />
        </FormRow>
        <FormRow label="重叠 (tokens)" hint="对应后端 chunkOverlap">
          <input
            type="number" value={form.overlap as string}
            onChange={(e) => onChange({ overlap: e.target.value })}
            className="w-full h-10 px-3 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent bg-background font-mono"
          />
        </FormRow>
      </div>
    </div>
  )
}

function WizardStep5({ form, onChange }: { form: Record<string, string | boolean>; onChange: (f: any) => void }) {
  const parsers = [
    { key: "parserPDF", label: "PDF 文件", opts: ["mineru"] },
    { key: "parserWord", label: "Word 文件", opts: ["mineru"] },
    { key: "parserImage", label: "图片文件", opts: ["mineru"] },
    { key: "parserMd", label: "Markdown", opts: ["native"] },
  ]
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">为每种文件类型指定解析引擎。当前为展示性配置，实际解析引擎由后端解析服务决定。</p>
      {parsers.map((p) => (
        <div key={p.key} className="flex items-center justify-between py-2 border-b border-border last:border-0">
          <span className="text-sm font-medium">{p.label}</span>
          <select
            value={form[p.key] as string}
            onChange={(e) => onChange({ [p.key]: e.target.value })}
            className="h-8 px-2 text-xs border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-accent bg-background appearance-none font-mono"
          >
            {p.opts.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      ))}
      <div className="mt-4 p-3 bg-emerald-50 border border-emerald-100 rounded-md text-xs text-emerald-700 flex items-start gap-2">
        <Check className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        配置完成后点击"创建知识库"，系统将初始化索引并准备接受文档上传。
      </div>
    </div>
  )
}
