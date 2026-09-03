import { createBrowserRouter, Navigate, Outlet } from "react-router-dom"
import MainLayout from "../layouts/MainLayout"
import LoginView from "../views/auth/LoginView"
import RegisterView from "../views/auth/RegisterView"
import InitView from "../views/auth/InitView"
import KnowledgeBasesView from "../views/kb/KnowledgeBasesView"
import KnowledgeBaseDetailView from "../views/kb/KnowledgeBaseDetailView"
import ChatView from "../views/chat/ChatView"
import SettingsView from "../views/settings/SettingsView"
import { AuthProvider } from "../store/auth"
import RequireAuth, { InitGate, LoginGate } from "./RequireAuth"

/** 根壳：提供认证上下文（AuthProvider 需要挂在 Router 内部才能用 useNavigate） */
function AuthShell() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  )
}

export const router = createBrowserRouter([
  {
    element: <AuthShell />,
    children: [
      { path: "/login", element: <LoginGate><LoginView /></LoginGate> },
      { path: "/register", element: <LoginGate><RegisterView /></LoginGate> },
      { path: "/init", element: <InitGate><InitView /></InitGate> },
      {
        path: "/",
        element: <RequireAuth><MainLayout /></RequireAuth>,
        children: [
          { index: true, element: <Navigate to="/kb" replace /> },
          { path: "kb", element: <KnowledgeBasesView /> },
          { path: "kb/:id", element: <KnowledgeBaseDetailView /> },
          { path: "chat", element: <ChatView /> },
          { path: "settings", element: <SettingsView /> },
        ],
      },
      { path: "*", element: <Navigate to="/login" replace /> },
    ],
  },
])
