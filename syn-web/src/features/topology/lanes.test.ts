/**
 * 泳道布局的单测。只锁三件会画错图的事：
 * 1. 一个主题一条泳道，主题节点跨行居中、抽取/任务各占一行；
 * 2. 共用数据源去重、落在第一条引用它的那一行，其余连线弯过去；
 * 3. 没有主题 / 没被引用的孤儿节点不丢，落进最后一条泳道。
 */
import { describe, expect, it } from "vitest";
import type { DatasourceInfo, SyncSource, SyncTask, TaskSpec } from "@/lib/api/types";
import { buildGraph, nodeId } from "./graph";
import { buildLanes, ORPHAN_LANE, orderedTaskIds } from "./lanes";

const audit = {
  creater_id: "0",
  create_ms: "0",
  updater_id: "0",
  update_ms: "0",
};

function ds(code: string): DatasourceInfo {
  return {
    id: code,
    code,
    name: `${code} 库`,
    engine: "postgres",
    target: "10.0.0.1:5432/iot",
    maxConnections: 4,
    enabled: true,
    version: 1,
    remark: null,
    ...audit,
  };
}

function src(code: string, topic: string, datasource = "iot"): SyncSource {
  return {
    id: code,
    code,
    name: `${code} 抽取`,
    kind: "sql",
    topic,
    enabled: true,
    interval_duration: "60s",
    batch_size: 500,
    spec: { datasource, mode: "cursor" },
    remark: null,
    cursor: null,
    last_run_ms: null,
    last_rows: 0,
    last_error: null,
    ...audit,
  };
}

function specOf(topic: string, sortOrder = 100): TaskSpec {
  return {
    topic,
    sort_order: sortOrder,
    enabled: true,
    exclusive: true,
    target: { kind: "http", service: "dtw-rs-svr", base: "" },
    match: [],
    mapping: { rows: [] },
    actions: [],
    guards: [],
    outcomes: [],
  };
}

function task(id: string, topic: string, sortOrder = 100): SyncTask {
  return {
    id,
    name: `${id} 任务`,
    topic,
    sort_order: sortOrder,
    enabled: true,
    version: 1,
    spec: specOf(topic, sortOrder),
    stats: {
      total: 0,
      success: 0,
      skip: 0,
      fatal: 0,
      retriable: 0,
      p95_ms: 0,
      last_hit_ms: null,
    },
    ...audit,
  };
}

describe("buildLanes", () => {
  it("一个主题一条泳道：抽取在左、主题跨行居中、任务在右", () => {
    const graph = buildGraph({
      datasources: [ds("iot")],
      sources: [src("a", "dtw.region"), src("b", "dtw.region")],
      tasks: [task("t1", "dtw.region", 200), task("t2", "dtw.region", 100)],
      services: [],
    });
    const model = buildLanes(graph);

    expect(model.lanes).toHaveLength(1);
    const lane = model.lanes[0];
    expect(lane.key).toBe("dtw.region");
    expect(lane.topic?.id).toBe(nodeId("topic", "dtw.region"));
    expect(lane.sources.map((n) => n.key)).toEqual(["a", "b"]);
    // 任务按 sort_order 升序，即匹配优先级
    expect(lane.tasks.map((n) => n.key)).toEqual(["t2", "t1"]);
    expect(orderedTaskIds(lane)).toEqual(["t2", "t1"]);
    expect(lane.rowCount).toBe(2);
    expect(lane.startRow).toBe(1);
  });

  it("共用数据源只画一个节点，落在第一条引用它的那一行", () => {
    const graph = buildGraph({
      datasources: [ds("iot")],
      sources: [src("a", "t1"), src("b", "t2")],
      tasks: [],
      services: [],
    });
    const model = buildLanes(graph);

    expect(model.datasources).toHaveLength(1);
    expect(model.datasources[0].node.key).toBe("iot");
    expect(model.datasources[0].row).toBe(1);
    expect(model.datasources[0].refs).toBe(2);
  });

  it("行数不足的一侧留空，但主题节点仍跨满整条泳道", () => {
    const graph = buildGraph({
      datasources: [],
      // 三个任务消费一个 CDC 主题，没有本地抽取
      sources: [],
      tasks: [task("t1", "cdt", 1), task("t2", "cdt", 2), task("t3", "cdt", 3)],
      services: [],
    });
    const model = buildLanes(graph);

    expect(model.lanes).toHaveLength(1);
    expect(model.lanes[0].sources).toEqual([]);
    expect(model.lanes[0].tasks).toHaveLength(3);
    expect(model.lanes[0].rowCount).toBe(3);
  });

  it("泳道之间有空行，行数把间隔算进去", () => {
    const graph = buildGraph({
      datasources: [],
      sources: [],
      tasks: [task("t1", "a"), task("t2", "b")],
      services: [],
    });
    const model = buildLanes(graph);

    expect(model.lanes).toHaveLength(2);
    expect(model.lanes[0].rowCount).toBe(1);
    expect(model.lanes[1].startRow).toBe(3); // 第 1 行 + 第 2 行空行
    expect(model.rows).toBe(3);
  });

  it("没有主题 / 没被引用的数据源落进孤儿泳道，不丢节点", () => {
    const graph = buildGraph({
      datasources: [ds("orphan-ds")],
      sources: [src("no-topic", "")],
      tasks: [task("no-topic-task", "")],
      services: [],
    });
    const model = buildLanes(graph);

    const orphan = model.lanes.find((l) => l.key === ORPHAN_LANE);
    expect(orphan).toBeDefined();
    expect(orphan!.sources.map((n) => n.key)).toEqual(["no-topic"]);
    expect(orphan!.tasks.map((n) => n.key)).toEqual(["no-topic-task"]);
    expect(model.datasources.map((s) => s.node.key)).toEqual(["orphan-ds"]);
  });

  it("空图给出一条空泳道，画布不会算出 0 行", () => {
    const model = buildLanes(buildGraph({ datasources: [], sources: [], tasks: [], services: [] }));
    expect(model.rows).toBeGreaterThanOrEqual(1);
  });
});
