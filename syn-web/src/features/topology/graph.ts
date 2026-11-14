/**
 * # 拓扑图的拼装（纯函数，便于单测）
 *
 * 画布上**没有任何结构存在库里**：节点来自任务 / 取数来源 / 数据源三张表，
 * 连线来自它们之间的引用（`source.spec.datasource`、`source.topic`、`task.topic`），
 * 库里只存节点坐标（`syn_canvas_layout`）。这样「图」永远和业务表一致 ——
 * 不可能出现「任务已经删了、图上还挂着」或者「改了引用关系、线还连着老的」。
 *
 * 主题（topic）是拼出来的虚拟节点：CDC 直接产 topic（没有来源记录），自拉来源
 * 写 `source:{code}` 虚拟 topic。所以 topic 节点的生产者集合 = 写了它的来源，
 * 消费者集合 = 匹配它的任务；两边都为空的 topic 不存在，不会被画出来。
 *
 * 方向就是数据流：数据源 → 取数来源 → 主题 → 任务。投递不画成节点 ——
 * 它是任务的第五段（第六段判定看的就是投递的响应），画到卡里（见 `TaskCard`），
 * 否则多个任务投同一个服务时会连出一堆交叉线，还把「投递目标」误当成共享实体。
 */

import type {
  CanvasNodeKind,
  CanvasNodePos,
  DatasourceInfo,
  SyncSource,
  SyncTask,
  TaskSpec,
} from "@/lib/api/types";
import { validateSpec } from "@/lib/spec/validate";

/** 节点 id：`类型:标识`。同一 code 在数据源和任务下是两个节点 */
export const nodeId = (kind: CanvasNodeKind, key: string): string => `${kind}:${key}`;

export type NodeTone = "ok" | "warn" | "bad" | "muted";

/** 任务卡里可点开的六段，值与任务抽屉的页签同名 */
export type TaskStage = "match" | "mapping" | "guards" | "actions" | "outcomes" | "target";

export interface TaskSegment {
  stage: TaskStage;
  /** 段名，带序号：`1 匹配` */
  label: string;
  /** 段内概要，例如 `3 条断言` */
  detail: string;
  /** 该段自身的问题数（0 表示没问题，红点由卡片画） */
  issues: number;
}

export interface GraphNode {
  id: string;
  kind: CanvasNodeKind;
  key: string;
  title: string;
  subtitle: string;
  tone: NodeTone;
  /** 卡片右上角的状态文字 */
  status: string;
  /** 阻断性问题（红角标，悬停可看） */
  issues: string[];
  /** 弱提示（黄角标）：不算错，但值得看一眼 */
  hints: string[];
  /** 各类型专属实体，卡片据此渲染细节 */
  task?: SyncTask;
  source?: SyncSource;
  datasource?: DatasourceInfo;
  /** 任务卡的六段 */
  segments?: TaskSegment[];
  /** 主题节点：写它的来源数 / 消费它的任务数 */
  producers: number;
  consumers: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  /** 目标节点是停用的：线画成虚线，表示这条链此刻不会真的走 */
  muted: boolean;
}

export interface TopologyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const TONE_RANK: Record<NodeTone, number> = { ok: 3, warn: 2, muted: 1, bad: 0 };

export function worstTone(...tones: NodeTone[]): NodeTone {
  return tones.reduce((a, b) => (TONE_RANK[b] < TONE_RANK[a] ? b : a), "ok");
}

/* ------------------------------- 任务六段 ------------------------------- */

const STAGE_LABEL: Array<{ stage: TaskStage; label: string }> = [
  { stage: "match", label: "1 匹配" },
  { stage: "mapping", label: "2 映射" },
  { stage: "guards", label: "3 校验" },
  { stage: "actions", label: "4 动作" },
  // 投递在判定之前：判定段看的就是投递的响应（http 的回复 / db 的 {affected:n}），
  // 先有投递才有结论，顺序不能反过来
  { stage: "target", label: "5 投递" },
  { stage: "outcomes", label: "6 判定" },
];

/** 投递段概要：http 看服务 + 路径，db 看数据源 + 表 */
export function targetSummary(spec: TaskSpec): string {
  const target = spec.target;
  if (target.kind === "db") {
    const table = target.table?.trim() || "未填表";
    return `${target.datasource?.trim() || "未选数据源"} · ${table}`;
  }
  return target.service?.trim() || "未填服务名";
}

/** 投递段的第二行：路径或冲突策略 */
export function targetDetail(spec: TaskSpec): string {
  const target = spec.target;
  if (target.kind === "db") {
    const key = target.key?.join(",") || "无冲突键";
    return `${target.on_conflict ?? "update"} · ${key}`;
  }
  return target.base?.trim() || "未填路径前缀";
}

/**
 * 把一个任务的 spec 拆成六段概要。
 *
 * 段内只放「条数 / 名字」这类一眼能核对的信息，完整内容仍在抽屉里改 ——
 * 卡片上塞下 `$.after.op in [c,r,u,d]` 会让卡变成第二份编辑器。
 */
