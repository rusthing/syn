/**
 * # 控制面板
 *
 * 一张图看清「数据从哪来、经过哪些任务、投到哪去」：
 * 数据源 → 取数来源 → 主题 → 任务，投递是任务第五段（判定看投递响应），画在卡里。
 *
 * 图不落库：节点来自三张业务表，连线来自它们之间的引用，库里只存节点坐标
 * （`syn_canvas_layout`）。所以这张图不可能和真实配置不一致 —— 这也意味着
 * **不能在这里直接改引用关系**：改「来源用哪个数据源」要回表单，图只负责呈现与跳转。
 *
 * 这里只做写操作：拖动后保存坐标、单击在右侧属性栏看属性、双击打开居中窗体、
 * 点任务卡的某一段直达页签、组件栏点选直接新建（新建窗体与维护页共用同一个组件，
 * 实体传 null 即创建模式）。
 */

import { useMemo, useState } from "react";
import { Link2, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/page";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils";
import type { CanvasNodePos, DatasourceInfo, SyncSource, SyncTask } from "@/lib/api/types";
import { useAllTasks } from "@/hooks/use-tasks";
import { useDatasources, useServices, useSources } from "@/hooks/use-sources";
import { useCanvasLayout, useCanvasMutations } from "@/hooks/use-canvas";
import { useTaskMutations } from "@/hooks/use-tasks";
import { cloneSpec } from "@/lib/spec/defaults";
import { SourceEditorDrawer } from "@/features/sources/SourceEditorDrawer";
import { DatasourceEditorDrawer } from "@/features/datasources/DatasourceEditorDrawer";
import { TaskEditorDrawer, type TaskTab } from "@/features/tasks/TaskEditorDrawer";
import { buildGraph, mergePositions, type GraphNode, type TaskStage } from "./graph";
import { TopologyCanvas } from "./TopologyCanvas";
import { TopologyInspector } from "./TopologyInspector";
import { TopologyPalette } from "./TopologyPalette";

type Editing =
  | { kind: "task"; task: SyncTask; tab: TaskTab }
  | { kind: "task-new" }
  | { kind: "source"; source: SyncSource }
  | { kind: "source-new" }
  | { kind: "datasource"; datasource: DatasourceInfo }
  | { kind: "datasource-new" }
  | null;

/** 组件栏能新建的三类 ↔ Editing 的 -new 变体 */
const CREATE_KIND: Record<"datasource" | "source" | "task", Exclude<Editing, null>> = {
  datasource: { kind: "datasource-new" },
  source: { kind: "source-new" },
  task: { kind: "task-new" },
};

const KIND_LEGEND = [
  { label: "数据源", dot: "bg-info" },
  { label: "取数来源", dot: "bg-violet" },
  { label: "主题", dot: "bg-line-strong" },
  { label: "任务", dot: "bg-accent" },
] as const;

export function TopologyPage() {
  const toast = useToast();
  const { data: datasources = [], isLoading: loadingDs } = useDatasources();
  const { data: sources = [] } = useSources();
  const { data: tasks = [], isLoading: loadingTasks } = useAllTasks();
  const { data: services = [] } = useServices();
  const { data: stored = [], refetch } = useCanvasLayout();
  const { save: saveTask, toggle: toggleTaskMutation } = useTaskMutations();
  const { save } = useCanvasMutations();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 拖动中的临时坐标：不等接口回来就先把卡放到新位置 */
  const [dragging, setDragging] = useState<Record<string, CanvasNodePos>>({});
  const [editing, setEditing] = useState<Editing>(null);
  /**
   * 在途的开关请求，键是 `${node.id}:${action}`。启用和独占各占一键，互不干扰；
   * 且**只做视觉提示**，不给按钮加原生 disabled —— 那会把后续 click 整个吞掉。
   */
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());

  const runPending = (key: string, run: (settled: () => void) => void) => {
    setPendingKeys((prev) => new Set(prev).add(key));
    run(() =>
      setPendingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      }),
    );
  };

  /** 卡右上角 / 属性栏的启用开关：直接走 toggle 接口，不必进窗体 */
  const toggleTask = (node: GraphNode, next: boolean) => {
    if (!node.task) return;
    runPending(`${node.id}:enabled`, (settled) =>
      toggleTaskMutation.mutate(
        { id: node.task!.id, enabled: next },
        {
          onSuccess: () =>
            toast.success(next ? "已启用" : "已停用", "已通知各副本刷新执行器快照"),
          onError: (err) => toast.error("操作失败", err instanceof Error ? err.message : "接口不可达"),
          onSettled: settled,
        },
      ),
    );
  };

  /** 连线落点的独占开关：改 spec.exclusive 保存（版本 +1） */
  const toggleExclusive = (node: GraphNode) => {
    if (!node.task) return;
    const task = node.task;
    const next = { ...cloneSpec(task.spec), exclusive: task.spec.exclusive === false };
    runPending(`${node.id}:exclusive`, (settled) =>
      saveTask.mutate(
        { id: task.id, name: task.name, spec: next },
        {
          onSuccess: () =>
            toast.success(
              next.exclusive ? "已设为独占" : "已取消独占",
              `${next.exclusive ? "命中后停止匹配" : "命中后继续匹配下一个任务"}；版本 +1，已通知各副本刷新执行器快照`,
            ),
          onError: (err) => toast.error("操作失败", err instanceof Error ? err.message : "接口不可达"),
          onSettled: settled,
        },
      ),
    );
  };

  const graph = useMemo(
    () =>
      buildGraph({
        datasources,
        sources,
        tasks,
        services: services.map((s) => s.name),
      }),
    [datasources, sources, tasks, services],
  );

  const positions = useMemo(() => {
    const base = mergePositions(graph.nodes, stored);
    return { ...base, ...dragging };
  }, [graph.nodes, stored, dragging]);

  /** 属性栏只读图节点，不另存一份选中实体：图变了属性跟着变，不存在两份状态不同步 */
  const selectedNode = graph.nodes.find((n) => n.id === selectedId) ?? null;

  const issueNodes = graph.nodes.filter((n) => n.issues.length > 0);
  // 只有「主题没人消费」这种会真丢数据的才上条；「没登记生产者」走 CDC 时是常态，
  // 全列出来会把条占满，反而盖住真问题（它仍写在卡片 tip 里）
  const warnNodes = graph.nodes.filter(
    (n) => !n.issues.length && n.hints.some((h) => h.includes("没有任务消费")),
  );
  /** 条上最多放 6 条，多出来的折成「还有 N 条」，避免把画布顶下去 */
  const stripIssues = issueNodes.slice(0, 6);
  const stripWarns = warnNodes.slice(0, Math.max(0, 6 - stripIssues.length));
  const stripMore = issueNodes.length + warnNodes.length - stripIssues.length - stripWarns.length;

  const onMove = (id: string, pos: { x: number; y: number }) => {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) return;
    const next: CanvasNodePos = { kind: node.kind, key: node.key, x: pos.x, y: pos.y };
    setDragging((prev) => ({ ...prev, [id]: next }));
    save.mutate([next], {
      onError: (err) => {
        // 保存失败就把卡放回原位：留着会让人以为「已经记住了」
        setDragging((prev) => {
          const rest = { ...prev };
          delete rest[id];
          return rest;
        });
        toast.error("位置没保存成功", err instanceof Error ? err.message : "接口不可达");
      },
    });
  };

  const openEntity = (node: GraphNode) => {
    if (node.task) return setEditing({ kind: "task", task: node.task, tab: "match" });
    if (node.source) return setEditing({ kind: "source", source: node.source });
    if (node.datasource) return setEditing({ kind: "datasource", datasource: node.datasource });
    toast.info("主题是虚拟节点", "它由来源写入、被任务消费；双击两端的卡片改具体配置。");
  };

  const openStage = (node: GraphNode, stage: TaskStage) => {
    if (!node.task) return;
    setEditing({ kind: "task", task: node.task, tab: stage as TaskTab });
  };

  const loading = (loadingDs || loadingTasks) && graph.nodes.length === 0;

  return (
    <>
      <PageHeader
        title="控制面板"
        subtitle={
          <>
            数据源 → 取数来源 → 主题 → 任务，投递在判定之前。左侧组件栏点选直接新建；
            单击卡片在右侧看属性，双击打开窗体改配置，拖动节点即保存摆位；卡右上角切换启用，
            连线落点切换独占。
          </>
        }
        actions={
          <>
            <div className="hidden items-center gap-3 rounded-lg border border-line bg-surface px-2.5 py-1.5 lg:flex">
              {KIND_LEGEND.map((item) => (
                <span key={item.label} className="flex items-center gap-1.5 text-[11px] text-muted">
                  <span className={cn("size-1.5 rounded-full", item.dot)} />
                  {item.label}
                </span>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw className="size-3.5" />}
              onClick={() => {
                void refetch();
                toast.info("已刷新", "坐标按服务端最新值重排");
              }}
            >
              刷新
            </Button>
          </>
        }
      />

      {(issueNodes.length > 0 || warnNodes.length > 0) && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5 rounded-[10px] border border-line bg-surface px-2.5 py-2">
          <span className="mr-1 text-[11.5px] font-medium text-ink-soft">需要看一眼</span>
          {stripIssues.map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => setSelectedId(node.id)}
              title={node.issues.join("\n")}
              className="flex items-center gap-1 rounded-md bg-danger-soft px-1.5 py-0.5 text-[11px] text-danger hover:brightness-95"
            >
              <TriangleAlert className="size-3" />
              {node.title}：{node.issues[0]}
            </button>
          ))}
          {stripWarns.map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => setSelectedId(node.id)}
              title={node.hints.join("\n")}
              className="flex items-center gap-1 rounded-md bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn hover:brightness-95"
            >
              <Link2 className="size-3" />
              {node.title}：{node.hints[0]}
            </button>
          ))}
          {stripMore > 0 && (
            <span className="text-[11px] text-muted">还有 {stripMore} 条，画布上带角标的都是</span>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex h-[520px] items-center justify-center rounded-[14px] border border-line bg-surface text-[12.5px] text-muted">
          正在拼图…
        </div>
      ) : (
        <div className="flex items-stretch gap-2.5">
          <TopologyPalette onAdd={(kind) => setEditing(CREATE_KIND[kind])} />
          <div className="min-w-0 flex-1">
            <TopologyCanvas
              graph={graph}
              positions={positions}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onMove={onMove}
              onOpenStage={openStage}
              onOpenEntity={openEntity}
              onToggleTask={toggleTask}
              onToggleExclusive={toggleExclusive}
              pendingKeys={pendingKeys}
            />
          </div>
          <TopologyInspector
            node={selectedNode}
            onClose={() => setSelectedId(null)}
            onOpenEntity={openEntity}
            onOpenStage={openStage}
            onToggleEnabled={(n, next) => toggleTask(n, next)}
            enabledBusy={selectedNode ? pendingKeys.has(`${selectedNode.id}:enabled`) : false}
          />
        </div>
      )}

      <p className="mt-2 text-[11px] leading-relaxed text-muted">
        共 {graph.nodes.length} 个节点、{graph.edges.length} 条连线；其中 {tasks.length} 个任务、
        {sources.length} 个取数来源、{datasources.length} 个数据源。虚线表示下游已停用，
        这条链此刻不会真的走。
      </p>

      <TaskEditorDrawer
        open={editing?.kind === "task" || editing?.kind === "task-new"}
        task={editing?.kind === "task" ? editing.task : null}
        initialTab={editing?.kind === "task" ? editing.tab : undefined}
        onClose={() => setEditing(null)}
      />
      <SourceEditorDrawer
        open={editing?.kind === "source" || editing?.kind === "source-new"}
        source={editing?.kind === "source" ? editing.source : null}
        onClose={() => setEditing(null)}
      />
      <DatasourceEditorDrawer
        open={editing?.kind === "datasource" || editing?.kind === "datasource-new"}
        datasource={editing?.kind === "datasource" ? editing.datasource : null}
        onClose={() => setEditing(null)}
      />
    </>
  );
}
