// API 客户端单元测试（frontend/src/api/client.spec.ts）
// 覆盖：JWT 注入 / baseURL 拼接 / 401 刷新重试 / 刷新失败通知 / 业务错误归一化 /
// query 拼接 / JSON 序列化 / FormData 上传。fetch 通过 vi.stubGlobal 注入 mock。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  addAuthFailureListener,
  api,
  ApiError,
  clearTokens,
  request,
  setTokens,
} from "./client"

/** 构造最小可用的 mock Response（不依赖全局 Response，保证 jsdom 下可跑）
 * 默认 Content-Type: application/json（与真实后端一致）；非 JSON 响应显式传 header 覆盖。
 */
function mockResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const headerMap: Record<string, string> = {
    "content-type": "application/json",
  }
  for (const [key, value] of Object.entries(headers)) {
    headerMap[key.toLowerCase()] = value
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headerMap[name.toLowerCase()] ?? null,
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body)
    },
    async json() {
      return typeof body === "string" ? JSON.parse(body) : body
    },
  } as unknown as Response
}

/** 断言请求必然失败，返回归一化后的 ApiError（带完整类型，便于断言字段） */
async function expectReject<T>(promise: Promise<T>): Promise<ApiError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof ApiError) return err
    throw new Error(`期望抛 ApiError，实际抛了: ${String(err)}`)
  }
  throw new Error("期望请求失败，实际成功了")
}

/** 读取第 index 次 fetch 调用的 [url, init]，并把 init 视为普通对象 */
function fetchCall(index: number): [string, { headers: Record<string, string>; body?: unknown; method?: string }] {
  const call = vi.mocked(fetch).mock.calls[index] as [string, Record<string, unknown>]
  return [call[0], call[1] as { headers: Record<string, string>; body?: unknown; method?: string }]
}

