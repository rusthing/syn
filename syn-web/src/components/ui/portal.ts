/**
 * Portal 宿主：vite-plugin-scope-utilities 把 Tailwind 工具类收进了
 * @scope (.syn-federated)，直接挂 document.body 的弹层会掉出作用域、样式全丢。
 * 这里挂一个同作用域的隐形容器，并复制主题令牌，独立站与联邦都适用。
 */
let portalRoot: HTMLDivElement | null = null;

export function overlayPortalTarget(): HTMLElement {
  if (!portalRoot) {
    portalRoot = document.createElement("div");
    portalRoot.className = "syn-federated syn-overlay-portal";
  }
  const pageRoot = document.querySelector(".syn-federated:not(.syn-overlay-portal)");
  const theme = pageRoot?.getAttribute("data-theme");
  if (theme) portalRoot.setAttribute("data-theme", theme);
  else portalRoot.removeAttribute("data-theme");
  if (portalRoot.parentElement !== document.body) document.body.appendChild(portalRoot);
  return portalRoot;
}
