/**
 * # 拓扑卡片
 *
 * 四类卡片同一骨架：类型标识（图标 + 文字）→ 名称 → 关键字段 → 状态 → 操作行。
 * 颜色只区分「哪一类节点」，状态只用标签和左侧色条表达 —— 一屏几十张卡时，
 * 颜色一多就分不清哪个是错误色、哪个是类型色。
 *
 * 任务卡只有一种形态（600×140）：六段并排、每段可点，点哪段进窗体的哪个页签。
 * 收起/展开切换存在过，但六段摘要收成一行小格子后基本读不出内容，两态还带来
 * 选中让位、邻居下移这些复杂度，不如恒展开。
 *
 * 两个开关不在编辑窗体里，就在卡上：
 * - **启用**：右上角的标准 Switch，点了直接调 toggle 接口；
 * - **独占**：主题连线落到卡片的位置（顶边中点）做成一个圆形图标按钮 ——
 *   独占时数据到此为止（箭头落地），非独占时数据会继续流给下一个任务（分叉）。
 *
 * 两者的悬停说明由画布层统一渲染：卡片整个处在 `scale()` 容器里，气泡画在卡内会
 * 跟着缩到看不清；原生 title 又要等一秒才弹，缩到 45% 时图标只有十来像素，
 * 用户很难确认自己指着什么。见 `TopologyCanvas` 的 `hint`。
 */

import {
  ArrowDownToLine,
  Database,
  Layers,
  Radio,
  Split,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasNodeKind } from "@/lib/api/types";
import type { GraphNode, NodeTone, TaskSegment, TaskStage } from "./graph";
import { Switch } from "@/components/ui/Switch";

/**
 * 悬停说明上报。传鼠标事件用来在画布层定位气泡，传 null 表示移出。
 * 卡片只管「说什么」和「什么时候说」，不管气泡画在哪。
 */
export type HintHandler = (
  event: React.MouseEvent | React.FocusEvent | null,
  text: string,
) => void;

/** 画布上的交互控件标记：pointerdown 落在这里就不启动卡片拖拽/画布平移 */
export const NO_DRAG_ATTR = "data-no-drag";

/** 卡片尺寸：同类同高，操作行才能对齐 */
export const CARD_SIZE: Record<CanvasNodeKind, { w: number; h: number }> = {
  datasource: { w: 260, h: 84 },
  source: { w: 280, h: 84 },
  topic: { w: 220, h: 56 },
  task: { w: 600, h: 140 },
};

