/**
 * # 泳道布局模型（纯函数，便于单测）
 *
 * 把 `buildGraph` 产出的「节点 + 连线」摊成一张泳道网格，学习 uiam 网关配置那张
 * 「监听器 → 路由 → 目标 → 后端」图的结构：
 *
 * ```
 * 数据源(col1) → 数据抽取(col2) → 主题(col3) → 任务(col4)
 * ```
 *
 * ## 行由「主题」决定
 *
 * 一个主题 = 一条泳道。写它的抽取排在 col2、读它的任务排在 col4，各占一行；
 * 主题节点在 col3 跨这几行并垂直居中 —— 视觉上就是一根「数据总线」，几条抽取
 * 汇进来、几个任务分出去。行数是 `max(抽取数, 任务数, 1)`，多出来的一侧留空。
 *
 * ## 为什么数据源去重
 *
 * 一个数据源常被多条抽取共用。跟 uiam 里「几条路由共用一个 LB」同理：同名数据源
 * 只画一个节点，落在**第一条引用它的抽取**那一行，其余抽取的连线弯过去汇到它。
 * 这样「谁和谁共用一个连接池」在图上直接看得见，而不是画 N 个同名盒子。
 *
 * ## 连线不在这里算
 *
 * 边的方向/归属完全由 `graph.edges` 决定，这里只决定**节点落在哪一行**。画布按
 * `data-node` 从 DOM 量出盒子后再画贝塞尔曲线；模型重复一遍连线只会多出一份
 * 会和真实配置对不上的状态。
 *
 * ## 孤儿节点
 *
 * 没有主题的抽取 / 任务、以及没有任何抽取引用的数据源，落进最后一条 `__orphan`
 * 泳道，按各自的列排布。它们通常是「写了一半」的配置，留在图上比丢掉更有用。
 */
import type { GraphNode, TopologyGraph } from "./graph";

export const ORPHAN_LANE = "__orphan";

export interface Lane {
  /** 主题名，或 `ORPHAN_LANE` */
  key: string;
  /** 写这个主题的抽取（col2），每行一个 */
  sources: GraphNode[];
  /** 跨行居中的主题节点（col3）；孤儿泳道没有 */
  topic?: GraphNode;
  /** 读这个主题的任务（col4），按 sort_order 排，每行一个 */
  tasks: GraphNode[];
  /** 该泳道第一行在 grid 里的行号（1 基） */
  startRow: number;
  /** 占用行数 = max(sources, tasks, 1) */
  rowCount: number;
}

export interface DatasourceSlot {
  node: GraphNode;
  /** 落在哪一行（第一条引用它的抽取） */
  row: number;
  /** 被几条抽取引用 */
  refs: number;
}

export interface SwimlaneModel {
  lanes: Lane[];
  /** 去重后的数据源及其落点 */
  datasources: DatasourceSlot[];
  /** 总行数（含泳道间隔空行） */
  rows: number;
}

const byKey = (a: GraphNode, b: GraphNode) => a.key.localeCompare(b.key);
/** 任务的 sort_order 就是匹配优先级，泳道里从上到下按它排（拖动即改顺序） */
const bySort = (a: GraphNode, b: GraphNode) =>
  (a.task?.sort_order ?? 0) - (b.task?.sort_order ?? 0) || a.id.localeCompare(b.id);

interface Bucket {
  topic?: GraphNode;
  sources: GraphNode[];
  tasks: GraphNode[];
}

export function buildLanes(graph: TopologyGraph): SwimlaneModel {
  const datasources = graph.nodes.filter((n) => n.kind === "datasource");
  const sources = graph.nodes.filter((n) => n.kind === "source");
  const topics = graph.nodes.filter((n) => n.kind === "topic");
  const tasks = graph.nodes.filter((n) => n.kind === "task");
  const dsByCode = new Map(datasources.map((d) => [d.key, d]));

  /* 先按主题分桶；孤儿先归拢好，后面才知道要不要留最后一道间隔 */
  const buckets: Array<{ key: string; bucket: Bucket }> = [];
  const bucketByTopic = new Map<string, Bucket>();
  for (const topic of topics.slice().sort(byKey)) {
    const bucket: Bucket = { topic, sources: [], tasks: [] };
    bucketByTopic.set(topic.key, bucket);
    buckets.push({ key: topic.key, bucket });
  }

  const orphan: Bucket = { sources: [], tasks: [] };
  for (const source of sources.slice().sort(byKey)) {
    const topic = (source.source?.topic ?? "").trim();
    const bucket = topic ? bucketByTopic.get(topic) : undefined;
    if (bucket) bucket.sources.push(source);
    else orphan.sources.push(source);
  }
  for (const task of tasks.slice().sort(bySort)) {
    const topic = (task.task?.topic ?? "").trim();
    const bucket = topic ? bucketByTopic.get(topic) : undefined;
    if (bucket) bucket.tasks.push(task);
    else orphan.tasks.push(task);
  }

  const lanes: Lane[] = [];
  const slots: DatasourceSlot[] = [];
  const placed = new Set<string>();
  const placeDs = (node: GraphNode, atRow: number) => {
    const existing = slots.find((s) => s.node.id === node.id);
    if (existing) {
      existing.refs += 1;
      return;
    }
    slots.push({ node, row: atRow, refs: 1 });
    placed.add(node.id);
  };

  // 有没有孤儿要留位，取决于最后还会不会多出一条泳道；此时 placed 还是空的，
  // 所以「数据源全被引用」不能靠它判断 —— 用「有没有数据源没被任何抽取引用」来算。
  const allReferencedDs = datasources.every((d) =>
    sources.some((s) => (s.source?.spec.datasource ?? "").trim() === d.key),
  );
  const hasOrphan =
    orphan.sources.length > 0 || orphan.tasks.length > 0 || !allReferencedDs;

  let row = 1;
  buckets.forEach(({ key, bucket }, index) => {
    const rowCount = Math.max(bucket.sources.length, bucket.tasks.length, 1);
    lanes.push({
      key,
      topic: bucket.topic,
      sources: bucket.sources,
      tasks: bucket.tasks,
      startRow: row,
      rowCount,
    });
    bucket.sources.forEach((source, i) => {
      const code = (source.source?.spec.datasource ?? "").trim();
      const ds = code ? dsByCode.get(code) : undefined;
      if (ds) placeDs(ds, row + i);
    });
    row += rowCount;
    if (index < buckets.length - 1 || hasOrphan) row += 1;
  });

  const leftoverDs = datasources.filter((d) => !placed.has(d.id)).sort(byKey);
  if (orphan.sources.length || orphan.tasks.length || leftoverDs.length) {
    const rowCount = Math.max(
      orphan.sources.length,
      orphan.tasks.length,
      leftoverDs.length,
      1,
    );
    lanes.push({
      key: ORPHAN_LANE,
      sources: orphan.sources,
      tasks: orphan.tasks,
      startRow: row,
      rowCount,
    });
    leftoverDs.forEach((ds, i) => placeDs(ds, row + i));
  }

  return { lanes, datasources: slots, rows: Math.max(row - 1, 1) };
}

/** 一条泳道里任务的当前顺序（拖动落库用） */
export function orderedTaskIds(lane: Lane): string[] {
  return lane.tasks.map((t) => t.task!.id);
}
