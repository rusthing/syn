/**
 * # 控制面板
 *
 * 一张图看清「数据从哪来、经过哪些任务、投到哪去」：
 * 数据源 → 数据抽取 → 主题 → 任务，投递是任务第六段之前的最后一步（判定看投递响应），
 * 画在卡里。
 *
 * 图不落库：节点来自三张业务表，连线来自它们之间的引用，库里只存节点坐标
 * （`syn_canvas_layout`）。所以这张图不可能和真实配置不一致 —— 这也意味着
 * **不能在这里直接改引用关系**：改「数据抽取用哪个数据源」要回表单，图只负责呈现与跳转。
 *
 * 操作都在卡片上，属性栏只读：
 * - 卡片右上角：启用/停用；连线落点：独占；
 * - 卡片状态栏下面：编辑（最左）、测试连接 / 试跑、删除（最右隔开）；
 * - 卡里点某一段：右侧属性栏换成那一段的详情，**不弹窗体**；
 * - 双击卡片仍然直接进窗体，是给老用户的近路。
 */

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/page";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/Drawer";
import type {
  CanvasNodePos,
  DatasourceInfo,
  DatasourceTestResult,
  SyncSource,
  SyncTask,
} from "@/lib/api/types";
import { useAllTasks } from "@/hooks/use-tasks";
import { useDatasources, useServices, useSources, useSourceMutations, useDatasourceMutations } from "@/hooks/use-sources";
import { useCanvasLayout, useCanvasMutations } from "@/hooks/use-canvas";
import { useTaskMutations } from "@/hooks/use-tasks";
import { cloneSpec } from "@/lib/spec/defaults";
import { SourceEditorDrawer } from "@/features/sources/SourceEditorDrawer";
import { DatasourceEditorDrawer } from "@/features/datasources/DatasourceEditorDrawer";
import { TaskEditorDrawer, type TaskTab } from "@/features/tasks/TaskEditorDrawer";
import { buildGraph, mergePositions, nodeId, type GraphNode, type TaskStage } from "./graph";
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

/** 待删除的节点：确认框里要说清「删的是哪一条」 */
type Removing =
  | { kind: "task"; task: SyncTask }
  | { kind: "source"; source: SyncSource }
  | { kind: "datasource"; datasource: DatasourceInfo }
  | null;

