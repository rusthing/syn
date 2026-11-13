import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  CircleCheck,
  CircleSlash,
  DatabaseZap,
  Radio,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Panel, PanelHeader, PanelState, Skeleton } from "@/components/ui/Panel";
import { PageHeader, StatCard } from "@/components/page";
import { cn, percent } from "@/lib/utils";
import { formatDateTime, formatTime } from "@/lib/time";
import { useOverview } from "@/hooks/use-overview";
import { useAllTasks } from "@/hooks/use-tasks";
import { useSources } from "@/hooks/use-sources";
import { VERDICTS } from "@/lib/spec/defaults";

const WINDOWS = [
  { key: "1h", label: "1 小时" },
  { key: "24h", label: "24 小时" },
  { key: "7d", label: "7 天" },
] as const;

export function OverviewPage() {
  const [window, setWindow] = useState<string>("24h");
  const { data, isLoading, error, refetch } = useOverview(window);
  const { data: tasks } = useAllTasks();
  const { data: sources } = useSources();

  const successRate = data ? percent(data.success, data.total || 1) : 0;
  const enabledTasks = (tasks ?? []).filter((t) => t.enabled);
  const risky = enabledTasks
    .map((t) => ({ task: t, rate: percent(t.stats.fatal + t.stats.retriable, t.stats.total || 1) }))
    .filter((x) => x.task.stats.total > 0)
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 5);

  return (
    <>
      <PageHeader
        title="同步总览"
        subtitle="一条记录进来到确定结论的全景：取数 → 五段 → 投递。数字默认看最近 24 小时。"
        actions={
          <div className="flex items-center gap-1">
            {WINDOWS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setWindow(item.key)}
                className={cn(
                  "h-8 rounded-md border px-2.5 text-[12px] transition-colors",
                  window === item.key
                    ? "border-accent/40 bg-accent-soft font-medium text-accent"
                    : "border-line bg-surface text-ink-soft hover:bg-sunken",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        }
      />

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : error ? (
        <Panel>
          <PanelState
            title="加载失败"
            description={(error as Error).message}
            action={
              <button
                type="button"
                className="h-8 rounded-lg border border-line px-3 text-[12.5px]"
                onClick={() => void refetch()}
              >
                重试
              </button>
            }
          />
        </Panel>
      ) : data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="记录总数"
              value={data.total.toLocaleString()}
              suffix="条"
              icon={<Activity className="size-4" />}
              footer={`${data.enabled_tasks}/${data.tasks} 个任务在跑`}
            />
            <StatCard
              label="成功率"
              value={successRate}
              suffix="%"
              accent={successRate >= 99 ? "success" : successRate >= 95 ? "warn" : "danger"}
              footer={`跳过 ${data.skip.toLocaleString()} 条按 200 提交`}
            />
            <StatCard
              label="失败"
              value={data.fatal.toLocaleString()}
              suffix="条"
              accent={data.fatal > 0 ? "danger" : "default"}
              icon={<TriangleAlert className="size-4" />}
              footer="确定性失败：已进死信，需人工处理"
            />
            <StatCard
              label="P95 耗时"
              value={data.p95_ms}
              suffix="ms"
              footer={`重试 ${data.retriable.toLocaleString()} 条已交还 sink`}
            />
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <Panel>
              <PanelHeader
                title="吞吐"
                subtitle="按小时聚合；绿色成功、红色失败、橙色重试"
                icon={<Activity className="size-3.5" />}
                actions={<Badge tone="muted">{window}</Badge>}
              />
              <div className="px-3 pb-2 pt-3">
                <ThroughputChart series={data.series} />
              </div>
            </Panel>

            <Panel>
              <PanelHeader
                title="失败分类"
                subtitle="按分类码聚：改配置比改数据快，先看它们能不能归并"
                icon={<TriangleAlert className="size-3.5" />}
              />
              {data.top_failures.length === 0 ? (
                <PanelState compact icon={<CircleCheck className="size-4" />} title="没有失败" description="这个窗口内所有记录都拿到了确定结论。" />
              ) : (
                <ul className="divide-y divide-line/70">
                  {data.top_failures.map((item) => (
                    <li key={`${item.task_code}-${item.code}`} className="flex items-center gap-2 px-3 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[11.5px] text-ink">{item.code}</span>
                        <span className="block truncate font-mono text-[10.5px] text-muted">{item.task_code}</span>
                      </span>
                      <span className="tnum shrink-0 font-mono text-[12px] text-danger">{item.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <Panel>
              <PanelHeader
                title="任务体检"
                subtitle="失败率最高的几个启用任务"
                icon={<Workflow className="size-3.5" />}
                actions={
                  <Link to="/tasks" className="text-[11.5px] text-accent hover:text-accent-strong">
                    全部任务
                  </Link>
                }
              />
              <ul className="divide-y divide-line/70">
                {risky.length === 0 && (
                  <li className="px-3 py-8 text-center text-[12px] text-muted">没有在跑的任务</li>
                )}
                {risky.map(({ task, rate }) => (
                  <li key={task.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span className="truncate text-[12.5px] font-medium text-ink">{task.name}</span>
                        <span className="shrink-0 font-mono text-[10.5px] text-muted">{task.code}</span>
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[10.5px] text-muted">
                        {task.topic} · 命中 {task.stats.total.toLocaleString()}
                      </span>
                    </span>
                    <div className="hidden w-[92px] shrink-0 sm:block">
                      <div className="h-1.5 overflow-hidden rounded-full bg-ink/[0.06]">
                        <div
                          className={cn("h-full rounded-full", rate >= 1 ? "bg-danger" : rate > 0 ? "bg-warn" : "bg-success")}
                          style={{ width: `${Math.min(100, Math.max(2, rate))}%` }}
                        />
                      </div>
                    </div>
                    <span
                      className={cn(
                        "tnum w-10 shrink-0 text-right font-mono text-[11.5px]",
                        rate >= 1 ? "text-danger" : rate > 0 ? "text-warn" : "text-muted",
                      )}
                    >
                      {rate.toFixed(rate < 1 ? 1 : 0)}%
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel>
              <PanelHeader title="链路" subtitle="取数来源与最终结论的分布" icon={<Radio className="size-3.5" />} />
              <div className="grid grid-cols-3 gap-2 border-b border-line/70 px-3 py-2.5">
                <MiniStat label="来源" value={`${(sources ?? []).filter((s) => s.enabled).length}/${(sources ?? []).length}`} icon={<DatabaseZap className="size-3" />} />
                <MiniStat label="启用任务" value={`${data.enabled_tasks}/${data.tasks}`} icon={<Workflow className="size-3" />} />
                <MiniStat label="P95" value={`${data.p95_ms}ms`} icon={<Activity className="size-3" />} />
              </div>
              <ul className="divide-y divide-line/70">
                {VERDICTS.map((v) => {
                  const count = data[v.value];
                  const share = percent(count, data.total || 1);
                  return (
                    <li key={v.value} className="flex items-center gap-2 px-3 py-2">
                      <span className="w-14 shrink-0 text-[12px] text-ink-soft">{v.label}</span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink/[0.06]">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            v.value === "success" && "bg-success",
                            v.value === "skip" && "bg-muted/50",
                            v.value === "fatal" && "bg-danger",
                            v.value === "retriable" && "bg-warn",
                          )}
                          style={{ width: `${Math.min(100, share)}%` }}
                        />
                      </div>
                      <span className="tnum w-16 shrink-0 text-right font-mono text-[11px] text-muted">
                        {count.toLocaleString()}
                      </span>
                      <span className="tnum w-9 shrink-0 text-right font-mono text-[10.5px] text-muted/80">
                        {share}%
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="flex items-center gap-1.5 border-t border-line px-3 py-2 text-[10.5px] text-muted">
                <CircleSlash className="size-3" />
                跳过的记录同样提交 offset；只有失败会进死信。
              </div>
            </Panel>
          </div>

          <p className="mt-3 px-1 text-[11px] text-muted">
            数据截至 {formatTime(Date.now())} · 上次刷新 {formatDateTime(Date.now())}
          </p>
        </>
      ) : null}
    </>
  );
}

function MiniStat({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[10.5px] text-muted">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 font-mono tnum text-[13px] font-medium text-ink">{value}</div>
    </div>
  );
}

/**
 * 吞吐柱状图。
 *
 * 不引图表库：这里只需要「每小时一根堆叠柱」，用 viewBox 画 SVG 既省 30KB
 * 依赖，也不用为深色模式再调一遍主题色。
 */
function ThroughputChart({ series }: { series: Array<{ hour_ms: number; success: number; fatal: number; retriable: number }> }) {
  const W = 640;
  const H = 176;
  const padBottom = 18;
  const padTop = 8;
  const plotH = H - padBottom - padTop;
  const max = Math.max(1, ...series.map((s) => s.success + s.fatal + s.retriable));
  const slot = W / Math.max(1, series.length);
  const barW = Math.max(3, slot * 0.62);

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[176px] w-full" role="img" aria-label="每小时投递吞吐">
        {[0.25, 0.5, 0.75, 1].map((t) => (
          <line
            key={t}
            x1={0}
            x2={W}
            y1={padTop + plotH * (1 - t)}
            y2={padTop + plotH * (1 - t)}
            stroke="#e4e6df"
            strokeWidth={1}
            strokeDasharray={t === 1 ? undefined : "3 4"}
          />
        ))}
        {series.map((s, i) => {
          const x = i * slot + (slot - barW) / 2;
          const total = s.success + s.fatal + s.retriable;
          const hSuccess = (s.success / max) * plotH;
          const hRetriable = (s.retriable / max) * plotH;
          const hFatal = (s.fatal / max) * plotH;
          const base = padTop + plotH;
          const yRetriable = base - hSuccess - hRetriable;
          const yFatal = yRetriable - hFatal;
          return (
            <g key={s.hour_ms}>
              <title>{`${formatTime(s.hour_ms, false)} 成功 ${s.success} · 失败 ${s.fatal} · 重试 ${s.retriable}`}</title>
              <rect
                x={x}
                y={base - hSuccess}
                width={barW}
                height={Math.max(1, hSuccess)}
                fill="#17794a"
                opacity={0.85}
                rx={1.5}
              />
              <rect
                x={x}
                y={yRetriable}
                width={barW}
                height={Math.max(0.8, hRetriable)}
                fill="#a2670a"
                opacity={0.9}
                rx={1}
              />
              <rect
                x={x}
                y={yFatal}
                width={barW}
                height={Math.max(0.8, hFatal)}
                fill="#b3392e"
                opacity={0.9}
                rx={1}
              />
              {total === 0 && <rect x={x} y={base - 1} width={barW} height={1} fill="#cdd2c6" />}
              {i % 4 === 0 && (
                <text
                  x={x + barW / 2}
                  y={H - 4}
                  textAnchor="middle"
                  fontSize={9}
                  fill="#7b8175"
                  fontFamily="ui-monospace, monospace"
                >
                  {formatTime(s.hour_ms, false)}
                </text>
              )}
            </g>
          );
        })}
        <line x1={0} x2={W} y1={padTop + plotH} y2={padTop + plotH} stroke="#cdd2c6" strokeWidth={1} />
      </svg>
      <div className="mt-1 flex items-center justify-between text-[10px] text-muted">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-sm bg-success" />
            成功
          </span>
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-sm bg-warn" />
            重试
          </span>
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-sm bg-danger" />
            失败
          </span>
        </span>
        <span className="flex items-center gap-1">
          峰值 {max.toLocaleString()} 条/小时
          <ArrowRight className="size-2.5" />
        </span>
      </div>
    </div>
  );
}
