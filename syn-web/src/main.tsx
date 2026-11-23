import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// 独立站根节点带上联邦作用域类：vite-plugin-scope-utilities 把 Tailwind 工具类
// 收进了 @scope (.syn-federated)，独立入口也必须落在这个作用域内，样式才生效。
document.getElementById("root")!.classList.add("syn-federated");

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