export function cardSize(kind: CanvasNodeKind): { w: number; h: number } {
  return CARD_SIZE[kind];
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

const EXCLUSIVE_HINT = {
  on: "独占 · 命中即止：数据匹配到这个任务后就不再往下匹配，后面的任务拿不到这条数据。点击可改为「非独占」。",
  off: "非独占 · 分叉继续：命中后数据还会继续流给下一个任务，用来把一份数据同步到多个下游。点击可改为「独占」。",
} as const;

/**
 * 独占开关：钉在主题连线落进卡片的位置（顶边中点）。
 *
 * 图标就是语义：独占 = 命中即止（箭头落地，数据到这张卡为止）；非独占 = 分叉继续
 * （数据还会流给后面的任务）。点击直接改 spec.exclusive 保存，不用进窗体。
 *
 * 图标只有 22px，画布默认还缩到 45%，所以视觉尺寸不变、用 after 伪元素把 hover /
 * 点击热区扩到约 38px；说明文字交给画布层的气泡，不用会跟着缩放的原生 title。
 */
function ExclusiveToggle({
  exclusive,
  busy,
  onToggle,
  onHint,
}: {
  exclusive: boolean;
  busy?: boolean;
  onToggle: () => void;
  onHint?: HintHandler;
}) {
  const hint = exclusive ? EXCLUSIVE_HINT.on : EXCLUSIVE_HINT.off;
  return (
    <button
      type="button"
      data-no-drag
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseEnter={(e) => onHint?.(e, hint)}
      onMouseLeave={() => onHint?.(null, "")}
      onFocus={(e) => onHint?.(e, hint)}
      onBlur={() => onHint?.(null, "")}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-label={hint}
      aria-pressed={exclusive}
      aria-busy={busy || undefined}
      className={cn(
        "absolute -top-[11px] left-1/2 z-10 flex size-[22px] -translate-x-1/2 items-center justify-center rounded-full border shadow-panel transition-colors",
        "after:absolute after:-inset-2 after:content-['']",
        exclusive
          ? "border-accent/50 bg-accent-soft text-accent-strong"
          : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink",
        // 请求中不禁用：原生 disabled 会连 click 一起吞掉，看起来就是「点不动」
        busy && "cursor-wait opacity-70 ring-2 ring-accent/25",
      )}
    >
      {exclusive ? <ArrowDownToLine className="size-3.5" /> : <Split className="size-3.5" />}
    </button>
  );
}

export function TaskCard({
  node,
  selected,
  onPointerDown,
  onOpenStage,
  onToggleEnabled,
  onToggleExclusive,
  onHint,
  enabledBusy,
  exclusiveBusy,
}: {
  node: GraphNode;
  selected: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  onOpenStage: (stage: TaskStage) => void;
  /** 启用开关直接走 toggle 接口；窗体里不再有这一项 */
  onToggleEnabled: (next: boolean) => void;
  onToggleExclusive: () => void;
  onHint?: HintHandler;
  /** 两个请求各记各的，互不置灰；都只影响视觉，不禁用按钮 */
  enabledBusy?: boolean;
  exclusiveBusy?: boolean;
}) {
  const task = node.task;
  const segments = node.segments ?? [];
  const stats = task?.stats;
  const exclusive = task?.spec.exclusive !== false;
  const enabledHint = task?.enabled
    ? "当前启用：点击停用这个任务。停用后事件会落到下一个任务或直接进死信；写库时会通知各副本刷新执行器快照。"
    : "当前停用：点击启用这个任务。启用后写库同样会通知各副本刷新执行器快照。";

  return (
    <CardShell node={node} selected={selected} onPointerDown={onPointerDown}>
      <ExclusiveToggle
        exclusive={exclusive}
        busy={exclusiveBusy}
        onToggle={onToggleExclusive}
        onHint={onHint}
      />

      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-[11px] font-medium text-accent">
          <Workflow className="size-3" />
          任务
        </span>
        <div
          className="flex items-center gap-1.5"
          data-no-drag
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseEnter={(e) => onHint?.(e, enabledHint)}
          onMouseLeave={() => onHint?.(null, "")}
          onFocus={(e) => onHint?.(e, enabledHint)}
          onBlur={() => onHint?.(null, "")}
          onClick={(e) => e.stopPropagation()}
        >
          {node.issues.length > 0 && (
            <span className="rounded bg-danger-soft px-1.5 py-0.5 text-[10.5px] font-medium text-danger">
              待修正
            </span>
          )}
          <Switch
            checked={!!task?.enabled}
            size="sm"
            label={task?.enabled ? `停用 ${node.title}` : `启用 ${node.title}`}
            busy={enabledBusy}
            onChange={onToggleEnabled}
          />
        </div>
      </div>

      <div className="mt-0.5 flex items-center gap-1.5">
        <span className="truncate text-[13px] font-medium text-ink">{node.title}</span>
        <Flags node={node} />
        <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted">{node.key}</span>
      </div>

      <div className="mt-1.5 flex items-stretch gap-1">
        {segments.map((segment, i) => (
          <div key={segment.stage} className="flex min-w-0 flex-1 items-center gap-1">
            <SegmentChip segment={segment} onClick={onOpenStage} />
            {i < segments.length - 1 && <span className="text-[10px] text-line-strong">›</span>}
          </div>
        ))}
      </div>

      <div className="mt-auto flex items-center gap-2 text-[10.5px] text-muted">
        <span className="truncate">
          {task?.spec.target.kind === "db" ? "直写库表" : "HTTP"} · {node.subtitle.split(" · ")[1] ?? ""}
        </span>
        <span className="ml-auto shrink-0 font-mono">
          {stats && stats.total > 0 ? `今日 ${stats.total.toLocaleString()} 条` : "今日无记录"}
        </span>
      </div>
    </CardShell>
  );
}
