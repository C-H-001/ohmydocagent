// 登录页（frontend/src/views/auth/LoginView.tsx）
// - 调 POST /auth/login（经 store.login 写入 token + 用户信息）
// - 成功 → /kb；失败 → toast 后端中文 message（如「邮箱或密码错误」）

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
import { useAuth } from "../../store/auth"

export default function LoginView() {
  const navigate = useNavigate()
  const { login } = useAuth()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const handleLogin = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      await login(email, password)
      toast("登录成功")
      navigate("/kb", { replace: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : "登录失败"
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
          <CardTitle className="text-2xl text-center">登录</CardTitle>
          <p className="text-sm text-muted-foreground text-center">
            输入您的企业账号以进入工作台
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-foreground">账号 / 邮箱</label>
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="owner@ohmydocagent.local"
              onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-foreground">密码</label>
              <span className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                忘记密码?
              </span>
            </div>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            />
          </div>
          <Button
            className="w-full mt-2"
            disabled={submitting || !email || !password}
            onClick={handleLogin}
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            进入系统
          </Button>
          <div className="text-center text-xs text-muted-foreground mt-4 flex gap-4 justify-center">
            <span
              className="cursor-pointer hover:underline"
              onClick={() => navigate("/init")}
            >
              初始化系统
            </span>
            <span
              className="cursor-pointer hover:underline"
              onClick={() => navigate("/register")}
            >
              接受邀请注册
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
