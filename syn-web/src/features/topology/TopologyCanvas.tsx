/**
 * # 泳道画布（学习 uiam 网关配置图的结构）
 *
 * 一张 CSS Grid 泳道：数据源 → 数据抽取 → 任务，列的**顺序**固定、**宽度**可调，
 * 行由引用关系决定（见 `lanes.ts`）。节点不再自由拖拽、坐标不再入库 —— 图永远按当前
 * 配置自动排布；唯一可拖的除了任务卡上的把手（同泳道内调匹配顺序 sort_order），就是
 * 题头右缘的列宽把手：拖自己那列、双击复位，结果写 localStorage（见 `layout-prefs.ts`），
 * 换机不带走。
 *
 * ## 为什么连线用「测量 + SVG 贝塞尔」而不是 CSS 直线
 *
 * 真正要表达的是**汇聚**：几条抽取写同一个 topic、一个 topic 被多个任务读、几条抽取
 * 共用一个数据源。同名实体只画一个节点，线弯过去汇到它 —— 这正是「谁和谁共用」
 * 这个问句的答案。节点按文档流排（行高自适应内容），坐标渲染后从 DOM 量出来再画。
 * 数据在变化、容器尺寸变化、字体加载完成三种时机重测（`sameBoxes` 抑制亚像素抖动）。
 *
 * ## 缩放为什么用 zoom 而不是 transform
 *
 * `transform: scale()` 不改布局尺寸，滚动范围与视觉尺寸对不上；`zoom` 是布局级缩放，
 * 滚动范围、sticky 题头、文字排版一起变，代价只是量出来的坐标要多除一次缩放系数
 * （见 `measureNow`）。
 *
 * ## 光标语义（与 uiam 一致）
 *
 * - 卡片 / 按钮 / 开关：pointer —— 可点击；
 * - 任务卡的把手：grab / grabbing —— 可移动；
 * - 画布空白：default —— 靠滚动条平移，不伪装成可拖。
 *
 * ## 悬停说明（hint）
 *
 * 走 portal + `position: fixed`，不参与缩放也不被画布的 overflow 裁掉；完整详情
 * （issues / hints 逐行）原文呈现，`whitespace-pre-line` 保留换行，不再用会被缩小的
 * 原生 `title`，也不截断成一行。
 */

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Crosshair, Maximize2, Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasNodeKind, DatasourceTestResult } from "@/lib/api/types";
import { nodeId, type GraphNode, type TaskStage, type TopologyGraph } from "./graph";
import {
  buildLanes,
  ORPHAN_LANE,
  type Lane,
  type SwimlaneModel,
} from "./lanes";
import { EntityCard, TaskCard, type HintHandler } from "./TopologyCards";
import {
  clampLaneColumn,
  DEFAULT_LANE_COLUMNS,
  LANE_COLUMNS_KEY,
  normalizeLaneColumns,
  readPref,
  writePref,
} from "./layout-prefs";

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 1.8;
const clampZoom = (k: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(k * 100) / 100));
const FIT_PAD = 24;

const NODE_KIND_LABEL: Record<CanvasNodeKind, string> = {
  datasource: "数据源",
  source: "数据抽取",
  task: "任务",
};

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Hint {
  x: number;
  y: number;
  text: string;
  above: boolean;
}

/** 两次测量完全一致才复用对象：拖窗口每帧都换对象会让整张图重渲染 */
function sameBoxes(a: Record<string, Box>, b: Record<string, Box>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (
      !y ||
      Math.abs(x.x - y.x) > 0.5 ||
      Math.abs(x.y - y.y) > 0.5 ||
      Math.abs(x.w - y.w) > 0.5 ||
      Math.abs(x.h - y.h) > 0.5
    )
      return false;
  }
  return true;
}

