/**
 * 拓扑建图的单测。
 *
 * 这一层是纯函数，值得锁死的只有三件事：
 * 1. 连线的方向和归属（数据源 → 来源 → 主题 → 任务）—— 画错了图就是错的；
 * 2. 状态与问题的判定口径（停用、拉取失败、目标服务未注册、配置不完整）；
 * 3. 默认布局与持久化坐标的合并规则（孤儿坐标必须丢掉，否则换库后节点会飞到画布外）。
 *
 * 不测 DOM：卡片怎么画是组件的事，这里只保证喂给它的数据是对的。
 */

import { describe, expect, it } from "vitest";
import type { DatasourceInfo, SyncSource, SyncTask, TaskSpec } from "@/lib/api/types";
import { buildGraph, defaultPositions, mergePositions, nodeId, taskSegments } from "./graph";

const audit = {
  creater_id: "0",
  create_ms: "0",
  updater_id: "0",
  update_ms: "0",
};

function ds(code: string, over: Partial<DatasourceInfo> = {}): DatasourceInfo {
  return {
    id: code,
    code,
    name: `${code} 库`,
    target: "10.0.0.1:5432/iot",
    maxConnections: 4,
    enabled: true,
    version: 1,
    remark: null,
    ...audit,
    ...over,
  };
}

function src(code: string, topic: string, over: Partial<SyncSource> = {}): SyncSource {
  return {
    id: code,
    code,
    name: `${code} 来源`,
    kind: "sql",
    topic,
    enabled: true,
    interval_duration: "60s",
    batch_size: 500,
    spec: { datasource: "iot", select: "select * from region", cursor_column: "updated_at" },
    remark: null,
    cursor: null,
    last_run_ms: "1763000000000",
    last_rows: 120,
    last_error: null,
    ...audit,
    ...over,
  };
}

function specOf(topic: string, over: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "dtw-region",
    topic,
    priority: 100,
    enabled: true,
    exclusive: true,
    target: { kind: "http", service: "dtw-rs-svr", base: "/dtw/region" },
    match: [{ field: "$.op", op: "in", value: ["c", "u"] }],
    mapping: { rows: [{ to: "id", from: "$.after.id" }] },
    // 快照读 r 是必配项（漏了历史数据补不上），所以样例任务也要有
    actions: [
      { op: "c", method: "POST", body: "mapped" },
      { op: "r", method: "POST", body: "mapped" },
    ],
    guards: [],
    outcomes: [
      { scope: "status", assert: [{ op: "eq", value: 200 }], verdict: "success" },
      { scope: "status", assert: [{ op: "in", value: [400, 500] }], verdict: "fatal" },
    ],
    ...over,
  };
}

function task(code: string, topic: string, over: Partial<SyncTask> = {}, specOver: Partial<TaskSpec> = {}): SyncTask {
  return {
    id: code,
    code,
    name: `${code} 任务`,
    topic,
    priority: 100,
    enabled: true,
    version: 1,
    spec: specOf(topic, specOver),
    stats: { total: 12400, success: 12000, skip: 400, fatal: 0, retriable: 0, p95_ms: 120, last_hit_ms: null },
    ...audit,
    ...over,
  };
}

