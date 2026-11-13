/**
 * # 登录门
 *
 * `VITE_AUTH_MODE=disabled` 时 `readSession()` 永远返回系统账号会话，直接放行；
 * `required` 时没有有效会话就跳到本应用的登录页，并通过 `returnUrl` 带回原地址。
 *
 * 401 与本地过期由 auth core 广播 `SESSION_EXPIRED_EVENT`，这里只负责清状态并跳转。
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { SESSION_EXPIRED_EVENT, clearSession, readSession, startSessionWatch } from '../lib/auth-core';

export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState(() => readSession());
  const location = useLocation();

  useEffect(() => {
    const onExpired = () => {
      clearSession();
      setSession(null);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    // 长时间停留时令牌可能到期，auth core 会按分钟检查并广播。
    const stopWatch = startSessionWatch();
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
      stopWatch();
    };
  }, []);

  if (!session) {
    const returnUrl = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?returnUrl=${encodeURIComponent(returnUrl)}`} replace />;
  }
  return <>{children}</>;
}
