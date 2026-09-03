// 知识图谱画布（frontend/src/components/graph/GraphCanvas.tsx，Task 5.9）
// 轻量力导向图：原生 SVG + 简单斥力/弹簧布局（无重型可视化库）。
// - 布局：初始化随机位置 → 迭代 ~200 轮（节点间斥力 + 边弹簧 + 向心引力），
//   50 节点内性能可接受；布局结果在数据变化时重算
// - 节点：半径 = 1.5 + log2(size+1)（size=degree），label 直接渲染（≤50 节点）
// - 交互：hover 高亮邻接边、点击实体 → onSelectEntity；搜索命中 → 高亮
import { useEffect, useMemo, useRef, useState } from "react"

export interface GraphNodeData {
  id: string
  name: string
  size: number
  attributes?: string[]
}
export interface GraphEdgeData {
  source: string
  target: string
  type: string
  weight: number
}

interface Position { x: number; y: number }

/** 力导向布局：返回 nodeId → 位置（多次迭代近似收敛，冻结渲染） */
function computeLayout(
  nodes: GraphNodeData[],
  edges: GraphEdgeData[],
  width: number,
  height: number,
): Map<string, Position> {
  const positions = new Map<string, Position>()
  const velocities = new Map<string, { vx: number; vy: number }>()
  // 确定性伪随机初始化（固定种子，避免每次渲染抖动）
  let seed = 42
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280
    return seed / 233280
  }
  for (const n of nodes) {
    positions.set(n.id, { x: width * (0.15 + 0.7 * rand()), y: height * (0.15 + 0.7 * rand()) })
    velocities.set(n.id, { vx: 0, vy: 0 })
  }
  if (nodes.length <= 1) return positions

  const edgePairs = edges
    .map(e => ({ a: e.source, b: e.target }))
    .filter((e, i, arr) => arr.findIndex(x => (x.a === e.a && x.b === e.b) || (x.a === e.b && x.b === e.a)) === i)

  const REPULSION = 1800
  const SPRING = 0.02
  const GRAVITY = 0.008
  const ITERATIONS = 200
  const damping = 0.85

  for (let iter = 0; iter < ITERATIONS; iter++) {
    // 斥力（O(n²)，50 节点可接受）
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]
        const b = nodes[j]
        const pa = positions.get(a.id)!
        const pb = positions.get(b.id)!
        let dx = pb.x - pa.x
        let dy = pb.y - pa.y
        let dist = Math.sqrt(dx * dx + dy * dy) || 1
        const force = REPULSION / (dist * dist)
        dx /= dist
        dy /= dist
        velocities.get(a.id)!.vx -= dx * force
        velocities.get(a.id)!.vy -= dy * force
        velocities.get(b.id)!.vx += dx * force
        velocities.get(b.id)!.vy += dy * force
      }
    }
    // 弹簧（边）
    for (const { a, b } of edgePairs) {
      const pa = positions.get(a)
      const pb = positions.get(b)
      if (!pa || !pb) continue
      let dx = pb.x - pa.x
      let dy = pb.y - pa.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const restLength = Math.min(140, Math.max(60, 90))
      const force = (dist - restLength) * SPRING
      dx /= dist
      dy /= dist
      velocities.get(a)!.vx += dx * force
      velocities.get(a)!.vy += dy * force
      velocities.get(b)!.vx -= dx * force
      velocities.get(b)!.vy -= dy * force
    }
    // 向心引力 + 积分
    for (const n of nodes) {
      const p = positions.get(n.id)!
      const v = velocities.get(n.id)!
      v.vx += (width / 2 - p.x) * GRAVITY
      v.vy += (height / 2 - p.y) * GRAVITY
      v.vx *= damping
      v.vy *= damping
      p.x += v.vx
      p.y += v.vy
      // 边界钳制
      p.x = Math.min(width - 20, Math.max(20, p.x))
      p.y = Math.min(height - 20, Math.max(20, p.y))
    }
  }
  return positions
}