interface Props {
  graph: TopologyGraph;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** 任务卡某一段：只切右侧属性栏，不开窗体 */
  onOpenStage: (node: GraphNode, stage: TaskStage) => void;
  /** 编辑入口（卡片操作行最左 / 双击） */
  onOpenEntity: (node: GraphNode) => void;
  onDeleteEntity: (node: GraphNode) => void;
  onTryTask: (node: GraphNode) => void;
  onToggleTask: (node: GraphNode, next: boolean) => void;
  onToggleExclusive: (node: GraphNode) => void;
  onToggleEntity: (node: GraphNode, next: boolean) => void;
  onTestDatasource: (node: GraphNode) => void;
  /** 数据抽取卡片的「立即拉取」 */
  onPullSource: (node: GraphNode) => void;
  testResults?: Record<string, DatasourceTestResult>;
  /** `${node.id}:${action}`，各动作各占一键，只做视觉提示不禁用按钮 */
  pendingKeys?: ReadonlySet<string>;
  /** 同泳道内拖动任务后的新顺序（完整 id 列表），落库由页面负责 */
  onReorderTasks?: (laneKey: string, orderedIds: string[]) => void;
  /** 组件栏新建入口：图头上的 + 复用同一组编辑器 */
  onAdd?: (kind: "datasource" | "source" | "task") => void;
  /** 外部要求把某张卡滚到视野内（警示条点节点） */
  focus?: { id: string; token: number } | null;
}

