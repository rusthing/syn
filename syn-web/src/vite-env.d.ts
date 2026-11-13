/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_SYN_TOKEN?: string;
  readonly VITE_ROUTER?: "browser" | "hash";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
