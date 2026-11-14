import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FlaskConical, Pencil, Plus, Search, Trash2, Workflow } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input, Select } from "@/components/ui/Field";
import { Panel, PanelState, Skeleton } from "@/components/ui/Panel";
import { ConfirmDialog } from "@/components/ui/Drawer";
import { Switch } from "@/components/ui/Switch";
import { PageHeader, StatCard } from "@/components/page";
import { EmptyRow, TableShell, Td, Th } from "@/components/table";
import { useToast } from "@/components/ui/Toast";
import { cn, percent } from "@/lib/utils";
import { formatRelative } from "@/lib/time";
import type { SyncTask } from "@/lib/api/types";
import { useTaskMutations, useTasksPage } from "@/hooks/use-tasks";
import { useDebounced } from "@/hooks/use-debounce";
import { TaskEditorDrawer } from "./TaskEditorDrawer";

export function TasksPage() {
  const [keyword, setKeyword] = useState("");
  const [topic, setTopic] = useState("");
  const [enabled, setEnabled] = useState<"all" | "on" | "off">("all");
  const [editing, setEditing] = useState<SyncTask | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<SyncTask | null>(null);

  const debounced = useDebounced(keyword, 250);
  const navigate = useNavigate();
  const toast = useToast();
  const { toggle, remove } = useTaskMutations();

  const query = useMemo(
    () => ({
      keyword: debounced.trim() || undefined,
      topic: topic || undefined,
      enabled: enabled === "all" ? undefined : enabled === "on",
      pageNum: 1,
      pageSize: 100,
    }),
    [debounced, topic, enabled],
  );

  const { data, isLoading, error, refetch } = useTasksPage(query);

  const topics = useMemo(() => {
    const set = new Set((data?.list ?? []).map((t) => t.topic));
    return [...set].sort();
  }, [data]);

  const stats = useMemo(() => {
    const list = data?.list ?? [];
    const on = list.filter((t) => t.enabled);
    const failing = list.filter((t) => t.enabled && t.stats.fatal + t.stats.retriable > t.stats.total * 0.01);
    const hit = list.reduce((acc, t) => acc + t.stats.total, 0);
    return { total: list.length, on: on.length, failing: failing.length, hit };
  }, [data]);

  return (
    <>
      <PageHeader
        title="同步任务"
        subtitle="一个 topic 下可以有多个任务：按优先级依次匹配，命中即停；关掉「独占」就继续往下走。"
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<FlaskConical className="size-3.5" />}
              onClick={() => navigate("/playground")}
            >
              新开试跑
            </Button>
            <Button variant="primary" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
              新建任务
            </Button>
          </>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="任务总数"
          value={stats.total}
          suffix="个"
          icon={<Workflow className="size-4" />}
          footer={`覆盖 ${topics.length} 个 topic`}
        />
        <StatCard
          label="启用中"
          value={stats.on}
          suffix={`/ ${stats.total}`}
          accent="success"
          footer="停用的保留配置但不参与匹配"
        />
        <StatCard
          label="失败率偏高"
          value={stats.failing}
          suffix="个任务"
          accent={stats.failing > 0 ? "danger" : "default"}
          footer="近 24 小时失败 + 重试 > 1%"
        />
        <StatCard
          label="24h 命中"
          value={stats.hit.toLocaleString()}
          suffix="条"
          footer="所有任务合计；同一记录扇出会重复计数"
        />
      </div>

      <Panel>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <Input
              value={keyword}
              placeholder="搜 code / 名称 / topic"
              className="h-8 w-[240px] pl-8 text-[12.5px]"
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <Select value={topic} onChange={(e) => setTopic(e.target.value)} className="h-8 w-[190px] text-[12px]">
            <option value="">全部 topic</option>
            {topics.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <div className="flex items-center gap-1">
            {[
              { key: "all", label: "全部" },
              { key: "on", label: "启用" },
              { key: "off", label: "停用" },
            ].map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setEnabled(item.key as typeof enabled)}
                className={cn(
                  "h-8 rounded-md border px-2.5 text-[12px] transition-colors",
                  enabled === item.key
                    ? "border-accent/40 bg-accent-soft font-medium text-accent"
                    : "border-line bg-surface text-ink-soft hover:bg-sunken",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="ml-auto text-[11.5px] text-muted">{data ? `${data.total} 个任务` : ""}</span>
        </div>

        {isLoading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : error ? (
          <PanelState
            title="加载失败"
            description={(error as Error).message}
            action={
              <Button size="sm" variant="secondary" onClick={() => void refetch()}>
                重试
              </Button>
            }
          />
        ) : (
          <TableShell minWidth={900}>
            <thead>
              <tr>
                <Th sticky className="w-[240px]">
                  任务
                </Th>
                <Th className="w-[150px]">topic</Th>
                <Th align="center" className="w-[62px]">
                  优先级
                </Th>
                <Th className="w-[150px]">目标</Th>
                <Th className="w-[120px]">五段</Th>
                <Th align="right" className="w-[92px]">
                  24h 命中
                </Th>
                <Th align="right" className="w-[78px]">
                  失败率
                </Th>
                <Th className="w-[86px]">最近命中</Th>
                <Th align="center" className="w-[64px]">
                  启用
                </Th>
                <Th align="right" className="w-[110px]">
                  操作
                </Th>
              </tr>
            </thead>
            <tbody>
              {(data?.list ?? []).length === 0 && (
                <EmptyRow colSpan={10}>没有符合条件的任务。换个筛选，或新建一个。</EmptyRow>
              )}
              {(data?.list ?? []).map((task) => {
                const bad = task.stats.fatal + task.stats.retriable;
                const badRate = percent(bad, task.stats.total || 1);
                return (
                  <tr
                    key={task.id}
                    className={cn("group transition-colors hover:bg-sunken/50", !task.enabled && "opacity-60")}
                  >
                    <Td sticky>
                      <button
                        type="button"
                        className="flex min-w-0 flex-col items-start text-left"
                        onClick={() => setEditing(task)}
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium text-ink">{task.name}</span>
                          <span className="shrink-0 rounded bg-ink/[0.05] px-1 font-mono text-[10px] text-muted">
                            v{task.version}
                          </span>
                        </span>
                        <span className="truncate font-mono text-[10.5px] text-muted">{task.code}</span>
                      </button>
                    </Td>
                    <Td mono className="text-[11px]">
                      {task.topic}
                    </Td>
                    <Td align="center" mono>
                      {task.priority}
                    </Td>
                    <Td>
                      <span className="block text-[12px] text-ink-soft">{task.spec.target.service}</span>
                      <span className="block truncate font-mono text-[10.5px] text-muted">{task.spec.target.base}</span>
                    </Td>
                    <Td>
                      <StageDots task={task} />
                    </Td>
                    <Td align="right" mono>
                      {task.stats.total.toLocaleString()}
                    </Td>
                    <Td align="right">
                      {task.stats.total === 0 ? (
                        <span className="text-[11px] text-muted">—</span>
                      ) : (
                        <span
                          className={cn(
                            "tnum font-mono text-[11.5px]",
                            badRate >= 1 ? "text-danger" : badRate > 0 ? "text-warn" : "text-muted",
                          )}
                        >
                          {badRate.toFixed(badRate < 1 ? 1 : 0)}%
                        </span>
                      )}
                    </Td>
                    <Td>
                      <span className="text-[11.5px] text-muted">
                        {task.stats.last_hit_ms ? formatRelative(task.stats.last_hit_ms) : "—"}
                      </span>
                    </Td>
                    <Td align="center">
                      <Switch
                        checked={task.enabled}
                        size="sm"
                        label={`${task.enabled ? "停用" : "启用"} ${task.name}`}
                        busy={toggle.isPending}
                        onChange={(next) =>
                          toggle.mutate(
                            { id: task.id, enabled: next },
                            {
                              onSuccess: () =>
                                toast.success(
                                  next ? "已启用" : "已停用",
                                  "已通知各副本刷新执行器快照",
                                ),
                              onError: (err: Error) => toast.error("操作失败", err.message),
                            },
                          )
                        }
                      />
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-0.5">
                        <IconButton
                          label="试跑这条任务"
                          onClick={() => navigate(`/playground?topic=${encodeURIComponent(task.topic)}&task=${task.code}`)}
                        >
                          <FlaskConical className="size-3.5" />
                        </IconButton>
                        <IconButton label="编辑" onClick={() => setEditing(task)}>
                          <Pencil className="size-3.5" />
                        </IconButton>
                        <IconButton label="删除" tone="danger" onClick={() => setRemoving(task)}>
                          <Trash2 className="size-3.5" />
                        </IconButton>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </TableShell>
        )}
      </Panel>

      <p className="mt-2 px-1 text-[11px] leading-relaxed text-muted">
        配置改的是库里的 <code className="font-mono">syn_task</code>，执行器读的是内存快照：
        每次写库都会发刷新信号、各副本下一拍自动重载，不需要重启进程；顶栏的「重载快照」是手动兜底。
      </p>

      <TaskEditorDrawer
        open={creating || editing !== null}
        task={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => void refetch()}
      />

      <ConfirmDialog
        open={removing !== null}
        title={`删除任务 ${removing?.code ?? ""}？`}
        description={
          <>
            任务配置会连同它的版本历史一起删除。已经发出去的数据不会回滚；
            如果只是想暂停，把「启用」关掉即可。
          </>
        }
        confirmText="删除"
        loading={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          remove.mutate(removing.id, {
            onSuccess: () => {
              toast.success("已删除", "已通知各副本刷新执行器快照");
              setRemoving(null);
            },
            onError: (err: Error) => toast.error("删除失败", err.message),
          });
        }}
      />
    </>
  );
}

/** 五段的存在感：有内容的那段点亮，一眼看出哪条规则是空的 */
function StageDots({ task }: { task: SyncTask }) {
  const spec = task.spec;
  const stages = [
    { key: "匹配", count: spec.match?.length ?? 0, tone: "bg-accent" },
    { key: "映射", count: spec.mapping.rows.length, tone: "bg-info" },
    { key: "校验", count: spec.guards?.length ?? 0, tone: "bg-violet" },
    { key: "动作", count: spec.actions?.length ?? 0, tone: "bg-warn" },
    { key: "判定", count: spec.outcomes?.length ?? 0, tone: "bg-success" },
  ];
  return (
    <div className="flex items-center gap-1" title={stages.map((s) => `${s.key} ${s.count}`).join(" · ")}>
      {stages.map((stage) => (
        <span
          key={stage.key}
          className={cn(
            "flex h-4 min-w-4 items-center justify-center rounded px-1 font-mono text-[9.5px]",
            stage.count > 0 ? `${stage.tone}/15 text-ink` : "bg-ink/[0.05] text-muted/70",
          )}
        >
          {stage.count}
        </span>
      ))}
      {!task.enabled && <Badge tone="muted">停用</Badge>}
    </div>
  );
}