export function TopologyCanvas({
  graph,
  selectedId,
  onSelect,
  onOpenStage,
  onOpenEntity,
  onDeleteEntity,
  onTryTask,
  onToggleTask,
  onToggleExclusive,
  onToggleEntity,
  onTestDatasource,
  onPullSource,
  testResults,
  pendingKeys,
  onReorderTasks,
  onAdd,
  focus,
}: Props) {
  const model = useMemo<SwimlaneModel>(() => buildLanes(graph), [graph]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const rafRef = useRef(0);

  const [zoom, setZoom] = useState(1);
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ w: 0, h: 0 });
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [mapOpen, setMapOpen] = useState(true);
  const [hint, setHint] = useState<Hint | null>(null);

  /* -------------------------------- 列宽 -------------------------------- */

  /**
   * 三列的宽度。初值读 localStorage（脏值先被 `normalizeLaneColumns` 收一遍），
   * 拖动题头右侧的把手改，**松手才写回** —— 每帧写一次 localStorage 会拖慢拖拽。
   * 题头与网格共用同一个 `gridTemplate`，两边才不会错位（它们是两个独立的 grid）。
   */
  const [cols, setCols] = useState<number[]>(() =>
    normalizeLaneColumns(readPref(LANE_COLUMNS_KEY)),
  );
  const colsRef = useRef(cols);
  useEffect(() => {
    colsRef.current = cols;
  }, [cols]);

  /** 正在拖的列：起点、起始宽度、整份快照（按 Esc 要能整条退回） */
  const colDrag = useRef<{ index: number; startX: number; startW: number; snapshot: number[] } | null>(
    null,
  );
  const [resizingCol, setResizingCol] = useState<number | null>(null);

  const gridTemplate = cols.map((w) => `${w}px`).join(" ");

  const startColDrag = (index: number) => (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    colDrag.current = { index, startX: event.clientX, startW: cols[index], snapshot: cols };
    setResizingCol(index);
  };

  /** 双击把手：这一列回到默认宽度，其它列不动 */
  const resetCol = (index: number) => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const next = cols.map((w, i) => (i === index ? DEFAULT_LANE_COLUMNS[index] : w));
    setCols(next);
    writePref(LANE_COLUMNS_KEY, next);
  };

  useEffect(() => {
    if (resizingCol === null) return;
    const drag = colDrag.current;
    if (!drag) return;

    // 画布是布局级 zoom：指针走 N 个屏幕像素，网格只该长 N / zoom 个 CSS 像素
    const move = (event: PointerEvent) => {
      const width = clampLaneColumn(drag.index, drag.startW + (event.clientX - drag.startX) / zoomRef.current);
      setCols((prev) =>
        prev[drag.index] === width ? prev : prev.map((w, i) => (i === drag.index ? width : w)),
      );
    };
    const finish = (commit: boolean) => {
      colDrag.current = null;
      setResizingCol(null);
      if (commit) writePref(LANE_COLUMNS_KEY, colsRef.current);
      else setCols(drag.snapshot);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish(false);
    };
    // 拖列时整页都是「列宽光标」：否则指针一划过卡片就变 pointer，看着像拖不动
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    };
  }, [resizingCol]);

  /* -------------------------------- 悬停说明 -------------------------------- */

  /** 悬浮/聚焦时算一次视口坐标；气泡挂 body，字号与位置不受 zoom 影响 */
  const showHint = useCallback<HintHandler>((event, text) => {
    if (!event || !text) {
      setHint(null);
      return;
    }
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
    const above = cy > 96;
    setHint({ x: Math.max(200, Math.min(window.innerWidth - 200, cx)), y: above ? cy - 8 : cy + 8, text, above });
  }, []);

  // 请求开始后指针可能已离开卡片（气泡残留），主动收掉
  useEffect(() => {
    if (pendingKeys?.size) setHint(null);
  }, [pendingKeys]);

  /* -------------------------------- 测量坐标 -------------------------------- */

  const measureNow = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const k = zoomRef.current;
    const base = wrap.getBoundingClientRect();
    const next: Record<string, Box> = {};
    let maxX = 0;
    let maxY = 0;
    wrap.querySelectorAll<HTMLElement>("[data-node]").forEach((el) => {
      const r = el.getBoundingClientRect();
      const box: Box = {
        x: (r.left - base.left) / k,
        y: (r.top - base.top) / k,
        w: r.width / k,
        h: r.height / k,
      };
      next[el.dataset.node as string] = box;
      maxX = Math.max(maxX, box.x + box.w);
      maxY = Math.max(maxY, box.y + box.h);
    });
    setBoxes((prev) => (sameBoxes(prev, next) ? prev : next));
    const w = maxX + 1;
    const h = maxY + 1;
    setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
  }, []);

  const measureRaf = useRef(0);
  const measure = useCallback(() => {
    if (measureRaf.current) return;
    measureRaf.current = requestAnimationFrame(() => {
      measureRaf.current = 0;
      measureNow();
    });
  }, [measureNow]);

  const measureView = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setView({ w: el.clientWidth, h: el.clientHeight });
  }, []);

  useLayoutEffect(() => {
    measureNow();
    measureView();
    const id = requestAnimationFrame(() => {
      measureNow();
      measureView();
    });
    const wrap = wrapRef.current;
    const el = scrollRef.current;
    const ro = new ResizeObserver(measure);
    const roView = new ResizeObserver(measureView);
    if (wrap) ro.observe(wrap);
    if (el) roView.observe(el);
    void document.fonts?.ready.then(() => measure());
    return () => {
      cancelAnimationFrame(id);
      ro.disconnect();
      roView.disconnect();
    };
  }, [measure, measureNow, measureView, model]);

  useLayoutEffect(() => {
    zoomRef.current = zoom;
    measureNow();
    measureView();
  }, [zoom, measureNow, measureView]);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      cancelAnimationFrame(measureRaf.current);
    },
    [],
  );

  const onScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = scrollRef.current;
      if (el) setScroll({ left: el.scrollLeft, top: el.scrollTop });
    });
  }, []);

  /* -------------------------------- 连线 -------------------------------- */

  const edges = useMemo(() => {
    return graph.edges.flatMap((edge, i) => {
      const a = boxes[edge.from];
      const b = boxes[edge.to];
      if (!a || !b) return [];
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      const y2 = b.y + b.h / 2;
      const dx = Math.max(18, Math.abs(x2 - x1) / 2);
      return [
        {
          key: edge.id,
          muted: edge.muted,
          d: `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`,
          delay: `${(-((i * 0.47) % 2.6)).toFixed(2)}s`,
        },
      ];
    });
  }, [graph.edges, boxes]);

  /* -------------------------------- 任务重排 -------------------------------- */

  const [drag, setDrag] = useState<{ laneKey: string; taskId: string; slot: number } | null>(null);
  const dragRef = useRef<{
    laneKey: string;
    taskId: string;
    fromIndex: number;
    slot: number;
  } | null>(null);

  const onGripDown = (lane: Lane, taskId: string) => (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const fromIndex = lane.tasks.findIndex((n) => n.task?.id === taskId);
    if (fromIndex < 0) return;
    dragRef.current = { laneKey: lane.key, taskId, fromIndex, slot: fromIndex };
    setDrag({ laneKey: lane.key, taskId, slot: fromIndex });
  };

  useEffect(() => {
    if (!drag) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const lane = model.lanes.find((l) => l.key === dragRef.current?.laneKey);
    if (!lane) return;

    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const y = (e.clientY - wrap.getBoundingClientRect().top) / zoomRef.current;
      let slot = lane.tasks.length;
      for (let i = 0; i < lane.tasks.length; i++) {
        const box = boxes[nodeId("task", lane.tasks[i].key)];
        if (box && y < box.y + box.h / 2) {
          slot = i;
          break;
        }
      }
      if (slot === d.slot) return;
      d.slot = slot;
      setDrag({ laneKey: d.laneKey, taskId: d.taskId, slot });
    };

    const finish = (commit: boolean) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!commit || !d || !onReorderTasks) return;
      const to = d.slot > d.fromIndex ? d.slot - 1 : d.slot;
      if (to === d.fromIndex) return;
      const ids = lane.tasks.map((n) => n.task!.id).filter((id) => id !== d.taskId);
      ids.splice(to, 0, d.taskId);
      onReorderTasks(d.laneKey, ids);
    };

    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    };
  }, [drag, model, boxes, onReorderTasks]);

  const dropLine = useMemo(() => {
    if (!drag) return null;
    const lane = model.lanes.find((l) => l.key === drag.laneKey);
    if (!lane || lane.tasks.length === 0) return null;
    const first = boxes[nodeId("task", lane.tasks[0].key)];
    if (!first) return null;
    const target = lane.tasks[drag.slot];
    const box = target ? boxes[nodeId("task", target.key)] : undefined;
    const last = boxes[nodeId("task", lane.tasks[lane.tasks.length - 1].key)];
    const y = box ? box.y - 5 : (last?.y ?? 0) + (last?.h ?? 0) + 5;
    return { x: first.x, w: first.w, y };
  }, [drag, model, boxes]);

  /* -------------------------------- 缩放 / 定位 -------------------------------- */

  const fit = () => {
    const el = scrollRef.current;
    if (!el || !size.w) return;
    setZoom(
      clampZoom(Math.min(1, Math.min((el.clientWidth - FIT_PAD * 2) / size.w, (el.clientHeight - FIT_PAD * 2) / size.h))),
    );
  };

  const jump = (left: number, top: number) => scrollRef.current?.scrollTo({ left, top, behavior: "smooth" });

  const lastFocusToken = useRef(0);
  useEffect(() => {
    if (!focus || focus.token === lastFocusToken.current) return;
    lastFocusToken.current = focus.token;
    const box = boxes[focus.id];
    if (!box) return;
    jump(box.x * zoom - view.w / 2 + box.w * zoom / 2, box.y * zoom - view.h / 2 + box.h * zoom / 2);
  }, [focus, boxes, zoom, view.w, view.h]);

  const isEmpty = graph.nodes.length === 0;

  /**
   * 题头：文字截断 + 可选的新建按钮 + 右缘的列宽把手。
   * 把手挂在**自己这一列的右缘**，拖它就改自己——不牵连相邻列，四列各有一条，
   * 位置彼此不重叠（都落在 40px 的列间距里）。
   */
  const columnHead = (
    index: number,
    label: string,
    name: string,
    addKind?: "datasource" | "source" | "task",
  ) => (
    <div className="tl-h">
      <span className="tl-h-text">{label}</span>
      {onAdd && addKind && (
        <button
          type="button"
          className="tl-h-add"
          title={`新建${NODE_KIND_LABEL[addKind]}`}
          aria-label={`新建${NODE_KIND_LABEL[addKind]}`}
          onClick={() => onAdd(addKind)}
        >
          <Plus size={11} />
        </button>
      )}
      <button
        type="button"
        className={cn("tl-colgrip", resizingCol === index && "on")}
        title={`${name}列宽 ${cols[index]}px · 拖动调整，双击复位`}
        aria-label={`拖动调整「${name}」列宽，双击复位`}
        onPointerDown={startColDrag(index)}
        onDoubleClick={resetCol(index)}
        // 点把手别把画布的「点空白清选中」带出来：拖完还会补一个 click
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );

  /* -------------------------------- 渲染 -------------------------------- */

  const cell = (
    node: GraphNode,
    row: number,
    col: number,
    extra?: string,
    gripDown?: (e: React.PointerEvent<HTMLButtonElement>) => void,
    rowSpan?: number,
  ) => (
    <div
      key={node.id}
      data-node={node.id}
      className={cn("tl-cell", `tl-cell-${node.kind}`, extra)}
      style={{ gridRow: rowSpan && rowSpan > 1 ? `${row} / span ${rowSpan}` : row, gridColumn: col }}
      tabIndex={0}
      role="button"
      aria-label={`${NODE_KIND_LABEL[node.kind]} ${node.title}，回车查看属性，双击编辑`}
      aria-pressed={node.id === selectedId}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(node.id);
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("button, input, [role='switch'], [data-no-drag]")) return;
        e.stopPropagation();
        onSelect(node.id);
        onOpenEntity(node);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onSelect(node.id);
      }}
    >
      {node.kind === "task" ? (
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
          onToggleEnabled={(next) => {
            onSelect(node.id);
            onToggleTask(node, next);
          }}
          onToggleExclusive={() => {
            onSelect(node.id);
            onToggleExclusive(node);
          }}
          onGripDown={gripDown}
          onHint={showHint}
          enabledBusy={pendingKeys?.has(`${node.id}:enabled`)}
          exclusiveBusy={pendingKeys?.has(`${node.id}:exclusive`)}
        />
      ) : (
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
          onTest={
            node.kind === "datasource"
              ? () => {
                  onSelect(node.id);
                  onTestDatasource(node);
                }
              : undefined
          }
          onPull={
            node.kind === "source"
              ? () => {
                  onSelect(node.id);
                  onPullSource(node);
                }
              : undefined
          }
          test={testResults?.[node.id]}
          testBusy={pendingKeys?.has(`${node.id}:test`)}
          pullBusy={pendingKeys?.has(`${node.id}:pull`)}
          enabledBusy={pendingKeys?.has(`${node.id}:enabled`)}
          onHint={showHint}
        />
      )}
    </div>
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onClick={() => {
          onSelect(null);
          setHint(null);
        }}
        className="tl-scroll"
      >
        <div className="tl-stage" style={{ zoom, width: view.w || undefined }}>
          <div className="tl-head" style={{ gridTemplateColumns: gridTemplate }}>
            {columnHead(0, "数据源", "数据源", "datasource")}
            {columnHead(1, "数据抽取 · 按 topic 直连任务", "数据抽取", "source")}
            {columnHead(2, "任务 · 按匹配顺序，命中即停（可拖动排序）", "任务", "task")}
          </div>

          <div className={cn("tl-wrap", drag && "dragging")} ref={wrapRef}>
            <svg className="tl-edges" width={size.w} height={size.h} aria-hidden>
              <defs>
                {(["neutral", "bad"] as const).map((tone) => (
                  <marker
                    key={tone}
                    id={`tl-arrow-${tone}`}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M1.5 1.5 8.5 5 1.5 8.5Z" className={cn("tl-arrow", tone)} />
                  </marker>
                ))}
              </defs>
              {edges.map((edge) => (
                <g key={edge.key}>
                  <path
                    d={edge.d}
                    className={cn("tl-edge", edge.muted && "muted")}
                    markerEnd={`url(#tl-arrow-${edge.muted ? "bad" : "neutral"})`}
                  />
                  {!edge.muted && (
                    <path d={edge.d} className="tl-flow" style={{ animationDelay: edge.delay }} />
                  )}
                </g>
              ))}
            </svg>

            {dropLine && (
              <div className="tl-dropline" style={{ left: dropLine.x, top: dropLine.y, width: dropLine.w }} aria-hidden />
            )}

            <div
              className="tl-grid"
              style={{ gridTemplateColumns: gridTemplate, gridTemplateRows: `repeat(${model.rows}, auto)` }}
            >
              {model.lanes.map((lane, laneIndex) => (
                <Fragment key={lane.key}>
                  {/* 数据源：全局去重，落在第一条引用它的抽取那一行 */}
                  {model.datasources
                    .filter((slot) => {
                      const row = slot.row;
                      return row >= lane.startRow && row < lane.startRow + lane.rowCount;
                    })
                    .map((slot) => cell(slot.node, slot.row, 1, cn("tl-cell-ds", slot.refs > 1 && "shared")))}

                  {lane.sources.map((node, i) => cell(node, lane.startRow + i, 2))}
                  {lane.tasks.map((node, i) =>
                    cell(
                      node,
                      lane.startRow + i,
                      3,
                      drag?.taskId === node.task?.id ? "dragging" : undefined,
                      onReorderTasks ? onGripDown(lane, node.task!.id) : undefined,
                    ),
                  )}

                  {laneIndex < model.lanes.length - 1 && lane.key !== ORPHAN_LANE && (
                    <div className="tl-spacer" style={{ gridRow: lane.startRow + lane.rowCount, gridColumn: "1 / -1" }} />
                  )}
                </Fragment>
              ))}
            </div>
          </div>
        </div>
      </div>

      {isEmpty && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
          <p className="text-[13px] font-medium text-ink">还没有可画的东西</p>
          <p className="max-w-[380px] text-[12px] leading-relaxed text-muted">
            先到「数据源」登记连接、到「数据抽取」登记拉取规则、或到「同步任务」新建任务，泳道会自动长出来。
          </p>
        </div>
      )}

      {hint &&
        createPortal(
          <div
            role="tooltip"
            className="tl-hint"
            style={{
              left: hint.x,
              top: hint.y,
              transform: hint.above ? "translate(-50%, -100%)" : "translate(-50%, 0)",
            }}
          >
            {hint.text}
          </div>,
          document.body,
        )}

      <div className="tl-dock">
        {mapOpen && (
          <div className="tl-map" title="点一下跳到那里">
            <button className="tl-map-x" onClick={() => setMapOpen(false)} title="收起预览图" aria-label="收起预览图">
              ×
            </button>
            <MiniMap
              boxes={boxes}
              size={size}
              view={view}
              scroll={scroll}
              zoom={zoom}
              onJump={jump}
            />
          </div>
        )}
        <div className="tl-zoomctl">
          <button onClick={() => setZoom((k) => clampZoom(k - 0.1))} title="缩小" aria-label="缩小">
            <Minus size={11} />
          </button>
          <button className="pct" onClick={() => setZoom(1)} title="回到 100%">
            {Math.round(zoom * 100)}%
          </button>
          <button onClick={() => setZoom((k) => clampZoom(k + 0.1))} title="放大" aria-label="放大">
            <Plus size={11} />
          </button>
          <span className="sep" />
          <button onClick={fit} title="缩到能看见整张图" aria-label="缩到能看见整张图">
            <Maximize2 size={11} />
          </button>
          {selectedId && (
            <button
              className="accent"
              onClick={() => {
                const box = boxes[selectedId];
                if (box) jump(box.x * zoom - view.w / 2 + box.w * zoom / 2, box.y * zoom - view.h / 2 + box.h * zoom / 2);
              }}
              title="把选中的卡片移到画布正中"
              aria-label="定位到选中卡片"
            >
              <Crosshair size={11} />
            </button>
          )}
          <button
            className={cn(mapOpen && "on")}
            onClick={() => setMapOpen((v) => !v)}
            title={mapOpen ? "收起预览图" : "展开预览图"}
            aria-label={mapOpen ? "收起预览图" : "展开预览图"}
          >
            <span className="tl-map-ico" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 预览图 */

