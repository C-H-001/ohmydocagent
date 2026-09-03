// 统一 API 客户端（frontend/src/api/client.ts）
// - baseURL 固定为 /api/v1（dev 由 Vite proxy 转发到后端 3000，生产由部署层反代）
// - 请求自动附带 Authorization: Bearer <accessToken>（token 持久化在 localStorage）
// - 401 自动尝试一次 refresh（POST /auth/refresh，携带 refreshToken 旋转）后重放原请求；
//   刷新失败 → 通知登录过期监听器（store 层负责清 token + 跳转 /login）并抛 401 ApiError
// - 业务错误（4xx/5xx 响应体含 message，含 NestJS class-validator 的 message 数组）
//   归一化为 ApiError，message 可直接展示（后端统一中文文案）
// - SSE / 流式接口（对话生成）留给 Task 5.6，本文件只提供标准 JSON 请求便捷方法

import type { AuthResponse } from "./types"

/** 后端 API 前缀（与 vite proxy /api 对齐） */
export const BASE_URL = "/api/v1"

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/** 业务/HTTP 错误：message 为后端返回的可展示文案，status 为 HTTP 状态码（网络错误为 0） */
export class ApiError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// token 存取（localStorage 持久化；auth store 与 client 共用）
// ---------------------------------------------------------------------------

const ACCESS_TOKEN_KEY = "ohmydocagent.accessToken"
const REFRESH_TOKEN_KEY = "ohmydocagent.refreshToken"

/** 安全读取 localStorage（无 localStorage 环境 / 隐私模式返回 null） */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

export function getAccessToken(): string | null {
  return storage()?.getItem(ACCESS_TOKEN_KEY) ?? null
}

export function getRefreshToken(): string | null {
  return storage()?.getItem(REFRESH_TOKEN_KEY) ?? null
}

/** 写入 token（登录成功 / 刷新旋转后调用） */
export function setTokens(accessToken: string, refreshToken: string): void {
  storage()?.setItem(ACCESS_TOKEN_KEY, accessToken)
  storage()?.setItem(REFRESH_TOKEN_KEY, refreshToken)
}

/** 清空本地登录态（登出 / 登录过期由 store 层调用） */
export function clearTokens(): void {
  storage()?.removeItem(ACCESS_TOKEN_KEY)
  storage()?.removeItem(REFRESH_TOKEN_KEY)
}

// ---------------------------------------------------------------------------
// 登录过期通知：任意请求 401 且刷新失败时触发，auth store 注册监听后清 token + 跳 /login
// ---------------------------------------------------------------------------

type AuthFailureListener = () => void
const authFailureListeners = new Set<AuthFailureListener>()

/** 注册登录过期监听，返回取消函数（组件卸载时调用） */
export function addAuthFailureListener(listener: AuthFailureListener): () => void {
  authFailureListeners.add(listener)
  return () => {
    authFailureListeners.delete(listener)
  }
}

function notifyAuthFailure(): void {
  authFailureListeners.forEach((fn) => fn())
}

// ---------------------------------------------------------------------------
// 请求核心
// ---------------------------------------------------------------------------

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  /** 对象自动 JSON 序列化；FormData 原样传递（不手动设 Content-Type） */
  body?: unknown
  headers?: Record<string, string>
  /** query 参数（undefined/null 值自动忽略） */
  query?: Record<string, string | number | boolean | undefined>
  /** 内部标记：已重试过，禁止再次触发刷新（防死循环） */
  _retried?: boolean
}

/**
 * 发起请求：
 * 1. 拼接 baseURL + path + query，注入 Authorization
 * 2. 401 且未重试 → 单飞刷新一次 → 成功则重放原请求（带新 token）
 * 3. 非 2xx → 抛 ApiError（message 取后端返回的可展示文案）
 */
export async function request<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = "GET", body, headers, query, _retried = false } = options

  let url = `${BASE_URL}${path}`
  if (query) {
    const qs = Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(
        ([key, value]) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
      )
      .join("&")
    if (qs) url += `?${qs}`
  }

  const requestHeaders: Record<string, string> = { ...headers }
  const token = getAccessToken()
  if (token) {
    requestHeaders.Authorization = `Bearer ${token}`
  }

  let payload: BodyInit | undefined
  if (body !== undefined && body !== null) {
    if (body instanceof FormData) {
      // FormData 由浏览器自动带 multipart boundary，不能手动设 Content-Type
      payload = body
    } else {
      payload = JSON.stringify(body)
      if (!requestHeaders["Content-Type"]) {
        requestHeaders["Content-Type"] = "application/json"
      }
    }
  }

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: payload,
    })
  } catch {
    // 网络层错误（后端未启动 / 断网）
    throw new ApiError("网络错误，请检查后端服务是否可用", 0)
  }

  // 401：尝试一次刷新后重放原请求
  if (response.status === 401 && !_retried) {
    const result = await refreshAccessToken()
    if (result.ok) {
      return request<T>(path, { ...options, _retried: true })
    }
    notifyAuthFailure()
    throw new ApiError(result.errorMessage ?? "登录已过期，请重新登录", 401)
  }

  return parseResponse<T>(response)
}

