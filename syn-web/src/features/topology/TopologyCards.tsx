/**
 * # 拓扑卡片
 *
 * 四类卡片同一骨架：类型标识（图标 + 文字）→ 名称 → 关键字段 → 状态 → 操作行。
 * 颜色只区分「哪一类节点」，状态只用标签和左侧色条表达 —— 一屏几十张卡时，
 * 颜色一多就分不清哪个是错误色、哪个是类型色。
 *
 * 任务卡有两态：
 * - 收起（300×88）：一眼能扫完整张图的密度，只有一行六段摘要；
 * - 展开（600×140）：选中后就地展开，六段并排、每段可点，点哪段进抽屉的哪个页签。
 *   展开只影响这一张卡，其余节点位置不变（`TopologyCanvas` 负责把邻居让开）。
 */

import {
  Database,
  Layers,
  Radio,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasNodeKind } from "@/lib/api/types";
import type { GraphNode, NodeTone, TaskSegment, TaskStage } from "./graph";

/** 卡片尺寸：同类同高，操作行才能对齐 */
export const CARD_SIZE: Record<CanvasNodeKind, { w: number; h: number }> = {
  datasource: { w: 260, h: 84 },
  source: { w: 280, h: 84 },
  topic: { w: 220, h: 56 },
  task: { w: 300, h: 88 },
};

/** 展开态的任务卡：六段并排要这么宽才写得下服务名 */
export const TASK_EXPANDED = { w: 600, h: 140 };

export function cardSize(kind: CanvasNodeKind, expanded: boolean): { w: number; h: number } {
  return kind === "task" && expanded ? TASK_EXPANDED : CARD_SIZE[kind];
}

const KIND_META: Record<CanvasNodeKind, { label: string; icon: typeof Database; accent: string }> = {
  datasource: { label: "数据源", icon: Database, accent: "text-info" },
  source: { label: "取数来源", icon: Radio, accent: "text-violet" },
  topic: { label: "主题", icon: Layers, accent: "text-muted" },
  task: { label: "任务", icon: Workflow, accent: "text-accent" },
};

const TONE_PILL: Record<NodeTone, string> = {
  ok: "bg-success-soft text-success",
  warn: "bg-warn-soft text-warn",
  bad: "bg-danger-soft text-danger",
  muted: "bg-sunken text-muted",
};

const TONE_BAR: Record<NodeTone, string> = {
  ok: "bg-success/70",
  warn: "bg-warn/80",
  bad: "bg-danger/80",
  muted: "bg-line-strong",
};

function KindLine({ kind, status, tone }: { kind: CanvasNodeKind; status: string; tone: NodeTone }) {
  const meta = KIND_META[kind];
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={cn("flex items-center gap-1 text-[11px] font-medium", meta.accent)}>
        <meta.icon className="size-3" />
        {meta.label}
      </span>
      <span className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-medium", TONE_PILL[tone])}>
        {status}
      </span>
    </div>
  );
}

function Flags({ node }: { node: GraphNode }) {
  const title = [...node.issues, ...node.hints].join("\n");
  if (!node.issues.length && !node.hints.length) return null;
  return (
    <span
      className={cn(
        "flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px]",
        node.issues.length ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn",
      )}
      title={title}
    >
      <TriangleAlert className="size-2.5" />
      {node.issues.length || node.hints.length}
    </span>
  );
}

/** 卡片外壳：左侧状态色条 + 白底 + 选中描边 */
export function CardShell({
  node,
  selected,
  children,
  className,
  onPointerDown,
}: {
  node: GraphNode;
  selected: boolean;
  children: React.ReactNode;
  className?: string;
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      className={cn(
        "relative flex h-full w-full cursor-pointer flex-col rounded-[10px] border bg-surface px-2.5 py-2 shadow-panel transition-shadow",
        selected ? "border-accent ring-2 ring-accent/25" : "border-line hover:border-line-strong",
        className,
      )}
    >
      <span className={cn("absolute left-0 top-2 bottom-2 w-[3px] rounded-full", TONE_BAR[node.tone])} />
      {children}
    </div>
  );
}

/* ------------------------------ 数据源 / 来源 ------------------------------ */

