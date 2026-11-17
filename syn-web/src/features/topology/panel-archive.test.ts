/**
 * 控制面板导出 / 导入的模型单测。
 *
 * 锁三件事：
 * 1. 导出的结构摘要与组件数据一致（泳道、孤儿、计数）；
 * 2. 文件解析的校验口径（kind / version / 编码 / spec）与结构摘要的重建；
 * 3. 导入预检的动作与阻断项 —— 预览说「能导」，后端就不该因为引用问题回滚。
 *
 * 不做端到端导入：真正的写入在后端单事务里，前端只负责这份 plan。
 */

import { describe, expect, it } from "vitest";
import type {
  DatasourceInfo,
  PanelExport,
  PanelSource,
  PanelTask,
  PanelDatasource,
  SourceSpec,
  SyncSource,
  SyncTask,
  TaskSpec,
} from "@/lib/api/types";
import {
  archiveFileName,
  buildArchive,
  missingUrlCodes,
  parseArchive,
  planCounts,
  planImport,
  type CurrentPanel,
} from "./panel-archive";

const audit = { creater_id: "0", create_ms: "0", updater_id: "0", update_ms: "0" };

function panelDs(code: string, over: Partial<PanelDatasource> = {}): PanelDatasource {
  return {
    code,
    name: `${code} 库`,
    engine: "postgres",
    url: `postgres://user:pass@db.local:5432/${code}`,
    maxConnections: 4,
    enabled: true,
    remark: null,
    target: `db.local:5432/${code}`,
    ...over,
  };
}

function panelSrc(code: string, topic: string, over: Partial<PanelSource> = {}): PanelSource {
  return {
    code,
    name: `${code} 抽取`,
    kind: "sql",
    topic,
    enabled: true,
    interval_duration: "60s",
    batch_size: 500,
    spec: {
      datasource: "iot",
      mode: "cursor",
      table: "region",
      cursor_field: "updated_at",
      cursor_type: "timestamptz",
      tie_field: "id",
      tie_type: "bigint",
    },
    remark: null,
    ...over,
  };
}

function taskSpec(topic: string, over: Partial<TaskSpec> = {}): TaskSpec {
  return {
    topic,
    sort_order: 10,
    enabled: true,
    exclusive: true,
    target: { kind: "http", service: "dtw-rs-svr", base: "/dtw/region" },
    match: [],
    mapping: { rows: [] },
    actions: [],
    guards: [],
    outcomes: [],
    ...over,
  } as TaskSpec;
}

function panelTask(name: string, topic: string, over: Partial<PanelTask> = {}): PanelTask {
  return {
    name,
    topic,
    sort_order: 10,
    enabled: true,
    exclusive: true,
    remark: null,
    spec: taskSpec(topic),
    ...over,
  };
}

function currentDs(code: string): DatasourceInfo {
  return {
    id: `ds-${code}`,
    code,
    name: `${code} 库`,
    engine: "postgres",
    target: "db.local:5432/iot",
    maxConnections: 4,
    enabled: true,
    version: 1,
    remark: null,
    ...audit,
  };
}

function currentSrc(code: string, topic: string, spec: SourceSpec = { datasource: "iot" }): SyncSource {
  return {
    id: `src-${code}`,
    code,
    name: `${code} 抽取`,
    kind: "sql",
    topic,
    enabled: true,
    interval_duration: "60s",
    batch_size: 500,
    spec,
    remark: null,
    cursor: null,
    last_run_ms: null,
    last_rows: 0,
    last_error: null,
    ...audit,
  };
}

function currentTask(name: string, topic: string, sort = 10): SyncTask {
  return {
    id: `task-${name}`,
    name,
    topic,
    sort_order: sort,
    enabled: true,
    version: 1,
    spec: taskSpec(topic, { sort_order: sort }),
    stats: { total: 0, success: 0, skip: 0, fatal: 0, retriable: 0, p95_ms: 0, last_hit_ms: null },
    ...audit,
  };
}

function exportPayload(
  datasources: PanelDatasource[],
  sources: PanelSource[],
  tasks: PanelTask[],
): PanelExport {
  return { exported_ms: "1763000000000", datasources, sources, tasks };
}

