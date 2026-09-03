// 设置中心（frontend/src/views/settings/SettingsView.tsx，Task 5.8）
// 12 子页真实 API 对接（轻量模式）：
//   个人资料 GET/PUT /settings/profile + POST /settings/change-password
//   工作区信息：当前用户 + 系统信息（只读，简化）
//   成员管理 GET/PUT /users、POST /users/transfer-ownership + /invitations
//   模型管理 GET/POST/PUT/DELETE /models + /models/test|:id/test|:id/debug
//   解析引擎：静态信息（简化，复用系统信息）
//   Web 搜索 GET/POST/PUT/DELETE /web-search/providers + 测试/设默认
//   聊天历史 GET /chat/history?keyword= + /chat/history/stats + DELETE /chat/history
//   API Keys GET/POST/DELETE /admin/api-keys（创建后明文仅显示一次）
//   任务队列 GET /admin/queues + /admin/queues/:name/jobs + retry/cancel
//   审计日志 GET /admin/audit-logs（分页筛选）
//   全局设置 GET/PUT /admin/settings
//   版本信息 GET /system/info

import { useCallback, useEffect, useState } from "react"
import {
  ShieldAlert, Plus, Loader2, Check, X, Copy, Eye, EyeOff,
  Trash2, Crown, Shield, RefreshCw, AlertCircle,
  Search, Cpu, Play, CheckCircle, XCircle,
  ToggleLeft, ToggleRight, Clock, Key, Activity,
  GitBranch, Globe, User, Building2, Settings2, Zap,
  Mail, Link as LinkIcon, RotateCcw, Database, Server, Gauge,
  MessageSquare, Pencil
} from "lucide-react"
import { cn, toast, ToastHost } from "../../components/ui"
import { useAuth } from "../../store/auth"
import {
  apiKeyApi, auditApi, historyApi, modelApi, profileApi,
  queueApi, systemApi, usageApi, workspaceApi,
  type HistoryHit, type HistoryStat, type ModelForm, type ModelUsageRow,
} from "../../api/settings"
import type { AuditLog, Model, PlatformApiKey, QueueJobInfo, User as WorkspaceUser } from "../../api/types"

