// 注册页（frontend/src/views/auth/RegisterView.tsx）
// 两种模式：
// - URL 带 ?token=（邀请）：调 POST /auth/invitations/lookup 展示邀请邮箱/角色，
//   提交时调 POST /auth/register-by-invite（body 含 token）
// - 无 token：公开注册 POST /auth/register（默认 Admin 角色）
// 成功即返回 AuthResponse，直接写入登录态 → /kb。

import { useMemo, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
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
import { setTokens } from "../../api/client"
import { useAuth } from "../../store/auth"

export default function RegisterView() {
  const navigate = useNavigate()
  const { setUser } = useAuth()
  const [searchParams] = useSearchParams()
  const inviteToken = useMemo(() => searchParams.get("token") ?? "", [searchParams])

  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [submitting, setSubmitting] = useState(false)
  // 邀请信息（lookup 成功后展示绑定邮箱，帮助用户避免输错）
  const [inviteEmail, setInviteEmail] = useState<string | null>(null)
  const [lookupFailed, setLookupFailed] = useState(false)

  // 有 token 时先校验邀请有效性
  useMemo(() => {
    if (!inviteToken) return
    void (async () => {
      try {
        const res = await api.post<{ email: string; role: string }>(
          "/auth/invitations/lookup",
          { token: inviteToken },
        )
        setInviteEmail(res.email)
        setEmail(res.email)
      } catch {
        setLookupFailed(true)
      }
    })()
  }, [inviteToken])

  const handleRegister = async () => {
    if (submitting) return
    if (password !== confirm) {
      toast("两次输入的密码不一致", "error")
      return
    }
    setSubmitting(true)
    try {
      let res: { accessToken: string; refreshToken: string; user: unknown }
      if (inviteToken) {
        res = await api.post("/auth/register-by-invite", {
          token: inviteToken,
          email,
          password,
          name,
        })
      } else {
        res = await api.post("/auth/register", { email, password, name })
      }
      setTokens(res.accessToken, res.refreshToken)
      setUser(res.user as never)
      toast(inviteToken ? "邀请注册成功" : "注册成功")
      navigate("/kb", { replace: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : "注册失败"
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
          <CardTitle className="text-xl text-center">
            {inviteToken ? "接受邀请注册" : "注册账号"}
          </CardTitle>
          <p className="text-sm text-muted-foreground text-center">
            {inviteToken
              ? "您已被邀请加入，注册后自动关联"
              : "创建账号以使用企业知识工作台"}
          </p>
          {inviteEmail && (
            <p className="text-xs text-center text-emerald-600 bg-emerald-50 border border-emerald-100 rounded-md px-3 py-1.5">
              邀请绑定邮箱：{inviteEmail}
            </p>
          )}
          {lookupFailed && (
            <p className="text-xs text-center text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-1.5">
              邀请链接无效或已过期，请联系管理员重新发送
            </p>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-foreground">昵称</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="您的姓名"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-foreground">邮箱</label>
            <Input
              value={email}
              disabled={!!inviteEmail}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
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
          <div className="space-y-2">
            <label className="text-xs font-medium text-foreground">确认密码</label>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="再次输入密码"
            />
          </div>
          <Button
            className="w-full mt-2"
            disabled={submitting || !email || !password || !confirm}
            onClick={handleRegister}
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            注册并进入系统
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