describe("buildArchive", () => {
  it("补出泳道结构、计数，并把任务的索引列对齐到 spec", () => {
    const payload = exportPayload(
      [panelDs("iot"), panelDs("adm")],
      [panelSrc("s1", "dtw.region"), panelSrc("s2", "dtw.region")],
      [
        panelTask("t1", "dtw.region", { sort_order: 20, enabled: false, exclusive: false }),
        panelTask("t2", "adm.people", { sort_order: 5 }),
      ],
    );
    const archive = buildArchive(payload, Date.parse("2026-11-17T07:55:00Z"));

    expect(archive.kind).toBe("syn-control-panel");
    expect(archive.summary).toEqual({ datasources: 2, sources: 2, tasks: 2, topics: 2 });
    expect(archive.panel.lanes.map((l) => l.topic)).toEqual(["adm.people", "dtw.region"]);
    const lane = archive.panel.lanes.find((l) => l.topic === "dtw.region")!;
    expect(lane.sources).toEqual(["s1", "s2"]);
    expect(lane.tasks).toEqual([{ name: "t1", topic: "dtw.region", sort_order: 20 }]);

    const t1 = archive.tasks.find((t) => t.name === "t1")!;
    expect(t1.spec).toMatchObject({
      topic: "dtw.region",
      sort_order: 20,
      enabled: false,
      exclusive: false,
    });
    expect(archive.exported_at).toBe("2026-11-17T07:55:00.000Z");
  });

  it("没有主题的组件进 orphans，不生成空泳道", () => {
    const archive = buildArchive(
      exportPayload([], [panelSrc("s1", "")], [panelTask("t1", "")]),
      0,
    );
    expect(archive.panel.lanes).toEqual([]);
    expect(archive.panel.orphans.sources).toEqual(["s1"]);
    expect(archive.panel.orphans.tasks).toHaveLength(1);
  });
});

describe("parseArchive", () => {
  it("导出 → JSON → 解析，结构完整", () => {
    const archive = buildArchive(
      exportPayload(
        [panelDs("iot")],
        [panelSrc("s1", "dtw.region")],
        [panelTask("t1", "dtw.region")],
      ),
    );
    const parsed = parseArchive(JSON.stringify(archive));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.archive.datasources[0].url).toContain("postgres://");
    expect(parsed.archive.summary).toEqual({ datasources: 1, sources: 1, tasks: 1, topics: 1 });
    expect(parsed.warnings).toEqual([]);
  });

  it("结构摘要被手工改过只提示，按组件重建", () => {
    const archive = buildArchive(exportPayload([], [panelSrc("s1", "a")], []));
    const tampered = {
      ...archive,
      panel: { lanes: [], orphans: { sources: [], tasks: [] } },
      summary: { datasources: 9, sources: 9, tasks: 9, topics: 9 },
    };
    const parsed = parseArchive(JSON.stringify(tampered));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.archive.panel.lanes.map((l) => l.topic)).toEqual(["a"]);
  });

  it("拒绝错误 kind / 版本 / 编码缺失 / 重复编码", () => {
    expect(parseArchive("{}")).toMatchObject({ ok: false });
    expect(parseArchive(JSON.stringify({ kind: "syn-control-panel", version: 99 }))).toMatchObject({
      ok: false,
    });

    const base = buildArchive(
      exportPayload([panelDs("iot")], [panelSrc("s1", "a")], []),
    );
    const noCode = JSON.parse(JSON.stringify(base));
    delete noCode.datasources[0].code;
    const r1 = parseArchive(JSON.stringify(noCode));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errors[0]).toContain("datasources[0].code");

    const dup = JSON.parse(JSON.stringify(base));
    dup.sources.push({ ...dup.sources[0], name: "另一条" });
    const r2 = parseArchive(JSON.stringify(dup));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors.join()).toContain("重复");
  });

  it("坏 JSON 给出可读错误", () => {
    const parsed = parseArchive("{not json");
    expect(parsed.ok).toBe(false);
  });
});