export function taskSegments(spec: TaskSpec): TaskSegment[] {
  const counts: Record<TaskStage, { detail: string; issues: number }> = {
    match: { detail: `${spec.match?.length ?? 0} 条断言`, issues: 0 },
    mapping: { detail: `${spec.mapping?.rows?.length ?? 0} 个字段`, issues: 0 },
    guards: { detail: `${spec.guards?.length ?? 0} 条`, issues: 0 },
    actions: { detail: `${spec.actions?.length ?? 0} 个`, issues: 0 },
    outcomes: { detail: `${spec.outcomes?.length ?? 0} 条`, issues: 0 },
    target: { detail: targetSummary(spec), issues: 0 },
  };

  // 校验问题按 path 前缀归段：`mapping.rows[3]...` 记到映射段上
  for (const issue of validateSpec(spec)) {
    const root = issue.path.split(/[.[]/)[0];
    const stage = stageOfPath(root);
    if (stage) counts[stage].issues += 1;
  }

  return STAGE_LABEL.map(({ stage, label }) => ({
    stage,
    label,
    detail: counts[stage].detail,
    issues: counts[stage].issues,
  }));
}

function stageOfPath(root: string): TaskStage | null {
  switch (root) {
    case "match":
      return "match";
    case "mapping":
      return "mapping";
    case "guards":
      return "guards";
    case "actions":
      return "actions";
    case "outcomes":
      return "outcomes";
    case "target":
      return "target";
    default:
      return null;
  }
}

/* -------------------------------- 建图 -------------------------------- */

export interface BuildGraphInput {
  datasources: DatasourceInfo[];
  sources: SyncSource[];
  tasks: SyncTask[];
  /** 注册中心里的服务名；空数组表示「没拿到」，此时不判未注册 */
  services: string[];
}

export function buildGraph({
  datasources,
  sources,
  tasks,
  services,
}: BuildGraphInput): TopologyGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const serviceSet = new Set(services);

  /* 数据源 */
  for (const ds of datasources) {
    const users = sources.filter((s) => (s.spec.datasource ?? "").trim() === ds.code);
    const issues: string[] = [];
    if (!ds.enabled && users.length > 0) {
      issues.push(`数据源已停用，但仍有 ${users.length} 个来源在引用它`);
    }
    nodes.push({
      id: nodeId("datasource", ds.code),
      kind: "datasource",
      key: ds.code,
      title: ds.name,
      subtitle: ds.target || ds.code,
      tone: !ds.enabled ? "muted" : issues.length ? "bad" : "ok",
      status: ds.enabled ? `${users.length} 个来源` : "停用",
      issues,
      hints: [],
      datasource: ds,
      producers: 0,
      consumers: users.length,
    });
  }

  /* 取数来源 */
  for (const src of sources) {
    const dsCode = (src.spec.datasource ?? "").trim();
    const issues: string[] = [];
    const hints: string[] = [];
    if (src.enabled && src.last_error) issues.push(`上一轮拉取失败：${src.last_error}`);
    if (src.enabled && !src.last_run_ms) hints.push("启用后还没跑过");
    if (dsCode && !datasources.some((d) => d.code === dsCode)) {
      issues.push(`引用的数据源 ${dsCode} 不存在`);
    }

    nodes.push({
      id: nodeId("source", src.code),
      kind: "source",
      key: src.code,
      title: src.name,
      subtitle: `${src.kind} · ${src.interval_duration} · ${src.topic}`,
      tone: !src.enabled ? "muted" : issues.length ? "bad" : "ok",
      status: !src.enabled ? "停用" : src.last_error ? "异常" : "运行中",
      issues,
      hints,
      source: src,
      producers: 0,
      consumers: 0,
    });

    if (dsCode) {
      edges.push({
        id: `e:${nodeId("datasource", dsCode)}->${nodeId("source", src.code)}`,
        from: nodeId("datasource", dsCode),
        to: nodeId("source", src.code),
        muted: !src.enabled,
      });
    }
  }

  /* 主题：来源与任务两边的 topic 求并集 */
  const topicNames = new Set<string>();
  for (const s of sources) if (s.topic) topicNames.add(s.topic);
  for (const t of tasks) if (t.topic) topicNames.add(t.topic);

  for (const topic of topicNames) {
    const producers = sources.filter((s) => s.topic === topic).length;
    const consumers = tasks.filter((t) => t.topic === topic).length;
    const hints: string[] = [];
    if (producers === 0) hints.push("没有在本控制台登记的取数来源（走 CDC 推来的可忽略）");
    if (consumers === 0 && producers > 0) hints.push("没有任务消费这个主题，拉到的事件会被丢掉");

    nodes.push({
      id: nodeId("topic", topic),
      kind: "topic",
      key: topic,
      title: topic,
      subtitle: `${producers} 个来源写入 · ${consumers} 个任务消费`,
      tone: consumers === 0 ? "warn" : "ok",
      status: consumers === 0 ? "无消费" : "正常",
      issues: [],
      hints,
      producers,
      consumers,
    });
  }

  for (const src of sources) {
    if (!src.topic) continue;
    edges.push({
      id: `e:${nodeId("source", src.code)}->${nodeId("topic", src.topic)}`,
      from: nodeId("source", src.code),
      to: nodeId("topic", src.topic),
      muted: !src.enabled,
    });
  }

  /* 任务 + 投递段 */
  for (const task of tasks) {
    const segments = taskSegments(task.spec);
    const issues: string[] = [];
    const hints: string[] = [];

    const segIssues = segments.reduce((n, s) => n + s.issues, 0);
    if (segIssues > 0) issues.push(`配置有 ${segIssues} 处待修正`);

    const target = task.spec.target;
    if (target.kind !== "db") {
      const service = (target.service ?? "").trim();
      if (!service) issues.push("没有填目标服务名");
      else if (serviceSet.size > 0 && !serviceSet.has(service)) {
        issues.push(`目标服务 ${service} 不在注册中心`);
      }
    } else if (!(target.datasource ?? "").trim()) {
      issues.push("直写库表没有选数据源");
    }

    if (!task.enabled) hints.push("任务已停用，事件会继续落到下一个任务或死信");

    nodes.push({
      id: nodeId("task", task.code),
      kind: "task",
      key: task.code,
      title: task.name || task.code,
      subtitle: `${task.code} · 优先级 ${task.priority}${task.spec.exclusive === false ? "" : " · 独占"}`,
      tone: !task.enabled ? "muted" : issues.length ? "bad" : "ok",
      status: !task.enabled ? "停用" : issues.length ? "待修正" : "启用",
      issues,
      hints,
      task,
      segments,
      producers: 0,
      consumers: 0,
    });

    if (task.topic) {
      edges.push({
        id: `e:${nodeId("topic", task.topic)}->${nodeId("task", task.code)}`,
        from: nodeId("topic", task.topic),
        to: nodeId("task", task.code),
        muted: !task.enabled,
      });
    }
  }

  // 外键对不上的连线直接丢掉，避免画出悬空的线（引用写错的来源会在这里显出「断开」）
  const ids = new Set(nodes.map((n) => n.id));
  return {
    nodes,
    edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
  };
}