export default function GraphCanvas({
  nodes,
  edges,
  highlightIds,
  onSelectEntity,
}: {
  nodes: GraphNodeData[]
  edges: GraphEdgeData[]
  /** 搜索命中的实体名集合（高亮） */
  highlightIds?: Set<string>
  onSelectEntity?: (name: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 800, height: 480 })
  const [hover, setHover] = useState<string | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect) setSize({ width: Math.max(320, rect.width), height: Math.max(320, rect.height) })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const positions = useMemo(
    () => computeLayout(nodes, edges, size.width, size.height),
    [nodes, edges, size.width, size.height],
  )

  const nodeById = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])
  const edgeEndpoints = useMemo(() => new Set<string>(), []) // 占位（保留 API 形态）
  void edgeEndpoints

  const highlighted = highlightIds ?? new Set<string>()

  return (
    <div ref={containerRef} className="w-full h-full min-h-[320px] relative">
      {nodes.length === 0 ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center gap-2">
          <div className="text-xs text-muted-foreground">该知识库暂无图谱数据</div>
          <p className="text-[11px] text-muted-foreground/70 max-w-xs">文档解析完成后，图谱抽取任务会自动构建实体关系网络。</p>
        </div>
      ) : (
        <svg width={size.width} height={size.height} className="select-none">
          {/* 边 */}
          {edges.map((e, i) => {
            const from = positions.get(e.source)
            const to = positions.get(e.target)
            if (!from || !to) return null
            const isActive = hover === e.source || hover === e.target
            return (
              <g key={`${e.source}-${e.target}-${i}`}>
                <line
                  x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                  stroke={isActive ? "#8b5cf6" : "#e2e8f0"}
                  strokeWidth={isActive ? 2 : Math.min(1.5, 0.5 + (e.weight ?? 1) * 0.3)}
                  opacity={isActive ? 0.9 : 0.6}
                />
              </g>
            )
          })}
          {/* 节点 */}
          {nodes.map(n => {
            const p = positions.get(n.id)
            if (!p) return null
            const r = Math.max(8, Math.min(26, 5 + Math.log2(n.size + 1) * 4))
            const isHover = hover === n.id
            const isHit = highlighted.has(n.name) || highlighted.has(n.id)
            return (
              <g
                key={n.id}
                transform={`translate(${p.x},${p.y})`}
                className="cursor-pointer"
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onSelectEntity?.(n.name)}
              >
                <circle
                  r={r}
                  fill={isHit ? "#f59e0b" : isHover ? "#8b5cf6" : "#a78bfa"}
                  fillOpacity={isHit ? 0.95 : isHover ? 0.85 : 0.75}
                  stroke={isHit ? "#b45309" : isHover ? "#7c3aed" : "#8b5cf6"}
                  strokeWidth={isHover || isHit ? 2 : 1}
                />
                <text
                  textAnchor="middle"
                  dy={r + 12}
                  fontSize={11}
                  fill={isHit ? "#b45309" : "#475569"}
                  fontWeight={isHover || isHit ? 600 : 400}
                  style={{ pointerEvents: "none" }}
                >
                  {n.name.length > 14 ? `${n.name.slice(0, 14)}…` : n.name}
                </text>
                {isHover && (
                  <text textAnchor="middle" dy={-r - 6} fontSize={10} fill="#64748b" style={{ pointerEvents: "none" }}>
                    {n.attributes?.length ? n.attributes.join(" / ") : `度 ${n.size}`}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      )}
      {/* 图例 */}
      {nodes.length > 0 && (
        <div className="absolute bottom-2 right-2 flex flex-col gap-1 bg-card/90 border border-border rounded-md px-2.5 py-1.5 text-[10px] text-muted-foreground">
          <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-violet-400 inline-block" />实体节点（大小=关联度）</div>
          <div className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-slate-300 inline-block" />关系边</div>
          {highlighted.size > 0 && <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" />搜索命中</div>}
        </div>
      )}
    </div>
  )
}
