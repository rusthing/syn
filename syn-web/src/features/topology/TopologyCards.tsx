/**
 * # 拓扑卡片
 *
 * 四类卡片同一骨架，顺序照 dbz 控制面板那张图定死：
 *
 * ```
 * ┌──────────────────────────────── 启用(右上角) ┐
 * │ 类型标识                     [Switch]        │
 * │ 名称  ⚠                                    │
 * │ 副标题（mono）                              │
 * │ ── 状态栏：状态标签 · 计数 · 测试结果 ──      │
 * │ ── 操作行：编辑  ……  其它  │  删除 ──        │
 * └─────────────────────────────────────────────┘
 * ```
 *
 * **操作只住在卡片上，不住在窗体与属性栏里**：启用/停用在右上角，编辑在操作行
 * 最左，删除隔一道分隔线放最右。添加/编辑页面里出现「启用」会把同一件事拆成
 * 两个入口 —— 用户在某处关掉、在另一处又打开，谁也不知道最后是哪次生效。
 *
 * 任务卡另有两个额外约定：
 * - 六段可点，但**点了不弹窗**，只把右侧属性栏切到那一段的详情（`onOpenStage`）；
 * - 独占开关钉在数据抽取连线落进卡片的位置（顶边中点），语义就是「命中即止 / 分叉继续」。
 *
 * 颜色只区分「哪一类节点」，状态只用标签表达 —— 一屏几十张卡时，颜色一多就
 * 分不清哪个是错误色、哪个是类型色。
 */

import {
  ArrowDownToLine,
  Database,
  GripVertical,
  Pencil,
  Play,
  Plug,
  FlaskConical,
  Radio,
  Split,
  Trash2,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTime } from "@/lib/time";
import type { CanvasNodeKind, DatasourceTestResult } from "@/lib/api/types";
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

/**
 * 卡片尺寸：同类同高，操作行才能对齐。
 * 状态栏与操作行各占一行，所以比只有「类型 / 名称 / 副标题」的老卡片高一些。
 */
export const CARD_SIZE: Record<CanvasNodeKind, { w: number; h: number }> = {
  datasource: { w: 268, h: 140 },
  source: { w: 292, h: 140 },
  task: { w: 620, h: 178 },
};

export function cardSize(kind: CanvasNodeKind): { w: number; h: number } {
  return CARD_SIZE[kind];
}

/** 与 uiam 网关图一致：卡片本身是可点击（pointer），只有拖动把手才是移动手型（grab） */
export const GRIP_ATTR = "data-grip";

const KIND_META: Record<CanvasNodeKind, { label: string; icon: typeof Database; accent: string }> = {
  datasource: { label: "数据源", icon: Database, accent: "text-info" },
  source: { label: "数据抽取", icon: Radio, accent: "text-violet" },
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

/** 状态栏上的小标签，三类卡片共用 */
function TonePill({ tone, text }: { tone: NodeTone; text: string }) {
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[11.5px] font-medium", TONE_PILL[tone])}>{text}</span>
  );
}

/** 问题 / 提示角标：数字放状态栏，说明交给画布层的气泡 */
function Flags({ node, onHint }: { node: GraphNode; onHint?: HintHandler }) {
  const title = [...node.issues, ...node.hints].join("\n");
  if (!node.issues.length && !node.hints.length) return null;
  return (
    <span
      onMouseEnter={(e) => onHint?.(e, title)}
      onMouseLeave={() => onHint?.(null, "")}
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[11px]",
        node.issues.length ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn",
      )}
    >
      <TriangleAlert className="size-2.5" />
      {node.issues.length || node.hints.length}
    </span>
  );
}

/** 卡片外壳：左侧状态色条 + 白底 + 选中描边。泳道网格里位置由 CSS Grid 决定，卡片本身不接收拖拽 */
export function CardShell({
  node,
  selected,
  children,
  className,
}: {
  node: GraphNode;
  selected: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative flex h-full w-full cursor-pointer flex-col rounded-[10px] border bg-surface px-2.5 py-2 shadow-panel transition-shadow",
        selected
          ? "border-accent shadow-float ring-2 ring-accent/30"
          : "border-line hover:border-line-strong hover:shadow-float",
        className,
      )}
    >
      <span className={cn("absolute left-0 top-2 bottom-2 w-[3px] rounded-full", TONE_BAR[node.tone])} />
      {children}
    </div>
  );
}

/**
 * 拖动把手：可拖的东西才是移动手型（grab / grabbing），跟 uiam 网关图的路由排序把手一致。
 * 按下即开始拖动，独立一小块而非整卡可拖 —— 卡片本体是「点一下选中 / 双击进窗体」。
 */
