/**
 * # 拓扑画布
 *
 * 只负责画和拖：节点位置、连线、缩放平移。写库的动作（保存坐标、打开窗体、
 * 启停任务）全部由页面传入 —— 组件不知道接口存在。
 *
 * 交互按 dbz 控制面板那套收敛：
 * - 默认视图按画布此刻的宽高算比例与位置（ResizeObserver 跟着窗口变化重算），
 *   卡片可拖，空白可平移，滚轮以指针为中心缩放，右下角可切换整图概览；
 * - 点卡片 / 键盘回车只选中，绝不改视角；要推近得自己滚、点百分比或按显式按钮；
 * - 连线只作展示：方向是数据流，不能拖拽改接（改引用要回表单改，图和表才一致）；
 *   唯一例外是落点处的独占图标（主题 → 任务那条线的终点，见 `TaskCard`）；
 * - 点卡片选中，点空白取消选中；任务卡的启用/独占开关直接在卡上切换。
 *
 * 拖拽用 window 上的 pointermove/up，而不是卡片的 onPointerMove：指针一旦移出
 * 卡片（画布上很常见），卡片收不到事件，拖拽会「粘住」。开关带 `data-no-drag`，
 * pointerdown 落在上面直接跳过拖拽 —— 否则缩到概览比例时轻微手抖就会把 click 吞掉，
 * 变成「拖了一下卡片」，看起来像开关点不动。开关的悬停说明也画在这一层：卡内
 * 的一切都跟着 `scale()` 缩，气泡放在缩放容器外才有正常字号。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Maximize2, Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasNodePos, DatasourceTestResult } from "@/lib/api/types";
import { nodeId, type GraphNode, type TaskStage, type TopologyGraph } from "./graph";
import {
  EntityCard,
  NO_DRAG_ATTR,
  TaskCard,
  TopicCard,
  cardSize,
  type HintHandler,
} from "./TopologyCards";

/** 自动适应允许缩到很小：窄窗口也要把整张图装进来，细节交给滚轮 / 百分比按钮 */
const MIN_SCALE = 0.16;
const MAX_SCALE = 2;
/** 自动适应不放大超过 1:1，否则只有两三张卡时会铺满整屏 */
const AUTO_MAX_SCALE = 1;
/** 可读视图的比例区间：窗口再窄也不把字缩成色块，宽窗口维持上一版的 90% */
const READABLE_MAX_SCALE = 0.9;
const READABLE_MIN_SCALE = 0.55;
/** 装图时四周留白（CSS 像素） */
const FIT_PAD = 24;
/** 世界坐标系的逻辑尺寸：节点拖到边缘也不会被裁掉 */
const WORLD_W = 2600;
const WORLD_H = 1800;

const NODE_KIND_LABEL: Record<GraphNode["kind"], string> = {
  datasource: "数据源",
  source: "取数来源",
  topic: "主题",
  task: "任务",
};

interface View {
  x: number;
  y: number;
  scale: number;
}

