/**
 * # Syn 同步台登录页
 *
 * 与其余六站共用 adm 账号体系：走 `lib/auth-core.ts` 的 SM3 两段式登录，
 * 成功后把会话写入统一 key，业务请求由 `authHeaders()` 带 Bearer 与真实 X-User-Id。
 * `VITE_AUTH_MODE=disabled`（开发）时内核直接返回系统账号会话，页面仍可正常进入。
 */

import { useNavigate, useSearchParams } from "react-router-dom";
import { loginWithPassword } from "@/lib/auth-core";
import { LoginShell } from "@/login/LoginShell";

/** 只接受站内绝对路径：拒绝 `//host`、反斜杠变形、控制字符与 /login 自跳转 */
function safeReturnUrl(raw: string | null): string {
  if (
    !raw ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("\\") ||
    /[\u0000-\u001f]/.test(raw)
  ) {
    return "/";
  }
  return raw.split(/[?#]/)[0] === "/login" ? "/" : raw;
}

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnUrl = safeReturnUrl(params.get("returnUrl"));

  async function submit(account: string, password: string) {
    await loginWithPassword(account, password);
    navigate(returnUrl, { replace: true });
  }

  return <LoginShell brand="syn" onSubmit={submit} />;
}
