import { useLocation } from "react-router-dom";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import { CircleUser, RefreshCw, RotateCw, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTime } from "@/lib/time";
import { tasks } from "@/lib/api";
import { useNow } from "@/hooks/use-now";
import { useToast } from "@/components/ui/Toast";
import { Wordmark } from "./Logo";
import { NAV } from "./Sidebar";

const TITLES: Record<string, string> = Object.fromEntries(NAV.map((n) => [n.to, n.label]));

export function Topbar() {
  const location = useLocation();
  const fetching = useIsFetching();
  const queryClient = useQueryClient();
  const now = useNow(1_000);
  const toast = useToast();

  const title = TITLES[location.pathname] ?? "同步总览";

  /**
   * 重载快照是**唯一**能让线上生效的动作：配置改在库里，进程里还是旧的那份。
   * 所以它必须显眼地放在顶栏，而不是藏在设置里。
   */
  const reload = useMutation({
    mutationFn: () => tasks.reload(),
    onSuccess: (result) => {
      void queryClient.invalidateQueries();
      const count = result && "count" in result ? result.count : null;
      toast.success(
        "已重载任务快照",
        count === null ? "执行器已按库里最新配置生效" : `${count} 个任务生效`,
      );
    },
    onError: (error: Error) => toast.error("重载失败", error.message),
  });

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-canvas/85 px-4 backdrop-blur-md lg:px-8">
      <div className="md:hidden">
        <Wordmark compact />
      </div>

      <div className="hidden items-center gap-2 text-[12px] text-muted md:flex">
        <span className="font-mono text-[11px] tracking-[0.04em] text-muted/80">SYN</span>
        <span className="text-line-strong">/</span>
        <span className="text-[12.5px] font-medium text-ink">{title}</span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span className="hidden items-center gap-1.5 text-[11px] text-muted lg:flex">
          <span className="relative flex size-1.5">
            <span className="live-dot relative size-1.5 rounded-full bg-success/80" />
          </span>
          <span className="tnum font-mono">{formatTime(now)}</span>
        </span>

        <button
          type="button"
          onClick={() => void queryClient.invalidateQueries()}
          title="刷新当前页数据"
          aria-label="刷新当前页数据"
          className={cn(
            "flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-muted transition-colors hover:border-line-strong hover:text-ink",
          )}
        >
          <RotateCw className={cn("size-3.5", fetching > 0 && "animate-spin")} />
        </button>

        <button
          type="button"
          onClick={() => reload.mutate()}
          disabled={reload.isPending}
          title="让执行器重新读取 syn_task 里的配置（不重启进程）"
          className="flex h-8 items-center gap-1.5 rounded-lg border border-accent/25 bg-accent-soft px-2.5 text-[12px] font-medium text-accent-strong transition-colors hover:bg-[#d9ebe3] disabled:opacity-50"
        >
          <Zap className="size-3.5" strokeWidth={2} />
          重载快照
          {reload.isPending && <RefreshCw className="size-3 animate-spin" />}
        </button>

        <span
          className="hidden h-8 items-center gap-1.5 rounded-lg border border-line bg-surface pl-1.5 pr-2 text-[12px] font-medium text-ink-soft sm:flex"
          title="写操作的 X-User-Id。生产由统一登录态提供，这里固定 0"
        >
          <CircleUser className="size-4 text-muted" strokeWidth={1.7} />
          <span className="tnum">操作人 #0</span>
        </span>
      </div>
    </header>
  );
}