interface DragState {
  id: string;
  dx: number;
  dy: number;
  x: number;
  y: number;
  /** 起点 + 是否已移动：抬手时据此判断「这是点击还是拖拽」 */
  cx: number;
  cy: number;
  moved: boolean;
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
  /** 任务卡某一段：只切右侧属性栏，不开窗体 */
  onOpenStage: (node: GraphNode, stage: TaskStage) => void;
  /** 操作行最左的「编辑」：开窗体 */
  onOpenEntity: (node: GraphNode) => void;
  onDeleteEntity: (node: GraphNode) => void;
  onTryTask: (node: GraphNode) => void;
  /** 卡片右上角的启用开关：任务走 tasks.toggle，来源/数据源走各自的 set_enabled */
  onToggleTask: (node: GraphNode, next: boolean) => void;
  /** 连线落点处的独占开关：改 spec.exclusive 保存 */
  onToggleExclusive: (node: GraphNode) => void;
  onToggleEntity: (node: GraphNode, next: boolean) => void;
  /** 数据源卡片的「测试连接」：测库里已存的那条 */
  onTestDatasource: (node: GraphNode) => void;
  /** 各数据源最近一次的测试结果，卡片状态栏显示 */
  testResults?: Record<string, DatasourceTestResult>;
  /**
   * 外部请求把某张卡移到视野正中（警示条点节点）。token 每次点击都变，
   * 连点同一条也能再次定位；不传则画布完全自己管视角。
   */
  focus?: { id: string; token: number } | null;
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
  onDeleteEntity,
  onTryTask,
  onToggleTask,
  onToggleExclusive,
  onToggleEntity,
  onTestDatasource,
  testResults,
  pendingKeys,
  focus,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  /**
   * 拖拽状态同时放在 ref 与 state：ref 供常驻的 window 监听器同步读取
   * （pointerdown 后立刻 pointerup 也不会漏），state 只负责把卡画到新位置。
   * 以前监听器挂在依赖 drag 的 effect 里，每帧都在增删监听，快速点击还会丢 pointerup。
   */
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const panRef = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null);
  /** 已经按哪个节点数做过自动适应：节点增删要重排，拖动坐标则不该抢走视角 */
  const fittedCountRef = useRef(0);
  /**
   * 用户是否亲手改过视角（滚轮 / 缩放按钮 / 平移 / 定位）。没改过时窗口大小变化
   * 就重新适应；改过之后只把视口中心的世界坐标保持住，不覆盖用户选的比例。
   */
  const userAdjustedRef = useRef(false);
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

  /**
   * 按画布此刻的真实宽高把整张图居中装下：比例不是写死的，窗口越大字越大，
   * 窗口变小也不会把右侧几列裁掉。先用夹紧后的 scale 再算偏移 —— 以前
   * x/y 用未夹紧的 scale、显示却用夹紧后的值，小窗口下整张图会整体偏出画布。
   */
  const fit = useCallback(() => {
    const box = boxRef.current;
    if (!box || graph.nodes.length === 0) return;
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
    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);
    const scale = Math.min(
      AUTO_MAX_SCALE,
      Math.max(
        MIN_SCALE,
        Math.min(
          (box.clientWidth - FIT_PAD * 2) / contentW,
          (box.clientHeight - FIT_PAD * 2) / contentH,
        ),
      ),
    );
    setView({
      x: (box.clientWidth - contentW * scale) / 2 - minX * scale,
      y: (box.clientHeight - contentH * scale) / 2 - minY * scale,
      scale,
    });
  }, [graph.nodes, rectOf]);

  /**
   * 默认视图：按画布宽度算比例，保证最宽的那张卡（任务卡）整张装得下。
   * 窗口变窄就等比缩一点、窗口变宽就在左边多露几列上游节点 —— 比例与位置
   * 都跟着容器走，但不会为了「一屏塞下 18 张卡」把 11px 的字缩成 3px。
   */
  const readableView = useCallback(() => {
    const box = boxRef.current;
    if (!box || graph.nodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let taskX = Infinity;
    let maxCardW = 0;
    for (const node of graph.nodes) {
      const r = rectOf(node);
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxCardW = Math.max(maxCardW, r.w);
      if (node.kind === "task") taskX = Math.min(taskX, r.x);
    }
    const anchorX = Number.isFinite(taskX) ? taskX : minX;
    const scale = Math.min(
      READABLE_MAX_SCALE,
      Math.max(READABLE_MIN_SCALE, (box.clientWidth - FIT_PAD * 2) / Math.max(1, maxCardW)),
    );
    // 任务列尽量靠右、左边多露上游列；窄窗口时退到左留白，保证整张卡不被裁
    const left = Math.min(
      box.clientWidth * 0.28,
      Math.max(FIT_PAD, box.clientWidth - maxCardW * scale - FIT_PAD),
    );
    setView({
      x: left - anchorX * scale,
      y: FIT_PAD - minY * scale,
      scale,
    });
  }, [graph.nodes, rectOf]);

  /** 把某张卡移到视口正中：只由警示条节点和「定位到选中卡片」这两个显式入口调用 */
  const focusOn = useCallback(
    (id: string, scale: number) => {
      const box = boxRef.current;
      const node = graph.nodes.find((n) => n.id === id);
      if (!box || !node) return;
      userAdjustedRef.current = true;
      const r = rectOf(node);
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
      setView({
        x: box.clientWidth / 2 - (r.x + r.w / 2) * next,
        y: box.clientHeight / 2 - (r.y + r.h / 2) * next,
        scale: next,
      });
    },
    [graph.nodes, rectOf],
  );

  /** 外部（警示条）要求定位：token 变了才动，节点数据刷新不会把镜头抢走 */
  const lastFocusToken = useRef(0);
  useEffect(() => {
    if (!focus || focus.token === lastFocusToken.current) return;
    lastFocusToken.current = focus.token;
    focusOn(focus.id, 1);
  }, [focus, focusOn]);

  /** 两种自动视图：默认可读局部，切一下是整图概览；两个都按容器尺寸算 */
  const [overview, setOverview] = useState(false);
  const autoView = useCallback(() => {
    if (overview) fit();
    else readableView();
  }, [overview, fit, readableView]);

  /** ResizeObserver 只挂一次，靠 ref 拿最新的自动视图计算（依赖会随坐标变化） */
  const autoViewRef = useRef(autoView);
  useEffect(() => {
    autoViewRef.current = autoView;
  }, [autoView]);

  /**
   * 首屏按画布真实尺寸自动适应；节点增删也要重排。用节点数做闸门：
   * 拖卡片 / 刷新坐标会让 autoView 的引用变化，但不该把用户摆好的视角抢回去。
   */
  useEffect(() => {
    const count = graph.nodes.length;
    if (count === 0 || userAdjustedRef.current || fittedCountRef.current === count) return;
    fittedCountRef.current = count;
    autoViewRef.current();
  }, [graph.nodes.length]);

  /** 切换可读 / 全图时立刻重算（节点数没变，上面那个 effect 不会触发） */
  useEffect(() => {
    if (userAdjustedRef.current || graph.nodes.length === 0) return;
    autoViewRef.current();
  }, [overview, graph.nodes.length]);

  /**
   * 容器尺寸变化（窗口缩放、侧栏折叠、页面高度变化）时重新适应，不是只在挂载算一次。
   * 用户亲手缩放/平移过之后不再改比例，只把视口中心的世界坐标保持住。
   */
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    let prevW = box.clientWidth;
    let prevH = box.clientHeight;
    const observer = new ResizeObserver(() => {
      const w = box.clientWidth;
      const h = box.clientHeight;
      if (!w || !h) return;
      const dw = w - prevW;
      const dh = h - prevH;
      if (dw === 0 && dh === 0) return;
      prevW = w;
      prevH = h;
      if (userAdjustedRef.current) {
        setView((v) => ({ ...v, x: v.x + dw / 2, y: v.y + dh / 2 }));
      } else {
        autoViewRef.current();
      }
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

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
      userAdjustedRef.current = true;
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
    userAdjustedRef.current = true;
    const cx = box.clientWidth / 2;
    const cy = box.clientHeight / 2;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    const wx = (cx - view.x) / view.scale;
    const wy = (cy - view.y) / view.scale;
    setView({ x: cx - wx * next, y: cy - wy * next, scale: next });
  };

  /** 百分比按钮：以视口中心为锚点回到 1:1，卡片上的字按原始字号渲染 */
  const resetScale = () => {
    const box = boxRef.current;
    if (!box) return;
    userAdjustedRef.current = true;
    const cx = box.clientWidth / 2;
    const cy = box.clientHeight / 2;
    const wx = (cx - view.x) / view.scale;
    const wy = (cy - view.y) / view.scale;
    setView({ x: cx - wx, y: cy - wy, scale: 1 });
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
    const next: DragState = {
      id: node.id,
      dx: wx - pos.x,
      dy: wy - pos.y,
      x: pos.x,
      y: pos.y,
      cx: e.clientX,
      cy: e.clientY,
      moved: false,
    };
    dragRef.current = next;
    setDrag(next);
  };

  /**
   * window 级监听常驻，不挂在 `drag` 上：pointerdown 写完 ref 后哪怕立刻抬手
   * 也能收到 pointerup（快速单击不会「点了没反应」），拖动时也不必每帧增删监听。
   */
  useEffect(() => {
    const onMoveEvent = (e: PointerEvent) => {
      const d = dragRef.current;
      const rect = boxRef.current?.getBoundingClientRect();
      if (!d || !rect) return;
      const wx = (e.clientX - rect.left - view.x) / view.scale;
      const wy = (e.clientY - rect.top - view.y) / view.scale;
      const next: DragState = {
        ...d,
        moved: d.moved || Math.abs(e.clientX - d.cx) > 3 || Math.abs(e.clientY - d.cy) > 3,
        x: Math.max(0, Math.min(WORLD_W, wx - d.dx)),
        y: Math.max(0, Math.min(WORLD_H, wy - d.dy)),
      };
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setDrag(null);
      if (d.moved) {
        onMove(d.id, { x: Math.round(d.x), y: Math.round(d.y) });
        return;
      }
      // 单击只选中（右侧属性栏常驻），镜头一动不动：点卡片不该把整张图推来推去。
      // 以前做成 toggle，连点同一张卡会把选中态抵消掉，属性栏会莫名消失。
      onSelect(d.id);
    };
    window.addEventListener("pointermove", onMoveEvent);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMoveEvent);
      window.removeEventListener("pointerup", onUp);
    };
  }, [view.x, view.y, view.scale, onMove, onSelect]);

  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0 || isControl(e.target)) return;
    panRef.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
    onSelect(null);
  };

  useEffect(() => {
    const onMoveEvent = (e: PointerEvent) => {
      const p = panRef.current;
      if (!p) return;
      userAdjustedRef.current = true;
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
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
      <div
        ref={boxRef}
        onPointerDown={startPan}
        className="relative h-full min-h-0 w-full flex-1 cursor-grab touch-none overflow-hidden bg-canvas active:cursor-grabbing"
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
            const selected = node.id === selectedId;
            const common = {
              style: { left: pos.x, top: pos.y, width: size.w, height: size.h },
              className: cn("absolute", dragging ? "z-20 cursor-grabbing" : "z-10 cursor-grab"),
              /**
               * 卡片自己可聚焦：拖拽之外给键盘一条「选中 / 看属性」的路
               * （WCAG 2.2 要求拖拽不能是唯一操作方式）。key 不放在 props 里 spread，
               * React 19 会警告「key prop is being spread into JSX」。
               */
              tabIndex: 0,
              role: "button" as const,
              "aria-label": `${NODE_KIND_LABEL[node.kind]} ${node.title}，回车查看属性`,
              "aria-pressed": selected,
              onKeyDown: (e: React.KeyboardEvent) => {
                // 卡里的开关 / 段 / 操作按钮也响应回车，不要冒泡成「选中卡片」
                if (e.target !== e.currentTarget) return;
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                // 和鼠标单击一致：只选中，不改视角
                onSelect(node.id);
              },
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
                <div key={node.id} {...common}>
                  <TopicCard node={node} selected={node.id === selectedId} />
                </div>
              );
            }
            if (node.kind === "task") {
              return (
                <div key={node.id} {...common}>
                  <TaskCard
                    node={node}
                    selected={node.id === selectedId}
                    onOpenStage={(stage) => {
                      onSelect(node.id);
                      onOpenStage(node, stage);
                    }}
                    onEdit={() => {
                      onSelect(node.id);
                      onOpenEntity(node);
                    }}
                    onTry={() => onTryTask(node)}
                    onDelete={() => onDeleteEntity(node)}
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
              <div key={node.id} {...common}>
                <EntityCard
                  node={node}
                  selected={node.id === selectedId}
                  onEdit={() => {
                    onSelect(node.id);
                    onOpenEntity(node);
                  }}
                  onDelete={() => onDeleteEntity(node)}
                  onToggleEnabled={(next) => {
                    onSelect(node.id);
                    onToggleEntity(node, next);
                  }}
                  // 只有数据源能测：来源连的是 Kafka/业务源，测它没有统一动作
                  onTest={
                    node.kind === "datasource"
                      ? () => {
                          onSelect(node.id);
                          onTestDatasource(node);
                        }
                      : undefined
                  }
                  test={testResults?.[node.id]}
                  testBusy={pendingKeys?.has(`${node.id}:test`)}
                  enabledBusy={pendingKeys?.has(`${node.id}:enabled`)}
                  onHint={showHint}
                />
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

        <div
          role="group"
          aria-label="画布视图"
          className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-line bg-surface/95 p-1 shadow-panel"
        >
          <button
            type="button"
            aria-label="缩小"
            title="缩小"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => zoomBy(1 / 1.2)}
            className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-ink"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="回到 100% 原始尺寸"
            title="回到 100% 原始尺寸（卡片按真实字号显示）"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={resetScale}
            className="w-11 rounded-md py-1 text-center font-mono text-[11.5px] text-muted hover:bg-sunken hover:text-ink"
          >
            {Math.round(view.scale * 100)}%
          </button>
          <button
            type="button"
            aria-label="放大"
            title="放大"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => zoomBy(1.2)}
            className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-ink"
          >
            <Plus className="size-3.5" />
          </button>
          <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
          {selectedId && (
            <button
              type="button"
              aria-label="定位到选中卡片"
              title="把选中的卡片移到画布正中"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => focusOn(selectedId, 1)}
              className="flex size-8 items-center justify-center rounded-md text-accent hover:bg-accent-soft"
            >
              <Crosshair className="size-3.5" />
            </button>
          )}
          {/* 可读局部 ⇄ 全图概览；每次点击都把视角交回自动模式，窗口变化继续跟着重算 */}
          <button
            type="button"
            aria-label={overview ? "切回可读视图" : "看全整张图"}
            title={
              overview
                ? "切回可读视图：按当前窗口算比例，卡片保持可读"
                : "看全整张图：缩到能一屏装下所有节点"
            }
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              userAdjustedRef.current = false;
              setOverview((v) => !v);
            }}
            className={cn(
              "flex h-8 items-center gap-1 rounded-md border px-2 text-[11.5px] font-medium",
              overview
                ? "border-accent bg-accent-soft text-accent-strong hover:bg-[#d9ebe3]"
                : "border-accent/30 bg-accent-soft text-accent-strong hover:bg-[#d9ebe3]",
            )}
          >
            <Maximize2 className="size-3.5" />
            {overview ? "可读" : "全图"}
          </button>
        </div>
      </div>
    </div>
  );
}

export { nodeId };
