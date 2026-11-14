import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  Database,
  Fingerprint,
  FlaskConical,
  LayoutDashboard,
  Network,
  Radio,
  ScrollText,
  Settings2,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  endpointLabel,
  getDataMode,
  setDataMode,
  subscribeDataMode,
  type DataMode,
} from "@/lib/api";
import { useOverview } from "@/hooks/use-overview";
import { useToast } from "@/components/ui/Toast";
import { Wordmark } from "./Logo";

export const NAV = [
  { to: "/", label: "同步总览", icon: LayoutDashboard, end: true },
  { to: "/topology", label: "控制面板", icon: Network },
  { to: "/tasks", label: "同步任务", icon: Workflow },
  { to: "/sources", label: "取数来源", icon: Radio },
  { to: "/datasources", label: "数据源", icon: Database },
  { to: "/playground", label: "试跑", icon: FlaskConical },
  { to: "/deliveries", label: "投递记录", icon: ScrollText },
  { to: "/idem", label: "幂等台账", icon: Fingerprint },
] as const;

export function useDataMode(): DataMode {
  const [mode, setMode] = useState<DataMode>(() => getDataMode());
  useEffect(() => subscribeDataMode(setMode), []);
  return mode;
}

export function Sidebar() {
  const mode = useDataMode();
  const { data } = useOverview();
  const toast = useToast();

  const toggle = () => {
    const next: DataMode = mode === "mock" ? "live" : "mock";
    setDataMode(next);
    toast.info(
      next === "mock" ? "已切换到演示数据" : "已切换到实时接口",
      next === "mock" ? "数据来自内存样例，不会写库" : endpointLabel(),
    );
  };

  return (
    <aside className="sticky top-0 hidden h-screen w-[228px] shrink-0 flex-col border-r border-line bg-surface md:flex">
      <div className="flex h-14 items-center border-b border-line px-4">
        <Wordmark />
      </div>

      <nav className="flex-1 overflow-y-auto px-2.5 pt-4">
        <p className="mb-1.5 px-2 text-[10.5px] font-medium tracking-[0.12em] text-muted/80">链路</p>
        <ul className="space-y-0.5">
          {NAV.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={"end" in item ? item.end : false}
                className={({ isActive }) =>
                  cn(
                    "group flex h-9 items-center gap-2.5 rounded-lg px-2 text-[13px] transition-colors",
                    isActive
                      ? "bg-accent-soft font-medium text-accent-strong"
                      : "text-ink-soft hover:bg-ink/[0.045] hover:text-ink",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon
                      className={cn("size-[15px]", isActive ? "text-accent" : "text-muted")}
                      strokeWidth={1.8}
                    />
                    <span>{item.label}</span>
                    {item.to === "/tasks" && data && data.tasks > 0 && (
                      <span className="ml-auto tnum text-[10.5px] text-muted">
                        {data.enabled_tasks}/{data.tasks}
                      </span>
                    )}
                    {item.to === "/deliveries" && data && data.fatal > 0 && (
                      <span className="ml-auto inline-flex items-center rounded-full bg-danger-soft px-1.5 text-[10.5px] font-medium text-danger">
                        {data.fatal}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>

        <p className="mb-1.5 mt-6 px-2 text-[10.5px] font-medium tracking-[0.12em] text-muted/80">
          接入
        </p>
        <div className="rounded-xl border border-line bg-sunken/80 p-2.5">
          <div className="flex items-center gap-1.5 text-[10.5px] font-medium text-muted">
            <Radio className="size-3" />
            数据源
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full", mode === "live" ? "bg-success" : "bg-warn")} />
            <span className="text-[12px] font-medium text-ink">
              {mode === "live" ? "实时接口" : "演示数据"}
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-muted" title={endpointLabel()}>
            {endpointLabel()}
          </div>
          <button
            type="button"
            onClick={toggle}
            className="mt-2 flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-line bg-surface text-[11.5px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
          >
            <Settings2 className="size-3" />
            切换为{mode === "live" ? "演示数据" : "实时接口"}
          </button>
        </div>

        <p className="mt-6 px-2 text-[10.5px] leading-relaxed text-muted/80">
          五段顺序固定：匹配 → 映射 → 校验 → 动作 → 判定。
          <br />
          任何一段短路，后段不再执行。
        </p>
      </nav>

      <div className="border-t border-line px-4 py-3">
        <div className="flex items-center justify-between text-[10.5px] text-muted">
          <span className="font-mono">syn-web 0.1.0</span>
          <span className="font-mono">api v1</span>
        </div>
      </div>
    </aside>
  );
}