/** 解析响应：JSON / 文本；非 2xx 归一化为 ApiError */
async function parseResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? ""
  const text = await response.text()
  let data: unknown = null
  if (text) {
    try {
      data = contentType.includes("json") ? JSON.parse(text) : text
    } catch {
      data = text
    }
  }

  if (!response.ok) {
    throw new ApiError(extractErrorMessage(data, response.status), response.status, extractErrorCode(data))
  }
  return data as T
}

/** 提取后端 message：字符串直接返回；NestJS 校验错误为数组时取第一条 */
function extractErrorMessage(data: unknown, status: number): string {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>
    if (typeof obj.message === "string") return obj.message
    if (Array.isArray(obj.message) && obj.message.length > 0) {
      const first = obj.message[0]
      if (typeof first === "string") return first
    }
  }
  if (status === 401) return "登录已过期，请重新登录"
  return `请求失败（HTTP ${status}）`
}

function extractErrorCode(data: unknown): string | undefined {
  if (data && typeof data === "object") {
    const code = (data as Record<string, unknown>).code
    if (typeof code === "string") return code
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 刷新 accessToken（单飞：并发 401 只触发一次刷新，其余请求等待同一 Promise）
// ---------------------------------------------------------------------------

interface RefreshResult {
  ok: boolean
  errorMessage?: string
}

let refreshInFlight: Promise<RefreshResult> | null = null

function refreshAccessToken(): Promise<RefreshResult> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

async function doRefresh(): Promise<RefreshResult> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) return { ok: false }

  try {
    const response = await fetch(`${BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    })
    if (!response.ok) {
      // 尝试提取后端错误消息（如「刷新令牌无效或已过期」）
      let errorMessage: string | undefined
      try {
        const data = (await response.json()) as Record<string, unknown>
        if (typeof data.message === "string") errorMessage = data.message
      } catch {
        // 响应体不是 JSON，忽略
      }
      return { ok: false, errorMessage }
    }
    // 后端旋转 refreshToken：同时更新 access + refresh
    const data = (await response.json()) as AuthResponse
    setTokens(data.accessToken, data.refreshToken)
    return { ok: true }
  } catch {
    return { ok: false, errorMessage: "网络错误，无法刷新登录状态" }
  }
}

// ---------------------------------------------------------------------------
// 便捷方法
// ---------------------------------------------------------------------------

type NoMethodBodyOptions = Omit<RequestOptions, "method" | "body">

export const api = {
  /** GET 请求 */
  get<T = unknown>(path: string, options?: NoMethodBodyOptions): Promise<T> {
    return request<T>(path, { ...options, method: "GET" })
  },

  /** POST 请求（body 为对象时自动 JSON 序列化） */
  post<T = unknown>(path: string, body?: unknown, options?: NoMethodBodyOptions): Promise<T> {
    return request<T>(path, { ...options, method: "POST", body })
  },

  /** PUT 请求（整体更新） */
  put<T = unknown>(path: string, body?: unknown, options?: NoMethodBodyOptions): Promise<T> {
    return request<T>(path, { ...options, method: "PUT", body })
  },

  /** PATCH 请求（部分更新） */
  patch<T = unknown>(path: string, body?: unknown, options?: NoMethodBodyOptions): Promise<T> {
    return request<T>(path, { ...options, method: "PATCH", body })
  },

  /** DELETE 请求（body 可选：批量删除等需要请求体的 DELETE 端点） */
  del<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>(path, { ...options, method: "DELETE" })
  },

  /** 文件上传：FormData 原样传递（自动 multipart） */
  upload<T = unknown>(path: string, formData: FormData, options?: NoMethodBodyOptions): Promise<T> {
    return request<T>(path, { ...options, method: "POST", body: formData })
  },
}

// 便捷导入
export const get = api.get
export const post = api.post
export const put = api.put
export const patch = api.patch
export const del = api.del