export function EntityCard({
  node,
  selected,
  onPointerDown,
}: {
  node: GraphNode;
  selected: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  return (
    <CardShell node={node} selected={selected} onPointerDown={onPointerDown}>
      <KindLine kind={node.kind} status={node.status} tone={node.tone} />
      <div className="mt-1 flex items-center gap-1.5">
        <span className="truncate text-[13px] font-medium text-ink">{node.title}</span>
        <Flags node={node} />
      </div>
      <div className="mt-auto truncate font-mono text-[11px] text-muted" title={node.subtitle}>
        {node.subtitle}
      </div>
    </CardShell>
  );
}

/* --------------------------------- 主题 --------------------------------- */

export function TopicCard({
  node,
  selected,
  onPointerDown,
}: {
  node: GraphNode;
  selected: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      className={cn(
        "flex h-full w-full cursor-pointer flex-col justify-center rounded-full border bg-sunken px-4",
        selected ? "border-accent ring-2 ring-accent/25" : "border-line hover:border-line-strong",
        node.tone === "warn" && "bg-warn-soft",
      )}
      title={node.hints.join("\n")}
    >
      <div className="flex items-center gap-1.5">
        <Layers className="size-3 shrink-0 text-muted" />
        <span className="truncate font-mono text-[12px] text-ink">{node.title}</span>
        <Flags node={node} />
      </div>
      <span className="mt-0.5 truncate pl-4 text-[10.5px] text-muted">{node.subtitle}</span>
    </div>
  );
}

/* --------------------------------- 任务 --------------------------------- */

function SegmentChip({
  segment,
  onClick,
}: {
  segment: TaskSegment;
  onClick: (stage: TaskStage) => void;
}) {
  const isTarget = segment.stage === "target";
  return (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick(segment.stage);
      }}
      title={`${segment.label} · ${segment.detail}${segment.issues ? ` · ${segment.issues} 处待修正` : ""}`}
      className={cn(
        "group relative flex h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md border px-1 transition-colors",
        isTarget
          ? "border-accent/40 bg-accent-soft/60 hover:bg-accent-soft"
          : "border-line bg-sunken/70 hover:bg-accent-soft/50",
        segment.issues > 0 && "border-danger/50 bg-danger-soft/60",
      )}
    >
      <span
        className={cn(
          "text-[10px] font-medium",
          isTarget ? "text-accent-strong" : "text-ink-soft",
          segment.issues > 0 && "text-danger",
        )}
      >
        {segment.label}
      </span>
      <span
        className={cn(
          "w-full truncate px-0.5 text-center font-mono text-[10.5px]",
          isTarget ? "text-accent-strong" : "text-muted",
        )}
      >
        {segment.detail}
      </span>
      {segment.issues > 0 && (
        <span className="absolute -right-1 -top-1 flex size-3 items-center justify-center rounded-full bg-danger text-[8px] font-medium text-white">
          {segment.issues}
        </span>
      )}
    </button>
  );
}

export function TaskCard({
  node,
  selected,
  expanded,
  onPointerDown,
  onOpenStage,
  onToggle,
}: {
  node: GraphNode;
  selected: boolean;
  expanded: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  onOpenStage: (stage: TaskStage) => void;
  onToggle: () => void;
}) {
  const task = node.task;
  const segments = node.segments ?? [];
  const stats = task?.stats;

  return (
    <CardShell node={node} selected={selected} onPointerDown={onPointerDown}>
      <KindLine kind="task" status={node.status} tone={node.tone} />
      <div className="mt-0.5 flex items-center gap-1.5">
        <span className="truncate text-[13px] font-medium text-ink">{node.title}</span>
        <Flags node={node} />
        <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted">{node.key}</span>
      </div>

      {expanded ? (
        <div className="mt-1.5 flex items-stretch gap-1">
          {segments.map((segment, i) => (
            <div key={segment.stage} className="flex min-w-0 flex-1 items-center gap-1">
              <SegmentChip segment={segment} onClick={onOpenStage} />
              {i < segments.length - 1 && <span className="text-[10px] text-line-strong">›</span>}
            </div>
          ))}
        </div>
      ) : (
        /* 收起态：六段各占一格，只写段名 —— 挤成一行文本必然被截掉最后几段，
           而「投递」正是最该一眼看到的那段。详情放 title，展开看全。 */
        <div className="mt-1 flex items-stretch gap-[3px]">
          {segments.map((segment) => {
            const isTarget = segment.stage === "target";
            return (
              <span
                key={segment.stage}
                title={`${segment.label} · ${segment.detail}${segment.issues ? ` · ${segment.issues} 处待修正` : ""}`}
                className={cn(
                  "flex h-[19px] min-w-0 flex-1 items-center justify-center rounded border px-0.5 text-[9.5px] font-medium",
                  isTarget
                    ? "border-accent/40 bg-accent-soft/60 text-accent-strong"
                    : "border-line bg-sunken/70 text-ink-soft",
                  segment.issues > 0 && "border-danger/50 bg-danger-soft/60 text-danger",
                )}
              >
                <span className="truncate">{segment.label.replace(/^\d+\s*/, "")}</span>
              </span>
            );
          })}
        </div>
      )}

      <div className="mt-auto flex items-center gap-2 text-[10.5px] text-muted">
        <span className="truncate">
          {task?.spec.target.kind === "db" ? "直写库表" : "HTTP"} · {node.subtitle.split(" · ")[1] ?? ""}
        </span>
        <span className="ml-auto shrink-0 font-mono">
          {stats && stats.total > 0 ? `今日 ${stats.total.toLocaleString()} 条` : "今日无记录"}
        </span>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="shrink-0 rounded px-1 text-[10.5px] text-accent hover:bg-accent-soft"
        >
          {expanded ? "收起" : "六段"}
        </button>
      </div>
    </CardShell>
  );
}
