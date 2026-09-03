// 前端展示格式化工具（frontend/src/utils/format.ts）
// 轻量模式：集中日期/文件大小/状态标签映射，供知识库列表、详情、预览抽屉复用。

/** 文档/分块解析状态 → 展示文案与色系（与后端 KnowledgeStatus 对齐） */
export type KnowledgeStatusMeta = {
  label: string
  /** tailwind 类（badge 底色/文字色） */
  cls: string
  loading?: boolean
}

export const KNOWLEDGE_STATUS_META: Record<string, KnowledgeStatusMeta> = {
  pending: { label: "排队中", cls: "bg-muted text-muted-foreground border-border" },
  parsing: { label: "解析中", cls: "bg-amber-50 text-amber-600 border-amber-100", loading: true },
  ready: { label: "就绪", cls: "bg-emerald-50 text-emerald-600 border-emerald-100" },
  failed: { label: "失败", cls: "bg-red-50 text-red-600 border-red-100" },
}

/** 分块向量化状态（indexStatus）→ 展示文案 */
export const CHUNK_INDEX_META: Record<string, string> = {
  processing: "向量化中",
  ready: "已索引",
  failed: "失败",
}

/** 文档来源类型 → 中文标签 */
export const KNOWLEDGE_TYPE_LABEL: Record<string, string> = {
  file: "上传",
  url: "URL 导入",
  manual: "手动创建",
}

/** ISO 时间串 → 本地化展示（空值返回占位符） */
export function formatDateTime(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 字节数 → 可读大小（B/KB/MB/GB） */
export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let unit = units[0]
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024
    unit = units[i]
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`
}

/** 解析阶段名 → 中文标签（stages 时间线展示） */
export const PARSER_STAGE_LABEL: Record<string, string> = {
  extract: "文本抽取",
  chunk: "分块处理",
  embed: "向量化",
  summary: "摘要生成",
}

/** 安全截断长文本（预览/摘要展示） */
export function truncate(text: string | null | undefined, max = 200): string {
  if (!text) return ""
  return text.length > max ? `${text.slice(0, max)}…` : text
}
