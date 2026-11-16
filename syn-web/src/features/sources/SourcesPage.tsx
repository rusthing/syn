import { useState } from "react";
import { AlertTriangle, DatabaseZap, Globe, Pencil, Play, Plus, Radio, RotateCcw, Timer, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Panel, PanelHeader, PanelState, Skeleton } from "@/components/ui/Panel";
import { Switch } from "@/components/ui/Switch";
import { PageHeader, StatCard } from "@/components/page";
import { useToast } from "@/components/ui/Toast";
import { WIDE_WIDGET_GRID, WIDGET_GRID, cn } from "@/lib/utils";
import { formatRelative } from "@/lib/time";
import type { SyncSource } from "@/lib/api/types";
import { buildSourceSql } from "@/lib/spec/source-sql";
import { useSourceMutations, useSources } from "@/hooks/use-sources";
import { RemoveSourceDialog, SourceEditorDrawer } from "./SourceEditorDrawer";

/** 全量源（sql 快照 / http）拉完就停，可以「重跑全量」 */
function isFull(s: SyncSource) {
  return s.kind === "http" || (s.spec.mode ?? "cursor") === "snapshot";
}

/** 抽取方式的展示名：sql 再按 mode 分快照 / 增量 */
function modeLabel(s: SyncSource) {
  if (s.kind === "http") return "http 分页";
  return (s.spec.mode ?? "cursor") === "snapshot" ? "全量快照" : "游标增量";
}

