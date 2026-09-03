// 格式化工具单测（frontend/src/utils/format.spec.ts）
// 轻量冒烟：覆盖日期/文件大小/状态映射三个高频工具函数。

import { describe, expect, it } from "vitest"
import {
  CHUNK_INDEX_META,
  KNOWLEDGE_STATUS_META,
  formatDateTime,
  formatFileSize,
  truncate,
} from "./format"

describe("formatDateTime", () => {
  it("ISO 时间串格式化为 YYYY-MM-DD HH:mm", () => {
    // 用本地时区构造，避免 CI 时区差异导致断言漂移
    const d = new Date(2026, 0, 15, 10, 23)
    expect(formatDateTime(d.toISOString())).toBe("2026-01-15 10:23")
  })

  it("空值/非法值返回占位符", () => {
    expect(formatDateTime(null)).toBe("—")
    expect(formatDateTime(undefined)).toBe("—")
    expect(formatDateTime("not-a-date")).toBe("—")
  })
})

describe("formatFileSize", () => {
  it("按字节数自动选单位", () => {
    expect(formatFileSize(512)).toBe("512 B")
    expect(formatFileSize(2048)).toBe("2.0 KB")
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe("2.5 MB")
    expect(formatFileSize(0)).toBe("—")
    expect(formatFileSize(null)).toBe("—")
  })
})

describe("状态映射", () => {
  it("解析状态四态齐全", () => {
    for (const s of ["pending", "parsing", "ready", "failed"]) {
      expect(KNOWLEDGE_STATUS_META[s]).toBeTruthy()
    }
    expect(KNOWLEDGE_STATUS_META.parsing.loading).toBe(true)
    expect(KNOWLEDGE_STATUS_META.ready.label).toBe("就绪")
  })

  it("分块索引状态映射", () => {
    expect(CHUNK_INDEX_META.ready).toBe("已索引")
  })
})

describe("truncate", () => {
  it("超长截断并加省略号", () => {
    expect(truncate("a".repeat(300), 200)).toHaveLength(201)
    expect(truncate("short", 200)).toBe("short")
    expect(truncate(null)).toBe("")
  })
})
