// PdfReader.tsx
// 自研 PDF 阅读器（pdfjs-dist 3.11）：
// - 左侧：页面预览（缩略图列表，点击跳页）——宽度可拖拽调整
// - 右侧：正文（当前页 canvas 渲染，翻页/缩放/适配宽度）
// - 参考 WeKnora：PDF 为原生渲染，不做自研文本选取/复制层
// - 首次打开自动适配宽度（scale=null 时按容器宽度实时计算）
import { useEffect, useRef, useState } from "react"
import * as pdfjsLib from "pdfjs-dist"
import workerUrl from "pdfjs-dist/build/pdf.worker.min.js?url"

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export default function PdfReader({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [pageNum, setPageNum] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  // null = 自动适配宽度（渲染时按容器实时计算）
  const [scale, setScale] = useState<number | null>(null)
  const [thumbs, setThumbs] = useState<string[]>([])
  const [loadErr, setLoadErr] = useState("")
  // 容器宽度变化计数（ResizeObserver）：auto 模式下右栏拖宽后重新适配
  const [resizeTick, setResizeTick] = useState(0)
  const scaleRef = useRef<number | null>(null)
  scaleRef.current = scale
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const obs = new ResizeObserver(() => {
      // 仅 auto 模式需要跟随容器（手动缩放时保持用户选择的倍率）
      if (scaleRef.current === null) setResizeTick((t) => t + 1)
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])
  // 缩略图栏宽度（px，右侧分隔条拖拽调整）
  const [thumbW, setThumbW] = useState(150)
  const thumbDrag = useRef<{ startX: number; startW: number } | null>(null)

  // 加载 PDF（blob URL → arrayBuffer）
  useEffect(() => {
    let alive = true
    setPdf(null); setThumbs([]); setPageNum(1); setPageCount(0); setLoadErr("")
    fetch(url).then((r) => r.arrayBuffer()).then(async (buf) => {
      if (!alive) return
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
      if (!alive) return
      setPdf(doc)
      setPageCount(doc.numPages)
    }).catch(() => { if (alive) setLoadErr("PDF 加载失败") })
    return () => { alive = false }
  }, [url])

  // 渲染全部缩略图（一次性，dataURL 缓存）
  useEffect(() => {
    if (!pdf) return
    let cancelled = false
    void (async () => {
      const list: string[] = []
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i)
        const vp = page.getViewport({ scale: 1 })
        const ratio = Math.min(1, 110 / vp.width)
        const cv = document.createElement("canvas")
        cv.width = Math.floor(vp.width * ratio)
        cv.height = Math.floor(vp.height * ratio)
        await page.render({ canvasContext: cv.getContext("2d")!, viewport: page.getViewport({ scale: ratio }) }).promise
        list.push(cv.toDataURL("image/jpeg", 0.7))
        if (cancelled) return
      }
      if (!cancelled) setThumbs(list)
    })()
    return () => { cancelled = true }
  }, [pdf])

  // 渲染当前页正文（scale=null 自动适配容器宽度；devicePixelRatio 高清渲染）
  useEffect(() => {
    if (!pdf || !canvasRef.current) return
    let cancelled = false
    void (async () => {
      const page = await pdf.getPage(pageNum)
      if (cancelled || !canvasRef.current) return
      // 有效缩放：auto → 按正文区可视宽度适配（滚动条 16px 预留），
      // 保证 canvas CSS 宽度 = 容器宽度，不超出边界
      const baseVp = page.getViewport({ scale: 1 })
      const containerW = bodyRef.current ? bodyRef.current.clientWidth - 16 : 600
      const effScale = scale ?? Math.max(0.3, Math.min(4, containerW / baseVp.width))
      // 高清：按 devicePixelRatio 放大渲染，CSS 尺寸回缩（高 DPI 屏不模糊，
      // 同原生 PDF viewer 的矢量清晰度）
      const dpr = window.devicePixelRatio || 1
      const vp = page.getViewport({ scale: effScale * dpr })
      const canvas = canvasRef.current
      canvas.width = Math.floor(vp.width)
      canvas.height = Math.floor(vp.height)
      canvas.style.width = `${Math.floor(vp.width / dpr)}px`
      canvas.style.height = `${Math.floor(vp.height / dpr)}px`
      await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise
    })()
    return () => { cancelled = true }
  }, [pdf, pageNum, scale, resizeTick])

  // 缩略图栏拖拽（跟手）
  const onThumbDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    thumbDrag.current = { startX: e.clientX, startW: thumbW }
    document.body.style.userSelect = "none"
    document.body.style.cursor = "col-resize"
    const onMove = (ev: MouseEvent) => {
      const d = thumbDrag.current
      if (!d) return
      setThumbW(Math.min(320, Math.max(80, d.startW + ev.clientX - d.startX)))
    }
    const onUp = () => {
      thumbDrag.current = null
      document.body.style.userSelect = ""
      document.body.style.cursor = ""
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  if (loadErr) return <div className="text-xs text-red-600 p-4">{loadErr}</div>
  if (!pdf) return <div className="text-xs text-muted-foreground py-6 text-center">PDF 加载中…</div>

  return (
    <div className="flex h-full min-h-0" style={{ height: "100%" }}>
      {/* 页面预览（缩略图）栏 */}
      <div style={{ width: thumbW }} className="border-r border-border overflow-y-auto flex-shrink-0 bg-muted/20">
        <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-3 py-2 sticky top-0 bg-muted/80 backdrop-blur">
          页面预览
        </div>
        <div className="px-2 pb-3 space-y-2">
          {thumbs.length === 0 && <div className="text-[10px] text-muted-foreground px-2 py-4 text-center">生成缩略图中…</div>}
          {thumbs.map((t, i) => (
            <button
              key={i}
              onClick={() => setPageNum(i + 1)}
              className={`w-full rounded overflow-hidden border transition-colors ${pageNum === i + 1 ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground/30"}`}
              title={`第 ${i + 1} 页`}
            >
              <img src={t} alt={`第 ${i + 1} 页`} className="w-full select-none" draggable={false} />
              <div className="text-[9px] text-muted-foreground text-center py-0.5 bg-card">{i + 1}</div>
            </button>
          ))}
        </div>
      </div>
      {/* 缩略图栏右侧分隔条（拖拽调宽） */}
      <div
        onMouseDown={onThumbDragStart}
        className="w-1.5 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors flex-shrink-0"
        title="拖拽调整页面预览宽度"
      />

      {/* 正文 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 工具栏 */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border flex-shrink-0 bg-muted/30">
          <button onClick={() => setPageNum((p) => Math.max(1, p - 1))} disabled={pageNum <= 1} className="h-6 px-2 text-[11px] border border-border rounded hover:bg-muted disabled:opacity-40">上一页</button>
          <span className="text-[11px] font-mono text-muted-foreground">{pageNum} / {pageCount}</span>
          <button onClick={() => setPageNum((p) => Math.min(pageCount, p + 1))} disabled={pageNum >= pageCount} className="h-6 px-2 text-[11px] border border-border rounded hover:bg-muted disabled:opacity-40">下一页</button>
          <div className="flex-1" />
          <button onClick={() => setScale((s) => Math.max(0.3, (s ?? 1) - 0.2))} className="h-6 w-6 text-[11px] border border-border rounded hover:bg-muted">−</button>
          <span className="text-[11px] font-mono text-muted-foreground">{scale === null ? "自动" : `${Math.round(scale * 100)}%`}</span>
          <button onClick={() => setScale((s) => Math.min(4, (s ?? 1) + 0.2))} className="h-6 w-6 text-[11px] border border-border rounded hover:bg-muted">+</button>
          <button onClick={() => setScale(null)} className="h-6 px-2 text-[11px] border border-border rounded hover:bg-muted">适配宽度</button>
        </div>
        {/* 页面画布（可滚动）——参考 WeKnora：PDF 原生渲染，无自研文本选取层 */}
        <div ref={bodyRef} className="flex-1 overflow-auto bg-muted/20 p-3">
          <div className="relative inline-block">
            <canvas ref={canvasRef} className="shadow-md bg-white rounded-sm" />
          </div>
        </div>
      </div>
    </div>
  )
}