export function SourcesPage() {
  const { data, isLoading, error, refetch } = useSources();
  const { pull, toggle } = useSourceMutations();
  const toast = useToast();
  /** null = 关闭；新建用 `editing === null` + open 区分，编辑时带实体 */
  const [editor, setEditor] = useState<{ open: boolean; source: SyncSource | null }>({
    open: false,
    source: null,
  });
  const [removing, setRemoving] = useState<SyncSource | null>(null);

  const list = data ?? [];
  const enabled = list.filter((s) => s.enabled).length;

  const onPulled = (r: { rows: number; duration_ms: number; stalled?: string | null; full_done?: boolean | null }) => {
    if (r.stalled) {
      toast.info(
        `已拉取 ${r.rows} 行，游标停在失败记录前`,
        `耗时 ${r.duration_ms} ms；${r.stalled}。修好这一条之前不会继续推进`,
      );
    } else if (r.full_done) {
      toast.success("全量拉取完成", `本轮 ${r.rows} 行，拉到底了；之后不再自动拉取，要重跑点「重跑全量」`);
    } else {
      toast.success(
        `已拉取 ${r.rows} 行`,
        `耗时 ${r.duration_ms} ms；游标已前移，下一轮从新位置继续`,
      );
    }
  };
  const onPullError = (err: Error) => toast.error("拉取失败", err.message);
  const stalled = list.filter((s) => s.enabled && s.last_error).length;
  const totalRows = list.reduce((acc, s) => acc + (s.cursor?.rows_total ?? 0), 0);

  return (
    <>
      <PageHeader
        title="数据抽取"
        subtitle="没有 CDC 的表靠自拉：全量快照或复合游标增量，写进虚拟 topic source:{code}，五段完全不知道数据是推来的还是拉来的。"
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="size-3.5" />}
            onClick={() => setEditor({ open: true, source: null })}
          >
            新增抽取
          </Button>
        }
      />

      <div className={`mb-4 ${WIDGET_GRID}`}>
        <StatCard label="抽取总数" value={list.length} suffix={`/ ${enabled} 启用`} icon={<Radio className="size-4" />} />
        <StatCard label="累计行数" value={totalRows.toLocaleString()} suffix="行" icon={<DatabaseZap className="size-4" />} />
        <StatCard
          label="异常抽取"
          value={stalled}
          suffix="个"
          accent={stalled > 0 ? "danger" : "default"}
          footer="启用中但最近一次拉取报错"
        />
      </div>

      {isLoading ? (
        <div className={WIDE_WIDGET_GRID}>
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-52 w-full" />
          ))}
        </div>
      ) : error ? (
        <Panel>
          <PanelState
            title="加载失败"
            description={(error as Error).message}
            action={
              <Button size="sm" onClick={() => void refetch()}>
                重试
              </Button>
            }
          />
        </Panel>
      ) : (
        <div className={WIDE_WIDGET_GRID}>
          {list.map((source) => (
            <SourceCard
              key={source.id}
              source={source}
              pulling={
                pull.isPending &&
                (typeof pull.variables === "string"
                  ? pull.variables === source.id
                  : pull.variables?.id === source.id)
              }
              onEdit={() => setEditor({ open: true, source })}
              onRemove={() => setRemoving(source)}
              onPull={() => pull.mutate(source.id, { onSuccess: onPulled, onError: onPullError })}
              onPullReset={() =>
                pull.mutate({ id: source.id, reset: true }, { onSuccess: onPulled, onError: onPullError })
              }
              onToggle={(next) =>
                toggle.mutate(
                  { id: source.id, enabled: next },
                  {
                    onSuccess: () => toast.success(next ? "已启用" : "已停用", "调度由 jobx 的计划任务触发"),
                    onError: (err: Error) => toast.error("操作失败", err.message),
                  },
                )
              }
            />
          ))}
          {list.length === 0 && (
            <Panel className="xl:col-span-2">
              <PanelState
                title="还没有数据抽取"
                description="CDC 覆盖不到的表才需要自拉；能走 sink 的表不要重复配。"
                action={
                  <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEditor({ open: true, source: null })}>
                    新增抽取
                  </Button>
                }
              />
            </Panel>
          )}
        </div>
      )}

      <Panel className="mt-4">
        <PanelHeader title="自拉的边界" subtitle="配之前先确认这几条能接受" icon={<AlertTriangle className="size-3.5" />} />
        <ul className="grid gap-x-6 gap-y-2 px-4 py-3 text-[11.5px] leading-relaxed text-ink-soft sm:grid-cols-2">
          <li>· 游标是 <span className="font-mono">(主游标, 决胜字段)</span> 复合，时间戳游标回读 5 秒重叠窗口，重复行靠下游幂等或判定段 skip 掉。</li>
          <li>· <b>删除拉不到</b>：物理删除不会留下行；要同步删除必须有 CDC 或软删除标记。</li>
          <li>· <b>全量快照只用于初始化</b>：拉完即停，增量交给游标模式或 dbz，两边别同时写同一张表。</li>
          <li>· 只允许单写者：多副本同时拉会互相把游标推乱，调度必须走 jobx 的单实例任务。</li>
          <li>· 游标存在 syn 库里，不与业务库同事务：崩溃后最多重复一轮，不会丢。</li>
          <li>· <b>连接串不在这里维护</b>：<code className="font-mono">[syn.datasources.*]</code> 在 <code className="font-mono">syn-svr.toml</code> / consul KV，本页只选名字；改完等 syn-svr 热更新。</li>
        </ul>
      </Panel>

      <SourceEditorDrawer
        open={editor.open}
        source={editor.source}
        onClose={() => setEditor({ open: false, source: null })}
      />
      <RemoveSourceDialog source={removing} onClose={() => setRemoving(null)} />
    </>
  );
}

