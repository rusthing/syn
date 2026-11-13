/**
 * # 统一登录骨架
 *
 * 七个前端共用同一份组件：只负责视图、字段校验、错误呈现与提交节流，
 * 认证调用、returnUrl 安全校验与业务错误文案仍留在各项目自己的登录页里。
 * 业务差异全部来自 BRANDS[brand]，不要在本文件里写任何站点判断。
 */

import { useState, type FormEvent, type ReactNode } from "react";
import { BRANDS, type BrandKey } from "./brands";
import "./kit.css";

export interface LoginShellProps {
  brand: BrandKey;
  /** 表单模式：账号 + 口令；入口模式：无凭据校验，只做访问说明 */
  variant?: "form" | "entry";
  /** 由各项目的认证逻辑实现；抛出的 Error.message 会显示在错误条 */
  onSubmit: (account: string, password: string) => Promise<void>;
  title?: string;
  subtitle?: string;
  /** 表单上方提示，例如「登录状态已失效」 */
  banner?: ReactNode;
  /** 替换默认的安全说明卡片 */
  note?: ReactNode;
  /** 安全说明卡片下方的补充说明 */
  extra?: ReactNode;
  submitLabel?: string;
  accountPlaceholder?: string;
  passwordPlaceholder?: string;
}

const DEFAULT_NOTE = (
  <div className="sl-note">
    <b>统一身份 · adm-rs</b>
    <p>
      登录使用 adm 账号体系；口令在浏览器侧完成 SM3 摘要后传输，不以明文提交。登录态在七个控制台间共用，登出一次即全部失效。
    </p>
  </div>
);

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.7" />
      {/* 口令可见时才画斜线（提示「点击隐藏」），与 antd Input.Password 的语义一致 */}
      {open && <path d="M4 4l16 16" />}
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="sl-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function LoginShell({
  brand,
  variant = "form",
  onSubmit,
  title,
  subtitle,
  banner,
  note = DEFAULT_NOTE,
  extra,
  submitLabel,
  accountPlaceholder = "登录名 / 手机号 / 邮箱 / 身份证号",
  passwordPlaceholder = "请输入口令",
}: LoginShellProps) {
  const data = BRANDS[brand];
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const isForm = variant === "form";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (isForm && (!account.trim() || !password)) {
      setError("请输入账号与口令");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit(account.trim(), password);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "登录失败，请稍后重试",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sl-shell" data-brand={data.key} data-login-page>
      <aside className="sl-story">
        <div className="sl-story-grid" aria-hidden="true" />
        <div className="sl-story-glow" aria-hidden="true" />

        <header className="sl-brand">
          <span className="sl-mark">{data.mark}</span>
          <span className="sl-brand-text">
            <b>{data.name}</b>
            <small>{data.en}</small>
          </span>
          <span className="sl-suite">ROBOTECH SUITE / 07</span>
        </header>

        <div className="sl-story-main">
          <div className="sl-visual">{data.glyph}</div>
          <h1 className="sl-headline">
            {data.headline[0]}
            <br />
            <em>{data.headline[1]}</em>
          </h1>
          <p className="sl-desc">{data.description}</p>
          <ul className="sl-features">
            {data.features.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <footer className="sl-story-foot">
          <span>{data.terms}</span>
          <span>UNIFIED IDENTITY</span>
        </footer>
      </aside>

      <main className="sl-pane">
        <div className="sl-panel">
          <div className="sl-mobile-brand">
            <span className="sl-mark">{data.mark}</span>
            <b>{data.name}</b>
          </div>

          <div className="sl-eyebrow">{isForm ? "SIGN IN" : "ACCESS"} · {data.en}</div>
          <h2 className="sl-title">{title ?? `登录 ${data.name}`}</h2>
          <p className="sl-sub">
            {subtitle ?? "使用 adm 统一账号登录；登录态在七个控制台间共用。"}
          </p>

          {banner && <div className="sl-banner">{banner}</div>}

          <form className="sl-form" onSubmit={handleSubmit} noValidate>
            {isForm && (
              <>
                <label className="sl-field">
                  <span className="sl-label">账号<i>*</i></span>
                  <span className="sl-input-wrap">
                    <input
                      className="sl-input"
                      data-login-account
                      type="text"
                      autoFocus
                      autoComplete="username"
                      value={account}
                      placeholder={accountPlaceholder}
                      disabled={busy}
                      onChange={(event) => {
                        setAccount(event.target.value);
                        setError("");
                      }}
                    />
                  </span>
                </label>

                <label className="sl-field">
                  <span className="sl-label">口令<i>*</i></span>
                  <span className="sl-input-wrap">
                    <input
                      className="sl-input"
                      data-login-password
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      value={password}
                      placeholder={passwordPlaceholder}
                      disabled={busy}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setError("");
                      }}
                    />
                    <button
                      className="sl-eye"
                      type="button"
                      aria-label={showPassword ? "隐藏口令" : "显示口令"}
                      onClick={() => setShowPassword((value) => !value)}
                    >
                      <EyeIcon open={showPassword} />
                    </button>
                  </span>
                </label>
              </>
            )}

            {error && (
              <div className="sl-error" role="alert" data-login-error>
                {error}
              </div>
            )}

            <button className="sl-submit" type="submit" data-login-submit disabled={busy}>
              {busy ? (
                <>
                  <Spinner /> 正在校验…
                </>
              ) : (
                <>
                  {submitLabel ?? (isForm ? "登录" : "进入控制台")} <ArrowIcon />
                </>
              )}
            </button>
          </form>

          {note}
          {extra && <div className="sl-extra">{extra}</div>}

          <div className="sl-foot">
            <span>ROBOTECH SUITE · {data.key.toUpperCase()}</span>
            <span>© {new Date().getFullYear()} · UNIFIED IDENTITY</span>
          </div>
        </div>
      </main>
    </div>
  );
}