export function GripButton({
  onPointerDown,
  onHint,
  label = "拖动调整匹配顺序",
}: {
  onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onHint?: HintHandler;
  label?: string;
}) {
  return (
    <button
      type="button"
      {...{ [GRIP_ATTR]: "" }}
      aria-label={label}
      data-no-drag
      onPointerDown={(e) => {
        e.stopPropagation();
        onHint?.(null, "");
        onPointerDown(e);
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseEnter={(e) => onHint?.(e, label)}
      onMouseLeave={() => onHint?.(null, "")}
      className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md text-muted transition-colors hover:bg-sunken hover:text-ink active:cursor-grabbing"
    >
      <GripVertical className="size-3.5" />
    </button>
  );
}

/* ------------------------------ 头部与操作 ------------------------------ */

/** 卡片头部：类型标识在前，启用开关统一贴右上角；开关不参与卡片拖动 */
function CardHead({
  node,
  enabled,
  busy,
  onToggleEnabled,
  onHint,
  hint,
}: {
  node: GraphNode;
  enabled: boolean;
  busy?: boolean;
  onToggleEnabled: (next: boolean) => void;
  onHint?: HintHandler;
  hint: string;
}) {
  const meta = KIND_META[node.kind];
  return (
    <div className="flex items-center justify-between gap-2">
      {/* 类型文字统一墨灰，颜色只留在图标与左侧状态条上：四类色 + 状态色会糊成一团 */}
      <span className="flex items-center gap-1 text-[11.5px] font-medium text-ink-soft">
        <meta.icon className={cn("size-3", meta.accent)} />
        {meta.label}
      </span>
      <span
        data-no-drag
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onMouseEnter={(e) => onHint?.(e, hint)}
        onMouseLeave={() => onHint?.(null, "")}
        onFocus={(e) => onHint?.(e, hint)}
        onBlur={() => onHint?.(null, "")}
        onClick={(e) => e.stopPropagation()}
      >
        <Switch
          checked={enabled}
          size="sm"
          label={enabled ? `停用 ${node.title}` : `启用 ${node.title}`}
          busy={busy}
          onChange={onToggleEnabled}
        />
      </span>
    </div>
  );
}

interface CardActionProps {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  onHint?: HintHandler;
  tone?: "danger";
  busy?: boolean;
}

/** 操作行上的一个图标按钮：说明走画布气泡，不用会跟着缩放的原生 title */
function CardAction({ label, icon, onClick, onHint, tone, busy }: CardActionProps) {
  return (
    <button
      type="button"
      data-no-drag
      aria-label={label}
      aria-busy={busy || undefined}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseEnter={(e) => onHint?.(e, label)}
      onMouseLeave={() => onHint?.(null, "")}
      onFocus={(e) => onHint?.(e, label)}
      onBlur={() => onHint?.(null, "")}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      // 请求中不禁用：原生 disabled 连 click 都不派发，看起来就是「点不动」
      className={cn(
        // 视觉仍是 24px（卡片高度固定），透明伪元素把点击热区扩到 ~32px
        "relative flex size-6 items-center justify-center rounded-md border border-transparent text-muted transition-colors",
        "after:absolute after:-inset-1 after:content-['']",
        "hover:bg-sunken hover:text-ink",
        tone === "danger" && "hover:bg-danger-soft hover:text-danger",
        busy && "cursor-wait opacity-70",
      )}
    >
      {icon}
    </button>
  );
}

/** 操作行：编辑靠最左，其它靠右，删除隔一道分隔线放最后 */
function CardActions({
  left,
  right,
  danger,
}: {
  left: React.ReactNode;
  right?: React.ReactNode;
  danger?: React.ReactNode;
}) {
  return (
    <div
      className="mt-1 flex items-center gap-0.5 border-t border-line/70 pt-1"
      data-no-drag
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {left}
      <span className="flex-1" />
      {right}
      {danger && (
        <>
          <span className="mx-0.5 h-3.5 w-px bg-line" aria-hidden />
          {danger}
        </>
      )}
    </div>
  );
}

/* ------------------------------ 任务 / 数据源 ------------------------------ */

const EXCLUSIVE_HINT = {
  on: "独占 · 命中即止：数据匹配到这个任务后就不再往下匹配，后面的任务拿不到这条数据。点击可改为「非独占」。",
  off: "非独占 · 分叉继续：命中后数据还会继续流给下一个任务，用来把一份数据同步到多个下游。点击可改为「独占」。",
} as const;

/**
 * 独占开关：钉在数据抽取连线落进卡片的位置（顶边中点）。
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

/**
 * 数据源 / 数据抽取卡片。
 *
 * 两者的差别只有两处：数据源多一个「测试连接」动作（结果写在状态栏），
 * 数据抽取的状态栏显示「最近一轮」而不是引用数。
 */
export function EntityCard({
  node,
  selected,
  onEdit,
  onDelete,
  onToggleEnabled,
  onTest,
  onPull,
  test,
  testBusy,
  pullBusy,
  enabledBusy,
  onHint,
}: {
  node: GraphNode;
  selected: boolean;
  onEdit: () => void;
  onDelete: () => void;
  /** 启用开关直接走 toggle 接口；窗体里不再有这一项 */
  onToggleEnabled: (next: boolean) => void;
  /** 只有数据源有：测一次连接，结果进状态栏 */
  onTest?: () => void;
  /** 只有数据抽取有：手动拉取一轮（与计划任务同一条路径） */
  onPull?: () => void;
  test?: DatasourceTestResult | null;
  testBusy?: boolean;
  pullBusy?: boolean;
  enabledBusy?: boolean;
  onHint?: HintHandler;
}) {
  const enabled = node.datasource?.enabled ?? node.source?.enabled ?? true;
  const enabledHint = enabled
    ? `当前启用：点击停用「${node.title}」。停用后保留配置，但不再参与取数 / 投递。`
    : `当前停用：点击启用「${node.title}」。`;

  return (
    <CardShell node={node} selected={selected}>
      <CardHead
        node={node}
        enabled={enabled}
        busy={enabledBusy}
        onToggleEnabled={onToggleEnabled}
        onHint={onHint}
        hint={enabledHint}
      />

      <div className="mt-1 flex items-center gap-1.5">
        <span className="truncate text-[13.5px] font-medium text-ink">{node.title}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">{node.key}</span>
      </div>

      <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted">{node.subtitle}</div>

      {/* 状态栏：状态标签 · 关键计数 · 测试结果（数据源）· 问题角标 */}
      <div className="mt-auto flex min-w-0 items-center gap-1.5 pt-1" data-no-drag>
        <TonePill tone={node.tone} text={node.status} />
        {node.kind === "datasource" ? (
          <span className="truncate text-[11.5px] text-muted">
            v{node.datasource?.version ?? 1} · 连接池 {node.datasource?.maxConnections ?? 0}
          </span>
        ) : (
          <span className="truncate text-[11.5px] text-muted">
            {/* last_run_ms 是字符串毫秒（U64 走字符串），不能直接喂 Date —— 「1763003520000」
                会被当成日期串解析成 Invalid Date，所以统一走 time.ts 的 toMs */}
            {node.source?.last_run_ms
              ? `最近 ${formatTime(node.source.last_run_ms, false)}`
              : "还没跑过"}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {test && (
            <span
              className={cn(
                "truncate rounded px-1 py-0.5 text-[11px] font-medium",
                test.ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
              )}
            >
              {test.ok ? `连通 ${test.elapsedMs}ms` : "测试失败"}
            </span>
          )}
          <Flags node={node} onHint={onHint} />
        </span>
      </div>

      <CardActions
        left={
          <CardAction
            label="编辑配置"
            icon={<Pencil className="size-3.5" />}
            onClick={onEdit}
            onHint={onHint}
          />
        }
        right={
          <>
            {onPull && (
              <CardAction
                label={pullBusy ? "正在拉取…" : "立即拉取一轮"}
                icon={<Play className="size-3.5" />}
                onClick={onPull}
                onHint={onHint}
                busy={pullBusy}
              />
            )}
            {onTest && (
              <CardAction
                label={testBusy ? "正在测试连接…" : "测试连接"}
                icon={<Plug className="size-3.5" />}
                onClick={onTest}
                onHint={onHint}
                busy={testBusy}
              />
            )}
          </>
        }
        danger={
          <CardAction
            label="删除"
            icon={<Trash2 className="size-3.5" />}
            tone="danger"
            onClick={onDelete}
            onHint={onHint}
          />
        }
      />
    </CardShell>
  );
}

/** 任务卡里可点的六段之一 */
function SegmentChip({
  segment,
  onClick,
}: {
  segment: TaskSegment;
  onClick: (stage: TaskStage) => void;
}) {
  const isTarget = segment.stage === "target";
  const describe = `${segment.label} · ${segment.detail}${segment.issues ? ` · ${segment.issues} 处待修正` : ""}`;
  return (
    <button
      type="button"
      data-no-drag
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick(segment.stage);
      }}
      title={describe}
      // 原生 title 会跟着画布 scale 缩掉；键盘/读屏走这一份完整说明
      aria-label={`${describe}；点这里在右侧属性栏看详情`}
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
          "text-[11px] font-medium",
          isTarget ? "text-accent-strong" : "text-ink-soft",
          segment.issues > 0 && "text-danger",
        )}
      >
        {segment.label}
      </span>
      <span
        className={cn(
          "w-full truncate px-0.5 text-center font-mono text-[11.5px]",
          isTarget ? "text-accent-strong" : "text-muted",
        )}
      >
        {segment.detail}
      </span>
      {segment.issues > 0 && (
        <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-danger text-[10px] font-medium text-white">
          {segment.issues}
        </span>
      )}
    </button>
  );
}

