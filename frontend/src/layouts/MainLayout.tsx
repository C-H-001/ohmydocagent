import { useState } from "react"
import { Outlet, useNavigate, useLocation } from "react-router-dom"
import {
  Book, MessageSquare, Settings, LayoutTemplate,
  ChevronDown, LogOut, User, Shield
} from "lucide-react"
import { cn } from "../components/ui"
import { useAuth } from "../store/auth"

export default function MainLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const current = location.pathname
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const { user, logout } = useAuth()
  const displayName = user?.name || user?.email?.split("@")[0] || "用户"
  const roleLabel =
    user?.role === "super" ? "系统管理员" : user?.role === "member" ? "成员" : ""

  const handleLogout = async () => {
    setUserMenuOpen(false)
    await logout()
    navigate("/login", { replace: true })
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <aside className="w-[220px] flex-shrink-0 border-r border-border bg-card flex flex-col z-20">
        {/* Logo */}
        <div className="h-14 flex items-center px-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2 font-semibold text-foreground tracking-tight">
            <LayoutTemplate className="w-5 h-5 text-foreground" />
            <span className="text-sm">AI Workbench</span>
          </div>
        </div>

        {/* Primary Nav */}
        <nav className="flex-shrink-0 py-3 px-3 space-y-0.5 border-b border-border">
          <NavItem
            icon={<Book className="w-4 h-4" />}
            label="知识库"
            active={current.startsWith("/kb")}
            onClick={() => navigate("/kb")}
          />
          <NavItem
            icon={<MessageSquare className="w-4 h-4" />}
            label="会话"
            active={current.startsWith("/chat")}
            onClick={() => navigate("/chat")}
          />
        </nav>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Bottom Nav */}
        <div className="p-3 border-t border-border space-y-0.5 flex-shrink-0">
          <NavItem
            icon={<Settings className="w-4 h-4" />}
            label="设置中心"
            active={current.startsWith("/settings")}
            onClick={() => navigate("/settings")}
          />

          {/* User area */}
          <div className="relative mt-1">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className={cn(
                "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md hover:bg-muted transition-colors",
                userMenuOpen && "bg-muted"
              )}
            >
              <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold font-mono flex-shrink-0">
                AU
              </div>
              <div className="flex-1 min-w-0 text-left">
                <div className="text-xs font-semibold truncate">{displayName}</div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-mono">{roleLabel}</div>
              </div>
              <ChevronDown className={cn("w-3.5 h-3.5 text-muted-foreground transition-transform", userMenuOpen && "rotate-180")} />
            </button>

            {userMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setUserMenuOpen(false)} />
                <div className="absolute bottom-full left-0 right-0 mb-1 z-20 bg-card border border-border rounded-lg shadow-xl py-1 overflow-hidden">
                  <div className="px-3 py-2 border-b border-border">
                    <div className="text-xs font-semibold">{displayName}</div>
                    <div className="text-[10px] text-muted-foreground">{user?.email ?? ""}</div>
                  </div>
                  <button
                    onClick={() => { setUserMenuOpen(false); navigate("/settings") }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-muted transition-colors"
                  >
                    <User className="w-3.5 h-3.5 text-muted-foreground" />
                    个人资料
                  </button>
                  <button
                    onClick={() => { setUserMenuOpen(false); navigate("/settings") }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-muted transition-colors"
                  >
                    <Shield className="w-3.5 h-3.5 text-muted-foreground" />
                    系统设置
                  </button>
                  <div className="border-t border-border my-0.5" />
                  <button
                    onClick={handleLogout}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-red-50 text-red-600 transition-colors"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    退出登录
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-background relative">
        <Outlet />
      </main>
    </div>
  )
}

function NavItem({
  icon, label, active, onClick,
}: {
  icon: React.ReactNode; label: string; active?: boolean; onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm font-medium transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}