describe("buildGraph", () => {
  it("按数据流连出 数据源 → 取数来源 → 主题 → 任务", () => {
    const graph = buildGraph({
      datasources: [ds("iot")],
      sources: [src("region_incr", "source:region_incr")],
      tasks: [task("dtw-region", "source:region_incr")],
      services: ["dtw-rs-svr"],
    });

    expect(graph.nodes.map((n) => n.kind)).toEqual(["datasource", "source", "topic", "task"]);
    expect(graph.edges).toEqual([
      {
        id: `e:${nodeId("datasource", "iot")}->${nodeId("source", "region_incr")}`,
        from: nodeId("datasource", "iot"),
        to: nodeId("source", "region_incr"),
        muted: false,
      },
      {
        id: `e:${nodeId("source", "region_incr")}->${nodeId("topic", "source:region_incr")}`,
        from: nodeId("source", "region_incr"),
        to: nodeId("topic", "source:region_incr"),
        muted: false,
      },
      {
        id: `e:${nodeId("topic", "source:region_incr")}->${nodeId("task", "dtw-region")}`,
        from: nodeId("topic", "source:region_incr"),
        to: nodeId("task", "dtw-region"),
        muted: false,
      },
    ]);

    const topic = graph.nodes.find((n) => n.kind === "topic")!;
    expect(topic.producers).toBe(1);
    expect(topic.consumers).toBe(1);
    expect(topic.tone).toBe("ok");
  });

  it("来源和任务引用同一个主题时只生成一个主题节点", () => {
    const graph = buildGraph({
      datasources: [ds("iot")],
      sources: [src("a", "dtw.region"), src("b", "dtw.region")],
      tasks: [task("t1", "dtw.region"), task("t2", "dtw.region")],
      services: [],
    });
    const topics = graph.nodes.filter((n) => n.kind === "topic");
    expect(topics).toHaveLength(1);
    expect(topics[0].producers).toBe(2);
    expect(topics[0].consumers).toBe(2);
  });

  it("停在停用来源上的连线画成虚线，节点判为 muted", () => {
    const graph = buildGraph({
      datasources: [ds("iot")],
      sources: [src("region_incr", "source:region_incr", { enabled: false })],
      tasks: [],
      services: [],
    });
    expect(graph.nodes.find((n) => n.kind === "source")!.tone).toBe("muted");
    expect(graph.edges.filter((e) => e.from.includes("source:") || e.from.startsWith("source:"))).toBeTruthy();
    expect(graph.edges.every((e) => e.to.startsWith("source:") ? e.muted : true)).toBe(true);
  });

  it("拉取失败的来源判为 bad，并把原因写进 issues", () => {
    const graph = buildGraph({
      datasources: [ds("iot")],
      sources: [src("region_incr", "source:x", { last_error: "connection refused" })],
      tasks: [],
      services: [],
    });
    const node = graph.nodes.find((n) => n.kind === "source")!;
    expect(node.tone).toBe("bad");
    expect(node.issues[0]).toContain("connection refused");
  });

  it("引用不存在的数据源时给出问题，不画悬空的线", () => {
    const graph = buildGraph({
      datasources: [],
      sources: [src("region_incr", "source:x")],
      tasks: [],
      services: [],
    });
    const node = graph.nodes.find((n) => n.kind === "source")!;
    expect(node.issues.join()).toContain("iot");
    expect(graph.edges).toHaveLength(1); // 只剩 来源 → 主题
  });

  it("目标服务不在注册中心时判为待修正；注册中心没数据时不冤枉人", () => {
    const withServices = buildGraph({
      datasources: [],
      sources: [],
      tasks: [task("dtw-region", "dtw.region")],
      services: ["jobx-svr"],
    });
    const taskNode = withServices.nodes.find((n) => n.kind === "task")!;
    expect(taskNode.issues.join()).toContain("不在注册中心");

    const noServices = buildGraph({
      datasources: [],
      sources: [],
      tasks: [task("dtw-region", "dtw.region")],
      services: [],
    });
    expect(noServices.nodes.find((n) => n.kind === "task")!.issues).toEqual([]);
  });

  it("没有任务消费的主题给黄色提示而不是错误", () => {
    const graph = buildGraph({
      datasources: [ds("iot")],
      sources: [src("region_incr", "source:region_incr")],
      tasks: [],
      services: [],
    });
    const topic = graph.nodes.find((n) => n.kind === "topic")!;
    expect(topic.tone).toBe("warn");
    expect(topic.hints.join()).toContain("没有任务消费");
    expect(topic.issues).toEqual([]);
  });
});

describe("taskSegments", () => {
  it("六段的顺序与概要固定", () => {
    const segments = taskSegments(specOf("dtw.region"));
    expect(segments.map((s) => s.stage)).toEqual([
      "match",
      "mapping",
      "guards",
      "actions",
      "outcomes",
      "target",
    ]);
    expect(segments[0].detail).toBe("1 条断言");
    expect(segments[1].detail).toBe("1 个字段");
    expect(segments[5].detail).toBe("dtw-rs-svr");
    expect(segments.every((s) => s.issues === 0)).toBe(true);
  });

  it("校验问题按 path 归到对应段", () => {
    const spec = specOf("dtw.region", { mapping: { rows: [{ to: "", from: "$.after.id" }] } });
    const segments = taskSegments(spec);
    expect(segments.find((s) => s.stage === "mapping")!.issues).toBeGreaterThan(0);
    expect(segments.find((s) => s.stage === "match")!.issues).toBe(0);
  });

  it("db 投递段显示数据源与表", () => {
    const spec = specOf("dtw.region", {
      target: { kind: "db", service: "", base: "", datasource: "iot", table: "region", key: ["id"] },
    });
    expect(taskSegments(spec)[5].detail).toBe("iot · region");
  });
});

describe("布局", () => {
  it("默认位置按类型分四列，同列按 key 递增", () => {
    const graph = buildGraph({
      datasources: [ds("b"), ds("a")],
      sources: [src("s", "t")],
      tasks: [task("t", "t")],
      services: [],
    });
    const pos = defaultPositions(graph.nodes);
    const a = pos[nodeId("datasource", "a")];
    const b = pos[nodeId("datasource", "b")];
    expect(a.x).toBe(b.x);
    expect(a.y).toBeLessThan(b.y);
    expect(pos[nodeId("source", "s")].x).toBeGreaterThan(a.x);
    expect(pos[nodeId("task", "t")].x).toBeGreaterThan(pos[nodeId("source", "s")].x);
  });

  it("持久化坐标覆盖默认值，孤儿坐标被丢弃", () => {
    const graph = buildGraph({
      datasources: [ds("iot")],
      sources: [],
      tasks: [],
      services: [],
    });
    const merged = mergePositions(graph.nodes, [
      { kind: "datasource", key: "iot", x: 900, y: 700 },
      { kind: "datasource", key: "gone", x: 1, y: 2 },
    ]);
    expect(merged[nodeId("datasource", "iot")]).toMatchObject({ x: 900, y: 700 });
    expect(Object.keys(merged)).toEqual([nodeId("datasource", "iot")]);
  });
});