const MAP_W = 156;
const MAP_H = 104;

const MAP_TONE: Record<CanvasNodeKind, string> = {
  datasource: "ds",
  source: "src",
  task: "task",
};

function MiniMap({
  boxes,
  size,
  view,
  scroll,
  zoom,
  onJump,
}: {
  boxes: Record<string, Box>;
  size: { w: number; h: number };
  view: { w: number; h: number };
  scroll: { left: number; top: number };
  zoom: number;
  onJump: (left: number, top: number) => void;
}) {
  const s = size.w > 0 && size.h > 0 ? Math.min(MAP_W / size.w, MAP_H / size.h) : 0;
  if (s <= 0) return null;
  const mw = Math.max(24, size.w * s);
  const mh = Math.max(18, size.h * s);
  const kindOf = (key: string): CanvasNodeKind => {
    const head = key.split(":")[0];
    return (head === "datasource" || head === "source" || head === "task"
      ? head
      : "task") as CanvasNodeKind;
  };
  const jump = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const cx = ((e.clientX - r.left) / s) * zoom;
    const cy = ((e.clientY - r.top) / s) * zoom;
    onJump(cx - view.w / 2, cy - view.h / 2);
  };
  return (
    <svg width={mw} height={mh} onClick={jump} role="presentation">
      {Object.entries(boxes).map(([key, b]) => (
        <rect
          key={key}
          x={b.x * s}
          y={b.y * s}
          width={Math.max(1.5, b.w * s)}
          height={Math.max(1.5, b.h * s)}
          rx={1}
          className={cn("tl-map-n", MAP_TONE[kindOf(key)])}
        />
      ))}
      <rect
        className="tl-map-vp"
        x={(scroll.left / zoom) * s}
        y={(scroll.top / zoom) * s}
        width={Math.max(6, (view.w / zoom) * s)}
        height={Math.max(6, (view.h / zoom) * s)}
        rx={1.5}
      />
    </svg>
  );
}

export { nodeId };
