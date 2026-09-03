// 认证状态管理（frontend/src/store/auth.tsx）
// - token 持久化在 localStorage（读写见 api/client.ts 的 setTokens / clearTokens）
// - 启动时调用 GET /auth/me 校验登录态（client 内部已做 401 → refresh 重试；
//   仍失败 → 未登录态），并并行拉取 /auth/init-status 供路由守卫区分
//   「未初始化 → /init」与「已初始化 → /login」
// - 任意请求 401 且刷新失败 → client 触发登录过期通知，本 store 监听后
//   清空 token + 跳转 /login
// - 对外暴露：{ user, loading, initialized, login, logout, refresh, setUser }

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { useNavigate } from "react-router-dom"
import {
  addAuthFailureListener,
  api,
  clearTokens,
  getRefreshToken,
  setTokens,
} from "../api/client"
import type { AuthResponse, InitStatus, User } from "../api/types"

export interface AuthContextValue {
  /** 当前登录用户；未登录为 null */
  user: User | null
  /** 启动校验是否完成（loading=false 后路由守卫才能安全判断跳转） */
  loading: boolean
  /** 系统是否已初始化（GET /auth/init-status；拉取失败时保守视为已初始化） */
  initialized: boolean
  /** 登录：成功写入 token 与用户信息 */
  login: (email: string, password: string) => Promise<User>
  /** 登出：调用后端销毁 refreshToken（失败不阻塞）并清空本地登录态 */
  logout: () => Promise<void>
  /** 手动刷新登录态（重新 GET /auth/me） */
  refresh: () => Promise<void>
  /** 更新本地用户信息（个人资料修改后同步） */
  setUser: (user: User | null) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const [user, setUser] = useState<User | null>(null)
  const [initialized, setInitialized] = useState(true)
  const [loading, setLoading] = useState(true)

  // 启动校验：并行拉取当前用户 + 初始化状态
  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const me = await api.get<User>("/auth/me")
        if (!cancelled) setUser(me)
      } catch {
        // 未登录 / 刷新失败：保持未登录态（client 已触发登录过期通知）
        if (!cancelled) setUser(null)
      }

      // 初始化状态用于 /init 与 /login 互斥守卫；失败时保守视为已初始化
      try {
        const status = await api.get<InitStatus>("/auth/init-status")
        if (!cancelled) setInitialized(status.initialized)
      } catch {
        // 忽略：保持默认 true
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  // 任意请求 401 且刷新失败 → 自动登出并跳转登录页
  useEffect(() => {
    return addAuthFailureListener(() => {
      clearTokens()
      setUser(null)
      // 已在登录页则不重复跳转
      if (typeof window !== "undefined" && window.location.pathname !== "/login") {
        navigate("/login", { replace: true })
      }
    })
  }, [navigate])

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<AuthResponse>("/auth/login", { email, password })
    setTokens(res.accessToken, res.refreshToken)
    setUser(res.user)
    return res.user
  }, [])

  const logout = useCallback(async () => {
    const refreshToken = getRefreshToken()
    try {
      if (refreshToken) {
        // 后端销毁 Redis 中的 jti；失败不阻塞本地登出
        await api.post("/auth/logout", { refreshToken })
      }
    } catch {
      // 忽略：保证本地登出一定执行
    } finally {
      clearTokens()
      setUser(null)
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<User>("/auth/me")
      setUser(me)
    } catch {
      setUser(null)
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, initialized, login, logout, refresh, setUser }),
    [user, loading, initialized, login, logout, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error("useAuth 必须在 <AuthProvider> 内使用")
  }
  return ctx
}