function SourceCard({
  source,
  onPull,
  onPullReset,
  onToggle,
  onEdit,
  onRemove,
  pulling,
}: {
  source: SyncSource;
  onPull: () => void;
  onPullReset: () => void;
  onToggle: (next: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
  pulling: boolean;
}) {
  const Icon = source.kind === "sql" ? DatabaseZap : Globe;
  const full = isFull(source);
  const cursorFields = [source.spec.cursor_field, source.spec.tie_field].filter(Boolean).join(", ");
  return (
    <Panel className={cn(!source.enabled && "opacity-70")}>
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            <Icon className="size-3.5 text-muted" />
            {source.name}
            <Badge tone={source.kind === "http" ? "violet" : "info"} mono>
              {modeLabel(source)}
            </Badge>
          </span>
        }
        subtitle={
          <span className="font-mono">
            {source.code} → {source.topic}
          </span>
        }
        actions={
          <>
            <Switch checked={source.enabled} size="sm" label="启用抽取" onChange={onToggle} />
            <IconButton label="编辑数据抽取" onClick={onEdit}>
              <Pencil className="size-3.5" />
            </IconButton>
            <IconButton label="删除数据抽取" tone="danger" onClick={onRemove}>
              <Trash2 className="size-3.5" />
            </IconButton>
            {full && (
              <Button
                size="xs"
                variant="ghost"
                icon={<RotateCcw className="size-3" />}
                disabled={!source.enabled || pulling}
                onClick={onPullReset}
              >
                重跑全量
              </Button>
            )}
            <Button
              size="xs"
              variant="secondary"
              icon={<Play className="size-3" />}
              loading={pulling}
              disabled={!source.enabled}
              onClick={onPull}
            >
              立即拉取
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-3 gap-2 border-b border-line/70 px-3 py-2.5">
        <Metric label="间隔" value={source.interval_duration} mono icon={<Timer className="size-3" />} />
        <Metric label="批大小" value={String(source.batch_size)} mono />
        <Metric label="累计行数" value={(source.cursor?.rows_total ?? 0).toLocaleString()} mono />
      </div>

      <dl className="space-y-1.5 px-3 py-2.5 text-[11.5px]">
        <div className="flex items-baseline gap-2">
          <dt className="w-[68px] shrink-0 text-muted">游标</dt>
          <dd className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-soft">
            {source.cursor ? source.cursor.position : "（尚未开始）"}
          </dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="w-[68px] shrink-0 text-muted">最近拉取</dt>
          <dd className="flex-1 text-ink-soft">
            {source.last_run_ms ? formatRelative(source.last_run_ms) : "—"}
            {source.last_rows > 0 && <span className="ml-1.5 text-muted">· {source.last_rows} 行</span>}
          </dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="w-[68px] shrink-0 text-muted">数据源</dt>
          <dd className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-soft">
            {source.spec.datasource ?? "—"}
          </dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="w-[68px] shrink-0 text-muted">{source.kind === "http" ? "地址" : "源表"}</dt>
          <dd className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
            {source.kind === "http"
              ? (source.spec.url ?? "—")
              : source.spec.sql !== undefined
                ? "手写 SQL（见下方预览）"
                : (source.spec.table ?? "—")}
          </dd>
        </div>
        {source.kind === "sql" && (
          <div className="flex items-baseline gap-2">
            <dt className="w-[68px] shrink-0 text-muted">抽取字段</dt>
            <dd className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
              {full ? "全表（无游标）" : cursorFields || "—"}
            </dd>
          </div>
        )}
      </dl>

      {source.last_error && (
        <div className="mx-3 mb-3 flex items-start gap-1.5 rounded-md bg-danger-soft/70 px-2 py-1.5 text-[11px] leading-snug text-danger">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>{source.last_error}</span>
        </div>
      )}

      {source.kind === "sql" && (
        <details className="group border-t border-line/70 px-3 py-2">
          <summary className="cursor-pointer list-none text-[11px] text-muted hover:text-ink">查看取数 SQL</summary>
          <pre className="mt-1.5 max-h-[180px] overflow-auto rounded-md bg-sunken/70 p-2 font-mono text-[10.5px] leading-relaxed text-ink-soft">
            {buildSourceSql(source.spec, source.batch_size)}
          </pre>
        </details>
      )}
    </Panel>
  );
}

function Metric({
  label,
  value,
  mono,
  icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[10.5px] text-muted">
        {icon}
        {label}
      </div>
      <div className={cn("mt-0.5 text-[13px] font-medium text-ink", mono && "font-mono tnum text-[12.5px]")}>
        {value}
      </div>
    </div>
  );
}