/** 模型提供商预设（BYOK：系统提供的接口范围——用户选预设后填自己的 API Key） */
const PROVIDER_PRESETS = [
  { value: "openai-compatible", label: "OpenAI 兼容", hint: "DeepSeek / 通义千问等（自由填 baseUrl）", baseUrl: "" },
  { value: "deepseek", label: "DeepSeek", hint: "https://api.deepseek.com（deepseek-chat 等）", baseUrl: "https://api.deepseek.com" },
  { value: "dashscope", label: "通义千问（DashScope）", hint: "https://dashscope.aliyuncs.com/compatible-mode/v1（qwen-plus / text-embedding-v4 等）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { value: "ollama", label: "Ollama（本地）", hint: "http://127.0.0.1:11434（llama3 等）", baseUrl: "http://127.0.0.1:11434" },
] as const

type TabId =
  | "profile" | "workspace" | "usage" | "members"
  | "models" | "parser" | "websearch" | "history"
  | "apikeys" | "queue" | "audit" | "system" | "version"

const NAV_GROUPS = [
  {
    label: "账号与工作区",
    items: [
      { id: "profile" as TabId, label: "个人资料", icon: <User className="w-3.5 h-3.5" /> },
      { id: "workspace" as TabId, label: "工作区信息", icon: <Building2 className="w-3.5 h-3.5" /> },
      { id: "usage" as TabId, label: "模型用量", icon: <Gauge className="w-3.5 h-3.5" /> },
    ],
  },
  {
    label: "引擎与运行时",
    items: [
      { id: "models" as TabId, label: "模型管理", icon: <Cpu className="w-3.5 h-3.5" /> },
      { id: "parser" as TabId, label: "解析引擎", icon: <GitBranch className="w-3.5 h-3.5" /> },
      { id: "history" as TabId, label: "聊天历史", icon: <Clock className="w-3.5 h-3.5" /> },
    ],
  },
  {
    label: "系统管理",
    admin: true,
    items: [
      { id: "members" as TabId, label: "成员管理", icon: <Shield className="w-3.5 h-3.5" /> },
      { id: "apikeys" as TabId, label: "平台 API Keys", icon: <Key className="w-3.5 h-3.5" /> },
      { id: "queue" as TabId, label: "任务队列监控", icon: <Activity className="w-3.5 h-3.5" /> },
      { id: "audit" as TabId, label: "审计日志", icon: <Search className="w-3.5 h-3.5" /> },
      { id: "system" as TabId, label: "全局设置", icon: <Settings2 className="w-3.5 h-3.5" /> },
      { id: "version" as TabId, label: "版本信息", icon: <Zap className="w-3.5 h-3.5" /> },
    ],
  },
]

export default function SettingsView() {
  const [activeTab, setActiveTab] = useState<TabId>("profile")
  const { user } = useAuth()
  const isSuper = user?.role === "super"

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar */}
      <div className="w-52 border-r border-border bg-card/30 flex flex-col flex-shrink-0 overflow-y-auto py-4">
        {/* 系统管理（含成员管理）仅 super 可见；普通用户不展示这些入口 */}
        {NAV_GROUPS.filter(g => !g.admin || isSuper).map(group => (
          <div key={group.label} className="mb-5 px-3">
            <div className={cn(
              "text-[10px] font-bold uppercase tracking-wider mb-1.5 px-2 flex items-center gap-1.5",
              group.admin ? "text-amber-600" : "text-muted-foreground",
            )}>
              {group.admin && <ShieldAlert className="w-3 h-3" />}
              {group.label}
            </div>
            <div className="space-y-0.5">
              {group.items.map(item => (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm font-medium transition-colors text-left",
                    activeTab === item.id
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-8">
          {activeTab === "profile" && <ProfileSettings />}
          {activeTab === "workspace" && <WorkspaceSettings />}
          {activeTab === "usage" && <ModelUsageSettings />}
          {activeTab === "members" && <MembersSettings />}
          {activeTab === "models" && <ModelsSettings />}
          {activeTab === "parser" && <ParserSettings />}
          {activeTab === "history" && <HistorySettings />}
          {activeTab === "apikeys" && <ApiKeysSettings />}
          {activeTab === "queue" && <QueueSettings />}
          {activeTab === "audit" && <AuditSettings />}
          {activeTab === "system" && <SystemConfigSettings />}
          {activeTab === "version" && <VersionSettings />}
        </div>
      </div>
      <ToastHost />
    </div>
  )
}

// ─── 个人资料 ─────────────────────────────────────────────────────────────────
function ProfileSettings() {
  const { user, setUser } = useAuth()
  const [name, setName] = useState(user?.name ?? "")
  const [email, setEmail] = useState(user?.email ?? "")
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pwOpen, setPwOpen] = useState(false)
  const [pwOld, setPwOld] = useState("")
  const [pwNew, setPwNew] = useState("")
  const [pwConfirm, setPwConfirm] = useState("")
  const [pwSaving, setPwSaving] = useState(false)

  useEffect(() => {
    setName(user?.name ?? "")
    setEmail(user?.email ?? "")
  }, [user])

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await profileApi.update({ name })
      setUser(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setSaving(false)
    }
  }

  const handleChangePassword = async () => {
    if (pwNew !== pwConfirm) {
      toast("两次输入的新密码不一致", "error")
      return
    }
    setPwSaving(true)
    try {
      await profileApi.changePassword(pwOld, pwNew)
      toast("密码已修改")
      setPwOpen(false)
      setPwOld(""); setPwNew(""); setPwConfirm("")
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setPwSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader title="个人资料" desc="管理你的账号基本信息" />

      <div className="flex items-center gap-4 p-4 bg-card border border-border rounded-lg">
        <div className="w-16 h-16 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-bold text-xl">
          {(name || "?").slice(0, 2).toUpperCase()}
        </div>
        <div>
          <div className="text-sm font-semibold">{name || "未设置昵称"}</div>
          <div className="text-xs text-muted-foreground">{email}</div>
          <div className="text-[10px] text-muted-foreground mt-0.5">
            {user?.role === "super" ? "Owner" : "Admin"} · 注册于 {user?.createdAt ? new Date(user.createdAt).toLocaleDateString("zh-CN") : "-"}
          </div>
        </div>
      </div>

      <FormSection label="账号信息">
        <Field label="昵称">
          <input value={name} onChange={e => setName(e.target.value)} className={inputCls} />
        </Field>
        <Field label="邮箱">
          <input value={email} disabled className={cn(inputCls, "disabled:opacity-60")} />
          <p className="text-[10px] text-muted-foreground">邮箱为登录账号，暂不支持修改</p>
        </Field>
      </FormSection>

      {!pwOpen ? (
        <button onClick={() => setPwOpen(true)} className="text-xs text-accent hover:underline">修改密码</button>
      ) : (
        <FormSection label="修改密码">
          <Field label="当前密码">
            <PasswordInput value={pwOld} onChange={setPwOld} placeholder="••••••••" />
          </Field>
          <Field label="新密码">
            <PasswordInput value={pwNew} onChange={setPwNew} placeholder="••••••••" />
          </Field>
          <Field label="确认新密码">
            <PasswordInput value={pwConfirm} onChange={setPwConfirm} placeholder="••••••••" />
          </Field>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void handleChangePassword()}
              disabled={!pwOld || !pwNew || pwSaving}
              className="h-9 px-4 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-40 flex items-center gap-1.5"
            >
              {pwSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              确认修改
            </button>
            <button onClick={() => setPwOpen(false)} className="text-xs text-muted-foreground hover:text-foreground">取消</button>
          </div>
        </FormSection>
      )}

      <SaveButton saved={saved} saving={saving} onClick={() => void handleSave()} />
    </div>
  )
}

// ─── 工作区信息 ───────────────────────────────────────────────────────────────
function WorkspaceSettings() {
  const { user } = useAuth()
  const [sysInfo, setSysInfo] = useState<{ version?: string; services?: Record<string, unknown> } | null>(null)

  useEffect(() => {
    void systemApi.info().then(setSysInfo).catch(() => {})
  }, [])

  const rows: [string, string][] = [
    ["工作区所有者", user?.name || user?.email || "-"],
    ["所有者邮箱", user?.email || "-"],
    ["角色", user?.role === "super" ? "Owner" : "Admin"],
    ["用户 ID", user?.id?.slice(0, 8) ?? "-"],
    ["产品版本", sysInfo?.version ?? "-"],
  ]

  return (
    <div className="space-y-6">
      <SectionHeader title="工作区信息" desc="工作区概览（只读）" />
      <div className="bg-card border border-border rounded-lg divide-y divide-border">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">{k}</span>
            <span className="text-sm font-mono font-medium truncate max-w-[60%]">{v}</span>
          </div>
        ))}
      </div>
      <div className="p-3 border border-border bg-muted/30 rounded-md text-xs text-muted-foreground">
        存储用量与运行环境详情见「版本信息」页（GET /system/info）。
      </div>
    </div>
  )
}

// ─── 成员管理 ─────────────────────────────────────────────────────────────────
function MembersSettings() {
  const { user: currentUser } = useAuth()
  const isOwner = currentUser?.role === "super"
  const [users, setUsers] = useState<WorkspaceUser[]>([])
  const [invites, setInvites] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(true)
  const [showInvite, setShowInvite] = useState(false)
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState("Admin")
  const [sending, setSending] = useState(false)
  const [transferTo, setTransferTo] = useState("")
  const [transferring, setTransferring] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [userRes, inviteRes] = await Promise.all([
        workspaceApi.listUsers(1, 100),
        workspaceApi.listInvitations(1, 100),
      ])
      setUsers(userRes.items)
      setInvites(inviteRes.items)
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const handleInvite = async () => {
    setSending(true)
    try {
      const inv = await workspaceApi.createInvitation(inviteEmail.trim(), inviteRole === "Owner" ? "super" : "admin")
      const token = String((inv as Record<string, unknown>).token ?? "")
      if (token) {
        const url = `${window.location.origin}/register?invite=${token}`
        void navigator.clipboard?.writeText(url)
        toast("邀请已创建，链接已复制到剪贴板", "info")
      } else {
        toast("邀请已创建")
      }
      setShowInvite(false)
      setInviteEmail("")
      void load()
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setSending(false)
    }
  }

  const handleRoleChange = async (id: string, role: "super" | "member") => {
    try {
      await workspaceApi.updateRole(id, role)
      toast("角色已更新")
      void load()
    } catch (err) {
      toast(errMessage(err), "error")
    }
  }

  const handleTransfer = async () => {
    if (!transferTo) return
    if (!window.confirm("确定转移工作区所有权？此操作不可逆，您将降级为 Admin。")) return
    setTransferring(true)
    try {
      await workspaceApi.transferOwnership(transferTo)
      toast("所有权已转移")
      setTransferTo("")
      void load()
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setTransferring(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <SectionHeader title="成员管理" desc="管理工作区访问权限" />
        {isOwner && (
          <button onClick={() => setShowInvite(!showInvite)} className="h-9 px-4 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 flex items-center gap-2">
            <Plus className="w-4 h-4" />邀请成员
          </button>
        )}
      </div>

      {showInvite && (
        <div className="p-4 bg-card border border-border rounded-lg space-y-3">
          <div className="text-sm font-medium">邀请新成员</div>
          <div className="flex gap-2">
            <input
              value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
              placeholder="账号 / 邮箱"
              className={cn(inputCls, "flex-1")}
            />
            <select value={inviteRole} onChange={e => setInviteRole(e.target.value)} className="h-10 px-2 text-sm border border-border rounded-md bg-background appearance-none">
              <option value="Admin">Admin</option>
            </select>
            <button
              onClick={() => void handleInvite()}
              disabled={!inviteEmail || sending}
              className="h-10 px-4 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-40 flex items-center gap-1.5"
            >
              {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              {sending ? "创建中" : "创建邀请"}
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground">邀请链接（含 token）创建后自动复制到剪贴板，仅展示一次。</p>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
          {users.map(m => (
            <div key={m.id} className="flex items-center gap-3 px-4 py-3">
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-bold font-mono flex-shrink-0">
                {(m.name || m.email).slice(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{m.name || m.email}</div>
                <div className="text-[11px] text-muted-foreground truncate">{m.email}</div>
              </div>
              <div className="flex items-center gap-2">
                {m.role === "super" ? (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Crown className="w-3.5 h-3.5 text-amber-500" />Owner
                  </span>
                ) : (
                  <>
                    <select
                      value={m.role}
                      disabled={!isOwner}
                      onChange={e => void handleRoleChange(m.id, e.target.value as "super" | "member")}
                      className="h-7 px-2 text-xs border border-border rounded bg-background disabled:opacity-50"
                    >
                      <option value="member">成员</option>
                      <option value="super">系统管理员</option>
                    </select>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 邀请列表 */}
      {invites.length > 0 && (
        <div>
          <div className="text-sm font-semibold mb-2">待处理邀请</div>
          <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
            {invites.map(inv => (
              <div key={String(inv.id)} className="flex items-center gap-3 px-4 py-3">
                <Mail className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{String(inv.email ?? "-")}</div>
                  <div className="text-[11px] text-muted-foreground font-mono">{String(inv.tokenPreview ?? "")}</div>
                </div>
                <button
                  onClick={() => { void workspaceApi.revokeInvitation(String(inv.id)).then(() => { toast("邀请已撤销"); void load() }) }}
                  className="h-7 px-2 text-xs text-red-600 border border-red-100 rounded hover:bg-red-50 flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" />撤销
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 所有权转移 */}
      {isOwner && (
        <div className="p-4 border border-amber-100 bg-amber-50/50 rounded-md space-y-3">
          <div className="text-xs text-amber-700 flex items-start gap-2">
            <Crown className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            所有权转移：仅 Owner 可将工作区所有权转移给其他 Admin。此操作不可逆，请谨慎操作。
          </div>
          <div className="flex gap-2">
            <select
              value={transferTo}
              onChange={e => setTransferTo(e.target.value)}
              className="flex-1 h-9 px-3 text-sm border border-border rounded-md bg-background"
            >
              <option value="">选择目标成员…</option>
              {users.filter(u => u.role === "member").map(u => (
                <option key={u.id} value={u.id}>{u.name || u.email}</option>
              ))}
            </select>
            <button
              onClick={() => void handleTransfer()}
              disabled={!transferTo || transferring}
              className="h-9 px-4 text-sm bg-amber-600 text-white rounded-md hover:bg-amber-700 disabled:opacity-40 flex items-center gap-1.5"
            >
              {transferring && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              转移所有权
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 模型管理 ─────────────────────────────────────────────────────────────────
const MODEL_TYPE_LABELS: Record<string, string> = {
  chat: "对话",
  embedding: "Embedding",
  rerank: "重排序",
}
const PROVIDER_LABELS: Record<string, string> = {
  "openai-compatible": "OpenAI 兼容",
  ollama: "Ollama 本地",
}

function ModelsSettings() {
  const { user } = useAuth()
  const isSuper = user?.role === "super"
  const [models, setModels] = useState<Model[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showDebug, setShowDebug] = useState<string | null>(null)
  const [debugging, setDebugging] = useState(false)
  const [debugResult, setDebugResult] = useState<string | null>(null)
  const [debugMsg, setDebugMsg] = useState("你好，请简单介绍一下自己。")
  const [form, setForm] = useState<ModelForm>({
    provider: "openai-compatible", name: "", baseUrl: "", apiKey: "", modelName: "", type: "chat",
  })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setModels(await modelApi.list())
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await modelApi.testConnection(form)
      setTestResult(res.ok ? "ok" : "fail")
      if (!res.ok) toast(res.error ?? "连接失败", "error")
    } catch (err) {
      setTestResult("fail")
      toast(errMessage(err), "error")
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await modelApi.create(form)
      toast("模型已新增")
      setShowAdd(false)
      setForm({ provider: "openai-compatible", name: "", baseUrl: "", apiKey: "", modelName: "", type: "chat" })
      setTestResult(null)
      void load()
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setSaving(false)
    }
  }

  const handleEdit = (m: Model) => {
    setEditingId(m.id)
    setForm({
      provider: m.provider, name: m.name, baseUrl: m.baseUrl, apiKey: "", modelName: m.modelName, type: m.type,
    })
    setTestResult(null)
  }

  const handleSaveEdit = async () => {
    if (!editingId || saving) return
    setSaving(true)
    try {
      await modelApi.update(editingId, {
        name: form.name,
        baseUrl: form.baseUrl,
        modelName: form.modelName,
        // apiKey 留空 = 不修改（后端 update 空串 = 清除；此处不传则保持）
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      })
      toast("模型已更新")
      setEditingId(null)
      setForm({ provider: "openai-compatible", name: "", baseUrl: "", apiKey: "", modelName: "", type: "chat" })
      void load()
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!window.confirm("确定删除该模型？")) return
    try {
      await modelApi.remove(id)
      toast("模型已删除")
      void load()
    } catch (err) {
      toast(errMessage(err), "error")
    }
  }

  const handleSetDefault = async (id: string) => {
    try {
      await modelApi.setDefault(id)
      toast("已设为默认模型")
      void load()
    } catch (err) {
      toast(errMessage(err), "error")
    }
  }

  const handleDebug = async () => {
    if (!showDebug) return
    setDebugging(true)
    setDebugResult(null)
    try {
      const res = await modelApi.debug(showDebug, debugMsg)
      setDebugResult(res.response)
    } catch (err) {
      setDebugResult(`调试失败：${errMessage(err)}`)
    } finally {
      setDebugging(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <SectionHeader title="模型管理" desc="配置对话、Embedding、重排序等模型供应商" />
        <button onClick={() => { setShowAdd(true); setTestResult(null) }} className="h-9 px-4 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 flex items-center gap-2">
          <Plus className="w-4 h-4" />新增模型
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="space-y-6">
          {/* 我的模型（BYOK：自己的 API Key） */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-semibold">我的模型</span>
              <span className="text-[11px] text-muted-foreground">配置你自己的模型与 API Key（对话/Embedding/重排序分别设置默认）</span>
            </div>
            {models.filter(m => m.userId !== null).length === 0 ? (
              <div className="text-xs text-muted-foreground py-6 text-center border border-dashed border-border rounded-lg">
                还没有配置模型——点「新增模型」选择提供商（DeepSeek/通义千问/Ollama 等），填入你自己的 API Key
              </div>
            ) : (
              <ModelList items={models.filter(m => m.userId !== null)} isSuper={isSuper} />
            )}
          </div>
        </div>
      )}
      {/* 列表渲染占位（由 ModelList 组件承担） */}
      {/* Edit Model Modal（可重新设置 API Key——此前只有新增/删除，无法修改已有模型） */}
      {editingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-xl shadow-2xl w-[520px] p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold">编辑模型</h3>
              <button onClick={() => setEditingId(null)} className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <FormRow label="名称">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
              </FormRow>
              <FormRow label="Base URL">
                <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} className={inputCls} placeholder="https://api.xxx.com/v1" />
              </FormRow>
              <FormRow label="模型 ID（modelName）">
                <input value={form.modelName} onChange={(e) => setForm({ ...form, modelName: e.target.value })} className={inputCls} />
              </FormRow>
              <FormRow label="API Key" hint="留空 = 保持原 Key；填了则覆盖（修复「解密失败」时重新填入）">
                <input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} className={inputCls} placeholder="sk-..." />
              </FormRow>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setEditingId(null)} className="h-9 px-4 text-sm border border-border rounded-md hover:bg-muted">取消</button>
              <button onClick={() => void handleSaveEdit()} disabled={saving} className="h-9 px-4 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2">
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Model Modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-xl shadow-2xl w-[520px] p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-base font-semibold">新增模型</h3>
              <button onClick={() => { setShowAdd(false); setTestResult(null) }} className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Field label="模型提供商">
                  <select
                    value={form.provider}
                    onChange={e => {
                      const preset = PROVIDER_PRESETS.find(p => p.value === e.target.value)
                      setForm(p => ({
                        ...p,
                        provider: e.target.value as ModelForm["provider"],
                        // 选预设 → 预填 baseUrl（自定义时保留手填）
                        baseUrl: preset?.baseUrl ?? p.baseUrl,
                      }))
                    }}
                    className="h-9 w-full px-3 text-sm border border-border rounded-md bg-background appearance-none"
                  >
                    {PROVIDER_PRESETS.map(p => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {PROVIDER_PRESETS.find(p => p.value === form.provider)?.hint ?? "选择预设后填写你的 API Key"}
                  </p>
                </Field>
                <Field label="模型类型">
                  <select value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value as ModelForm["type"] }))} className="h-9 w-full px-3 text-sm border border-border rounded-md bg-background appearance-none">
                    <option value="chat">对话</option>
                    <option value="embedding">Embedding</option>
                    <option value="rerank">重排序</option>
                  </select>
                </Field>
              </div>
              <Field label="显示名称">
                <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="例如：DeepSeek V3" className={inputCls} />
              </Field>
              <Field label="上游模型 ID（modelName）">
                <input value={form.modelName} onChange={e => setForm(p => ({ ...p, modelName: e.target.value }))} placeholder="deepseek-chat / qwen2.5:7b / text-embedding-3-small" className={cn(inputCls, "font-mono")} />
              </Field>
              <Field label="Base URL（可选；Ollama 留空用默认端点）">
                <input value={form.baseUrl} onChange={e => setForm(p => ({ ...p, baseUrl: e.target.value }))} placeholder="https://api.deepseek.com/v1" className={cn(inputCls, "font-mono")} />
              </Field>
              <Field label="API Key（Ollama 可留空）">
                <PasswordInput value={form.apiKey ?? ""} onChange={v => setForm(p => ({ ...p, apiKey: v }))} placeholder="sk-..." />
              </Field>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => void handleTest()}
                  disabled={testing || !form.name || !form.modelName}
                  className="h-9 px-4 text-sm border border-border rounded-md hover:bg-muted flex items-center gap-2 disabled:opacity-40"
                >
                  {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  测试连通
                </button>
                {testResult === "ok" && <span className="text-xs text-emerald-600 flex items-center gap-1"><Check className="w-3.5 h-3.5" />连接成功</span>}
                {testResult === "fail" && <span className="text-xs text-red-600 flex items-center gap-1"><X className="w-3.5 h-3.5" />连接失败</span>}
                <div className="ml-auto flex gap-2">
                  <button onClick={() => { setShowAdd(false); setTestResult(null) }} className="h-9 px-4 text-sm border border-border rounded-md hover:bg-muted">取消</button>
                  <button
                    onClick={() => void handleSave()}
                    disabled={!form.name || !form.modelName || saving}
                    className="h-9 px-4 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-40 flex items-center gap-1.5"
                  >
                    {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    保存
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Debug Modal */}
      {showDebug && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-xl shadow-2xl w-[520px] p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold">模型调试 — {models.find(m => m.id === showDebug)?.name}</h3>
              <button onClick={() => { setShowDebug(null); setDebugResult(null) }} className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted">
                <X className="w-4 h-4" />
              </button>
            </div>
            <textarea
              rows={3}
              value={debugMsg}
              onChange={e => setDebugMsg(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent bg-background resize-none mb-3"
            />
            <button
              onClick={() => void handleDebug()}
              disabled={debugging}
              className="h-9 px-4 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 flex items-center gap-2 mb-4 disabled:opacity-60"
            >
              {debugging ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              发起调试调用
            </button>
            {debugResult && (
              <div className="bg-muted/50 border border-border rounded-md p-3 text-xs font-mono text-foreground/90 whitespace-pre-wrap max-h-64 overflow-y-auto">
                {debugResult}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 解析引擎（静态信息，简化） ───────────────────────────────────────────────
function ParserSettings() {
  return (
    <div className="space-y-6">
      <SectionHeader title="解析引擎配置" desc="文档解析管线说明（运行状态见版本信息）" />
      <div className="space-y-3">
        {[
          {
            name: "MinerU",
            status: "内置",
            formats: ["PDF（版式优化）", "Word", "图片（OCR）"],
            desc: "专为 PDF 版式复杂文档优化：光栅化→版面检测→阅读顺序→内容框识别（OCR/表格/图片）→组装",
          },
        ].map(engine => (
          <div key={engine.name} className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{engine.name}</span>
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-100">
                    {engine.status}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{engine.desc}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {engine.formats.map(f => (
                <span key={f} className="text-[10px] px-2 py-0.5 bg-muted rounded-full text-muted-foreground">{f}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Web 搜索配置 ─────────────────────────────────────────────────────────────
function HistorySettings() {
  const [keyword, setKeyword] = useState("")
  const [hits, setHits] = useState<HistoryHit[]>([])
  const [stats, setStats] = useState<HistoryStat[]>([])
  const [searched, setSearched] = useState(false)
  const [searching, setSearching] = useState(false)
  const [clearing, setClearing] = useState(false)

  const loadStats = useCallback(() => {
    void historyApi.stats(30).then(setStats).catch(() => {})
  }, [])
  useEffect(loadStats, [loadStats])

  const handleSearch = async () => {
    if (!keyword.trim()) return
    setSearching(true)
    try {
      const res = await historyApi.search(keyword.trim())
      setHits(res.items)
      setSearched(true)
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setSearching(false)
    }
  }

  const handleClear = async () => {
    if (!window.confirm("确定清空全部聊天历史？所有会话将被删除，此操作不可恢复。")) return
    setClearing(true)
    try {
      const res = await historyApi.clearAll()
      toast(`已清空 ${res.deleted} 个会话`, "info")
      setHits([])
      void loadStats()
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader title="聊天历史" desc="搜索历史消息与按知识库统计使用量" />

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") void handleSearch() }}
            placeholder="搜索历史消息关键词…"
            className="h-9 w-full pl-8 pr-3 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent bg-background"
          />
        </div>
        <button
          onClick={() => void handleSearch()}
          disabled={searching || !keyword.trim()}
          className="h-9 px-4 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-40 flex items-center gap-1.5"
        >
          {searching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          搜索
        </button>
      </div>

      {searched && (
        <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
          {hits.length === 0 ? (
            <div className="text-xs text-muted-foreground py-8 text-center">未找到相关消息</div>
          ) : hits.map(h => (
            <div key={h.messageId} className="px-4 py-3">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1">
                <MessageSquareIcon className="w-3 h-3" />
                <span className="font-medium truncate">{h.sessionTitle}</span>
                <span className={cn("px-1.5 py-0.5 rounded text-[9px] border", h.role === "user" ? "border-primary/30 text-primary" : "border-emerald-200 text-emerald-700")}>
                  {h.role === "user" ? "我" : "AI"}
                </span>
                <span className="ml-auto font-mono">{new Date(h.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2">{h.content}</p>
            </div>
          ))}
        </div>
      )}

      <div>
        <div className="text-sm font-semibold mb-2">按知识库统计（近 30 天）</div>
        <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
          {stats.length === 0 ? (
            <div className="text-xs text-muted-foreground py-6 text-center">暂无统计数据</div>
          ) : stats.map(s => (
            <div key={s.kbId} className="flex items-center gap-3 px-4 py-3">
              <Globe className="w-4 h-4 text-violet-500 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{s.kbName ?? "未知知识库"}</div>
                <div className="text-[11px] text-muted-foreground">{s.messageCount} 条消息 · {s.citationCount} 次引用</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="p-3 border border-red-100 bg-red-50/40 rounded-md">
        <div className="flex items-center justify-between">
          <div className="text-xs text-red-700 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" />
            清空全部会话与聊天历史（不可恢复）
          </div>
          <button
            onClick={() => void handleClear()}
            disabled={clearing}
            className="h-8 px-3 text-xs bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-40 flex items-center gap-1.5"
          >
            {clearing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            清空历史
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── 平台 API Keys ────────────────────────────────────────────────────────────
function ApiKeysSettings() {
  const [keys, setKeys] = useState<PlatformApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newKeyName, setNewKeyName] = useState("")
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setKeys(await apiKeyApi.list())
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const res = await apiKeyApi.create(newKeyName)
      setCreatedKey(res.apiKey)
      void load()
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async (id: string) => {
    if (!window.confirm("确定撤销该 API Key？")) return
    try {
      await apiKeyApi.remove(id)
      toast("密钥已撤销")
      void load()
    } catch (err) {
      toast(errMessage(err), "error")
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <SectionHeader title="平台 API Keys" desc="用于外部应用集成和 CI/CD 流程" />
        <button onClick={() => setShowCreate(true)} className="h-9 px-4 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 flex items-center gap-2">
          <Plus className="w-4 h-4" />生成密钥
        </button>
      </div>

      <div className="p-3 border border-amber-100 bg-amber-50/50 rounded-md text-xs text-amber-700 flex items-start gap-2">
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        API Key 仅在创建时完整显示一次，请立即保存到安全的位置。
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : keys.length === 0 ? (
        <div className="text-xs text-muted-foreground py-10 text-center border border-dashed border-border rounded-lg">暂无 API Keys</div>
      ) : (
        <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
          {keys.map(key => (
            <div key={key.id} className="px-4 py-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium">{key.name}</span>
                <button
                  onClick={() => void handleRevoke(key.id)}
                  className="h-7 px-2 text-xs text-red-600 border border-red-100 rounded hover:bg-red-50 flex items-center gap-1 transition-colors"
                >
                  <X className="w-3 h-3" />撤销
                </button>
              </div>
              <div className="flex items-center gap-4 text-[11px] text-muted-foreground font-mono">
                <span>{key.id.slice(0, 8)}••••••••</span>
                <span>创建 {key.createdAt ? new Date(key.createdAt).toLocaleDateString("zh-CN") : "-"}</span>
                <span>最近使用 {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString("zh-CN") : "从未"}</span>
                <div className="flex gap-1">
                  {(key.scopes ?? []).map(s => (
                    <span key={s} className="px-1.5 py-0.5 bg-muted rounded text-[10px]">{s}</span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Dialog */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-xl shadow-2xl w-[460px] p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-base font-semibold">生成新 API Key</h3>
              <button onClick={() => { setShowCreate(false); setCreatedKey(null); setNewKeyName("") }} className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted">
                <X className="w-4 h-4" />
              </button>
            </div>

            {!createdKey ? (
              <div className="space-y-4">
                <Field label="密钥名称">
                  <input value={newKeyName} onChange={e => setNewKeyName(e.target.value)} placeholder="例如：CI Pipeline / 外部集成" className={inputCls} />
                </Field>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setShowCreate(false)} className="h-9 px-4 text-sm border border-border rounded-md hover:bg-muted">取消</button>
                  <button
                    onClick={() => void handleCreate()}
                    disabled={!newKeyName || creating}
                    className="h-9 px-4 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-40 flex items-center gap-1.5"
                  >
                    {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    生成
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="p-3 bg-emerald-50 border border-emerald-100 rounded-md text-xs text-emerald-700 flex items-start gap-2">
                  <Check className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  密钥已生成。请立即复制并保存，此后将无法再次查看完整密钥。
                </div>
                <div className="relative">
                  <code className="block w-full p-3 bg-muted rounded-md text-xs font-mono break-all pr-16">{createdKey}</code>
                  <button
                    onClick={() => { void navigator.clipboard?.writeText(createdKey); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
                    className="absolute top-2 right-2 h-7 px-2 bg-card border border-border rounded text-xs flex items-center gap-1 hover:bg-muted"
                  >
                    {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                    {copied ? "已复制" : "复制"}
                  </button>
                </div>
                <button
                  onClick={() => { setShowCreate(false); setCreatedKey(null); setNewKeyName("") }}
                  className="w-full h-9 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                >
                  完成
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 任务队列监控 ─────────────────────────────────────────────────────────────
function QueueSettings() {
  const [overview, setOverview] = useState<{ name: string; counts: Record<string, number> }[]>([])
  const [jobs, setJobs] = useState<QueueJobInfo[]>([])
  const [activeQueue, setActiveQueue] = useState<string>("")
  const [jobState, setJobState] = useState("")
  const [loading, setLoading] = useState(true)
  const [jobsLoading, setJobsLoading] = useState(false)

  const loadOverview = useCallback(async () => {
    setLoading(true)
    try {
      const list = await queueApi.overview()
      setOverview(list)
      if (list.length > 0 && !activeQueue) setActiveQueue(list[0].name)
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setLoading(false)
    }
  }, [activeQueue])

  useEffect(() => { void loadOverview() }, [loadOverview])

  const loadJobs = useCallback(async () => {
    if (!activeQueue) return
    setJobsLoading(true)
    try {
      const res = await queueApi.jobs(activeQueue, jobState || undefined, 1, 20)
      setJobs(res.items)
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setJobsLoading(false)
    }
  }, [activeQueue, jobState])

  useEffect(() => { void loadJobs() }, [loadJobs])

  const handleRetry = async (jobId: string | number) => {
    try {
      await queueApi.retry(activeQueue, jobId)
      toast("已重试")
      void loadJobs()
    } catch (err) {
      toast(errMessage(err), "error")
    }
  }

  const handleCancel = async (jobId: string | number) => {
    try {
      await queueApi.cancel(activeQueue, jobId)
      toast("已取消")
      void loadJobs()
    } catch (err) {
      toast(errMessage(err), "error")
    }
  }

  const failedTotal = overview.reduce((sum, q) => sum + (q.counts.failed ?? 0), 0)
  const waitingTotal = overview.reduce((sum, q) => sum + (q.counts.waiting ?? 0), 0)
  const activeTotal = overview.reduce((sum, q) => sum + (q.counts.active ?? 0), 0)
  const completedTotal = overview.reduce((sum, q) => sum + (q.counts.completed ?? 0), 0)

  return (
    <div className="space-y-5">
      <SectionHeader title="任务队列监控" desc="实时监控文档解析与向量化任务状态" />

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: "待处理", value: waitingTotal, color: "text-amber-600", bg: "bg-amber-50", border: "border-amber-100" },
              { label: "执行中", value: activeTotal, color: "text-accent", bg: "bg-blue-50", border: "border-blue-100" },
              { label: "已完成", value: completedTotal, color: "text-emerald-600", bg: "bg-emerald-50", border: "border-emerald-100" },
              { label: "失败", value: failedTotal, color: "text-red-600", bg: "bg-red-50", border: "border-red-100" },
            ].map(s => (
              <div key={s.label} className={cn("p-4 rounded-lg border", s.bg, s.border)}>
                <div className={cn("text-2xl font-bold font-mono", s.color)}>{s.value.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>

          <div>
            <div className="flex items-center gap-2 mb-2">
              <select
                value={activeQueue}
                onChange={e => setActiveQueue(e.target.value)}
                className="h-8 px-2 text-xs border border-border rounded bg-background"
              >
                {overview.map(q => (
                  <option key={q.name} value={q.name}>{q.name}</option>
                ))}
              </select>
              <select
                value={jobState}
                onChange={e => setJobState(e.target.value)}
                className="h-8 px-2 text-xs border border-border rounded bg-background"
              >
                <option value="">全部状态</option>
                {["waiting", "active", "completed", "failed", "delayed", "paused"].map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <button onClick={() => void loadJobs()} className="h-8 px-3 text-xs border border-border rounded hover:bg-muted flex items-center gap-1">
                <RefreshCw className="w-3 h-3" />刷新
              </button>
            </div>
            <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
              {jobsLoading ? (
                <div className="flex justify-center py-8"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
              ) : jobs.length === 0 ? (
                <div className="text-xs text-muted-foreground py-8 text-center">该队列暂无任务</div>
              ) : jobs.map(job => (
                <div key={String(job.id)} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">#{String(job.id)}</span>
                        {job.name}
                        <StateBadge state={job.state} />
                      </div>
                      {job.data && (
                        <div className="text-[11px] text-muted-foreground font-mono truncate mt-0.5">
                          {Object.entries(job.data as Record<string, unknown>).slice(0, 3).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(" · ")}
                        </div>
                      )}
                      {job.failedReason && (
                        <div className="text-[11px] text-red-600 mt-0.5 line-clamp-2">{job.failedReason}</div>
                      )}
                      <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                        {job.processedOn ? `开始 ${new Date(job.processedOn).toLocaleTimeString("zh-CN", { hour12: false })} · ` : ""}
                        {job.finishedOn ? `完成 ${new Date(job.finishedOn).toLocaleTimeString("zh-CN", { hour12: false })}` : new Date(job.timestamp).toLocaleTimeString("zh-CN", { hour12: false })}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {job.state === "failed" && (
                        <button onClick={() => void handleRetry(job.id)} className="h-7 px-2.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 flex items-center gap-1">
                          <RotateCcw className="w-3 h-3" />重试
                        </button>
                      )}
                      {(job.state === "waiting" || job.state === "delayed" || job.state === "active") && (
                        <button onClick={() => void handleCancel(job.id)} className="h-7 px-2.5 text-xs border border-border rounded hover:bg-muted flex items-center gap-1">
                          <X className="w-3 h-3" />取消
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function StateBadge({ state }: { state: string }) {
  const map: Record<string, string> = {
    waiting: "bg-amber-50 text-amber-700 border-amber-100",
    active: "bg-blue-50 text-blue-700 border-blue-100",
    completed: "bg-emerald-50 text-emerald-700 border-emerald-100",
    failed: "bg-red-50 text-red-700 border-red-100",
    delayed: "bg-purple-50 text-purple-700 border-purple-100",
  }
  return (
    <span className={cn("text-[9px] font-medium px-1.5 py-0.5 rounded-full border", map[state] ?? "bg-muted text-muted-foreground border-border")}>
      {state}
    </span>
  )
}

// ─── 审计日志 ─────────────────────────────────────────────────────────────────
function AuditSettings() {
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [actionFilter, setActionFilter] = useState("")
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await auditApi.list(actionFilter || undefined, undefined, page, 20)
      setLogs(res.items)
      setTotal(res.total)
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setLoading(false)
    }
  }, [actionFilter, page])

  useEffect(() => { void load() }, [load])

  const totalPages = Math.max(1, Math.ceil(total / 20))

  return (
    <div className="space-y-4">
      <SectionHeader title="审计日志" desc="查看所有用户操作记录" />
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={actionFilter}
            onChange={e => { setActionFilter(e.target.value); setPage(1) }}
            placeholder="按操作动作筛选（如 kb.create / user.login）…"
            className="h-9 w-full pl-8 pr-3 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-accent bg-background"
          />
        </div>
      </div>
      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2 text-left">动作</th>
                <th className="px-4 py-2 text-left">对象</th>
                <th className="px-4 py-2 text-left">操作人</th>
                <th className="px-4 py-2 text-left">IP</th>
                <th className="px-4 py-2 text-left">时间</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-2.5 font-mono text-xs">{log.action}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground truncate max-w-[200px]">{log.resourceType}{log.resourceId ? ` / ${log.resourceId.slice(0, 8)}` : ""}</td>
                  <td className="px-4 py-2.5 text-xs">{log.userId ? log.userId.slice(0, 8) : "-"}</td>
                  <td className="px-4 py-2.5 text-[11px] text-muted-foreground font-mono">{log.ip || "-"}</td>
                  <td className="px-4 py-2.5 text-[11px] text-muted-foreground font-mono">{new Date(log.createdAt).toLocaleString("zh-CN", { hour12: false })}</td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-xs text-muted-foreground">暂无审计记录</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>共 {total} 条记录</span>
        <div className="flex items-center gap-1">
          <button
            disabled={page <= 1}
            onClick={() => setPage(p => Math.max(1, p - 1))}
            className="h-7 px-2.5 border border-border rounded hover:bg-muted disabled:opacity-40"
          >
            上一页
          </button>
          <span className="px-2 font-mono">{page} / {totalPages}</span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            className="h-7 px-2.5 border border-border rounded hover:bg-muted disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── 全局设置 ─────────────────────────────────────────────────────────────────
function SystemConfigSettings() {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const settings = await systemApi.getSettings()
        setValues(settings as Record<string, unknown>)
      } catch (err) {
        toast(errMessage(err), "error")
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const setBool = (key: string, v: boolean) => setValues(prev => ({ ...prev, [key]: v }))
  const setNum = (key: string, v: string) => setValues(prev => ({ ...prev, [key]: Number(v) || 0 }))

  const handleSave = async () => {
    setSaving(true)
    try {
      await systemApi.updateSettings(values)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      toast(errMessage(err), "error")
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
  }

  return (
    <div className="space-y-6">
      <SectionHeader title="全局设置" desc="配置系统级参数（仅管理员可修改）" />
      <div className="space-y-3">
        {Object.entries(values).filter(([, v]) => typeof v === "boolean").map(([key, v]) => (
          <ToggleRow key={key} label={settingLabel(key)} desc={settingDesc(key)} checked={Boolean(v)} onToggle={val => setBool(key, val)} />
        ))}
      </div>
      <FormSection label="数值配置">
        {Object.entries(values).filter(([, v]) => typeof v === "number").map(([key, v]) => (
          <Field key={key} label={settingLabel(key)}>
            <input
              type="number"
              value={String(v)}
              onChange={e => setNum(key, e.target.value)}
              className={cn(inputCls, "w-40 font-mono")}
            />
          </Field>
        ))}
      </FormSection>
      <SaveButton saved={saved} saving={saving} onClick={() => void handleSave()} />
    </div>
  )
}

function settingLabel(key: string): string {
  const map: Record<string, string> = {
    allowPublicRegistration: "允许公开注册",
    requireInvitation: "注册需要管理员邀请",
    maxUploadSizeMb: "单文件最大上传大小 (MB)",
    maxKbsPerUser: "每用户最大知识库数量",
    maxSessionsPerUser: "每用户最大会话数量",
    defaultWebSearchEnabled: "默认开启 Web 搜索",
  }
  return map[key] ?? key
}
function settingDesc(key: string): string | undefined {
  const map: Record<string, string> = {
    allowPublicRegistration: "关闭后仅邀请链接可注册",
    requireInvitation: "开启后所有注册均需邀请链接",
    defaultWebSearchEnabled: "新会话默认启用联网搜索",
  }
  return map[key]
}

// ─── 版本信息 ─────────────────────────────────────────────────────────────────
function VersionSettings() {
  const [info, setInfo] = useState<{ version?: string; services?: Record<string, { ok?: boolean; latencyMs?: number; detail?: string }>; timestamp?: string } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      try {
        setInfo(await systemApi.info())
      } catch (err) {
        toast(errMessage(err), "error")
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const serviceLabels: Record<string, string> = {
    postgres: "PostgreSQL",
    redis: "Redis",
    neo4j: "Neo4j",
  }

  return (
    <div className="space-y-6">
      <SectionHeader title="版本信息" desc="当前系统版本与运行环境详情" />
      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <div className="bg-card border border-border rounded-lg divide-y divide-border">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-muted-foreground">产品版本</span>
              <span className="text-sm font-mono">{info?.version ?? "-"}</span>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-muted-foreground">探测时间</span>
              <span className="text-sm font-mono">{info?.timestamp ? new Date(info.timestamp).toLocaleString("zh-CN", { hour12: false }) : "-"}</span>
            </div>
          </div>

          <div>
            <div className="text-sm font-semibold mb-2 flex items-center gap-1.5"><Server className="w-4 h-4" />依赖服务健康</div>
            <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
              {Object.entries(info?.services ?? {}).map(([name, s]) => (
                <div key={name} className="flex items-center gap-3 px-4 py-3">
                  <Database className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <span className="text-sm font-medium flex-1">{serviceLabels[name] ?? name}</span>
                  {s?.ok ? (
                    <span className="flex items-center gap-1 text-[10px] text-emerald-600"><CheckCircle className="w-3 h-3" />正常{s.latencyMs != null ? ` · ${s.latencyMs}ms` : ""}</span>
                  ) : (
                    <span className="flex items-center gap-1 text-[10px] text-red-600"><XCircle className="w-3 h-3" />异常{s?.detail ? ` · ${s.detail}` : ""}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Shared UI Primitives ─────────────────────────────────────────────────────
const inputCls = "flex h-9 w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"

function FormRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function SectionHeader({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="mb-2">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {desc && <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>}
    </div>
  )
}

function FormSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-3">{label}</div>
      <div className="space-y-3 max-w-md">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium">{label}</label>
      {children}
    </div>
  )
}

function SaveButton({ saved, saving, onClick }: { saved: boolean; saving?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={saving}
      className={cn(
        "h-9 px-4 text-sm rounded-md flex items-center gap-2 transition-colors disabled:opacity-60",
        saved ? "bg-emerald-600 text-white" : "bg-primary text-primary-foreground hover:bg-primary/90",
      )}
    >
      {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <Check className="w-3.5 h-3.5" /> : null}
      {saving ? "保存中…" : saved ? "已保存" : "保存更改"}
    </button>
  )
}

function PasswordInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <input
        type={show ? "text" : "password"}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(inputCls, "pr-10 font-mono")}
      />
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  )
}

function ToggleRow({ label, desc, checked, onToggle }: { label: string; desc?: string; checked: boolean; onToggle: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between p-3 bg-card border border-border rounded-lg">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {desc && <div className="text-xs text-muted-foreground">{desc}</div>}
      </div>
      <button onClick={() => onToggle(!checked)}>
        {checked ? <ToggleRight className="w-8 h-8 text-accent" /> : <ToggleLeft className="w-8 h-8 text-muted-foreground" />}
      </button>
    </div>
  )
}

function MessageSquareIcon({ className }: { className?: string }) {
  return <MessageSquare className={className} />
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

// ─── 模型用量（GET /me/model-usage——所有用户可见，查看自己的 token 消耗） ───
function ModelUsageSettings() {
  const [rows, setRows] = useState<ModelUsageRow[]>([])
  const [summary, setSummary] = useState<{ totalTokens: number; totalCalls: number }>({ totalTokens: 0, totalCalls: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    usageApi.listMine().then((res) => {
      setRows(res.items)
      setSummary({ totalTokens: res.totalTokens, totalCalls: res.totalCalls })
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const fmt = (n: number) => n.toLocaleString("zh-CN")

  if (loading) {
    return <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="模型用量"
        desc="您在各对话模型上的调用次数与 Token 消耗（个人维度）"
      />
      {/* 汇总卡片 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-xs text-muted-foreground">累计调用</div>
          <div className="text-2xl font-semibold mt-1">{fmt(summary.totalCalls)} 次</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-xs text-muted-foreground">累计 Token</div>
          <div className="text-2xl font-semibold mt-1">{fmt(summary.totalTokens)}</div>
        </div>
      </div>

      {/* 明细表 */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
              <th className="px-4 py-2 text-left">模型</th>
              <th className="px-4 py-2 text-left">类型</th>
              <th className="px-4 py-2 text-right">调用次数</th>
              <th className="px-4 py-2 text-right">输入 Token</th>
              <th className="px-4 py-2 text-right">输出 Token</th>
              <th className="px-4 py-2 text-right">合计</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground text-xs">暂无用量数据（发起对话后自动统计）</td></tr>
            ) : rows.map((r) => (
              <tr key={r.modelId} className="hover:bg-muted/30">
                <td className="px-4 py-2.5 font-medium">{r.modelName || r.modelId.slice(0, 8)}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{r.type === "chat" ? "对话" : r.type === "embedding" ? "向量化" : "重排"}</td>
                <td className="px-4 py-2.5 text-right font-mono">{fmt(r.calls)}</td>
                <td className="px-4 py-2.5 text-right font-mono">{fmt(r.inputTokens)}</td>
                <td className="px-4 py-2.5 text-right font-mono">{fmt(r.outputTokens)}</td>
                <td className="px-4 py-2.5 text-right font-mono">{fmt(r.inputTokens + r.outputTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── 模型配置（普通用户只读视图：查看可用模型与默认模型，无管理操作） ─────────
// 模型列表（BYOK 分区块共用：我的模型 / 全局默认）
function ModelList({ items, isSuper }: { items: Model[]; isSuper: boolean }) {
  const toast_ = toast
  const [debugId, setDebugId] = useState<string | null>(null)
  const [debugMsg, setDebugMsg] = useState("你好，请简单介绍一下自己。")
  const [debugResult, setDebugResult] = useState<string | null>(null)
  const [debugging, setDebugging] = useState(false)

  const runDebug = async (m: Model) => {
    if (debugging) return
    setDebugging(true)
    setDebugResult(null)
    try {
      const res = await modelApi.debug(m.id, debugMsg)
      setDebugResult((res as { output?: string }).output ?? (res as { response?: string }).response ?? "（无输出）")
    } catch (err) {
      toast_(errMessage(err), "error")
    } finally {
      setDebugging(false)
    }
  }

  return (
    <>
      <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
        <div className="grid grid-cols-5 px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground bg-muted/30">
          <div>供应商</div>
          <div className="col-span-2">模型</div>
          <div>类型</div>
          <div>状态</div>
        </div>
        {items.map(m => (
          <div key={m.id} className="grid grid-cols-5 items-center px-4 py-3">
            <div className="text-xs text-muted-foreground">{PROVIDER_LABELS[m.provider] ?? m.provider}</div>
            <div className="col-span-2 min-w-0">
              <div className="text-sm font-mono font-medium truncate">{m.name}</div>
              <div className="text-[10px] text-muted-foreground font-mono truncate">{m.modelName}</div>
            </div>
            <div className="text-xs text-muted-foreground">
              {MODEL_TYPE_LABELS[m.type] ?? m.type}
              {m.isDefault && <span className="ml-1.5 text-[9px] text-amber-600 border border-amber-200 rounded-full px-1.5 py-0.5">默认</span>}
            </div>
            <div className="flex items-center gap-2">
              {m.enabled
                ? <span className="flex items-center gap-1 text-[10px] text-emerald-600"><CheckCircle className="w-3 h-3" />可用</span>
                : <span className="flex items-center gap-1 text-[10px] text-muted-foreground"><XCircle className="w-3 h-3" />停用</span>}
              <button
                onClick={() => { void modelApi.testSaved(m.id).then(res => toast_(res.ok ? "连接正常" : `连接失败：${res.error}`, res.ok ? "success" : "error")) }}
                className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-accent hover:bg-accent/10 transition-colors" title="测试连通"
              >
                <RefreshCw className="w-3 h-3" />
              </button>
              <button
                onClick={() => { setDebugId(m.id); setDebugResult(null) }}
                disabled={m.userId === null && !isSuper}
                className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-accent hover:bg-accent/10 transition-colors disabled:opacity-30 disabled:pointer-events-none" title="调试"
              >
                <Play className="w-3 h-3" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* 调试弹窗 */}
      {debugId && (() => {
        const m = items.find(x => x.id === debugId)
        if (!m) return null
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="fixed inset-0 bg-black/30" onClick={() => setDebugId(null)} />
            <div className="relative z-50 bg-card border border-border rounded-xl shadow-2xl w-[480px] p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-semibold">调试 · {m.name}</h2>
                <button onClick={() => setDebugId(null)} className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:bg-muted"><X className="w-4 h-4" /></button>
              </div>
              <textarea value={debugMsg} onChange={e => setDebugMsg(e.target.value)} rows={3} className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background" />
              <div className="flex justify-end gap-2 mt-3">
                <button onClick={() => setDebugId(null)} className="h-8 px-4 text-sm border border-border rounded hover:bg-muted">取消</button>
                <button onClick={() => void runDebug(m)} disabled={debugging} className="h-8 px-4 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2">
                  {debugging && <Loader2 className="w-3.5 h-3.5 animate-spin" />}运行
                </button>
              </div>
              {debugResult && (
                <div className="mt-3 text-xs font-mono whitespace-pre-wrap bg-muted/30 border border-border rounded-md p-3 max-h-48 overflow-y-auto">{debugResult}</div>
              )}
            </div>
          </div>
        )
      })()}
    </>
  )
}

function ModelReadonlySettings() {
  const [models, setModels] = useState<Model[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    modelApi.list().then((res) => { setModels(res); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  if (loading) return <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>

  return (
    <div className="space-y-6">
      <SectionHeader title="模型配置" desc="当前平台可用的模型（对话 / Embedding / 重排序）。模型管理由系统管理员维护。" />
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
              <th className="px-4 py-2 text-left">模型</th>
              <th className="px-4 py-2 text-left">类型</th>
              <th className="px-4 py-2 text-left">模型 ID</th>
              <th className="px-4 py-2 text-right">状态</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {models.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground text-xs">暂无模型配置</td></tr>
            ) : models.map((m) => (
              <tr key={m.id} className="hover:bg-muted/30">
                <td className="px-4 py-2.5">
                  <div className="font-medium">{m.name}</div>
                  <div className="text-[10px] text-muted-foreground font-mono">{m.baseUrl}</div>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{MODEL_TYPE_LABELS[m.type] ?? m.type}</td>
                <td className="px-4 py-2.5 font-mono text-xs">{m.modelName}</td>
                <td className="px-4 py-2.5 text-right">
                  {m.isDefault && (
                    <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-primary/10 text-primary border border-primary/20">默认</span>
                  )}
                  {m.userId === null && (
                    <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-muted text-muted-foreground border border-border">全局</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        对话模型在聊天窗口中选择；向量化/重排序由系统自动使用默认模型。
      </p>
    </div>
  )
}