describe("API 客户端", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it("baseURL 拼接正确，且请求自动携带 Authorization", async () => {
    setTokens("test-access-token", "test-refresh-token")
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse(200, { id: "u1", email: "a@b.c" }))
    vi.stubGlobal("fetch", fetchMock)

    const data = await request<{ id: string }>("/auth/me")

    expect(data.id).toBe("u1")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchCall(0)
    expect(url).toBe("/api/v1/auth/me")
    expect(init.headers.Authorization).toBe("Bearer test-access-token")
  })

  it("无 token 时请求不带 Authorization", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse(200, { initialized: true }))
    vi.stubGlobal("fetch", fetchMock)

    await request("/auth/init-status")

    const [, init] = fetchCall(0)
    expect(init.headers.Authorization).toBeUndefined()
  })

  it("401 时自动刷新一次并重放原请求，新 token 写入本地", async () => {
    setTokens("expired-token", "rotatable-refresh")
    const fetchMock = vi
      .fn()
      // 1. 原请求 401
      .mockResolvedValueOnce(mockResponse(401, { message: "未授权" }))
      // 2. POST /auth/refresh 成功（旋转出新的双 token）
      .mockResolvedValueOnce(
        mockResponse(200, {
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
          user: { id: "u1" },
        }),
      )
      // 3. 重放原请求成功
      .mockResolvedValueOnce(mockResponse(200, { id: "u1" }))
    vi.stubGlobal("fetch", fetchMock)

    const data = await request<{ id: string }>("/auth/me")

    expect(data).toEqual({ id: "u1" })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // refresh 请求体携带原 refreshToken，且请求 /auth/refresh
    const [refreshUrl, refreshInit] = fetchCall(1)
    expect(refreshUrl).toBe("/api/v1/auth/refresh")
    expect(JSON.parse(refreshInit.body as string).refreshToken).toBe("rotatable-refresh")

    // 新 token 已持久化，重放请求使用新 accessToken
    expect(localStorage.getItem("ohmydocagent.accessToken")).toBe("new-access-token")
    expect(localStorage.getItem("ohmydocagent.refreshToken")).toBe("new-refresh-token")
    const [, retryInit] = fetchCall(2)
    expect(retryInit.headers.Authorization).toBe("Bearer new-access-token")
  })

  it("并发 401 只触发一次刷新（单飞）", async () => {
    setTokens("expired-token", "rotatable-refresh")
    const fetchMock = vi
      .fn()
      // 两次原请求均 401
      .mockResolvedValueOnce(mockResponse(401, { message: "未授权" }))
      .mockResolvedValueOnce(mockResponse(401, { message: "未授权" }))
      // 一次 refresh
      .mockResolvedValueOnce(
        mockResponse(200, {
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
          user: { id: "u1" },
        }),
      )
      // 两次重放
      .mockResolvedValueOnce(mockResponse(200, { id: "u1" }))
      .mockResolvedValueOnce(mockResponse(200, { id: "u2" }))
    vi.stubGlobal("fetch", fetchMock)

    const [a, b] = await Promise.all([
      request("/auth/me"),
      request("/users/1"),
    ])

    expect(a).toEqual({ id: "u1" })
    expect(b).toEqual({ id: "u2" })
    // 原请求 2 次 + refresh 1 次 + 重放 2 次
    expect(fetchMock).toHaveBeenCalledTimes(5)
    const refreshCalls = fetchMock.mock.calls.filter(
      ([url]) => url === "/api/v1/auth/refresh",
    )
    expect(refreshCalls).toHaveLength(1)
  })

  it("刷新失败时抛 401 ApiError 并通知登录过期监听器（token 清理由 store 层）", async () => {
    setTokens("expired-token", "bad-refresh")
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(401, { message: "未授权" }))
      .mockResolvedValueOnce(
        mockResponse(401, { message: "刷新令牌无效或已过期" }),
      )
    vi.stubGlobal("fetch", fetchMock)

    const listener = vi.fn()
    const unsubscribe = addAuthFailureListener(listener)

    const err = await expectReject(request("/auth/me"))
    expect(err.status).toBe(401)
    expect(err.message).toBe("刷新令牌无效或已过期")
    expect(listener).toHaveBeenCalledTimes(1)
    // 刷新失败时 client 不主动清 token（由 store 层监听器负责）
    expect(localStorage.getItem("ohmydocagent.accessToken")).toBe("expired-token")

    unsubscribe()
  })

  it("业务错误抛 ApiError，message 直接取自后端中文文案", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(400, { message: "知识库名称不能为空", code: "KB_NAME_REQUIRED" }),
      ),
    )

    const err = await expectReject(request("/kb"))
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe("知识库名称不能为空")
    expect(err.status).toBe(400)
    expect(err.code).toBe("KB_NAME_REQUIRED")
  })

  it("NestJS 校验错误（message 数组）取第一条文案", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(400, { message: ["邮箱格式不正确", "密码不能为空"] }),
      ),
    )

    const err = await expectReject(
      api.post("/auth/login", { email: "x", password: "" }),
    )
    expect(err.message).toBe("邮箱格式不正确")
  })

  it("非 JSON 错误响应回退为通用文案", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(500, "Internal Server Error", { "Content-Type": "text/plain" }),
      ),
    )

    const err = await expectReject(request("/kb"))
    expect(err.message).toBe("请求失败（HTTP 500）")
  })

  it("网络错误（fetch 抛异常）归一化为 ApiError status=0", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")))

    const err = await expectReject(request("/kb"))
    expect(err.status).toBe(0)
    expect(err.message).toContain("网络错误")
  })

  it("query 参数正确拼接到 URL，undefined 值被忽略", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(200, { items: [], total: 0, page: 1, pageSize: 10 }),
      ),
    )

    await api.get("/kb", {
      query: { page: 1, pageSize: 10, q: "abc def", keyword: undefined },
    })

    const [url] = fetchCall(0)
    expect(url).toBe("/api/v1/kb?page=1&pageSize=10&q=abc%20def")
  })

  it("POST 对象自动 JSON 序列化并带 Content-Type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(200, { accessToken: "a", refreshToken: "r", user: { id: "u1" } }),
      ),
    )

    await api.post("/auth/login", { email: "a@b.c", password: "p" })

    const [, init] = fetchCall(0)
    expect(init.method).toBe("POST")
    expect(init.headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.c", password: "p" })
  })

  it("upload 使用 FormData 且不手动设置 Content-Type", async () => {
    const formData = new FormData()
    formData.append("file", new Blob(["hello"]), "a.pdf")

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse(201, { id: "k1" })),
    )

    await api.upload("/kb/upload", formData)

    const [url, init] = fetchCall(0)
    expect(url).toBe("/api/v1/kb/upload")
    expect(init.body).toBe(formData)
    expect(init.headers["Content-Type"]).toBeUndefined()
  })

  it("clearTokens 清空本地 token", () => {
    setTokens("a", "r")
    expect(localStorage.getItem("ohmydocagent.accessToken")).toBe("a")
    clearTokens()
    expect(localStorage.getItem("ohmydocagent.accessToken")).toBeNull()
    expect(localStorage.getItem("ohmydocagent.refreshToken")).toBeNull()
  })
})
