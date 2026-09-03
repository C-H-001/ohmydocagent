// 聊天页（frontend/src/views/chat/ChatView.tsx，Task 5.6）
// 真实 API 对接（轻量模式，核心链路 = SSE 流式）：
// - 会话：GET/POST /chat/sessions、PUT /chat/sessions/:id（重命名/置顶）、
//   DELETE /chat/sessions/:id、DELETE /chat/sessions/batch、
//   DELETE /chat/sessions/:id/messages、DELETE /chat/history（清空全部）
// - 消息：GET /chat/sessions/:id/messages（历史回放）；发送走
//   hooks/useChatStream（fetch POST → ReadableStream → SSE 事件分派：
//   stage → RAG 进度条 / tool_call → 工具树 / reasoning_delta → 深度思考 /
//   delta → 正文 / references → 引用 / done → 完成 / error → 中文文案）
// - 模型选择：GET /models?type=chat
// - @提及：GET /kbs + GET /kbs/:id/knowledge → 生成 @kb:<uuid>/@file:<uuid>
// - 图片附件：POST /chat/sessions/:id/attachments（multipart，仅图片——文件附件已删）
// - 停止生成：POST /chat/sessions/:id/stop（useChatStream.stop 内部调用）

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react"
import {
  Plus, Search, MoreHorizontal, Trash2, Edit3,
  MessageSquare, Send, Square, ChevronDown, ChevronRight, X,
  AtSign, Copy,
  RefreshCw, Cpu, Check, AlertCircle, Loader2,
  FileText, ChevronUp, Info, Bot, User, Sparkles,
  CheckSquare, Pin, PinOff, Network, Zap,
  ExternalLink, Images as ImagesIcon, FileSearch
} from "lucide-react"
import { cn, toast, ToastHost } from "../../components/ui"
import { api } from "../../api/client"
import {
  chatApi, listChatModels, listKbsForMention,
  listKnowledgeForMention, type RagReference, type SendMessageBody,
  type SessionListItem,
} from "../../api/chat"
import { useChatStream, type ToolCallRecord } from "../../hooks/useChatStream"
import type { Knowledge, KnowledgeBase, Message, Model } from "../../api/types"

// ─── UI 消息模型（历史回放 + 流式增量共用） ─────────────────────────────────
interface UiMessage {
  /** 后端消息 id（流式中为临时 id，done 后由 messageId 替换） */
  id: string
  role: "user" | "assistant"
  content: string
  reasoning?: string
  toolCalls?: ToolCallRecord[]
  ragSteps?: { label: string; status: "done" | "loading" }[]
  references?: RagReference[]
  modelName?: string
  createdAt?: string
  /** 流式生成中（骨架屏 + 停止按钮态） */
  streaming?: boolean
  /** 生成被中断（done.interrupted） */
  interrupted?: boolean
  /** token 用量（done.usage：输入/输出/缓存命中——Header 顶栏展示） */
  usage?: { inputTokens?: number; outputTokens?: number; cacheHitTokens?: number }
  /** 错误展示（error 事件/HTTP 错误） */
  error?: string
}

/** RAG 阶段 label 映射（协议 stage 名 → 展示文案） */
const RAG_STAGE_LABELS: Record<string, string> = {
  search: "向量检索",
  rerank: "重排序",
  merge: "上下文合并",
  generate: "生成回答",
}

const EMPTY_REF: RagReference[] = []

