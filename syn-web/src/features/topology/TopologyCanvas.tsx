/**
 * # 拓扑画布
 *
 * 只负责画和拖：节点位置、连线、缩放平移。写库的动作（保存坐标、打开窗体、
 * 启停任务）全部由页面传入 —— 组件不知道接口存在。
 *
 * 交互按 dbz 控制面板那套收敛：
 * - 卡片可拖，空白可平移，滚轮以指针为中心缩放，右下角可一键适应；
 * - 连线只作展示：方向是数据流，不能拖拽改接（改引用要回表单改，图和表才一致）；
 *   唯一例外是落点处的独占图标（主题 → 任务那条线的终点，见 `TaskCard`）；
 * - 点卡片选中，点空白取消选中；任务卡的启用/独占开关直接在卡上切换。
 *
 * 拖拽用 window 上的 pointermove/up，而不是卡片的 onPointerMove：指针一旦移出
 * 卡片（画布上很常见），卡片收不到事件，拖拽会「粘住」。开关带 `data-no-drag`，
 * pointerdown 落在上面直接跳过拖拽 —— 否则缩到 45% 时轻微手抖就会把 click 吞掉，
 * 变成「拖了一下卡片」，看起来像开关点不动。开关的悬停说明也画在这一层：卡内
 * 的一切都跟着 `scale()` 缩，气泡放在缩放容器外才有正常字号。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasNodePos } from "@/lib/api/types";
import { nodeId, type GraphNode, type TaskStage, type TopologyGraph } from "./graph";
import {
  EntityCard,
  NO_DRAG_ATTR,
  TaskCard,
  TopicCard,
  cardSize,
  type HintHandler,
} from "./TopologyCards";

const MIN_SCALE = 0.3;
const MAX_SCALE = 2;
/** 世界坐标系的逻辑尺寸：节点拖到边缘也不会被裁掉 */
const WORLD_W = 2600;
const WORLD_H = 1800;

interface View {
  x: number;
  y: number;
  scale: number;
}

/** 悬停说明：坐标是相对画布的 CSS 像素，气泡画在缩放容器之外，字号不会被 scale 缩掉 */
interface Hint {
  x: number;
  y: number;
  text: string;
  /** 太靠顶就翻到指针下方，免得气泡被画布上沿裁掉 */
  below: boolean;
}

/** 卡片上的开关：pointerdown 落在这里一律不启动拖拽/平移，否则轻微手抖就会吞掉 click */
const isControl = (target: EventTarget | null): boolean =>
  target instanceof Element && !!target.closest(`[${NO_DRAG_ATTR}]`);

interface Props {
  graph: TopologyGraph;
  positions: Record<string, CanvasNodePos>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** 拖动结束（松手）才回调，避免每帧都写库 */
  onMove: (id: string, pos: { x: number; y: number }) => void;
  onOpenStage: (node: GraphNode, stage: TaskStage) => void;
  onOpenEntity: (node: GraphNode) => void;
  /** 任务卡右上角的启用开关：走 tasks.toggle 接口 */
  onToggleTask: (node: GraphNode, next: boolean) => void;
  /** 连线落点处的独占开关：改 spec.exclusive 保存 */
  onToggleExclusive: (node: GraphNode) => void;
  /**
   * 正在进行的开关请求，键是 `${node.id}:${action}`。启用与独占各占一键，
   * 一个在途时不会把另一个也点不了；只给视觉提示，不禁用任何按钮。
   */
  pendingKeys?: ReadonlySet<string>;
}