describe("planImport", () => {
  const current: CurrentPanel = {
    datasources: [currentDs("iot")],
    sources: [currentSrc("s1", "dtw.region")],
    tasks: [currentTask("t1", "dtw.region")],
  };
  const archive = buildArchive(
    exportPayload(
      [panelDs("iot"), panelDs("adm")],
      [panelSrc("s1", "dtw.region"), panelSrc("s2", "adm.people", {
        spec: { datasource: "adm", mode: "cursor", table: "people" },
      })],
      [panelTask("t1", "dtw.region"), panelTask("t2", "adm.people")],
    ),
  );

  it("覆盖模式：同 code 更新、缺的新建；新增数据源要求补连接串", () => {
    const plan = planImport(archive, current, "overwrite");
    expect(plan.datasources.map((r) => [r.code, r.action, r.needsUrl])).toEqual([
      ["iot", "update", false],
      ["adm", "create", true],
    ]);
    expect(plan.sources.map((r) => [r.code, r.action])).toEqual([
      ["s1", "update"],
      ["s2", "create"],
    ]);
    expect(plan.tasks.map((r) => [r.name, r.action])).toEqual([
      ["t1", "update"],
      ["t2", "create"],
    ]);
    expect(plan.blockers).toEqual([]);
  });

  it("仅补缺模式：已存在的全部跳过，只算新增", () => {
    const plan = planImport(archive, current, "skip");
    expect(planCounts(plan)).toEqual({ create: 3, update: 0, skip: 3 });
    expect(plan.sources[0].action).toBe("skip");
    expect(plan.tasks[0].action).toBe("skip");
  });

  it("改主题把旧主题让给文件里另一条抽取，不算冲突", () => {
    const takeover = buildArchive(
      exportPayload(
        [],
        [panelSrc("s1", "fresh"), panelSrc("s2", "dtw.region")],
        [],
      ),
    );
    expect(planImport(takeover, current, "overwrite").blockers).toEqual([]);
  });

  it("文件内两条抽取争同一主题仍然阻断", () => {
    const clash = buildArchive(
      exportPayload(
        [panelDs("iot")],
        [panelSrc("s2", "dup"), panelSrc("s3", "dup")],
        [],
      ),
    );
    const plan = planImport(clash, { datasources: [], sources: [], tasks: [] }, "overwrite");
    expect(plan.blockers.join()).toContain("已被 s2 占用");
  });

  it("主题被另一条抽取占用时阻断", () => {
    const clash = buildArchive(
      exportPayload([], [panelSrc("s2", "dtw.region")], []),
    );
    const plan = planImport(clash, current, "overwrite");
    expect(plan.blockers.join()).toContain("已被 s1 占用");
  });

  it("抽取引用不存在的数据源 / db 任务引用不存在的数据源都阻断", () => {
    const missingDs = buildArchive(
      exportPayload(
        [panelDs("iot")],
        [panelSrc("s1", "a", { spec: { datasource: "gone" } })],
        [],
      ),
    );
    expect(planImport(missingDs, { datasources: [], sources: [], tasks: [] }, "overwrite").blockers.join()).toContain(
      "数据源 gone",
    );

    const dbTask = buildArchive(
      exportPayload(
        [panelDs("iot")],
        [],
        [
          panelTask("t1", "a", {
            spec: taskSpec("a", {
              target: {
                kind: "db",
                service: "",
                base: "",
                datasource: "gone",
                table: "t",
                key: ["id"],
              },
            }),
          }),
        ],
      ),
    );
    expect(planImport(dbTask, { datasources: [], sources: [], tasks: [] }, "overwrite").blockers.join()).toContain(
      "任务 t1 直写的数据源 gone",
    );
  });

  it("缺失连接串只对新建行生效", () => {
    const plan = planImport(archive, current, "overwrite");
    expect(missingUrlCodes(plan, { iot: "x" })).toEqual(["adm"]);
    expect(missingUrlCodes(plan, { adm: "postgres://x" })).toEqual([]);
  });
});

describe("archiveFileName", () => {
  it("按本地时间命名，分钟级、可排序", () => {
    const archive = buildArchive(exportPayload([], [], []), Date.parse("2026-11-17T07:55:00Z"));
    const name = archiveFileName(archive, new Date(2026, 10, 17, 15, 30));
    expect(name).toMatch(/^syn-control-panel-\d{8}-\d{4}\.json$/);
    expect(name).toContain("syn-control-panel-");
  });
});
