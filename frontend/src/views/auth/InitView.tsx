// 首次部署初始化页（frontend/src/views/auth/InitView.tsx）
// - 调 POST /auth/init（email/name/password）创建 Owner
// - 成功后用同一凭据自动登录（复用 store.login，失败则退回登录页手动登录）
// - 后端 409「系统已初始化」/ 校验错误 400 等中文 message 经 ApiError 直接 toast

import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { LayoutTemplate, Loader2 } from "lucide-react"
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Button,
  Input,
  toast,
} from "../../components/ui"
import { api } from "../../api/client"
import { useAuth } from "../../store/auth"

export default function InitView() {
  const navigate = useNavigate()
  const { login } = useAuth()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const handleInit = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      await api.post("/auth/init", { email, password, name })
      toast("初始化成功，正在进入系统…")
      try {
        await login(email, password)
        navigate("/kb", { replace: true })
      } catch {
        // init 已签发 token，但自动登录失败（如限流）——退回登录页手动登录
        navigate("/login", { replace: true })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "初始化失败"
      toast(message, "error")
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-screen w-full items-center justify-center bg-muted/30">
      <Card className="w-full max-w-sm shadow-xl shadow-black/5">
        <CardHeader className="space-y-1 pb-4">
          <div className="flex items-center gap-2 font-semibold text-xl text-foreground justify-center mb-4">
            <LayoutTemplate className="w-6 h-6 text-primary" />
            <span>AI Workbench</span>
          </div>
          <CardTitle className="text-xl text-center">初始化系统配置</CardTitle>
          <p className="text-sm text-muted-foreground text-center">
            首次部署，请创建超级管理员账号
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-foreground">管理员昵称</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：System Admin"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-foreground">账号 / 邮箱</label>
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@domain.com"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-foreground">密码</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 8 位，且包含字母和数字"
            />
          </div>
          <Button
            className="w-full mt-2"
            disabled={submitting || !email || !password}
            onClick={handleInit}
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            创建并进入系统
          </Button>
          <div className="text-center text-xs text-muted-foreground mt-4">
            <span
              className="cursor-pointer hover:underline"
              onClick={() => navigate("/login")}
            >
              已有账号？去登录
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