export function TaskCard({
  node,
  selected,
  onOpenStage,
  onEdit,
  onTry,
  onDelete,
  onToggleEnabled,
  onToggleExclusive,
  onGripDown,
  onHint,
  enabledBusy,
  exclusiveBusy,
}: {
  node: GraphNode;
  selected: boolean;
  /** 点某一段：只切换右侧属性栏，不弹窗体 */
  onOpenStage: (stage: TaskStage) => void;
  onEdit: () => void;
  onTry: () => void;
  onDelete: () => void;
  onToggleEnabled: (next: boolean) => void;
  onToggleExclusive: () => void;
  /** 拖动把手按下：在同一主题泳道内调整匹配顺序 */
  onGripDown?: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onHint?: HintHandler;
  /** 两个请求各记各的，互不置灰；都只影响视觉，不禁用按钮 */
  enabledBusy?: boolean;
  exclusiveBusy?: boolean;
}) {
  const task = node.task;
  const segments = node.segments ?? [];
  const stats = task?.stats;
  const exclusive = task?.spec.exclusive !== false;
  const enabled = !!task?.enabled;
  const enabledHint = enabled
    ? "当前启用：点击停用这个任务。停用后事件会落到下一个任务或直接进死信；写库时会通知各副本刷新执行器快照。"
    : "当前停用：点击启用这个任务。启用后写库同样会通知各副本刷新执行器快照。";
  const bad = stats ? stats.fatal + stats.retriable : 0;
  const badRate = stats && stats.total > 0 ? (bad / stats.total) * 100 : 0;

  return (
    <CardShell node={node} selected={selected}>
      <ExclusiveToggle
        exclusive={exclusive}
        busy={exclusiveBusy}
        onToggle={onToggleExclusive}
        onHint={onHint}
      />

      <CardHead
        node={node}
        enabled={enabled}
        busy={enabledBusy}
        onToggleEnabled={onToggleEnabled}
        onHint={onHint}
        hint={enabledHint}
      />

      <div className="mt-0.5 flex items-center gap-1.5">
        <span className="truncate text-[13.5px] font-medium text-ink">{node.title}</span>
        <span className="ml-auto shrink-0 truncate font-mono text-[11.5px] text-muted">
          {task?.topic ?? ""}
        </span>
      </div>

      <div className="mt-1.5 flex items-stretch gap-1">
        {segments.map((segment, i) => (
          <div key={segment.stage} className="flex min-w-0 flex-1 items-center gap-1">
            <SegmentChip segment={segment} onClick={onOpenStage} />
            {i < segments.length - 1 && <span className="text-[11px] text-line-strong">›</span>}
          </div>
        ))}
      </div>

      {/* 状态栏：结论 + 今日量 + 失败率 + 问题角标 */}
      <div className="mt-auto flex min-w-0 items-center gap-1.5 pt-1" data-no-drag>
        <TonePill tone={node.tone} text={node.status} />
        <span className="truncate text-[11.5px] text-muted">
          {task?.spec.target.kind === "db" ? "直写库表" : "HTTP"} ·{" "}
          {node.subtitle.split(" · ")[0] ?? ""}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">
          {stats && stats.total > 0 ? `今日 ${stats.total.toLocaleString()} 条` : "今日无记录"}
        </span>
        {stats && stats.total > 0 && (
          <span
            className={cn(
              "shrink-0 font-mono text-[11px]",
              badRate >= 1 ? "text-danger" : badRate > 0 ? "text-warn" : "text-muted",
            )}
          >
            {badRate.toFixed(badRate < 1 ? 1 : 0)}%
          </span>
        )}
        <Flags node={node} onHint={onHint} />
      </div>

      <CardActions
        left={
          <>
            {onGripDown && <GripButton onPointerDown={onGripDown} onHint={onHint} />}
            <CardAction
              label="编辑配置"
              icon={<Pencil className="size-3.5" />}
              onClick={onEdit}
              onHint={onHint}
            />
          </>
        }
        right={
          <CardAction
            label="用样例试跑这个任务"
            icon={<FlaskConical className="size-3.5" />}
            onClick={onTry}
            onHint={onHint}
          />
        }
        danger={
          <CardAction
            label="删除"
            icon={<Trash2 className="size-3.5" />}
            tone="danger"
            onClick={onDelete}
            onHint={onHint}
          />
        }
      />
    </CardShell>
  );
}

