/**
 * # 控制面板
 *
 * 一张泳道图看清「数据从哪来、经过哪些任务、投到哪去」（学习 uiam 网关配置图）：
 * 数据源 → 数据抽取 → 主题 → 任务，一条泳道就是一个主题；节点按引用关系自动排布，
 * **不再自由拖拽、坐标不再入库**。投递是任务卡里的一段（判定看投递响应），不单独建节点。
 *
 * 图不落库：节点来自三张业务表，连线来自它们之间的引用。所以图不可能和真实配置
 * 不一致 —— 这也意味着 **不能在这里直接改引用关系**：改「数据抽取用哪个数据源」
 * 要回表单，图只负责呈现与跳转。唯一可拖的是任务卡把手，在同一主题泳道内调整
 * 匹配顺序（写 `spec.sort_order`，与任务表单保存同一条路径）。
 *
 * 操作都在卡片上，属性栏只读：
 * - 卡片右上角：启用/停用；连线落点：独占；
 * - 卡片状态栏下面：编辑（最左）、测试连接 / 立即拉取 / 试跑、删除（最右隔开）；
 * - 卡里点某一段：右侧属性栏换成那一段的详情，**不弹窗体**；
 * - 双击卡片仍然直接进窗体，是给老用户的近路。
 */

import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download, RefreshCw, TriangleAlert, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/page";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/Drawer";
import type {
  DatasourceInfo,
  DatasourceTestResult,
  PanelImportMode,
  PanelImportResult,
  SyncSource,
  SyncTask,
} from "@/lib/api/types";
import { useAllTasks, useTaskMutations } from "@/hooks/use-tasks";
import { useDatasources, useServices, useSources, useSourceMutations, useDatasourceMutations } from "@/hooks/use-sources";
import { cloneSpec } from "@/lib/spec/defaults";
import { panel } from "@/lib/api";
import { SourceEditorDrawer } from "@/features/sources/SourceEditorDrawer";
import { DatasourceEditorDrawer } from "@/features/datasources/DatasourceEditorDrawer";
import { TaskEditorDrawer, type TaskTab } from "@/features/tasks/TaskEditorDrawer";
import { buildGraph, nodeId, type GraphNode, type TaskStage } from "./graph";
import { TopologyCanvas } from "./TopologyCanvas";
import { TopologyInspector } from "./TopologyInspector";
import { TopologyPalette } from "./TopologyPalette";
import {
  archiveFileName,
  buildArchive,
  parseArchive,
  planImport,
  toImportInput,
  type PanelArchive,
} from "./panel-archive";
import { PanelImportDialog } from "./PanelImportDialog";

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
  const { data: datasources = [], isLoading: loadingDs, refetch: refetchDs } = useDatasources();
  const { data: sources = [], refetch: refetchSources } = useSources();
  const { data: tasks = [], isLoading: loadingTasks, refetch: refetchTasks } = useAllTasks();
  const { data: services = [] } = useServices();
  const { save: saveTask, toggle: toggleTaskMutation, remove: removeTask } = useTaskMutations();
  const { pull: pullSource, toggle: toggleSource, remove: removeSource } = useSourceMutations();
  const { setEnabled: setDatasourceEnabled, remove: removeDatasource, test: testDatasource } =
    useDatasourceMutations();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 选中的任务段：非空时属性栏显示该段详情（点卡片里的第 N 段进来） */
  const [stage, setStage] = useState<TaskStage | null>(null);
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

  /* ------------------------- 控制面板导出 / 导入 ------------------------- */

  const fileRef = useRef<HTMLInputElement>(null);
  const [archive, setArchive] = useState<PanelArchive | null>(null);
  const [importMode, setImportMode] = useState<PanelImportMode>("overwrite");
  /** 新增数据源的连接串由用户在预览里现填，键是 code */
  const [importUrls, setImportUrls] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<PanelImportResult | null>(null);

  const currentPanel = useMemo(() => ({ datasources, sources, tasks }), [datasources, sources, tasks]);
  const importPlan = useMemo(
    () => archive && planImport(archive, currentPanel, importMode),
    [archive, currentPanel, importMode],
  );

  /** 导出走服务端：连接串明文只有 `GET /syn/panel/export` 给，前端拼不出来 */
  const exportPanel = async () => {
    try {
      const snapshot = buildArchive(await panel.export());
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = archiveFileName(snapshot);
      // Safari 要求锚点在文档里才肯触发下载；URL 延后释放，避免下载被取消
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      toast.success(
        "已导出控制面板",
        `数据源 ${snapshot.summary.datasources} · 数据抽取 ${snapshot.summary.sources} · 任务 ${snapshot.summary.tasks}；文件含连接串明文，请按密钥保管`,
      );
    } catch (err) {
      toast.error("导出失败", err instanceof Error ? err.message : "接口不可达");
    }
  };

  const pickArchive = () => fileRef.current?.click();

  /** 读文件、解析、预检；真正的写入等用户在预览里确认 */
  const loadArchive = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = parseArchive(await file.text());
      if (!parsed.ok) {
        toast.error("文件读不了", parsed.errors.slice(0, 2).join("；"));
        return;
      }
      setArchive(parsed.archive);
      setImportMode("overwrite");
      setImportUrls(
        Object.fromEntries(
          parsed.archive.datasources.map((d) => [d.code, d.url.trim()]),
        ),
      );
      setImportError(null);
      setImportResult(null);
      if (parsed.warnings.length > 0) {
        toast.info("文件有提示", parsed.warnings[0]);
      }
    } catch (err) {
      toast.error("文件读不了", err instanceof Error ? err.message : "无法读取文件");
    }
  };

  /**
   * 确认导入：后端单事务写入，失败即整批回滚。
   * 预览里补填的连接串只覆盖「当前环境没有、需要新建」的数据源；
   * 已存在的留住库里的那条，文件里带了新串才覆盖。
   */
  const confirmImport = async () => {
    if (!archive) return;
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const datasources = archive.datasources.map((d) => {
        const row = importPlan?.datasources.find((r) => r.code === d.code);
        return row?.action === "create"
          ? { ...d, url: (importUrls[d.code] ?? d.url).trim() }
          : d;
      });
      const result = await panel.import({
        ...toImportInput(archive, importMode),
        datasources,
      });
      setImportResult(result);
      setSelectedId(null);
      setStage(null);
      await Promise.all([refetchDs(), refetchSources(), refetchTasks()]);
      const written =
        result.datasources.created +
        result.datasources.updated +
        result.sources.created +
        result.sources.updated +
        result.tasks.created +
        result.tasks.updated;
      toast.success(
        "导入完成",
        `写入 ${written} 条（跳过 ${result.datasources.skipped + result.sources.skipped + result.tasks.skipped} 条）${result.watermarks_reset > 0 ? `；${result.watermarks_reset} 条抽取的水位已清空` : ""}`,
      );
      setArchive(null);
      setImportUrls({});
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "接口不可达");
    } finally {
      setImporting(false);
    }
  };

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

  /**
   * 数据抽取卡片的「立即拉取」：与「数据抽取」页的手动拉取走同一条接口，
   * 但与任务启停不同，拉取是**可能失败也可能停在中途**的动作，结果要说清楚。
   * 只把「本轮几行 / 是否拉到底 / 卡在哪」写进提示，游标前移由列表刷新体现。
   */
  const pullSourceNode = (node: GraphNode) => {
    if (!node.source) return;
    runPending(`${node.id}:pull`, (settled) =>
      pullSource.mutate(node.source!.id, {
        onSuccess: (result) => {
          if (result.stalled) {
            toast.info(
              `已拉取 ${result.rows} 行，游标停在失败记录前`,
              `耗时 ${result.duration_ms}ms；${result.stalled}。修好这一条之前不会继续推进`,
            );
          } else if (result.full_done) {
            toast.success(
              "全量拉取完成",
              `本轮 ${result.rows} 行，拉到底了；要重跑点「数据抽取」页的重跑全量`,
            );
          } else {
            toast.success(
              `已拉取 ${result.rows} 行`,
              `耗时 ${result.duration_ms}ms；游标已前移，下一轮从新位置继续`,
            );
          }
        },
        onError: (err) => toast.error("拉取失败", err instanceof Error ? err.message : "接口不可达"),
        onSettled: settled,
      }),
    );
  };

  /**
   * 泳道内拖动任务调整匹配顺序：把新顺序写进各任务的 spec.sort_order（版本 +1）。
   * 逐条保存走的是任务表单同一条 update 接口，后端会把 spec 里的 sort_order
   * 反写回列；全部成功后再失效缓存重排泳道。失败只提示，不回滚本地图 ——
   * 图本来就是从服务端读的，下一次刷新自然会回到真实顺序。
   */
  const reorderTasks = (_laneKey: string, orderedIds: string[]) => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const members = orderedIds.flatMap((id) => {
      const task = byId.get(id);
      return task ? [task] : [];
    });
    if (members.length < 2) return;
    // 从这一泳道最小的 sort_order 起重新编号，既保住原来的数值区间，又保证互不相同
    // （相同 sort_order 的任务排序会被 id 打破，拖动就永远存不住新顺序）。
    const base = Math.min(...members.map((t) => t.sort_order));
    const writes = orderedIds.map((id, i) => {
      const task = byId.get(id)!;
      return { id, name: task.name, spec: { ...cloneSpec(task.spec), sort_order: base + i } };
    });
    Promise.all(writes.map((w) => saveTask.mutateAsync({ id: w.id, name: w.name, spec: w.spec })))
      .then(() => toast.success("顺序已保存", "已通知各副本刷新执行器快照，按新顺序匹配"))
      .catch((err: Error) => toast.error("排序没保存成功", err.message));
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
        subtitle="一个主题一条泳道：数据源 → 数据抽取 → 主题 → 任务。图按引用关系自动排布；题头右缘拖动可调列宽（本机记住、双击复位），拖动任务把手改匹配顺序，双击卡片进编辑。"
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              icon={<Download className="size-3.5" />}
              onClick={() => void exportPanel()}
              title="导出面板结构与全部组件配置（含连接串明文，仅本接口破例）"
            >
              导出
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<Upload className="size-3.5" />}
              onClick={pickArchive}
              title="从导出文件恢复数据源 / 数据抽取 / 任务"
            >
              导入
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw className="size-3.5" />}
              onClick={() => {
                void Promise.all([refetchDs(), refetchSources(), refetchTasks()]);
                toast.info("已刷新", "按服务端最新配置重排泳道");
              }}
            >
              刷新
            </Button>
          </>
        }
      />

      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // 清空 value 才能再次选中同一个文件做「改完再导」
          e.target.value = "";
          void loadArchive(file);
        }}
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
              selectedId={selectedId}
              onSelect={selectNode}
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
              onPullSource={pullSourceNode}
              onReorderTasks={reorderTasks}
              onAdd={(kind) => setEditing(CREATE_KIND[kind])}
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

      <PanelImportDialog
        open={archive !== null}
        archive={archive}
        plan={importPlan}
        mode={importMode}
        urls={importUrls}
        busy={importing}
        error={importError}
        result={importResult}
        onModeChange={(mode) => {
          setImportMode(mode);
          setImportError(null);
        }}
        onUrlChange={(code, value) =>
          setImportUrls((prev) => ({ ...prev, [code]: value }))
        }
        onClose={() => {
          if (importing) return;
          setArchive(null);
          setImportUrls({});
          setImportError(null);
          setImportResult(null);
        }}
        onConfirm={() => void confirmImport()}
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
