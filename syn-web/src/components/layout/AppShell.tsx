import { Outlet, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

export function AppShell() {
  const { pathname } = useLocation();
  // 控制面板是画布页：宽度和高度都吃满可用容器；其它页保持 1440 阅读列 + 底部留白。
  // 外壳高度跟随容器（联邦窗口 / 独立站 #root），只有内容区滚动，侧栏不跟着滚。
  const fullBleed = pathname.replace(/\/+$/, "") === "/topology";

  return (
    <div className="flex h-full min-h-0 bg-canvas">
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Topbar />
        <main
          className={cn(
            "w-full flex-1 px-4 pt-5 lg:px-8",
            fullBleed
              ? "flex min-h-0 flex-col overflow-hidden pb-0"
              : "mx-auto max-w-[1440px] min-h-0 overflow-y-auto pb-12",
          )}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
