import { useCallback, useEffect, useRef, useState } from "react"
import { AlertCircle, Loader2 } from "lucide-react"
import { embeddingApi, type EmbeddingState, type ProfileView } from "../../api/kb"
import { modelApi } from "../../api/settings"
import type { KnowledgeBase, Model } from "../../api/types"
import { toast } from "../../components/ui"
import { useAuth } from "../../store/auth"

const buttonCls = "h-9 px-3 text-sm border border-border rounded-md hover:bg-muted disabled:opacity-50"
const message = (err: unknown) => err instanceof Error ? err.message : "向量配置请求失败"

export default function EmbeddingSettings({ kbId, creatorId, permission }: { kbId: string; creatorId: string; permission?: KnowledgeBase["myPermission"] }) {
  const { user } = useAuth()
  const canManage = permission === "full" && creatorId === user?.id
  const [state, setState] = useState<EmbeddingState | null>(null)
  const [models, setModels] = useState<Model[]>([])
  const [modelId, setModelId] = useState("")
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [modelsRevision, setModelsRevision] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [rebuildOpen, setRebuildOpen] = useState(false)
  const busyRef = useRef(false)
  // Each KB owns its requests; late GETs must not overwrite a mutation or another KB.
  const lifecycle = useRef({ disposed: false, version: 0 })

  const refresh = useCallback(async () => {
    const session = lifecycle.current
    const version = ++session.version
    try {
      const result = await embeddingApi.get(kbId)
      if (!session.disposed && session.version === version) {
        setState(result)
        setLoadError(null)
      }
    } catch (err) {
      if (!session.disposed && session.version === version) setLoadError(message(err))
    }
  }, [kbId])

  useEffect(() => {
    const session = { disposed: false, version: 0 }
    lifecycle.current = session
    busyRef.current = false
    setBusy(false)
    setState(null)
    setRebuildOpen(false)
    setLoadError(null)
    void refresh()
    return () => { session.disposed = true }
  }, [refresh])

  useEffect(() => {
    let disposed = false
    setModels([])
    setModelId("")
    setModelsError(null)
    setModelsLoading(false)
    if (!canManage || !user?.id || !rebuildOpen) return
    setModelsLoading(true)
    void modelApi.list("embedding").then(result => {
      if (!disposed) {
        const available = result.filter(m => m.enabled && m.type === "embedding" && m.userId === user.id)
        setModels(available)
        setModelId(available.find(m => m.id === state?.active?.modelId)?.id ?? available.find(m => m.isDefault)?.id ?? "")
      }
    }).catch(err => {
      if (!disposed) setModelsError(message(err))
    }).finally(() => {
      if (!disposed) setModelsLoading(false)
    })
    return () => { disposed = true }
  }, [kbId, canManage, user?.id, modelsRevision, rebuildOpen, state?.active?.modelId])

  useEffect(() => {
    if (state?.status !== "building" || busy) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (stopped || busyRef.current) return
      await refresh()
      if (!stopped) timer = setTimeout(poll, 5000)
    }
    timer = setTimeout(poll, 5000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [state?.status, busy, refresh])

  const run = async (action: "rebuild" | "activate" | "cancel") => {
    if (!canManage || busyRef.current || !state) return
    if (action === "rebuild" && !models.some(m => m.id === modelId)) return
    const session = lifecycle.current
    ++session.version
    busyRef.current = true
    setBusy(true)
    setLoadError(null)
    try {
      const result = action === "rebuild" ? await embeddingApi.rebuild(kbId, modelId) : await embeddingApi[action](kbId)
      if (!session.disposed) {
        setState(result)
        setRebuildOpen(false)
        toast({ rebuild: "已开始重建", activate: "向量库设置已更新", cancel: "已取消重建" }[action])
      }
    } catch (err) {
      if (!session.disposed) {
        toast(message(err), "error")
        await refresh()
      }
    } finally {
      if (!session.disposed) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  const profileLabel = (profile: ProfileView | null) => profile ? `${profile.modelName} · ${profile.dimension} 维` : "—"
  const canActivate = state?.pending && state.status !== "failed" && state.pendingIndexedChunks >= state.totalChunks

  return (
    <div className="space-y-4">
      {loadError && (
        <div role="alert" className="text-xs text-red-600 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />{loadError}
          <button className="underline shrink-0" disabled={busy} onClick={() => void refresh()}>重试</button>
        </div>
      )}
      {!state && !loadError && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" />加载向量配置…</div>}
      {state && <>
        <dl className="text-sm border border-border rounded-md px-3">
          <div className="flex justify-between gap-3 py-3">
            <dt className="text-muted-foreground shrink-0">当前向量库设置：</dt>
            <dd className="text-right break-all font-medium">{profileLabel(state.active)}</dd>
          </div>
        </dl>
        {canManage && <>
          {state.error && <p role="alert" className="text-xs text-red-600 flex items-center gap-2"><AlertCircle className="w-4 h-4 shrink-0" />{state.error}</p>}
          {state.pending ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">重建使用的模型：{profileLabel(state.pending)}</p>
              {!canActivate && !state.error && <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite"><Loader2 className="w-3.5 h-3.5 animate-spin" />正在重建…</p>}
              <div className="flex flex-wrap gap-2">
                <button className={buttonCls} disabled={busy || !canActivate} onClick={() => void run("activate")}>应用重建结果</button>
                <button className={buttonCls} disabled={busy} onClick={() => void run("cancel")}>取消重建</button>
              </div>
            </div>
          ) : rebuildOpen ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label htmlFor="kb-embedding-model" className="text-xs font-medium">重建使用的嵌入模型</label>
                <select id="kb-embedding-model" value={modelId} onChange={e => setModelId(e.target.value)} disabled={busy || modelsLoading} className="w-full h-9 px-3 text-sm border border-border rounded-md bg-background disabled:opacity-50">
                  <option value="">{modelsLoading ? "加载模型中…" : "请选择模型"}</option>
                  {models.map(m => <option key={m.id} value={m.id}>{m.name}（{m.modelName}）</option>)}
                </select>
                {modelsError ? <p role="alert" className="text-xs text-red-600">{modelsError} <button className="underline" onClick={() => setModelsRevision(n => n + 1)}>重试模型列表</button></p>
                  : !modelsLoading && models.length === 0 && <p className="text-xs text-muted-foreground">暂无可用模型，请先在设置中心添加并启用自己的 Embedding 模型。</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <button className={buttonCls} disabled={busy || modelsLoading || !modelId || state.status === "building"} onClick={() => void run("rebuild")}>开始重建</button>
                <button className={buttonCls} disabled={busy} onClick={() => setRebuildOpen(false)}>取消</button>
              </div>
            </div>
          ) : (
            <button className={buttonCls} disabled={busy || state.status === "building"} onClick={() => setRebuildOpen(true)}>重建向量</button>
          )}
        </>}
      </>}
    </div>
  )
}
