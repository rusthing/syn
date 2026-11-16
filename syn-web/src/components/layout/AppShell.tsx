import { Outlet, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

export function AppShell() {
  const { pathname } = useLocation();
  // 控制面板是画布页：宽度和高度都吃满可用视口；其它页保持 1440 阅读列 + 底部留白
  const fullBleed = pathname.replace(/\/+$/, "") === "/topology";

  return (
    <div className={cn("flex bg-canvas", fullBleed ? "h-screen overflow-hidden" : "min-h-screen")}>
      <Sidebar />
      <div className={cn("flex min-w-0 flex-1 flex-col", fullBleed && "min-h-0")}>
        <Topbar />
        <main
          className={cn(
            "w-full flex-1 px-4 pt-5 lg:px-8",
            fullBleed ? "flex min-h-0 flex-col pb-0" : "mx-auto max-w-[1440px] pb-12",
          )}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