/* -------------------------------- 布局 -------------------------------- */

/** 列序即数据流方向 */
const KIND_ORDER: CanvasNodeKind[] = ["datasource", "source", "topic", "task"];

/** 同列纵向间距：要容下最高的一种卡（收起态 88）与呼吸；展开只影响选中那一张 */
const ROW_GAP = 112;

/**
 * 每列最多放几张。
 *
 * 定得比较宽（12）：宁可让整张图纵向长一点、靠滚动看，也不要为了「一屏装下」把同类
 * 节点堆成两列 —— 一列换两列会把后面三个类型整体推出屏幕，用户第一眼看不到任务。
 * 超过 12 个才换列，那是真的需要缩放了。
 */
const PER_COLUMN = 12;

/** 每种卡的最大宽度（与 `TopologyCards.CARD_SIZE` 对齐），用来算列宽 */
const COLUMN_W: Record<CanvasNodeKind, number> = {
  datasource: 260,
  source: 280,
  topic: 220,
  task: 300,
};

const GAP_X = 70;

/**
 * 没有持久化坐标时按列堆叠。
 *
 * 列从左到右是数据流方向，每类节点超过 6 个就往右再起一列；列宽按卡片实际宽度推进，
 * 所以某个类型多出几列时，后面的类型整体右移，不会互相压住。
 *
 * 只按类型分列、按 key 排序，不做「按父节点对齐」这类聪明事：一旦有子节点被拖动，
 * 默认位置就会跟着变，用户会觉得「摆好的图自己动了」。默认位置稳定可预期更重要。
 */
export function defaultPositions(nodes: GraphNode[]): Record<string, CanvasNodePos> {
  const byKind: Record<CanvasNodeKind, GraphNode[]> = {
    datasource: [],
    source: [],
    topic: [],
    task: [],
  };
  for (const node of nodes) byKind[node.kind].push(node);

  const out: Record<string, CanvasNodePos> = {};
  let cursorX = 40;
  for (const kind of KIND_ORDER) {
    const list = byKind[kind].slice().sort((a, b) => a.key.localeCompare(b.key));
    const cols = Math.max(1, Math.ceil(list.length / PER_COLUMN));
    list.forEach((node, index) => {
      const col = Math.floor(index / PER_COLUMN);
      const row = index % PER_COLUMN;
      out[node.id] = {
        kind,
        key: node.key,
        x: cursorX + col * (COLUMN_W[kind] + GAP_X),
        y: 40 + row * ROW_GAP,
      };
    });
    cursorX += cols * (COLUMN_W[kind] + GAP_X);
  }
  return out;
}

/** 合并持久化坐标与默认布局：库里有的用库里的，没有的走默认 */
export function mergePositions(
  nodes: GraphNode[],
  stored: CanvasNodePos[],
): Record<string, CanvasNodePos> {
  const merged = defaultPositions(nodes);
  for (const pos of stored) {
    const id = nodeId(pos.kind, pos.key);
    if (merged[id]) merged[id] = pos;
  }
  return merged;
}
