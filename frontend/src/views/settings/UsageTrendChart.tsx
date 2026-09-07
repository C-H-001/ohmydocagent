// 用量趋势图（Task: 可视化——按日堆叠柱状图）
// 数据源 GET /me/model-usage/trend?days=N——近 N 天每天各模型 calls/tokens。
// 交互：指标切换（调用次数 / Token）、时间范围（7/14/30 天）、模型筛选 chips、
// 汇总统计（区间总量 / 单日峰值 / 纳入模型数）。
import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { usageApi, type TrendDay, type TrendPoint } from "../../api/settings"

const RANGES = [
  { label: "近 7 天", days: 7 },
  { label: "近 14 天", days: 14 },
  { label: "近 30 天", days: 30 },
]

// 模型颜色（按序分配——稳定色板；模型动态时可多可少）
const PALETTE = [
  "#6366f1", "#8b5cf6", "#06b6d4", "#10b981", "#f59e0b",
  "#ef4444", "#ec4899", "#84cc16", "#3b82f6", "#14b8a6",
]
const colorOf = (i: number) => PALETTE[i % PALETTE.length]

function fmt(n: number) { return n.toLocaleString("zh-CN") }
function fmtAxis(n: number) {
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}w`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return `${n}`
}
function fmtDate(iso: string) {
  const [, m, d] = iso.split("-")
  return `${Number(m)}/${Number(d)}`
}

interface TrendModel {
  id: string
  name: string
  color: string
  on: boolean
}

export function UsageTrendChart() {
  const [metric, setMetric] = useState<"calls" | "tokens">("calls")
  const [rangeDays, setRangeDays] = useState(14)
  const [rows, setRows] = useState<TrendDay[]>([])
  const [loading, setLoading] = useState(true)
  const [models, setModels] = useState<TrendModel[]>([])
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // 拉取趋势（范围变化时）
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    usageApi.trend(rangeDays).then((items) => {
      if (cancelled) return
      // 模型动态收集（按首次出现顺序）
      const seen: Record<string, string> = {}
      for (const day of items) {
        for (const [id, pt] of Object.entries(day.models)) {
          if (!(id in seen) && pt.name) seen[id] = pt.name
        }
      }
      setRows(items)
      setModels(prev => {
        const ids = Object.keys(seen)
        const next = ids.map((id, i) => {
          const old = prev.find(m => m.id === id)
          return { id, name: seen[id], color: colorOf(i), on: old ? old.on : true }
        })
        return next
      })
    }).catch((err: unknown) => {
      if (cancelled) return
      setRows([])
      setModels([])
      setError(err instanceof Error ? err.message : "用量趋势加载失败，请稍后重试")
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [rangeDays, reloadKey])

  const activeModels = models.filter(m => m.on)
  const allOn = models.length > 0 && activeModels.length === models.length

  const data = useMemo(() => {
    return rows.map(day => {
      const row: Record<string, number | string> = { date: day.date }
      for (const m of models) {
        const pt: TrendPoint | undefined = day.models[m.id]
        row[m.id] = pt ? (metric === "calls" ? pt.calls : pt.tokens) : 0
      }
      return row
    })
  }, [rows, models, metric])

  const periodTotal = data.reduce((acc, r) => {
    let t = 0
    for (const m of activeModels) t += Number(r[m.id] ?? 0)
    return acc + t
  }, 0)
  const peak = data.reduce((max, r) => {
    let t = 0
    for (const m of activeModels) t += Number(r[m.id] ?? 0)
    return Math.max(max, t)
  }, 0)

  const toggle = (id: string) => {
    setModels(prev => {
      const next = prev.map(m => m.id === id ? { ...m, on: !m.on } : m)
      if (!next.some(m => m.on)) return prev // 至少保留一个
      return next
    })
  }

  if (loading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">趋势加载中…</div>
  }

  if (error) {
    return (
      <div role="alert" className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card p-5 text-sm">
        <span>用量趋势加载失败：{error}</span>
        <button className="shrink-0 underline" onClick={() => setReloadKey(key => key + 1)}>重试</button>
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {/* header */}
      <div className="flex flex-col gap-4 border-b border-border p-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 className="text-sm font-semibold">每日用量趋势</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">按日统计各模型用量 · 总量为所选模型之和</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-border p-0.5">
            {([["calls", "调用次数"], ["tokens", "Token"]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setMetric(k)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${metric === k ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-lg border border-border p-0.5">
            {RANGES.map(r => (
              <button key={r.days} onClick={() => setRangeDays(r.days)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${rangeDays === r.days ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"}`}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* model chips */}
      {models.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
          <button onClick={() => setModels(prev => prev.map(m => ({ ...m, on: true })))}
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${allOn ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"}`}>
            全部模型
          </button>
          {models.map(m => (
            <button key={m.id} onClick={() => toggle(m.id)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${m.on ? "border-border text-foreground" : "border-border text-muted-foreground opacity-60"}`}>
              <span className="h-2 w-2 rounded-[3px]" style={{ background: m.on ? m.color : "transparent" }} />
              {m.name}
            </button>
          ))}
        </div>
      )}

      {/* summary */}
      <div className="flex flex-wrap gap-8 px-5 pt-4 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">区间{metric === "calls" ? "调用" : "Token"}总量</div>
          <div className="mt-0.5 font-mono text-lg font-semibold">{fmt(periodTotal)}{metric === "calls" ? " 次" : ""}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">单日峰值</div>
          <div className="mt-0.5 font-mono text-lg font-semibold">{fmt(peak)}{metric === "calls" ? " 次" : ""}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">纳入模型</div>
          <div className="mt-0.5 font-mono text-lg font-semibold">{activeModels.length} / {models.length || "-"}</div>
        </div>
      </div>

      {/* chart */}
      <div className="h-[320px] w-full px-2 pb-4 pt-5">
        {data.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
            暂无趋势数据（发起对话后开始统计）
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 0 }} barCategoryGap="22%">
              <CartesianGrid vertical={false} stroke="#e5e7eb" strokeDasharray="3 3" />
              <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fill: "#9ca3af", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} minTickGap={16} />
              <YAxis tickFormatter={fmtAxis} tick={{ fill: "#9ca3af", fontSize: 11 }} tickLine={false} axisLine={false} width={44} />
              <Tooltip cursor={{ fill: "rgba(0,0,0,0.04)" }} content={<TrendTooltip metric={metric} models={activeModels} />} />
              {activeModels.map((m, i) => (
                <Bar key={m.id} dataKey={m.id} stackId="usage" fill={m.color} stroke="#fff" strokeWidth={1.5}
                  radius={i === activeModels.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

function TrendTooltip({ active, label, payload, metric, models }: {
  active?: boolean
  label?: string
  payload?: { dataKey: string; value: number }[]
  metric: "calls" | "tokens"
  models: TrendModel[]
}) {
  if (!active || !payload || payload.length === 0) return null
  const total = payload.reduce((a, p) => a + (p.value || 0), 0)
  return (
    <div className="min-w-[170px] rounded-lg border border-border bg-card p-3 shadow-lg text-xs">
      <div className="mb-2 font-medium text-muted-foreground">{label}</div>
      <div className="space-y-1">
        {[...payload].reverse().map(p => {
          const m = models.find(mm => mm.id === p.dataKey)
          if (!m) return null
          return (
            <div key={p.dataKey} className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-[3px]" style={{ background: m.color }} />
              <span className="flex-1 truncate text-muted-foreground">{m.name}</span>
              <span className="font-mono font-medium">{fmt(p.value || 0)}</span>
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-border pt-2 font-medium">
        <span>总量</span>
        <span className="font-mono">{fmt(total)}{metric === "calls" ? " 次" : ""}</span>
      </div>
    </div>
  )
}