export function TopologyCanvas({
  graph,
  positions,
  selectedId,
  onSelect,
  onMove,
  onOpenStage,
  onOpenEntity,
  onToggleTask,
  onToggleExclusive,
  pendingKeys,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 0.8 });
  const [drag, setDrag] = useState<{
    id: string;
    dx: number;
    dy: number;
    x: number;
    y: number;
    /** 起点 + 是否已移动：抬手时据此判断「这是点击还是拖拽」 */
    cx: number;
    cy: number;
    moved: boolean;
  } | null>(null);
  const panRef = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null);
  const fittedRef = useRef(false);
  const [hint, setHint] = useState<Hint | null>(null);

  /** 开关的悬停说明。只在 enter/focus 时算一次位置，不跟着 mousemove 每帧重渲染画布 */
  const showHint = useCallback<HintHandler>((event, text) => {
    const box = boxRef.current;
    if (!event || !text || !box) {
      setHint(null);
      return;
    }
    const rect = box.getBoundingClientRect();
    let cx: number;
    let cy: number;
    if ("clientX" in event) {
      cx = event.clientX;
      cy = event.clientY;
    } else {
      const r = (event.currentTarget as Element).getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
    }
    const half = Math.min(148, rect.width / 2 - 8);
    setHint({
      x: Math.max(half, Math.min(rect.width - half, cx - rect.left)),
      y: cy - rect.top,
      text,
      below: cy - rect.top < 110,
    });
  }, []);

  // 请求开始后指针可能已不在卡片上（气泡会残留），主动收掉
  useEffect(() => {
    if (pendingKeys?.size) setHint(null);
  }, [pendingKeys]);

  const rectOf = useCallback(
    (node: GraphNode) => {
      const pos = positions[node.id] ?? { x: 0, y: 0 };
      const size = cardSize(node.kind);
      return { x: pos.x, y: pos.y, w: size.w, h: size.h };
    },
    [positions],
  );

  /* ------------------------------ 适应窗口 ------------------------------ */

  const fit = useCallback((floor = MIN_SCALE) => {
    const box = boxRef.current;
    if (!box || graph.nodes.length === 0) return;
    const pad = 48;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of graph.nodes) {
      const r = rectOf(node);
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
    const scale = Math.min(
      (box.clientWidth - pad * 2) / Math.max(1, maxX - minX),
      (box.clientHeight - pad * 2) / Math.max(1, maxY - minY),
      MAX_SCALE,
    );
    setView({
      x: pad - minX * scale + Math.max(0, (box.clientWidth - pad * 2 - (maxX - minX) * scale) / 2),
      y: pad - minY * scale,
      scale: Math.max(floor, scale),
    });
  }, [graph.nodes, rectOf]);

  // 第一次拿到节点时自动适应；之后不再自动调，避免用户摆好的视角被抢走
  useEffect(() => {
    if (fittedRef.current || graph.nodes.length === 0) return;
    fittedRef.current = true;
    // 初始只保证「大致装得下」，再小就只剩色块；真要一览无余点右下角的适应按钮
    fit(0.45);
  }, [graph.nodes.length, fit]);

  /* -------------------------------- 缩放 -------------------------------- */

  /**
   * 滚轮缩放必须用原生非被动监听：React 的 `onWheel` 挂在根节点上是 passive 的，
   * 里面 `preventDefault()` 不生效 —— 缩放的同时整页会跟着滚一下。
   */
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = box.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const next = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, view.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)),
      );
      // 以指针为锚点：指针下的那个世界坐标点在缩放前后保持不动
      const wx = (px - view.x) / view.scale;
      const wy = (py - view.y) / view.scale;
      setView({ x: px - wx * next, y: py - wy * next, scale: next });
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [view.x, view.y, view.scale]);

  const zoomBy = (factor: number) => {
    const box = boxRef.current;
    if (!box) return;
    const cx = box.clientWidth / 2;
    const cy = box.clientHeight / 2;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    const wx = (cx - view.x) / view.scale;
    const wy = (cy - view.y) / view.scale;
    setView({ x: cx - wx * next, y: cy - wy * next, scale: next });
  };

  /* ------------------------------ 拖拽 / 平移 ------------------------------ */

  const startNodeDrag = (node: GraphNode) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // 开关：不进拖拽。否则手一抖就变成「拖卡片」，click 被吞、还顺手写了一次坐标
    if (isControl(e.target)) {
      e.stopPropagation();
      setHint(null);
      return;
    }
    e.stopPropagation();
    const pos = positions[node.id] ?? { x: 0, y: 0 };
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return;
    const wx = (e.clientX - rect.left - view.x) / view.scale;
    const wy = (e.clientY - rect.top - view.y) / view.scale;
    setDrag({
      id: node.id,
      dx: wx - pos.x,
      dy: wy - pos.y,
      x: pos.x,
      y: pos.y,
      cx: e.clientX,
      cy: e.clientY,
      moved: false,
    });
  };

  useEffect(() => {
    if (!drag) return;
    const onMoveEvent = (e: PointerEvent) => {
      const rect = boxRef.current?.getBoundingClientRect();
      if (!rect) return;
      const wx = (e.clientX - rect.left - view.x) / view.scale;
      const wy = (e.clientY - rect.top - view.y) / view.scale;
      setDrag((d) =>
        d
          ? {
              ...d,
              moved:
                d.moved || Math.abs(e.clientX - d.cx) > 3 || Math.abs(e.clientY - d.cy) > 3,
              x: Math.max(0, Math.min(WORLD_W, wx - d.dx)),
              y: Math.max(0, Math.min(WORLD_H, wy - d.dy)),
            }
          : d,
      );
    };
    const onUp = () => {
      setDrag((d) => {
        if (!d) return null;
        if (d.moved) onMove(d.id, { x: Math.round(d.x), y: Math.round(d.y) });
        // 单击始终选中（右侧属性栏常驻）：点空白才取消。以前做成 toggle，
        // 连点同一张卡会把选中态抵消掉，属性栏/OA 面板会莫名消失。
        else onSelect(d.id);
        return null;
      });
    };
    window.addEventListener("pointermove", onMoveEvent);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMoveEvent);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, view.x, view.y, view.scale, onMove, onSelect]);

  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0 || isControl(e.target)) return;
    panRef.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
    onSelect(null);
  };

  useEffect(() => {
    const onMoveEvent = (e: PointerEvent) => {
      const p = panRef.current;
      if (!p) return;
      setView((v) => ({ ...v, x: p.vx + (e.clientX - p.px), y: p.vy + (e.clientY - p.py) }));
    };
    const onUp = () => {
      panRef.current = null;
    };
    window.addEventListener("pointermove", onMoveEvent);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMoveEvent);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const effectivePos = useCallback(
    (node: GraphNode) => {
      if (drag?.id === node.id) return { ...positions[node.id], x: drag.x, y: drag.y };
      return positions[node.id] ?? { x: 0, y: 0 };
    },
    [drag, positions],
  );

  /* -------------------------------- 连线 -------------------------------- */

  const edges = useMemo(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    return graph.edges.flatMap((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return [];
      const a = effectivePos(from);
      const b = effectivePos(to);
      const sizeA = cardSize(from.kind);
      const sizeB = cardSize(to.kind);
      const x1 = a.x + sizeA.w / 2;
      const y1 = a.y + sizeA.h;
      const x2 = b.x + sizeB.w / 2;
      const y2 = b.y;
      const my = (y1 + y2) / 2;
      return [
        {
          id: edge.id,
          d: `M${x1},${y1} L${x1},${my} L${x2},${my} L${x2},${y2}`,
          muted: edge.muted,
        },
      ];
    });
  }, [graph, effectivePos]);

  const isEmpty = graph.nodes.length === 0;

  return (
    <div className="relative overflow-hidden rounded-[14px] border border-line bg-surface">
      <div
        ref={boxRef}
        onPointerDown={startPan}
        className="relative h-[calc(100vh-320px)] min-h-[440px] w-full cursor-grab touch-none overflow-hidden bg-canvas active:cursor-grabbing"
        style={{
          backgroundImage: "radial-gradient(circle, #d8dbd2 1px, transparent 1px)",
          backgroundSize: `${24 * view.scale}px ${24 * view.scale}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            width: WORLD_W,
            height: WORLD_H,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        >
          <svg
            className="pointer-events-none absolute left-0 top-0"
            width={WORLD_W}
            height={WORLD_H}
            aria-hidden
          >
            <defs>
              <marker
                id="topo-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path
                  d="M2 1L8 5L2 9"
                  fill="none"
                  stroke="#a9b0a2"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </marker>
              <marker
                id="topo-arrow-muted"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path
                  d="M2 1L8 5L2 9"
                  fill="none"
                  stroke="#cdd2c6"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </marker>
            </defs>
            {edges.map((edge) => (
              <path
                key={edge.id}
                d={edge.d}
                fill="none"
                stroke={edge.muted ? "#cdd2c6" : "#a9b0a2"}
                strokeWidth={1.2}
                strokeDasharray={edge.muted ? "4 4" : undefined}
                markerEnd={`url(#${edge.muted ? "topo-arrow-muted" : "topo-arrow"})`}
              />
            ))}
          </svg>

          {graph.nodes.map((node) => {
            const pos = effectivePos(node);
            const size = cardSize(node.kind);
            const dragging = drag?.id === node.id;
            const common = {
              key: node.id,
              style: { left: pos.x, top: pos.y, width: size.w, height: size.h },
              className: cn("absolute", dragging ? "z-20 cursor-grabbing" : "z-10 cursor-grab"),
              onPointerDown: startNodeDrag(node),
              onDoubleClick: (e: React.MouseEvent) => {
                // 双击开关不该顺手把窗体打开（会盖住刚点的那张卡）
                if (isControl(e.target)) return;
                // 双击进窗体：顺手选中，窗体关掉后卡片仍是选中的那个（免得两次
                // 点击的 toggle 把选中态又抵消掉）
                onSelect(node.id);
                onOpenEntity(node);
              },
            };

            if (node.kind === "topic") {
              return (
                <div {...common}>
                  <TopicCard node={node} selected={node.id === selectedId} />
                </div>
              );
            }
            if (node.kind === "task") {
              return (
                <div {...common}>
                  <TaskCard
                    node={node}
                    selected={node.id === selectedId}
                    onOpenStage={(stage) => {
                      onSelect(node.id);
                      onOpenStage(node, stage);
                    }}
                    // 开关点下去也把卡片选中：右侧属性栏跟着切到这张卡
                    onToggleEnabled={(next) => {
                      onSelect(node.id);
                      onToggleTask(node, next);
                    }}
                    onToggleExclusive={() => {
                      onSelect(node.id);
                      onToggleExclusive(node);
                    }}
                    onHint={showHint}
                    enabledBusy={pendingKeys?.has(`${node.id}:enabled`)}
                    exclusiveBusy={pendingKeys?.has(`${node.id}:exclusive`)}
                  />
                </div>
              );
            }
            return (
              <div {...common}>
                <EntityCard node={node} selected={node.id === selectedId} />
              </div>
            );
          })}
        </div>

        {isEmpty && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
            <p className="text-[13px] font-medium text-ink">还没有可画的东西</p>
            <p className="max-w-[380px] text-[12px] leading-relaxed text-muted">
              先到「数据源」登记连接、到「取数来源」登记拉取规则、或到「同步任务」新建任务，
              拓扑会自动长出来。
            </p>
          </div>
        )}

        {hint && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-30 w-[296px] rounded-lg border border-line bg-surface px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-soft shadow-float"
            style={{
              left: hint.x,
              top: hint.below ? hint.y + 14 : hint.y - 14,
              transform: hint.below ? "translate(-50%, 0)" : "translate(-50%, -100%)",
            }}
          >
            {hint.text}
          </div>
        )}

        <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-line bg-surface/95 p-1 shadow-panel">
          <button
            type="button"
            aria-label="缩小"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => zoomBy(1 / 1.2)}
            className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-ink"
          >
            <Minus className="size-3.5" />
          </button>
          <span className="w-10 text-center font-mono text-[11px] text-muted">
            {Math.round(view.scale * 100)}%
          </span>
          <button
            type="button"
            aria-label="放大"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => zoomBy(1.2)}
            className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-ink"
          >
            <Plus className="size-3.5" />
          </button>
          <span className="mx-0.5 h-4 w-px bg-line" />
          <button
            type="button"
            aria-label="适应窗口"
            title="适应窗口"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => fit()}
            className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-ink"
          >
            <Maximize2 className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

export { nodeId };