export function TopologyPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { data: datasources = [], isLoading: loadingDs } = useDatasources();
  const { data: sources = [] } = useSources();
  const { data: tasks = [], isLoading: loadingTasks } = useAllTasks();
  const { data: services = [] } = useServices();
  const { data: stored = [], refetch } = useCanvasLayout();
  const { save: saveTask, toggle: toggleTaskMutation, remove: removeTask } = useTaskMutations();
  const { save } = useCanvasMutations();
  const { toggle: toggleSource, remove: removeSource } = useSourceMutations();
  const { setEnabled: setDatasourceEnabled, remove: removeDatasource, test: testDatasource } =
    useDatasourceMutations();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 选中的任务段：非空时属性栏显示该段详情（点卡片里的第 N 段进来） */
  const [stage, setStage] = useState<TaskStage | null>(null);
  /** 拖动中的临时坐标：不等接口回来就先把卡放到新位置 */
  const [dragging, setDragging] = useState<Record<string, CanvasNodePos>>({});
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<Removing>(null);
  /**
   * 在途的开关/测试请求，键是 `${node.id}:${action}`。各动作各占一键，互不干扰；
   * 且**只做视觉提示**，不给按钮加原生 disabled —— 那会把后续 click 整个吞掉。
   */
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * 数据源最近一次连接测试的结果，键是节点 id。
   * 放在页面这一层而不是卡片里：属性栏要显示同一份结果，卡片滚出视野也不该丢。
   */
  const [testResults, setTestResults] = useState<Record<string, DatasourceTestResult>>({});
  /** 外部要求画布把某张卡移到正中；token 保证连点同一条也能再次定位 */
  const [focus, setFocus] = useState<{ id: string; token: number } | null>(null);

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

  /** 卡右上角的启用开关（任务）：直接走 toggle 接口，不必进窗体 */
  const toggleTask = (node: GraphNode, next: boolean) => {
    if (!node.task) return;
    runPending(`${node.id}:enabled`, (settled) =>
      toggleTaskMutation.mutate(
        { id: node.task!.id, enabled: next },
        {
          onSuccess: () => toast.success(next ? "已启用" : "已停用", "已通知各副本刷新执行器快照"),
          onError: (err) => toast.error("操作失败", err instanceof Error ? err.message : "接口不可达"),
          onSettled: settled,
        },
      ),
    );
  };

  /** 卡右上角的启用开关（数据抽取 / 数据源）：各自一条 set_enabled */
  const toggleEntity = (node: GraphNode, next: boolean) => {
    const label = next ? "已启用" : "已停用";
    if (node.source) {
      runPending(`${node.id}:enabled`, (settled) =>
        toggleSource.mutate(
          { id: node.source!.id, enabled: next },
          {
            onSuccess: () => toast.success(label, "调度器下一拍按新状态跑"),
            onError: (err) => toast.error("操作失败", err instanceof Error ? err.message : "接口不可达"),
            onSettled: settled,
          },
        ),
      );
      return;
    }
    if (node.datasource) {
      runPending(`${node.id}:enabled`, (settled) =>
        setDatasourceEnabled.mutate(
          { id: node.datasource!.id, enabled: next },
          {
            onSuccess: () => toast.success(label, "已建好的连接池会按新状态下线 / 重建"),
            onError: (err) => toast.error("操作失败", err instanceof Error ? err.message : "接口不可达"),
            onSettled: settled,
          },
        ),
      );
    }
  };

  /** 数据源卡片的「测试连接」：只测，不写库；结果进卡片状态栏与属性栏 */
  const testDatasourceNode = (node: GraphNode) => {
    if (!node.datasource) return;
    runPending(`${node.id}:test`, (settled) =>
      testDatasource.mutate(
        { id: node.datasource!.id },
        {
          onSuccess: (result) => {
            setTestResults((prev) => ({ ...prev, [node.id]: result }));
            if (result.ok) {
              toast.success(
                `连上了 · ${result.elapsedMs}ms`,
                result.server ? `${result.server} · ${node.title}` : node.title,
              );
            } else {
              toast.error("连不上", result.message);
            }
          },
          onError: (err) => toast.error("测试失败", err instanceof Error ? err.message : "接口不可达"),
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

  /** 选中节点时把段详情收回去：换了卡片还挂着上一张卡的段会莫名其妙 */
  const selectNode = (id: string | null) => {
    setSelectedId(id);
    setStage(null);
  };

  /** 警示条上的节点名：选中之外还要把镜头推过去，否则点了也不知道指的是哪张卡 */
  const focusNode = (id: string) => {
    selectNode(id);
    setFocus((prev) => ({ id, token: (prev?.token ?? 0) + 1 }));
  };

  /** 卡片最左的「编辑」/ 双击：打开窗体 */
  const openEntity = (node: GraphNode) => {
    if (node.task) return setEditing({ kind: "task", task: node.task, tab: "match" });
    if (node.source) return setEditing({ kind: "source", source: node.source });
    if (node.datasource) return setEditing({ kind: "datasource", datasource: node.datasource });
    toast.info("主题是虚拟节点", "它由数据抽取写入、被任务消费；改两端的卡片即可。");
  };

  /** 卡里点某一段：只切属性栏，不弹窗体 */
  const openStage = (node: GraphNode, next: TaskStage) => {
    if (!node.task) return;
    setSelectedId(node.id);
    setStage(next);
  };

  const removeNode = (node: GraphNode) => {
    if (node.task) return setRemoving({ kind: "task", task: node.task });
    if (node.source) return setRemoving({ kind: "source", source: node.source });
    if (node.datasource) return setRemoving({ kind: "datasource", datasource: node.datasource });
    toast.info("主题是虚拟节点", "它不由本页维护。");
  };

  const confirmRemove = () => {
    if (!removing) return;
    const done = (text: string) => {
      toast.success(text, "已通知各副本刷新");
      setRemoving(null);
      setSelectedId(null);
      setStage(null);
    };
    const fail = (err: Error) => toast.error("删除失败", err.message);
    if (removing.kind === "task") {
      removeTask.mutate(removing.task.id, {
        onSuccess: () => done("任务已删除"),
        onError: fail,
      });
      return;
    }
    if (removing.kind === "source") {
      removeSource.mutate(removing.source.id, {
        onSuccess: () => done("数据抽取已删除"),
        onError: fail,
      });
      return;
    }
    removeDatasource.mutate(removing.datasource.id, {
      onSuccess: () => done("数据源已删除"),
      onError: fail,
    });
  };

  const loading = (loadingDs || loadingTasks) && graph.nodes.length === 0;

  return (
    // 控制面板独占 AppShell 剩下的全部宽高：不套 1440 阅读列，底部也不留 48px。
    // 页面根用 flex-1 吃掉 main 的剩余高度，画布再吃掉页头/警示条之外的高度；
    // 不再写死 calc(100vh-...)，顶栏或内边距改了也不会留一条没用的空白。
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="控制面板"
        subtitle="数据源 → 数据抽取 → 主题 → 任务。画布随窗口大小自动适应；点卡片只看属性、不改视角，右下角「全图」可看整张拓扑。"
        actions={
          <>
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
        <div className="mb-3 flex flex-wrap items-center gap-1.5 rounded-[10px] border border-line bg-surface px-2.5 py-1.5">
          {/* 只报节点名 + 总数，完整原因在 title / 属性栏里；整行长句子会把画布顶下去 */}
          <span className="mr-0.5 flex items-center gap-1 text-[11.5px] font-medium text-ink-soft">
            <TriangleAlert className="size-3 text-warn" />
            需要看一眼 · {issueNodes.length + warnNodes.length} 处
          </span>
          {stripIssues.map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => focusNode(node.id)}
              title={`${node.title}：${node.issues.join("\n")}（点击定位到这张卡）`}
              className="max-w-[170px] truncate rounded-md bg-danger-soft px-1.5 py-0.5 text-[11.5px] text-danger hover:brightness-95"
            >
              {shortNodeName(node.title)}
            </button>
          ))}
          {stripWarns.map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => focusNode(node.id)}
              title={`${node.title}：${node.hints.join("\n")}（点击定位到这张卡）`}
              className="max-w-[170px] truncate rounded-md bg-warn-soft px-1.5 py-0.5 text-[11.5px] text-warn hover:brightness-95"
            >
              {shortNodeName(node.title)}
            </button>
          ))}
          {stripMore > 0 && (
            <span className="text-[11.5px] text-muted">还有 {stripMore} 处，画布上带角标</span>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex flex-1 items-center justify-center rounded-[14px] border border-line bg-surface text-[12.5px] text-muted">
          正在拼图…
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-stretch gap-2.5">
          <TopologyPalette onAdd={(kind) => setEditing(CREATE_KIND[kind])} />
          <div className="flex min-w-0 flex-1 flex-col">
            <TopologyCanvas
              graph={graph}
              positions={positions}
              selectedId={selectedId}
              onSelect={selectNode}
              onMove={onMove}
              onOpenStage={openStage}
              onOpenEntity={openEntity}
              onDeleteEntity={removeNode}
              onTryTask={(node) =>
                node.task &&
                navigate(
                  `/playground?topic=${encodeURIComponent(node.task.topic)}&task=${node.task.id}`,
                )
              }
              onToggleTask={toggleTask}
              onToggleExclusive={toggleExclusive}
              onToggleEntity={toggleEntity}
              onTestDatasource={testDatasourceNode}
              testResults={testResults}
              pendingKeys={pendingKeys}
              focus={focus}
            />
          </div>
          <TopologyInspector
            node={selectedNode}
            stage={stage}
            onSelectStage={setStage}
            onClose={() => {
              setSelectedId(null);
              setStage(null);
            }}
            test={selectedNode ? testResults[selectedNode.id] : undefined}
            summary={{
              nodes: graph.nodes.length,
              edges: graph.edges.length,
              tasks: tasks.length,
              sources: sources.length,
              datasources: datasources.length,
            }}
          />
        </div>
      )}

      <TaskEditorDrawer
        open={editing?.kind === "task" || editing?.kind === "task-new"}
        task={editing?.kind === "task" ? editing.task : null}
        initialTab={editing?.kind === "task" ? editing.tab : undefined}
        onClose={() => setEditing(null)}
        onSaved={() => setSelectedId(null)}
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
        // 只认「正在编辑的这条」：从组件栏新建时没有节点，别把结果挂到别的卡上
        onTested={(result) => {
          if (editing?.kind !== "datasource") return;
          const id = nodeId("datasource", editing.datasource.code);
          setTestResults((prev) => ({ ...prev, [id]: result }));
        }}
        // 连接串可能改了：旧结论不能留在状态栏上（那是上一条串的结果）
        onSaved={() => {
          if (editing?.kind !== "datasource") return;
          const id = nodeId("datasource", editing.datasource.code);
          setTestResults((prev) => {
            const rest = { ...prev };
            delete rest[id];
            return rest;
          });
        }}
      />

      <ConfirmDialog
        open={removing !== null}
        title={`删除${removingTitle(removing)}？`}
        description={removingDescription(removing)}
        confirmText="删除"
        loading={removeSource.isPending || removeDatasource.isPending || removeTask.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={confirmRemove}
      />
    </div>
  );
}

/** 警示条只放节点名：主题节点的 `source:` 前缀在四列图里是冗余信息 */
function shortNodeName(title: string): string {
  return title.replace(/^source:/, "");
}

function removingTitle(removing: Removing): string {
  if (!removing) return "";
  if (removing.kind === "task") return `任务「${removing.task.name}」`;
  if (removing.kind === "source") return `数据抽取「${removing.source.name}」`;
  return `数据源「${removing.datasource.name}」`;
}

function removingDescription(removing: Removing) {
  if (!removing) return null;
  if (removing.kind === "task") {
    return <>任务配置会连同版本历史一起删除。已经发出去的数据不会回滚；只是想暂停就把右上角的开关关掉。</>;
  }
  if (removing.kind === "source") {
    return <>数据抽取会被删除，游标一并清掉；已经拉到下游的数据不会回滚。只是想暂停就把右上角的开关关掉。</>;
  }
  return (
    <>
      数据源记录会被删除，<b className="text-ink-soft">连接串不会回显也无法恢复</b>；
      仍有数据抽取引用它时，取数会直接报错。
    </>
  );
}
