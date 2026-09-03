// 路由守卫（frontend/src/router/RequireAuth.tsx）
// 组合了三条规则（与 Task 5.1 契约一致）：
// 1. RequireAuth：受保护路由未登录 → /login；未初始化 → /init
// 2. LoginGate：/login 已登录 → /（首页）；未初始化 → /init
// 3. InitGate：/init 已登录 → /；已初始化 → /login
// loading 阶段展示加载态，避免启动校验完成前误跳转。

import type { ReactNode } from "react"
import { Navigate, useLocation } from "react-router-dom"
import { useAuth } from "../store/auth"

/** 启动校验期间的全局加载态（防闪烁/误跳转） */
export function LoadingScreen() {
  return (
    <div className="flex h-screen w-full items-center justify-center bg-muted/30">
      <div className="flex flex-col items-center gap-2">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <div className="text-sm text-muted-foreground animate-pulse">加载中…</div>
      </div>
    </div>
  )
}

/** 受保护路由守卫：未登录跳 /login（未初始化跳 /init） */
export default function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, initialized } = useAuth()
  const location = useLocation()

  if (loading) return <LoadingScreen />
  if (!user) {
    // 未初始化 → 引导进入首次部署初始化；否则 → 登录页（记住来源路径）
    return (
      <Navigate
        to={initialized ? "/login" : "/init"}
        replace
        state={{ from: location.pathname }}
      />
    )
  }
  return <>{children}</>
}

/** 登录页守卫：已登录直接回首页；未初始化跳 /init */
export function LoginGate({ children }: { children: ReactNode }) {
  const { user, loading, initialized } = useAuth()

  if (loading) return <LoadingScreen />
  if (user) return <Navigate to="/" replace />
  if (!initialized) return <Navigate to="/init" replace />
  return <>{children}</>
}

/** 初始化页守卫：已登录回首页；已初始化跳 /login */
export function InitGate({ children }: { children: ReactNode }) {
  const { user, loading, initialized } = useAuth()

  if (loading) return <LoadingScreen />
  if (user) return <Navigate to="/" replace />
  if (initialized) return <Navigate to="/login" replace />
  return <>{children}</>
}
