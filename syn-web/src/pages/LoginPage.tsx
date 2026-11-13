import { useNavigate } from "react-router-dom";
import { LoginShell } from "@/login/LoginShell";

/**
 * # Syn 访问入口页
 *
 * 与其它六站使用同一套登录骨架，但 syn-svr 目前没有接入 adm 账号体系
 * （访问令牌由构建时注入的 VITE_SYN_TOKEN 提供），因此这里刻意不做假的账号口令校验：
 * 用 variant="entry" 明确标注访问模式，按钮只负责进入控制台。
 * 若将来 syn-svr 接上统一鉴权，把 variant 去掉、把 onSubmit 换成真实登录调用即可。
 */
export function LoginPage() {
  const navigate = useNavigate();

  async function submit() {
    navigate("/", { replace: true });
  }

  return (
    <LoginShell
      brand="syn"
      variant="entry"
      onSubmit={submit}
      title="进入 Syn 同步台"
      subtitle="本控制台未接入 adm 账号体系；访问令牌由部署方在构建时注入，此处不校验账号口令。"
      banner="当前为内网 / 演示访问模式：按钮直接进入控制台，不做身份校验。若部署方在网关侧启用了鉴权，请以网关登录为准。"
      note={
        <div className="sl-note">
          <b>关于访问方式</b>
          <p>
            syn-web 使用构建时注入的 VITE_SYN_TOKEN 直连 syn-svr，前端不保存任何账号信息。
            需要统一身份时，请先在 syn-svr 侧接入 adm 鉴权，再把本页切换为账号口令模式。
          </p>
        </div>
      }
    />
  );
}
