import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { federation } from "@module-federation/vite";
import { fileURLToPath, URL } from "node:url";
import { scopeUtilities } from "./vite-plugin-scope-utilities.mjs";

/**
 * 开发期把 `/api` 反代到 syn 服务端（默认 127.0.0.1:9007，见 syn-svr.toml 的 web.port），
 * 并去掉 `/api` 前缀 —— 后端真实路径是 `/syn/sync/{topic}` 这类，不带 `/api`。
 *
 * 换后端地址：VITE_PROXY_TARGET=http://10.0.0.7:9007 pnpm dev
 *
 * 部署到子路径（例如 http://host/syn-web/）时必须给 `PUBLIC_BASE`，它决定 index.html 里
 * 资源引用的前缀，必须和 nginx 的 location 一字不差，否则 `/assets/*.js` 全部 404：
 *   PUBLIC_BASE=/syn-web/ pnpm build
 * 生产值写在 `.env.production`，`pnpm build` 会自动读取；临时覆盖用命令行环境变量。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const base = env.PUBLIC_BASE?.trim() || "/";

  const sharedReact = {
    singleton: true,
    allowNodeModulesSuffixMatch: true,
  } as const;

  return {
    base,
    plugins: [
      // 联邦入口只暴露一个页面级模块：独立站照常 createRoot，两者共用 AppRoutes。
      federation({
        name: "syn-web",
        filename: "remoteEntry.js",
        exposes: { "./syn-app": "./src/federation/SynFederatedApp.tsx" },
        shared: {
          react: sharedReact,
          "react/jsx-runtime": sharedReact,
          "react-dom": sharedReact,
          "react-dom/client": sharedReact,
        },
        // 页面样式（Tailwind 生成的 @theme 变量也在其中）必须随暴露模块一起出，
        // 否则宿主只拿到组件、没有令牌，会渲染成无样式的裸 HTML。
        bundleAllCSS: true,
        manifest: true,
      }),
      react(),
      tailwindcss(),
      // 把工具类作用域限制在 .syn-federated 内，避免多联邦应用同名类互相覆盖
      scopeUtilities(".syn-federated"),
    ],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      port: 5182,
      // dev 下联邦 runtime 需要用绝对地址取 remoteEntry.js，否则 uiam 会从
      // 自己的 5183 端口去找，拿到的是 uiam 的 index.html。
      origin: env.VITE_DEV_ORIGIN?.trim() || "http://localhost:5182",
      proxy: {
        "/api": {
          target: env.VITE_PROXY_TARGET?.trim() || "http://127.0.0.1:9008",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
        // adm 统一身份接口：AUTH_BASE=/adm → /adm/auth/login。
        // 与其余六站同口径；两个服务不在同一端口时用 VITE_ADM_TARGET 覆盖。
        "/adm": {
          target: env.VITE_ADM_TARGET?.trim() || "http://127.0.0.1:9007",
          changeOrigin: true,
        },
      },
    },
    preview: {
      port: 4181,
    },
    build: {
      target: "es2022",
      sourcemap: false,
    },
  };
});
