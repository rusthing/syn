/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_ROUTER?: "browser" | "hash";
  /** adm 统一身份：构建期决定是否需要登录 */
  readonly VITE_AUTH_MODE?: "required" | "disabled";
  /** 认证接口前缀（含 /adm），见 src/lib/auth-core.ts */
  readonly VITE_AUTH_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