export default function ChatView() {
  // ── 会话 ──
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [sessionSearch, setSessionSearch] = useState("")
  const [batchMode, setBatchMode] = useState(false)
  const [batchSelected, setBatchSelected] = useState<string[]>([])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [sessionMenuOpen, setSessionMenuOpen] = useState<string | null>(null)

  // ── 消息 ──
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [messageLoading, setMessageLoading] = useState(false)
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null)
  // 最近一次生成 token 用量（顶栏展示：缓存命中/未命中/输出）
  const [lastUsage, setLastUsage] = useState<{ inputTokens?: number; outputTokens?: number; cacheHitTokens?: number } | null>(null)

  // ── 模型 / 提及 / 附件 ──
  const [models, setModels] = useState<Model[]>([])
  const [selectedModelId, setSelectedModelId] = useState("")
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [mentionKbs, setMentionKbs] = useState<KnowledgeBase[]>([])
  const [mentionFiles, setMentionFiles] = useState<Record<string, Knowledge[]>>({})
  const [mentionKbOpen, setMentionKbOpen] = useState<string | null>(null)
  const [showMentionPicker, setShowMentionPicker] = useState(false)

  // @ 引用（KB/文档）——特殊框（chip）态，不塞入文本框文本（对齐 WeKnora mention）
  const [mentions, setMentions] = useState<{ kind: "kb" | "file"; id: string; title: string }[]>([])


  // ── 引用抽屉 ──
  const [citationDrawerMsgId, setCitationDrawerMsgId] = useState<string | null>(null)
  // 引用来源抽屉宽度（拖左边缘调整，会话内保持）
  const [citationWidth, setCitationWidth] = useState(380)
  const [input, setInput] = useState("")
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({})
  const [expandedRAG, setExpandedRAG] = useState<Record<string, boolean>>({})
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({})
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const { send, stop, generating } = useChatStream()

  // ── 初始加载：会话列表 + 对话模型 + 提及知识库 ──
  useEffect(() => {
    void (async () => {
      try {
        const [sessRes, modelList, kbRes] = await Promise.all([
          chatApi.listSessions(),
          listChatModels(),
          listKbsForMention(),
        ])
        setSessions(sessRes.items)
        setModels(modelList)
        setMentionKbs(kbRes.items)
        const defaultModel = modelList.find(m => m.isDefault) ?? modelList[0]
        if (defaultModel) setSelectedModelId(defaultModel.id)
        if (sessRes.items.length > 0) {
          setActiveSessionId(sessRes.items[0].id)
        }
      } catch (err) {
        toast(errMessage(err), "error")
      } finally {
        setSessionLoading(false)
      }
    })()
  }, [])

  // ── 选中会话 → 加载历史消息 ──
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([])
      return
    }
    let cancelled = false
    setMessageLoading(true)
    const sessionId = activeSessionId
    void (async () => {
      try {
        const res = await chatApi.listMessages(sessionId, 1, 100)
        if (cancelled) return
        setMessages(res.items.map(m => toUiMessage(m)))
        // 顶栏 token 用量恢复：取最后一条带 usage 的 assistant 消息
        const last = [...res.items].reverse().find(m => m.role === "assistant" && m.usage)
        setLastUsage((last?.usage as { inputTokens?: number; outputTokens?: number; cacheHitTokens?: number } | undefined) ?? null)
      } catch (err) {
        if (!cancelled) toast(errMessage(err), "error")
      } finally {
        if (!cancelled) setMessageLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [activeSessionId])

  // 滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, generating])

  const refreshSessions = useCallback(async () => {
    try {
      const res = await chatApi.listSessions()
      setSessions(res.items)
    } catch { /* 静默：下次操作重试 */ }
  }, [])

  const selectSession = (id: string) => {
    setActiveSessionId(id)
    setSessionMenuOpen(null)
    setStreamingMsgId(null)
  }

  // ── 新建会话 ──
  const handleNewSession = async () => {
    try {
      const session = await chatApi.createSession()
      await refreshSessions()
      setActiveSessionId(session.id)
      setMessages([])
      setStreamingMsgId(null)
    } catch (err) {
      toast(errMessage(err), "error")
    }
  }

  // ── 重命名 / 置顶 ──
  const handleRename = async (id: string, title: string) => {
    try {
      await chatApi.updateSession(id, { title })
      setSessions(prev => prev.map(s => (s.id === id ? { ...s, title } : s)))
      toast("会话已重命名")
    } catch (err) {
      toast(errMessage(err), "error")
    }
  }
  const handlePin = async (id: string, pinned: boolean) => {
    try {
      await chatApi.updateSession(id, { pinned })
      setSessions(prev => prev.map(s => (s.id === id ? { ...s, pinned } : s)))
      toast(pinned ? "已置顶" : "已取消置顶")
    } catch (err) {
      toast(errMessage(err), "error")
    }
  }

  // ── 删除 / 批量删除 / 清空 ──
  const handleDeleteSession = async (id: string) => {
    try {
      await chatApi.deleteSession(id)
      setSessions(prev => prev.filter(s => s.id !== id))
      if (activeSessionId === id) setActiveSessionId(null)
      toast("会话已删除")
    } catch (err) {
      toast(errMessage(err), "error")
    }
  }
  const handleBatchDelete = async () => {
    if (batchSelected.length === 0) return
    try {
      const res = await chatApi.deleteSessions(batchSelected)
      setSessions(prev => prev.filter(s => !batchSelected.includes(s.id)))
      if (activeSessionId && batchSelected.includes(activeSessionId)) setActiveSessionId(null)
      setBatchSelected([])
      toast(`已删除 ${res.deleted} 个会话`, "info")
    } catch (err) {
      toast(errMessage(err), "error")
    }
  }
  const handleClearAll = async () => {
    if (!window.confirm("确定清空全部会话？此操作不可恢复。")) return
    try {
      const res = await api.del<{ deleted: number }>("/chat/history")
      setSessions([])
      setActiveSessionId(null)
      toast(`已清空 ${res.deleted} 个会话`, "info")
    } catch (err) {
      toast(errMessage(err), "error")
    }
  }

  // ── 附件上传（图片预览 + 附件引用） ──


  // ── 发送消息（SSE 流式核心） ──
  // 添加 @ 引用 chip（去重：同 kb/file 只保留一次）
  const addMention = (m: { kind: "kb" | "file"; id: string; title: string }) => {
    setMentions(prev => prev.some(x => x.kind === m.kind && x.id === m.id) ? prev : [...prev, m])
  }

  const handleSend = async () => {
    const content = input.trim()
    if (!content) return
    if (!activeSessionId) {
      toast("请先创建或选择一个会话", "info")
      return
    }
    if (generating) return

    const sessionId = activeSessionId
    const userMsgId = `u-${Date.now()}`
    const streamMsgId = `a-${Date.now()}`
    const userMsg: UiMessage = { id: userMsgId, role: "user", content }
    const streamMsg: UiMessage = {
      id: streamMsgId,
      role: "assistant",
      content: "",
      reasoning: "",
      toolCalls: [],
      ragSteps: [],
      streaming: true,
    }

    // 附件：图片 + 文件 attachmentIds（上传失败的图片不引用）
    // @提及：特殊框（mentions）为主——从 mentions 派生 kb/file id；文本中
    // 手打的 @kb:xxx/@file:xxx 亦解析（兼容粘贴/历史习惯，双通道合并见后端）
    const mentionKbIds = Array.from(new Set([
      ...mentions.filter(m => m.kind === "kb").map(m => m.id),
      ...[...content.matchAll(/@kb:([0-9a-fA-F-]{36})/g)].map(m => m[1]),
    ]))
    const mentionKnowledgeIds = Array.from(new Set([
      ...mentions.filter(m => m.kind === "file").map(m => m.id),
      ...[...content.matchAll(/@file:([0-9a-fA-F-]{36})/g)].map(m => m[1]),
    ]))

    setMessages(prev => [...prev, userMsg, streamMsg])
    setInput("")
    setMentions([])
    setStreamingMsgId(streamMsgId)

    const body: SendMessageBody = {
      content,
      mentionKbIds: mentionKbIds.length ? mentionKbIds : undefined,
      mentionKnowledgeIds: mentionKnowledgeIds.length ? mentionKnowledgeIds : undefined,
    }

    await send(sessionId, body, {
      onStage: (stage, status, detail) => {
        setMessages(prev => prev.map(m => {
          if (m.id !== streamMsgId) return m
          const label = RAG_STAGE_LABELS[stage] ?? stage
          if (status === "start") {
            // 追加新阶段（loading）
            const exists = m.ragSteps?.some(s => s.label === label)
            const steps = exists ? m.ragSteps! : [...(m.ragSteps ?? []), { label, status: "loading" as const }]
            return { ...m, ragSteps: steps.map(s => s.label === label ? { ...s, status: "loading" as const } : s) }
          }
          // done / error → 标记完成（error 阶段带 detail）
          const steps = (m.ragSteps ?? []).map(s =>
            s.label === label ? { ...s, status: status === "done" ? ("done" as const) : ("done" as const) } : s,
          )
          if (status === "error" && detail) {
            return { ...m, ragSteps: steps, error: detail }
          }
          return { ...m, ragSteps: steps }
        }))
      },
      onToolCall: (call) => {
        setMessages(prev => prev.map(m =>
          m.id === streamMsgId
            ? { ...m, toolCalls: [...(m.toolCalls ?? []), call] }
            : m,
        ))
      },
      onReasoningDelta: (text) => {
        setMessages(prev => prev.map(m =>
          m.id === streamMsgId ? { ...m, reasoning: (m.reasoning ?? "") + text } : m,
        ))
      },
      onDelta: (text) => {
        setMessages(prev => prev.map(m =>
          m.id === streamMsgId ? { ...m, content: m.content + text } : m,
        ))
      },
      onReferences: (refs) => {
        setMessages(prev => prev.map(m =>
          m.id === streamMsgId ? { ...m, references: refs } : m,
        ))
      },
      onDone: ({ messageId, interrupted, usage }) => {
        setMessages(prev => prev.map(m =>
          m.id === streamMsgId
            ? { ...m, id: messageId || m.id, streaming: false, interrupted: interrupted === true, modelName: currentModel?.name, ...(usage ? { usage } : {}) }
            : m,
        ))
        if (usage) setLastUsage(usage)
        setStreamingMsgId(null)
        refreshSessions()
      },
      onError: (code, message) => {
        setMessages(prev => prev.map(m =>
          m.id === streamMsgId
            ? { ...m, streaming: false, error: message || `生成失败（${code}）` }
            : m,
        ))
        setStreamingMsgId(null)
      },
    })
  }

  const handleStop = () => {
    if (activeSessionId) stop(activeSessionId)
    setMessages(prev => prev.map(m =>
      m.id === streamingMsgId ? { ...m, streaming: false, interrupted: true } : m,
    ))
    setStreamingMsgId(null)
  }

  const currentModel = models.find(m => m.id === selectedModelId)

  // ── 分组（今天/昨天/更早） ──
  const filteredSessions = sessions.filter(s =>
    !sessionSearch || s.title.toLowerCase().includes(sessionSearch.toLowerCase()),
  )
  const groups = groupSessions(filteredSessions)

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Session Sidebar ── */}
      <div className="w-56 flex-shrink-0 border-r border-border bg-card/30 flex flex-col">
        <div className="p-3 border-b border-border flex-shrink-0 space-y-1.5">
          <button
            onClick={handleNewSession}
            disabled={sessionLoading}
            className="w-full flex items-center gap-2 h-8 px-3 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" />
            新建会话
          </button>
          <button
            onClick={() => { setBatchMode(!batchMode); setBatchSelected([]) }}
            className={cn(
              "w-full flex items-center justify-center gap-1.5 h-7 px-3 text-xs rounded-md border transition-colors",
              batchMode ? "bg-accent/10 border-accent/30 text-accent" : "border-border text-muted-foreground hover:bg-muted",
            )}
          >
            <CheckSquare className="w-3.5 h-3.5" />
            {batchMode ? "退出批量管理" : "批量管理"}
            {batchMode && batchSelected.length > 0 && <span className="font-mono">({batchSelected.length})</span>}
          </button>
        </div>

        <div className="p-2 border-b border-border flex-shrink-0">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
            <input
              value={sessionSearch}
              onChange={e => setSessionSearch(e.target.value)}
              placeholder="搜索会话..."
              className="w-full h-7 pl-7 pr-2 text-xs bg-muted/50 border border-border rounded focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {sessionLoading ? (
            <div className="px-3 py-4 space-y-2">
              {[0, 1, 2].map(i => <div key={i} className="h-8 bg-muted/50 rounded animate-pulse" />)}
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {sessionSearch ? "无匹配会话" : "暂无会话，点击上方新建"}
            </div>
          ) : (
            groups.map(([group, list]) => (
              <div key={group}>
                <div className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{group}</div>
                {list.map(session => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={activeSessionId === session.id}
                    batchMode={batchMode}
                    batchSelected={batchSelected}
                    renamingId={renamingId}
                    renameValue={renameValue}
                    menuOpen={sessionMenuOpen === session.id}
                    onToggleSelect={() => {
                      setBatchSelected(prev => prev.includes(session.id) ? prev.filter(s => s !== session.id) : [...prev, session.id])
                    }}
                    onSelect={() => selectSession(session.id)}
                    onStartRename={() => { setRenamingId(session.id); setRenameValue(session.title); setSessionMenuOpen(null) }}
                    onRename={(title) => { void handleRename(session.id, title); setRenamingId(null) }}
                    onTogglePin={() => { void handlePin(session.id, !session.pinned); setSessionMenuOpen(null) }}
                    onDelete={() => { void handleDeleteSession(session.id); setSessionMenuOpen(null) }}
                    onToggleMenu={() => setSessionMenuOpen(sessionMenuOpen === session.id ? null : session.id)}
                  />
                ))}
              </div>
            ))
          )}
        </div>

        <div className="p-2 border-t border-border flex-shrink-0">
          {batchMode ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-accent flex-1 truncate">已选 {batchSelected.length} 项</span>
              <button
                disabled={batchSelected.length === 0}
                onClick={handleBatchDelete}
                className="flex items-center gap-1 text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded disabled:opacity-40 transition-colors"
              >
                <Trash2 className="w-3 h-3" />删除选中
              </button>
            </div>
          ) : (
            <button
              onClick={handleClearAll}
              disabled={sessions.length === 0}
              className="w-full text-xs text-muted-foreground hover:text-red-600 flex items-center gap-1.5 px-2 py-1 rounded hover:bg-red-50 transition-colors disabled:opacity-40"
            >
              <Trash2 className="w-3 h-3" />
              清空全部会话
            </button>
          )}
        </div>
      </div>

      {/* ── Chat Area ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header：左标题 / 中 token 用量（缓存命中/未命中/输出） / 右模型+垃圾桶 */}
        <div className="flex items-center justify-between px-5 py-2.5 border-b border-border bg-card flex-shrink-0 gap-3">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Bot className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <span className="text-sm font-medium truncate">{sessions.find(s => s.id === activeSessionId)?.title || "新对话"}</span>
            {generating && <Loader2 className="w-3.5 h-3.5 animate-spin text-accent flex-shrink-0" />}
          </div>
          {/* token 用量（会话页顶部条中间）：缓存命中/未命中/输出 */}
          <div className="flex items-center gap-2.5 text-[10px] font-mono text-muted-foreground whitespace-nowrap">
            {lastUsage && (lastUsage.outputTokens ?? 0) > 0 ? (
              <>
                <span className="flex items-center gap-1" title="输入缓存命中 token（prompt cache）">
                  <Zap className="w-3 h-3 text-amber-500" />缓存命中
                  <span className="text-amber-600 font-semibold">{lastUsage.cacheHitTokens ?? 0}</span>
                </span>
                <span className="flex items-center gap-1" title="输入未命中缓存 token">
                  未命中
                  <span className="text-muted-foreground font-semibold">{Math.max(0, (lastUsage.inputTokens ?? 0) - (lastUsage.cacheHitTokens ?? 0))}</span>
                </span>
                <span className="flex items-center gap-1" title="本次输出 token">
                  输出
                  <span className="text-emerald-600 font-semibold">{lastUsage.outputTokens}</span>
                </span>
              </>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-2 flex-1">
            <span className="text-xs text-muted-foreground font-mono hidden sm:inline">{currentModel?.modelName ?? "未选择模型"}</span>
            {activeSessionId && messages.length > 0 && (
              <button
                onClick={() => { if (activeSessionId) void chatApi.clearSessionMessages(activeSessionId).then(() => { setMessages([]); setLastUsage(null); toast("会话消息已清空", "info") }) }}
                className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="清空本会话消息"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Messages */}
        {messageLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <EmptyChatState />
        ) : (
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
              {messages.map(msg => (
                <ChatMessage
                  key={msg.id}
                  msg={msg}
                  expandedThinking={expandedThinking}
                  expandedRAG={expandedRAG}
                  expandedTools={expandedTools}
                  onToggleThinking={id => setExpandedThinking(prev => ({ ...prev, [id]: !prev[id] }))}
                  onToggleRAG={id => setExpandedRAG(prev => ({ ...prev, [id]: !prev[id] }))}
                  onToggleTool={id => setExpandedTools(prev => ({ ...prev, [id]: !prev[id] }))}
                  onOpenCitationDrawer={setCitationDrawerMsgId}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          </div>
        )}

        {/* Input area */}
        <div className="px-4 py-4 border-t border-border bg-card flex-shrink-0">
          <div className="max-w-5xl mx-auto">
            <div className="border border-border rounded-xl bg-background focus-within:ring-2 focus-within:ring-accent/30 transition-all overflow-visible">
              {/* @ 引用（KB/文档）特殊框 chips——不在文本框内（对齐 WeKnora mention） */}
              {mentions.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-3 pt-3">
                  {mentions.map(m => (
                    <span
                      key={`${m.kind}-${m.id}`}
                      className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border border-violet-200 bg-violet-50 text-violet-700"
                    >
                      {m.kind === "kb" ? <Network className="w-3 h-3" /> : <FileText className="w-3 h-3" />}
                      <span className="font-medium truncate max-w-[180px]">{m.title}</span>
                      <button
                        onClick={() => setMentions(prev => prev.filter(x => !(x.kind === m.kind && x.id === m.id)))}
                        className="text-violet-400 hover:text-violet-700 transition-colors"
                        title="移除引用"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend() } }}
                placeholder="输入消息，@ 引用知识库，Shift+Enter 换行…"
                rows={3}
                className="w-full px-4 pt-3 text-sm bg-transparent focus:outline-none resize-none placeholder:text-muted-foreground"
              />
              <div className="flex items-center gap-2 px-3 py-2 border-t border-border bg-muted/30">
                {/* @mention */}
                <div className="relative">
                  <button
                    onClick={() => setShowMentionPicker(!showMentionPicker)}
                    className="h-7 px-2 rounded text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    <AtSign className="w-3.5 h-3.5" />
                    引用
                  </button>
                  {showMentionPicker && (
                    <>
                      <div className="fixed inset-0 z-[50]" onClick={() => setShowMentionPicker(false)} />
                      <div className="absolute bottom-10 left-0 z-[60] w-80 bg-card border border-border rounded-lg shadow-xl py-1 max-h-72 overflow-y-auto">
                        <div className="px-3 py-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">知识库 / 文档</div>
                        {mentionKbs.length === 0 && (
                          <div className="px-3 py-3 text-xs text-muted-foreground">暂无知识库，请先创建</div>
                        )}
                        {mentionKbs.map(kb => (
                          <div key={kb.id}>
                            <button
                              onClick={() => {
                                setMentionKbOpen(mentionKbOpen === kb.id ? null : kb.id)
                                if (!mentionFiles[kb.id]) {
                                  void listKnowledgeForMention(kb.id).then(res => {
                                    setMentionFiles(prev => ({ ...prev, [kb.id]: res.items }))
                                  }).catch(err => toast(errMessage(err), "error"))
                                }
                              }}
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted text-left"
                            >
                              <Network className="w-3.5 h-3.5 text-violet-500 flex-shrink-0" />
                              <span className="flex-1 truncate">{kb.name}</span>
                              {mentionKbOpen === kb.id
                                ? <ChevronDown className="w-3 h-3 text-muted-foreground" />
                                : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
                            </button>
                            {mentionKbOpen === kb.id && (
                              <div className="pl-7 pr-2 pb-1 space-y-0.5">
                                <button
                                  onClick={() => {
                                    addMention({ kind: "kb", id: kb.id, title: kb.name })
                                    setShowMentionPicker(false)
                                  }}
                                  className="w-full flex items-center gap-1.5 px-2 py-1 text-xs text-violet-600 hover:bg-violet-50 rounded text-left"
                                >
                                  <Network className="w-3 h-3" />整个知识库
                                </button>
                                {mentionFiles[kb.id]?.map(file => (
                                  <button
                                    key={file.id}
                                    onClick={() => {
                                      addMention({ kind: "file", id: file.id, title: file.title })
                                      setShowMentionPicker(false)
                                    }}
                                    className="w-full flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:bg-muted rounded text-left"
                                  >
                                    <FileText className="w-3 h-3" />
                                    <span className="truncate flex-1">{file.title}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {/* Model selector */}
                <div className="relative ml-auto">
                  <button
                    onClick={() => setShowModelPicker(!showModelPicker)}
                    className="h-7 px-2.5 rounded border border-border text-xs flex items-center gap-1.5 hover:bg-muted transition-colors font-mono"
                  >
                    <Cpu className="w-3.5 h-3.5" />
                    {currentModel?.name ?? "选择模型"}
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {showModelPicker && (
                    <>
                      <div className="fixed inset-0 z-[50]" onClick={() => setShowModelPicker(false)} />
                      <div className="absolute bottom-10 right-0 z-[60] w-64 bg-card border border-border rounded-lg shadow-xl py-1 max-h-72 overflow-y-auto">
                        {models.length === 0 && (
                          <div className="px-3 py-3 text-xs text-muted-foreground">暂无对话模型，请到设置中心配置</div>
                        )}
                        {models.map(m => (
                          <button
                            key={m.id}
                            onClick={() => { setSelectedModelId(m.id); setShowModelPicker(false) }}
                            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted text-left"
                          >
                            <div className={cn("w-2 h-2 rounded-full flex-shrink-0", selectedModelId === m.id ? "bg-accent" : "bg-transparent border border-border")} />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-xs truncate">{m.name}</div>
                              <div className="text-[10px] text-muted-foreground">{m.provider === "ollama" ? "Ollama" : "OpenAI 兼容"} · {m.modelName}</div>
                            </div>
                            {m.isDefault && <span className="text-[9px] text-amber-600 border border-amber-200 rounded-full px-1.5 py-0.5 flex-shrink-0">默认</span>}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {/* Send / Stop */}
                {generating ? (
                  <button
                    onClick={handleStop}
                    className="h-7 w-7 rounded bg-foreground text-background flex items-center justify-center hover:bg-foreground/90 transition-colors"
                    title="停止生成"
                  >
                    <Square className="w-3 h-3 fill-current" />
                  </button>
                ) : (
                  <button
                    onClick={() => void handleSend()}
                    disabled={!input.trim() || !activeSessionId}
                    className="h-7 w-7 rounded bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 transition-colors disabled:opacity-40"
                  >
                    <Send className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
            <p className="text-center text-[10px] text-muted-foreground mt-2">AI 可能出错，重要信息请核实来源</p>
          </div>
        </div>
      </div>

      {/* Close menus */}
      {sessionMenuOpen && <div className="fixed inset-0 z-40" onClick={() => setSessionMenuOpen(null)} />}

      {/* Hidden file inputs */}


      {/* Citation Drawer */}
      <CitationDrawer
        msg={messages.find(m => m.id === citationDrawerMsgId)}
        width={citationWidth}
        onWidthChange={setCitationWidth}
        onClose={() => setCitationDrawerMsgId(null)}
      />

      <ToastHost />
    </div>
  )
}

// ─── 会话行 ──────────────────────────────────────────────────────────────────
function SessionRow({
  session, active, batchMode, batchSelected, renamingId, renameValue,
  menuOpen, onToggleSelect, onSelect, onStartRename, onRename, onTogglePin, onDelete, onToggleMenu,
}: {
  session: SessionListItem
  active: boolean
  batchMode: boolean
  batchSelected: string[]
  renamingId: string | null
  renameValue: string
  menuOpen: boolean
  onToggleSelect: () => void
  onSelect: () => void
  onStartRename: () => void
  onRename: (title: string) => void
  onTogglePin: () => void
  onDelete: () => void
  onToggleMenu: () => void
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-1.5 px-2 py-1.5 mx-1 rounded cursor-pointer transition-colors relative",
        batchMode
          ? batchSelected.includes(session.id)
            ? "bg-accent/10 text-foreground"
            : "text-muted-foreground hover:bg-muted/50"
          : active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
      onClick={batchMode ? onToggleSelect : onSelect}
    >
      {batchMode && (
        <input
          type="checkbox"
          checked={batchSelected.includes(session.id)}
          onChange={onToggleSelect}
          className="accent-primary w-3.5 h-3.5 flex-shrink-0"
        />
      )}
      {session.pinned && !batchMode && <Pin className="w-3 h-3 text-amber-500 flex-shrink-0" />}
      <MessageSquare className="w-3.5 h-3.5 flex-shrink-0" />
      {renamingId === session.id ? (
        <input
          autoFocus
          value={renameValue}
          onChange={e => onRename(e.target.value)}
          onBlur={() => onRename(renameValue)}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }}
          className="w-full h-6 px-1 text-xs bg-background border border-accent rounded focus:outline-none"
          onClick={e => e.stopPropagation()}
        />
      ) : (
        <span className="text-xs truncate flex-1">{session.title}</span>
      )}
      {!batchMode && (
        <button
          onClick={e => { e.stopPropagation(); onToggleMenu() }}
          className="w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-muted transition-colors flex-shrink-0"
        >
          <MoreHorizontal className="w-3 h-3" />
        </button>
      )}
      {menuOpen && (
        <div className="absolute right-0 top-7 z-50 w-36 bg-card border border-border rounded-lg shadow-xl py-1 text-xs">
          <button className="w-full px-3 py-1.5 text-left hover:bg-muted flex items-center gap-2" onClick={e => { e.stopPropagation(); onStartRename() }}>
            <Edit3 className="w-3 h-3" />重命名
          </button>
          <button className="w-full px-3 py-1.5 text-left hover:bg-muted flex items-center gap-2" onClick={e => { e.stopPropagation(); onTogglePin() }}>
            {session.pinned ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
            {session.pinned ? "取消置顶" : "置顶"}
          </button>
          <div className="border-t border-border my-0.5" />
          <button className="w-full px-3 py-1.5 text-left hover:bg-red-50 text-red-600 flex items-center gap-2" onClick={e => { e.stopPropagation(); onDelete() }}>
            <Trash2 className="w-3 h-3" />删除
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Empty State ─────────────────────────────────────────────────────────────
function EmptyChatState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8 py-12">
      <div className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center mb-5">
        <Sparkles className="w-7 h-7 text-primary-foreground" />
      </div>
      <h2 className="text-lg font-semibold mb-1">开始一个新会话</h2>
      <p className="text-sm text-muted-foreground text-center max-w-lg">
        使用 @ 引用知识库，开启基于文档的智能问答
      </p>
    </div>
  )
}

// ─── 消息气泡 ────────────────────────────────────────────────────────────────
function ChatMessage({
  msg, expandedThinking, expandedRAG, expandedTools,
  onToggleThinking, onToggleRAG, onToggleTool, onOpenCitationDrawer,
}: {
  msg: UiMessage
  expandedThinking: Record<string, boolean>
  expandedRAG: Record<string, boolean>
  expandedTools: Record<string, boolean>
  onToggleThinking: (id: string) => void
  onToggleRAG: (id: string) => void
  onToggleTool: (id: string) => void
  onOpenCitationDrawer: (id: string) => void
}) {
  if (msg.role === "user") {
    return (
      <div className="flex gap-3 justify-end">
        <div className="max-w-[75%]">
          <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words">
            {msg.content}
          </div>
        </div>
        <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center flex-shrink-0 mt-1">
          <User className="w-3.5 h-3.5 text-muted-foreground" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center flex-shrink-0 mt-1">
        <Bot className="w-3.5 h-3.5 text-primary-foreground" />
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        {msg.modelName && !msg.streaming && (
          <div className="text-[10px] text-muted-foreground font-mono">{msg.modelName}</div>
        )}

        {/* 深度思考 */}
        {msg.reasoning && (
          <div className="border border-border rounded-lg overflow-hidden">
            <button
              onClick={() => onToggleThinking(msg.id)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
            >
              <Zap className="w-3.5 h-3.5 text-amber-500" />
              <span className="font-medium">深度思考</span>
              {msg.streaming && <Loader2 className="w-3 h-3 animate-spin ml-auto" />}
              {expandedThinking[msg.id] ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
            </button>
            {expandedThinking[msg.id] && (
              <div className="px-3 py-2 border-t border-border bg-muted/20 text-xs text-muted-foreground leading-relaxed font-mono whitespace-pre-wrap max-h-64 overflow-y-auto">
                {msg.reasoning}
              </div>
            )}
          </div>
        )}

        {/* RAG 管线进度 */}
        {msg.ragSteps && msg.ragSteps.length > 0 && (
          <div className="border border-border rounded-lg overflow-hidden">
            <button
              onClick={() => onToggleRAG(msg.id)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5 text-accent" />
              <span className="font-medium text-muted-foreground">RAG 检索管线</span>
              <div className="flex items-center gap-1 ml-auto">
                {msg.ragSteps.every(s => s.status === "done") ? (
                  <span className="text-[10px] text-emerald-600 font-medium">完成</span>
                ) : (
                  <Loader2 className="w-3 h-3 animate-spin text-accent" />
                )}
                {expandedRAG[msg.id] ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </div>
            </button>
            {expandedRAG[msg.id] && (
              <div className="border-t border-border px-3 py-2 space-y-1">
                {msg.ragSteps.map((step, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    {step.status === "done"
                      ? <Check className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                      : <Loader2 className="w-3 h-3 animate-spin text-accent flex-shrink-0" />}
                    <span className={step.status === "done" ? "text-muted-foreground" : "text-foreground"}>{step.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 工具调用 */}
        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="border border-border rounded-lg overflow-hidden">
            <button
              onClick={() => onToggleTool(msg.id)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 transition-colors"
            >
              <Cpu className="w-3.5 h-3.5 text-violet-500" />
              <span className="font-medium text-muted-foreground">工具调用</span>
              <span className="ml-auto text-[10px] font-mono text-muted-foreground">{msg.toolCalls.length} 次</span>
              {expandedTools[msg.id] ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
            {expandedTools[msg.id] && (
              <div className="border-t border-border divide-y divide-border">
                {msg.toolCalls.map(tc => (
                  <div key={tc.id} className="px-3 py-2 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono font-semibold text-violet-600">{tc.name}</span>
                      {tc.status === "error"
                        ? <AlertCircle className="w-3 h-3 text-red-500" />
                        : <Check className="w-3 h-3 text-emerald-500" />}
                    </div>
                    <div className="text-[10px] font-mono bg-muted/50 rounded p-2 text-muted-foreground overflow-x-auto">{JSON.stringify(tc.arguments)}</div>
                    {tc.result && (
                      <div className={cn(
                        "text-[10px] font-mono rounded p-2 overflow-x-auto max-h-32 overflow-y-auto",
                        tc.status === "error" ? "bg-red-50/50 text-red-700" : "bg-emerald-50/50 text-emerald-700",
                      )}>
                        {tc.result}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 正文 */}
        {msg.streaming && !msg.content ? (
          <div className="flex items-center gap-2 py-2">
            <div className="flex gap-1">
              <div className="w-1.5 h-1.5 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:0ms]" />
              <div className="w-1.5 h-1.5 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:150ms]" />
              <div className="w-1.5 h-1.5 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:300ms]" />
            </div>
            <span className="text-xs text-muted-foreground">生成中…</span>
          </div>
        ) : (
          <div className="prose prose-sm max-w-none text-foreground leading-relaxed">
            <MarkdownRenderer content={msg.content} references={msg.references ?? EMPTY_REF} streaming={msg.streaming === true} />
          </div>
        )}

        {/* 中断/错误提示 */}
        {msg.interrupted && !msg.streaming && (
          <div className="text-xs text-amber-600 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" />已停止生成
          </div>
        )}
        {msg.error && (
          <div className="text-xs text-red-600 flex items-start gap-1.5 bg-red-50/50 border border-red-100 rounded-md px-3 py-2">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>{msg.error}</span>
          </div>
        )}

        {/* 引用 */}
        {msg.references && msg.references.length > 0 && !msg.streaming && (
          <div>
            <button
              onClick={() => onOpenCitationDrawer(msg.id)}
              className="flex items-center gap-1.5 text-xs text-accent hover:underline"
            >
              <FileText className="w-3.5 h-3.5" />
              {msg.references.length} 个引用来源
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* 操作栏 */}
        {!msg.streaming && msg.content && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => { void navigator.clipboard?.writeText(msg.content); toast("已复制到剪贴板", "info") }}
              className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            {msg.createdAt && (
              <div className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground font-mono">
                <Info className="w-3 h-3" />
                {new Date(msg.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Markdown 渲染（支持 [n] 内联引用悬浮） ─────────────────────────────────
function MarkdownRenderer({ content, references, streaming }: {
  content: string
  references: RagReference[]
  streaming: boolean
}) {
  const [hover, setHover] = useState<{ ref: RagReference; x: number; y: number } | null>(null)
  const lines = content.split("\n")

  const renderInline = (text: string) => {
    // 拆分：粗体 **x** / 行内代码 `x` / 引用 [n]
    const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[(\d+)\])/g)
    const out: React.ReactNode[] = []
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (!part) continue
      if (part.startsWith("**") && part.endsWith("**")) {
        out.push(<strong key={i}>{part.slice(2, -2)}</strong>)
      } else if (part.startsWith("`") && part.endsWith("`")) {
        out.push(<code key={i} className="font-mono text-xs bg-muted px-1 py-0.5 rounded">{part.slice(1, -1)}</code>)
      } else {
        const m = part.match(/^\[(\d+)\]$/)
        if (m) {
          const ref = references.find(r => r.index === Number(m[1]))
          if (ref) {
            out.push(
              <sup key={i}>
                <span
                  className="inline-flex items-center justify-center w-4 h-4 rounded text-[9px] font-mono text-accent bg-accent/10 border border-accent/20 cursor-pointer align-middle select-none hover:bg-accent/20"
                  onMouseEnter={e => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setHover({ ref, x: r.left, y: r.bottom + 6 })
                  }}
                  onMouseLeave={() => setHover(null)}
                >{ref.index}</span>
              </sup>,
            )
            continue
          }
        }
        out.push(<span key={i}>{part}</span>)
      }
    }
    return out
  }

  return (
    <>
      <div className="space-y-1.5">
        {lines.map((line, i) => {
          if (line.startsWith("### ")) return <h3 key={i} className="text-sm font-bold mt-3 mb-1">{renderInline(line.slice(4))}</h3>
          if (line.startsWith("## ")) return <h2 key={i} className="text-base font-bold mt-4 mb-1">{renderInline(line.slice(3))}</h2>
          if (line.startsWith("# ")) return <h1 key={i} className="text-lg font-bold mt-4 mb-1">{renderInline(line.slice(2))}</h1>
          if (line.startsWith("- ")) return <li key={i} className="text-sm ml-3 list-disc list-inside">{renderInline(line.slice(2))}</li>
          if (line.startsWith("```")) return <div key={i} className="text-[10px] font-mono bg-muted px-3 py-0.5 rounded text-muted-foreground">{line}</div>
          if (line.trim() === "") return <div key={i} className="h-1" />
          return <p key={i} className="text-sm leading-relaxed whitespace-pre-wrap break-words">{renderInline(line)}</p>
        })}
        {streaming && <span className="inline-block w-2 h-4 bg-accent/70 animate-pulse align-middle" />}
      </div>
      {hover && (
        <div
          className="fixed z-[60] w-72 bg-card border border-border rounded-lg shadow-xl p-3"
          style={{ top: hover.y, left: Math.min(hover.x, Math.max(8, window.innerWidth - 310)) }}
        >
          <div className="text-xs font-medium mb-1 flex items-center gap-1.5">
            <FileText className="w-3 h-3 text-blue-500" />
            {hover.ref.knowledgeTitle}
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">{hover.ref.content}</p>
          <div className="text-[10px] font-mono text-emerald-600 mt-1.5">相似度 {(hover.ref.score * 100).toFixed(0)}%</div>
        </div>
      )}
    </>
  )
}

// ─── 引用抽屉 ────────────────────────────────────────────────────────────────
function CitationDrawer({
  msg, width, onWidthChange, onClose,
}: {
  msg: UiMessage | undefined
  width: number
  onWidthChange: (w: number) => void
  onClose: () => void
}) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  if (!msg || !msg.references || msg.references.length === 0) return null

  // 左边缘拖拽调宽：startX 与 startWidth 记录 → window mousemove 算新宽
  // （右侧固定抽屉：向右拖变窄 = 宽度 = startWidth + (startX - clientX)）
  const onDragStart = (e: ReactMouseEvent) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startWidth: width }
    const onMove = (ev: globalThis.MouseEvent) => {
      if (!dragRef.current) return
      const w = dragRef.current.startWidth + (dragRef.current.startX - ev.clientX)
      onWidthChange(Math.min(760, Math.max(280, Math.round(w))))
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <aside
        style={{ width }}
        className="fixed top-0 right-0 z-40 h-full bg-card border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right-full"
      >
        {/* 左边缘拖拽把手（引用来源面板左缘调列宽） */}
        <div
          onMouseDown={onDragStart}
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-accent/50 active:bg-accent transition-colors z-10"
          title="拖动调整宽度"
        />
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
          <h3 className="text-sm font-semibold">引用来源 · {msg.references.length}</h3>
          <button onClick={onClose} className="w-7 h-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {[...msg.references].sort((a, b) => a.index - b.index).map(ref => (
            <div key={`${ref.knowledgeId}-${ref.index}`} className="border border-border rounded-lg overflow-hidden bg-background">
              {/* 卡头：编号 + 文档标题 + 类型徽标 + 块数 */}
              <div className="flex items-center gap-2 px-3 py-2 bg-muted/40 border-b border-border">
                <span className="text-[10px] font-mono text-muted-foreground flex-shrink-0">[{ref.index}]</span>
                {ref.type === "image"
                  ? <ImagesIcon className="w-3.5 h-3.5 text-violet-500 flex-shrink-0" />
                  : <FileText className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />}
                <span className="text-xs font-medium truncate flex-1" title={ref.knowledgeTitle}>{ref.knowledgeTitle}</span>
                {ref.type === "image" && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 flex-shrink-0">图片</span>
                )}
                {ref.page !== undefined && (
                  <span className="text-[9px] font-mono text-muted-foreground flex-shrink-0">P{ref.page}</span>
                )}
                {typeof ref.chunks?.length === "number" && ref.chunks.length > 1 && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground flex-shrink-0" title="同文档命中块数">
                    命中 {ref.chunks.length} 段
                  </span>
                )}
                <span className="text-[10px] font-mono text-emerald-600 flex-shrink-0">{(ref.score * 100).toFixed(0)}%</span>
              </div>
              {/* 图片缩略图行（引用带图——VLM 描述块命中；签名 URL 直出 <img>） */}
              {ref.images && ref.images.length > 0 && (
                <div className="flex flex-wrap gap-2 px-3 pt-2.5">
                  {ref.images.map((img, i) => (
                    <a
                      key={`${img.assetKey ?? img.url}-${i}`}
                      href={img.url}
                      target="_blank"
                      rel="noreferrer"
                      title={img.caption || "查看原图"}
                      className="group relative block w-20 h-20 rounded-md border border-border overflow-hidden hover:ring-2 hover:ring-accent transition-all"
                    >
                      <img src={img.url} alt={img.caption || "引用图片"} className="w-full h-full object-cover" loading="lazy" />
                      <span className="absolute inset-x-0 bottom-0 bg-black/45 text-white text-[8px] px-1 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity truncate">
                        查看原图
                      </span>
                    </a>
                  ))}
                </div>
              )}
              <p className={cn("px-3 text-xs text-muted-foreground leading-relaxed", ref.images?.length ? "pt-2 pb-1" : "py-2.5")}>{ref.content}</p>
              {/* 脚：URL 链接 / 打开文档 */}
              {(ref.url || ref.kbId) && (
                <div className="flex items-center gap-1 px-3 pb-2.5">
                  {ref.url && (
                    <a href={ref.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[11px] text-accent hover:underline truncate">
                      <ExternalLink className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate">{ref.url}</span>
                    </a>
                  )}
                  {ref.url && ref.kbId && <span className="text-muted-foreground/40 flex-shrink-0">·</span>}
                  {ref.kbId && (
                    <button
                      onClick={() => {
                        onClose()
                        // 跳 KB 详情并定位文档（详情页按 ?preview= 打开 DocPreviewDrawer）
                        window.location.href = `/kb/${ref.kbId}?preview=${ref.knowledgeId}`
                      }}
                      className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-accent transition-colors flex-shrink-0"
                    >
                      <FileSearch className="w-3 h-3" />
                      打开文档
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>
    </>
  )
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────
/** 历史消息 → UI 消息模型 */
function toUiMessage(m: Message): UiMessage {
  return {
    id: m.id,
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
    reasoning: m.reasoning || undefined,
    references: Array.isArray(m.references) && m.references.length ? m.references as RagReference[] : undefined,
    interrupted: m.interrupted === true,
    usage: m.usage ?? undefined,
    createdAt: m.createdAt,
  }
}

function groupSessions(list: SessionListItem[]): [string, SessionListItem[]][] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86400000
  const groups: Record<string, SessionListItem[]> = { 今天: [], 昨天: [], 更早: [] }
  for (const s of list) {
    const t = new Date(s.updatedAt || s.createdAt).getTime()
    if (t >= startOfToday) groups["今天"].push(s)
    else if (t >= startOfYesterday) groups["昨天"].push(s)
    else groups["更早"].push(s)
  }
  return (Object.entries(groups).filter(([, v]) => v.length > 0))
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
