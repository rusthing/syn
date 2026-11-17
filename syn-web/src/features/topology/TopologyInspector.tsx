/**
 * # 控制面板 · 右侧属性栏
 *
 * **只读**。这里不放任何操作 —— 没有开关、没有「编辑配置」按钮。启用在卡片右上角，
 * 编辑/删除/测试在卡片的状态栏下面，两处入口会把同一件事拆成两条路径：用户在这里
 * 关掉、在那里又打开，到最后没人说得清是哪一次生效（dbz 控制面板就是这么定的）。
 *
 * 两种视图，靠 `stage` 切换：
 * - **节点概览**（`stage == null`）：这个节点是什么、现在什么状态、有哪些问题；
 * - **某一段的详情**（`stage != null`，只有任务有）：点卡片上的第 N 段就到这里来，
 *   把那一段的配置按「读得懂的一句话」摊开 —— 不再点一下就弹一个占满屏幕的窗体。
 *
 * 数据全部来自 `GraphNode`（图是从三张业务表现拼的），可视化层不另存一份状态，
 * 所以属性栏不可能和画布不一致。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  MousePointerClick,
  PanelRightClose,
  PanelRightOpen,
  TriangleAlert,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { formatDateTime, formatRelative } from "@/lib/time";
import type { DatasourceTestResult, MappingRow, TaskSpec } from "@/lib/api/types";
import { conditionText, ruleSummary, verdictRules } from "@/lib/spec/rules";
import { analyzeRules } from "@/lib/spec/analyze";
import { verdictMeta } from "@/lib/spec/defaults";
import { targetDetail, targetSummary, type GraphNode, type TaskSegment, type TaskStage } from "./graph";
import {
  clampInspectorWidth,
  DEFAULT_INSPECTOR_WIDTH,
  INSPECTOR_KEY,
  normalizeInspectorPrefs,
  readPref,
  writePref,
} from "./layout-prefs";

const KIND_LABEL: Record<GraphNode["kind"], string> = {
  datasource: "数据源",
  source: "数据抽取",
  topic: "主题（虚拟节点）",
  task: "同步任务",
};

const TONE_BADGE: Record<GraphNode["tone"], "success" | "warn" | "danger" | "muted"> = {
  ok: "success",
  warn: "warn",
  bad: "danger",
  muted: "muted",
};

const STAGE_TITLE: Record<TaskStage, string> = {
  match: "匹配",
  mapping: "映射",
  guards: "校验",
  actions: "动作",
  target: "投递",
  outcomes: "判定",
};

function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line/60 py-[7px] last:border-0">
      <span className="shrink-0 pt-px text-[11.5px] text-muted">{label}</span>
      <span
        className={cn(
          "min-w-0 break-all text-right text-[12.5px] text-ink",
          mono && "font-mono text-[11.5px] leading-[18px]",
        )}
      >
        {children}
      </span>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="text-[11.5px] font-medium tracking-wide text-muted">{title}</h3>
      {hint && <p className="mb-1 mt-0.5 text-[11.5px] leading-snug text-muted">{hint}</p>}
      <div className="mt-1 rounded-lg border border-line bg-canvas/60 px-2.5 py-0.5">{children}</div>
    </section>
  );
}

/** 只读的一行配置：左边是「说什么」，右边是「说什么内容」，长内容自动折行 */
function Line({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2 border-b border-line/50 py-1.5 last:border-0">
      <span className="shrink-0 text-[11.5px] text-ink-soft">{label}</span>
      <span
        className={cn(
          "ml-auto min-w-0 break-all text-right text-[11.5px] leading-[18px] text-ink",
          mono && "font-mono text-[11.5px]",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <p className="py-2 text-[11.5px] leading-relaxed text-muted">{text}</p>;
}

/* ------------------------------ 段详情 ------------------------------ */

/** 条件数组逐条摊开：顶层是「并且」，分组交给 `conditionText` 递归 */
function ConditionList({
  conds,
  fallback,
  empty,
}: {
  conds: NonNullable<TaskSpec["match"]>;
  fallback: "record" | "body";
  empty: string;
}) {
  if (conds.length === 0) return <EmptyLine text={empty} />;
  return (
    <div className="py-0.5">
      {conds.map((c, i) => (
        <div key={i} className="flex items-start gap-2 py-1">
          <span className="mt-0.5 shrink-0 rounded bg-sunken px-1 font-mono text-[11px] text-muted">
            {i + 1}
          </span>
          <span className="min-w-0 break-words font-mono text-[11.5px] leading-[18px] text-ink">
            {conditionText([c], fallback)}
          </span>
        </div>
      ))}
    </div>
  );
}

function mappingSource(row: MappingRow): string {
  if (row.const !== undefined) return JSON.stringify(row.const);
  const from = row.from ?? "";
  const fn = row.fn?.length ? ` · ${row.fn.join(" → ")}` : "";
  const empty = row.on_empty && row.on_empty !== "keep" ? ` · 空值 ${row.on_empty}` : "";
  return `${from || "（未填）"}${fn}${empty}`;
}

function StageDetail({ spec, stage }: { spec: TaskSpec; stage: TaskStage }) {
  switch (stage) {
    case "match":
      return (
        <>
          <p className="text-[11.5px] leading-relaxed text-muted">
            回答「这条记录归不归我管」。全部条件满足才算命中；要表达「或」用分组，分组可嵌套。
          </p>
          <Section title={`条件 · ${spec.match?.length ?? 0} 条`}>
            <ConditionList
              conds={spec.match ?? []}
              fallback="record"
              empty="没有条件：这个主题的所有记录都归本任务。"
            />
          </Section>
        </>
      );

    case "mapping":
      return (
        <>
          <p className="text-[11.5px] leading-relaxed text-muted">
            记录 → 请求体，逐行取字段。没有分支：按来源分变体应该上移到匹配段拆成任务。
          </p>
          <Section title={`字段 · ${spec.mapping?.rows?.length ?? 0} 行`}>
            {(spec.mapping?.rows?.length ?? 0) === 0 ? (
              <EmptyLine text="还没有映射行：请求体会是空的。" />
            ) : (
              <div className="py-0.5">
                {spec.mapping.rows.map((row, i) => (
                  <div key={i} className="flex items-start gap-2 border-b border-line/50 py-1.5 last:border-0">
                    <span className="shrink-0 font-mono text-[11.5px] text-ink">{row.to}</span>
                    <span className="ml-auto min-w-0 break-all text-right font-mono text-[11.5px] text-muted">
                      {mappingSource(row)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>
          <Section title="空值">
            <Row label="来源为 null">
              {(() => {
                const rows = spec.mapping?.rows ?? [];
                const keep = rows.filter((row) => row.on_null === "keep").length;
                const fb = rows.filter((row) => row.on_null === "fallback").length;
                const parts: string[] = [];
                if (keep > 0) parts.push(`${keep} 行写 null`);
                if (fb > 0) parts.push(`${fb} 行兜底默认值`);
                return parts.length > 0 ? `${parts.join("，")}，其余省略` : "全部省略";
              })()}
            </Row>
          </Section>
        </>
      );

    case "guards":
      return (
        <>
          <p className="text-[11.5px] leading-relaxed text-muted">
            发送前的最后一道闸：只回答「能不能发」。看干净报文请把作用域选成 body。
          </p>
          {(spec.guards?.length ?? 0) === 0 ? (
            <Section title="校验 · 0 条">
              <EmptyLine text="没有校验：映射完的报文会直接发出去。" />
            </Section>
          ) : (
            (spec.guards ?? []).map((guard, i) => (
              <Section key={i} title={`校验 ${i + 1}`}>
                <div className="py-0.5">
                  {guard.when && (
                    <Line
                      label="仅当"
                      value={conditionText([guard.when], "body") || "—"}
                      mono
                    />
                  )}
                  {guard.assert.length === 0 ? (
                    <EmptyLine text="没有断言。" />
                  ) : (
                    guard.assert.map((c, j) => (
                      <Line key={j} label={`条件 ${j + 1}`} value={conditionText([c], "body")} mono />
                    ))
                  )}
                  <Line
                    label="不通过"
                    value={`${verdictMeta(guard.on_fail.verdict).label}${guard.on_fail.code ? ` · ${guard.on_fail.code}` : ""}`}
                  />
                  {guard.on_fail.message && <Line label="说明" value={guard.on_fail.message} />}
                </div>
              </Section>
            ))
          )}
        </>
      );

    case "actions":
      return (
        <>
          <p className="text-[11.5px] leading-relaxed text-muted">
            一个动作 = 一次 HTTP 调用。路径相对投递段的 base。
          </p>
          {(spec.actions?.length ?? 0) === 0 ? (
            <Section title="动作 · 0 个">
              <EmptyLine text="没有动作：这条任务不会被投递。" />
            </Section>
          ) : (
            (spec.actions ?? []).map((action, i) => (
              <Section key={i} title={`动作 ${i + 1} · ${action.op}`}>
                <div className="py-0.5">
                  <Line label="请求" value={`${action.method} ${action.path || "（相对 base）"}`} mono />
                  <Line label="请求体" value={action.body ?? "mapped"} />
                  <Line label="查询参数" value={action.query?.length ? `${action.query.length} 个` : "无"} />
                  <Line label="请求头" value={action.headers?.length ? `${action.headers.length} 个` : "无"} />
                </div>
              </Section>
            ))
          )}
        </>
      );

    case "target": {
      const target = spec.target;
      return (
        <>
          <p className="text-[11.5px] leading-relaxed text-muted">
            投递在判定之前：判定段看到的就是这一步的响应（HTTP 的回复 / 库的{" "}
            <code className="font-mono">{"{affected:n}"}</code>）。
          </p>
          {target.kind === "db" ? (
            <Section title="直写库表">
              <Row label="数据源" mono>
                {target.datasource || "（未选）"}
              </Row>
              <Row label="目标表" mono>
                {target.table || "（未填）"}
              </Row>
              <Row label="冲突键" mono>
                {target.key?.join(", ") || "（无）"}
              </Row>
              <Row label="冲突处理">{target.on_conflict ?? "update"}</Row>
            </Section>
          ) : (
            <Section title="HTTP">
              <Row label="目标服务" mono>
                {target.service || "（未填）"}
              </Row>
              <Row label="路径前缀" mono>
                {target.base || "（未填）"}
              </Row>
            </Section>
          )}
          <Section title="一句话">
            <Row label="目标">{targetSummary(spec)}</Row>
            <Row label="细节" mono>
              {targetDetail(spec)}
            </Row>
          </Section>
        </>
      );
    }

    case "outcomes": {
      const rules = verdictRules(spec);
      const analysis = analyzeRules(rules);
      return (
        <>
          <p className="text-[11.5px] leading-relaxed text-muted">
            自上而下执行，首个命中即返回。每个分支体必须以「必然给出结论」的语句收尾，
            否则会按 <code className="font-mono">UNCLASSIFIED</code> 致命处理。
          </p>
          <Section title={`语句 · ${rules.length} 条`} hint="顺序就是优先级">
            {rules.length === 0 ? (
              <EmptyLine text="还没有判定语句：任何响应都会被当成 UNCLASSIFIED。" />
            ) : (
              <div className="py-0.5">
                {rules.map((rule, i) => (
                  <div key={i} className="flex items-start gap-2 border-b border-line/50 py-1.5 last:border-0">
                    <span className="mt-0.5 shrink-0 rounded bg-sunken px-1 font-mono text-[11px] text-muted">
                      {i + 1}
                    </span>
                    <span className="min-w-0 break-words font-mono text-[11.5px] leading-[18px] text-ink">
                      {ruleSummary(rule)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>
          <Section
            title="静态检查"
            hint="只报能算准的：推不出来的组合标成「无法判定」，不猜"
          >
            {analysis.findings.length === 0 ? (
              <EmptyLine text="没有发现问题。" />
            ) : (
              <div className="py-0.5">
                {analysis.findings.slice(0, 8).map((f, i) => (
                  <p
                    key={i}
                    className={cn(
                      "flex items-start gap-1.5 px-0.5 py-1 text-[11.5px] leading-relaxed",
                      f.severity === "error" ? "text-danger" : "text-warn",
                    )}
                  >
                    <TriangleAlert className="mt-px size-3 shrink-0" />
                    {f.message}
                  </p>
                ))}
                {analysis.findings.length > 8 && (
                  <p className="px-0.5 py-1 text-[11.5px] text-muted">
                    还有 {analysis.findings.length - 8} 条，打开编辑器的「全貌」看全部
                  </p>
                )}
              </div>
            )}
          </Section>
        </>
      );
    }
  }
}

/* ------------------------------ 面板 ------------------------------ */

interface Props {
  node: GraphNode | null;
  /** 选中的段（只有任务有）；非空时显示段详情 */
  stage: TaskStage | null;
  onSelectStage: (stage: TaskStage | null) => void;
  onClose: () => void;
  /** 该数据源最近一次的连接测试结果（由页面持有，卡片与属性栏共用） */
  test?: DatasourceTestResult | null;
  /** 空态里显示图的规模：直接用页面已有的统计，不另发请求 */
  summary?: {
    nodes: number;
    edges: number;
    tasks: number;
    sources: number;
    datasources: number;
  };
}

export function TopologyInspector({ node, stage, onSelectStage, onClose, test, summary }: Props) {
  const detail = node?.task && stage ? stage : null;

  /* --------------------------- 宽度与收起 / 展开 --------------------------- */

  /**
   * 宽度和「收起」都是本机习惯，只写 localStorage（见 `layout-prefs.ts`）：
   * 概览在 292px 里够用，一条长连接串或六段条件就不够；想临时把画布铺满时又要能收掉。
   */
  const [prefs, setPrefs] = useState(() => normalizeInspectorPrefs(readPref(INSPECTOR_KEY)));
  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  const [dragging, setDragging] = useState(false);
  /** 起点、起始宽度、原始宽度（按 Esc 退回） */
  const drag = useRef<{ startX: number; startW: number; snapshot: number } | null>(null);

  /** 一次改两件（宽度 / 收起）都得落盘，写在一个入口里免得漏 */
  const persist = (next: typeof prefs) => {
    setPrefs(next);
    writePref(INSPECTOR_KEY, next);
  };

  const toggleCollapsed = () => persist({ ...prefs, collapsed: !prefs.collapsed });

  /** 双击左缘把手：宽度回默认，收起状态不动 */
  const resetWidth = () => persist({ ...prefs, width: DEFAULT_INSPECTOR_WIDTH });

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    drag.current = { startX: event.clientX, startW: prefs.width, snapshot: prefs.width };
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const start = drag.current;
    if (!start) return;

    // 往左拖 = 变宽（属性栏在右边，抓的是它的左缘）
    const move = (event: PointerEvent) => {
      const width = clampInspectorWidth(start.startW + (start.startX - event.clientX));
      setPrefs((prev) => (prev.width === width ? prev : { ...prev, width }));
    };
    const finish = (commit: boolean) => {
      drag.current = null;
      setDragging(false);
      if (commit) writePref(INSPECTOR_KEY, prefsRef.current);
      else setPrefs((prev) => ({ ...prev, width: start.snapshot }));
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish(false);
    };
    // 拖动期间整页锁定成列宽光标，否则光标一进内容区就变 pointer
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
  }, [dragging]);

  /**
   * 收起时留一条窄轨，而不是整块消失：消失之后没人知道它去哪了。
   * 窄轨本身就是重新展开的按钮，收起状态也记在 localStorage。
   */
  if (prefs.collapsed) {
    return (
      <button
        type="button"
        onClick={toggleCollapsed}
        title="展开属性栏"
        aria-label="展开属性栏"
        className="flex w-8 shrink-0 flex-col items-center justify-center gap-2.5 rounded-[14px] border border-line bg-surface text-muted transition-colors hover:border-line-strong hover:text-accent"
      >
        <PanelRightOpen className="size-3.5" />
        <span className="text-[11.5px] tracking-wide [writing-mode:vertical-rl]">属性</span>
      </button>
    );
  }

  return (
    <div className="relative flex min-h-0 shrink-0">
      {/* 左缘把手坐在 10px 的列间距里，不压画布内容 */}
      <button
        type="button"
        className={cn("tl-panel-grip", dragging && "on")}
        title={`拖动调整属性栏宽度（当前 ${prefs.width}px，双击复位）`}
        aria-label="拖动调整属性栏宽度，双击复位"
        onPointerDown={startResize}
        onDoubleClick={resetWidth}
        onClick={(event) => event.stopPropagation()}
      />
      <aside
        style={{ width: prefs.width }}
        className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[14px] border border-line bg-surface"
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-1.5">
            {detail ? (
              <button
                type="button"
                onClick={() => onSelectStage(null)}
                className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[12.5px] font-medium text-ink-soft hover:bg-sunken hover:text-ink"
              >
                <ArrowLeft className="size-3.5" />
                返回
              </button>
            ) : (
              <MousePointerClick className="size-3.5 text-accent" />
            )}
            <span className="truncate text-[12.5px] font-semibold text-ink">
              {detail ? `${STAGE_TITLE[detail]} · 详情` : "属性"}
            </span>
            {node && !detail && <span className="text-[11.5px] text-muted">· {KIND_LABEL[node.kind]}</span>}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <IconButton label="收起属性栏" onClick={toggleCollapsed}>
              <PanelRightClose className="size-3.5" />
            </IconButton>
            {node && (
              <IconButton label="关闭属性栏" onClick={onClose}>
                <X className="size-3.5" />
              </IconButton>
            )}
          </div>
        </header>

      {!node ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          {/* 空态不是留白，而是把「怎么用 / 图上有什么」一次讲清；这里只读，不放任何操作 */}
          <div className="flex flex-col items-center gap-2 px-3 py-5 text-center">
            <span className="flex size-9 items-center justify-center rounded-full bg-accent-soft text-accent">
              <MousePointerClick className="size-4" />
            </span>
            <p className="text-[13.5px] font-semibold text-ink">还没有选中节点</p>
            <p className="text-[11.5px] leading-relaxed text-muted">
              画布随窗口大小自动适应；单击卡片只看属性、不改视角。拖动卡片可摆位，滚轮缩放、拖空白平移。
            </p>
          </div>

          <Section title="怎么用">
            <ul className="space-y-2 py-2 text-[11.5px] leading-relaxed text-ink-soft">
              {[
                "卡片右上角的开关：启用 / 停用，改完下一拍生效。",
                "卡片最下面的操作行：编辑、测试连接 / 试跑、删除。",
                "任务卡的六段：点一段，这里换成那一段的只读详情。",
                "这一栏左缘可拖宽窄；标题栏右侧的收起按钮把它收成窄轨，点窄轨再展开 —— 宽窄和收起都记在本机。",
                "右下角「全图」看整张拓扑；窗口变化会自动重排，滚轮或点百分比放大看细节。",
              ].map((text, i) => (
                <li key={text} className="flex items-start gap-2">
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-accent-soft font-mono text-[11px] text-accent-strong">
                    {i + 1}
                  </span>
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="四类节点">
            <div className="py-2">
              {[
                { label: "数据源", dot: "bg-info", text: "连接配置" },
                { label: "数据抽取", dot: "bg-violet", text: "周期取数" },
                { label: "主题", dot: "bg-line-strong", text: "虚拟节点，自动生成" },
                { label: "任务", dot: "bg-accent", text: "六段流水线" },
              ].map((item) => (
                <div key={item.label} className="flex items-center gap-2 py-1 text-[11.5px]">
                  <span className={cn("size-2 shrink-0 rounded-full", item.dot)} />
                  <span className="shrink-0 font-medium text-ink">{item.label}</span>
                  <span className="truncate text-muted">{item.text}</span>
                </div>
              ))}
            </div>
          </Section>

          {summary && (
            <Section title="当前这张图">
              <Row label="节点 / 连线">
                {summary.nodes} / {summary.edges}
              </Row>
              <Row label="任务 / 来源 / 数据源">
                {summary.tasks} / {summary.sources} / {summary.datasources}
              </Row>
              <p className="py-2 text-[11.5px] leading-relaxed text-muted">
                虚线表示下游已停用，这条链此刻不会真的走。
              </p>
            </Section>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {detail ? (
            <div className="pt-3">
              <h2 className="text-[13.5px] font-semibold leading-snug text-ink">{node.title}</h2>
              <p className="mt-0.5 text-[11.5px] text-muted">
                第 {["match", "mapping", "guards", "actions", "target", "outcomes"].indexOf(detail) + 1} 段 ·{" "}
                {STAGE_TITLE[detail]}
              </p>
              <div className="mt-2">{node.task && <StageDetail spec={node.task.spec} stage={detail} />}</div>
            </div>
          ) : (
            <>
              <div className="pt-3">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="min-w-0 break-words text-[14.5px] font-semibold leading-snug text-ink">
                    {node.title}
                  </h2>
                  <Badge tone={TONE_BADGE[node.tone]} dot>
                    {node.status}
                  </Badge>
                </div>
                <p className="mt-1 break-all font-mono text-[11.5px] leading-relaxed text-muted">
                  {node.subtitle}
                </p>
              </div>

              {(node.issues.length > 0 || node.hints.length > 0) && (
                <div className="mt-3 space-y-1.5">
                  {node.issues.map((text) => (
                    <p
                      key={text}
                      className="flex items-start gap-1.5 rounded-md bg-danger-soft px-2 py-1.5 text-[11.5px] leading-relaxed text-danger"
                    >
                      <TriangleAlert className="mt-px size-3 shrink-0" />
                      {text}
                    </p>
                  ))}
                  {node.hints.map((text) => (
                    <p
                      key={text}
                      className="rounded-md bg-warn-soft px-2 py-1.5 text-[11.5px] leading-relaxed text-warn"
                    >
                      {text}
                    </p>
                  ))}
                </div>
              )}

              <Section title="节点">
                <Row label="标识" mono>
                  {node.key}
                </Row>
                <Row label="状态">{node.status}</Row>
                <Row label="上游 / 下游">
                  {node.producers} / {node.consumers}
                </Row>
              </Section>

              {node.task && (
                <>
                  <Section title="运行">
                    <Row label="启用">{node.task.enabled ? "是" : "否"}</Row>
                    <Row label="独占">
                      {node.task.spec.exclusive === false ? "否 · 命中后继续匹配" : "是 · 命中即止"}
                    </Row>
                    <Row label="主题" mono>
                      {node.task.topic || "—"}
                    </Row>
                    <Row label="排序值">{node.task.sort_order}</Row>
                    <Row label="版本">v{node.task.version}</Row>
                    <Row label="最后修改">{formatDateTime(node.task.update_ms)}</Row>
                  </Section>

                  <Section title="投递目标">
                    <Row label={node.task.spec.target.kind === "db" ? "直写库表" : "HTTP"}>
                      {targetSummary(node.task.spec)}
                    </Row>
                    <Row label="细节" mono>
                      {targetDetail(node.task.spec)}
                    </Row>
                  </Section>

                  <Section title="流水线六段" hint="点一段在本栏看详情；要改配置用卡片上的「编辑」">
                    <div className="py-1.5">
                      {(node.segments ?? []).map((segment: TaskSegment) => (
                        <button
                          key={segment.stage}
                          type="button"
                          onClick={() => onSelectStage(segment.stage)}
                          className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-accent-soft"
                        >
                          <span className="shrink-0 text-[11.5px] text-ink-soft">{segment.label}</span>
                          <span className="min-w-0 truncate font-mono text-[11.5px] text-muted">
                            {segment.detail}
                          </span>
                          {segment.issues > 0 && (
                            <span className="shrink-0 rounded bg-danger-soft px-1 text-[11px] text-danger">
                              {segment.issues} 处
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </Section>
                </>
              )}

              {node.source && (
                <Section title="取数配置">
                  <Row label="启用">{node.source.enabled ? "是" : "否"}</Row>
                  <Row label="方式">{node.source.kind}</Row>
                  <Row label="主题" mono>
                    {node.source.topic || "—"}
                  </Row>
                  <Row label="数据源" mono>
                    {node.source.spec.datasource || "—"}
                  </Row>
                  <Row label="间隔">{node.source.interval_duration}</Row>
                  <Row label="批量">{node.source.batch_size}</Row>
                  <Row label="游标" mono>
                    {node.source.cursor?.position || "—"}
                  </Row>
                  <Row label="累计行数">{node.source.cursor?.rows_total ?? 0}</Row>
                  <Row label="最近运行">
                    {node.source.last_run_ms ? formatDateTime(node.source.last_run_ms) : "还没跑过"}
                  </Row>
                  {node.source.last_error && <Row label="最近错误">{node.source.last_error}</Row>}
                </Section>
              )}

              {node.datasource && (
                <>
                  <Section title="连接">
                    <Row label="编码" mono>
                      {node.datasource.code}
                    </Row>
                    <Row label="目标（脱敏）" mono>
                      {node.datasource.target || "—"}
                    </Row>
                    <Row label="启用">{node.datasource.enabled ? "是" : "否"}</Row>
                    <Row label="最大连接数">{node.datasource.maxConnections}</Row>
                    <Row label="引用来源数">{node.consumers}</Row>
                    <Row label="版本">v{node.datasource.version}</Row>
                    {node.datasource.remark && <Row label="备注">{node.datasource.remark}</Row>}
                  </Section>

                  <Section title="最近一次连接测试" hint="在卡片上点「测试连接」重新测">
                    {test ? (
                      <>
                        <Row label="结果">
                          <span className={test.ok ? "text-success" : "text-danger"}>
                            {test.ok ? "连通" : "失败"}
                          </span>
                        </Row>
                        <Row label="耗时">{test.elapsedMs} ms</Row>
                        {test.server && (
                          <Row label="服务端" mono>
                            {test.server}
                          </Row>
                        )}
                        <Row label="说明">{test.message}</Row>
                      </>
                    ) : (
                      <EmptyLine text="还没测过。卡片状态栏会显示最近一次结果。" />
                    )}
                  </Section>
                </>
              )}

              {node.kind === "topic" && (
                <Section title="主题">
                  <Row label="写入来源">{node.producers}</Row>
                  <Row label="消费任务">{node.consumers}</Row>
                  <p className="py-2 text-[11.5px] leading-relaxed text-muted">
                    主题不是库表实体，由数据抽取写入、被任务消费。要改它请编辑两端的数据抽取或任务。
                  </p>
                </Section>
              )}

              {node.source && (
                <p className="mt-3 rounded-md bg-sunken/70 px-2 py-1.5 text-[11.5px] leading-relaxed text-muted">
                  最近运行 {node.source.last_run_ms ? formatRelative(node.source.last_run_ms) : "—"}
                </p>
              )}
            </>
          )}
        </div>
      )}
      </aside>
    </div>
  );
}
