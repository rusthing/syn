/**
 * 实时模式 wire → 实体的契约测试。
 *
 * 这些断言锁的不是「转换逻辑写对了」，而是**后端的输出形状**：哪天有人把
 * `SynTaskVo` 改成 snake_case、把 `U64` 换成数字、或在 `SyncVerdict` 上挂了
 * serde 字符串序列化，前端不会白屏也不会报错，只会安静地显示错数据。
 * 所以每个转换点都要有一个用例，改 VO 时这里先红。
 *
 * 只 stub `fetch`，不启动服务：这一层的职责是拆信封与改字段名，不是连通性。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  liveDatasources,
  liveDeliveries,
  liveIdem,
  liveOverview,
  liveSources,
  liveTasks,
} from "./live";

function reply(extra: unknown) {
  return {
    ok: true,
    status: 200,
    text: () =>
      Promise.resolve(
        JSON.stringify({ result: 1, msg: "ok", timestamp: "1763000000000", extra }),
      ),
  } as unknown as Response;
}

/** 按调用顺序给出若干响应；同时把每次的 URL 记下来，验 query 参数改名 */
function stubFetch(...extras: unknown[]) {
  const urls: string[] = [];
  const spy = vi.fn((input: string | URL | Request) => {
    urls.push(String(input));
    const extra = extras.shift();
    return Promise.resolve(reply(extra));
  });
  vi.stubGlobal("fetch", spy);
  return urls;
}

/** 写请求要连 method / body 一起看：字段改名和字典整数都只在这里能验到 */
function capture(...extras: unknown[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const spy = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(reply(extras.shift()));
  });
  vi.stubGlobal("fetch", spy);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const taskVo = {
  id: "18446744073709551615",
  code: "person_to_dtw",
  name: "人员同步",
  topic: "adm.person",
  priority: 10,
  enabled: true,
  exclusive: true,
  version: 3,
  spec: { topic: "adm.person", priority: 10, target: {}, mapping: { rows: [] } },
  createrId: "100237",
  createMs: "1763000000000",
  updaterId: "100238",
  updateMs: "1763000001000",
};

describe("liveTasks", () => {
  it("PageRx → Page：total 去字符串，审计列回 snake_case，spec.id 以 code 列为准", async () => {
    stubFetch({ pageNum: "1", total: "7", list: [taskVo] });
    const page = await liveTasks.page({ pageNum: 2, enabled: false });

    expect(page.total).toBe(7);
    expect(page.list).toHaveLength(1);
    const task = page.list[0];
    expect(task.id).toBe("18446744073709551615"); // U64 不被 Number 截断
    expect(task.spec.id).toBe("person_to_dtw");
    expect(task.creater_id).toBe("100237");
    expect(task.create_ms).toBe("1763000000000");
    expect(task.updater_id).toBe("100238");
    expect(task.update_ms).toBe("1763000001000");
    // 后端没有逐任务统计：诚实置 0，不编数
    expect(task.stats).toEqual({
      total: 0,
      success: 0,
      skip: 0,
      fatal: 0,
      retriable: 0,
      p95_ms: 0,
      last_hit_ms: null,
    });
  });

  it("query 原样透传 camelCase（pageNum / enabled=false 不能被当成空值丢掉）", async () => {
    const urls = stubFetch({ total: "0", list: [] });
    await liveTasks.page({ pageNum: 2, pageSize: 20, enabled: false, keyword: "人" });
    expect(urls[0]).toContain("pageNum=2");
    expect(urls[0]).toContain("enabled=false");
  });

  it("reload 的 Ro<u64>.extra → { count }", async () => {
    stubFetch(12);
    await expect(liveTasks.reload()).resolves.toEqual({ count: 12 });
  });

  it("remove 的 Ro<()> 没有 extra，落成 null", async () => {
    stubFetch(undefined);
    await expect(liveTasks.remove("1")).resolves.toBeNull();
  });
});

describe("liveSources", () => {
  const sourceVo = {
    id: "42",
    code: "adm_person",
    name: "人员表",
    kind: 0,
    topic: "source:adm_person",
    enabled: true,
    intervalDuration: "30s",
    batchSize: 500,
    spec: { datasource: "adm", cursor_column: "updated_at,id" },
    version: 1,
    cursor: {
      position: "1763003520,8821",
      rowsSynced: 184320,
      lastRunMs: "1763003520000",
      lastError: null,
    },
    createrId: "0",
    createMs: "1762900000000",
    updaterId: "0",
    updateMs: "1763003520000",
  };

  it("字典整数 → 小写字符串，游标字段名与层级按前端实体还原", async () => {
    stubFetch([sourceVo]);
    const [source] = await liveSources.list();
    expect(source.kind).toBe("sql");
    expect(source.interval_duration).toBe("30s");
    expect(source.batch_size).toBe(500);
    expect(source.cursor).toEqual({
      position: "1763003520,8821",
      updated_ms: "1763003520000",
      rows_total: 184320,
    });
    expect(source.last_run_ms).toBe("1763003520000");
    expect(source.last_error).toBeNull();
    expect(source.last_rows).toBe(0); // 后端不存上一轮行数
  });

  it("pull：durationMs → duration_ms，并把本轮行数回填下一次 list", async () => {
    stubFetch(
      { rows: 37, durationMs: 128, success: 37, skip: 0, fatal: 0, retriable: 0, position: "p1" },
      [{ ...sourceVo, cursor: { ...sourceVo.cursor } }],
    );
    const result = await liveSources.pull("42");
    expect(result.rows).toBe(37);
    expect(result.duration_ms).toBe(128);
    expect(result.stalled).toBeNull();

    const [source] = await liveSources.list();
    expect(source.last_rows).toBe(37);
  });

  it("pull 被卡住时把 stalled 透出来，界面才能说明为什么没继续推进", async () => {
    stubFetch({
      rows: 3,
      durationMs: 90,
      success: 3,
      skip: 0,
      fatal: 1,
      retriable: 0,
      stalled: "GUARD_FAILED",
    });
    await expect(liveSources.pull("42")).resolves.toMatchObject({
      rows: 3,
      stalled: "GUARD_FAILED",
    });
  });

  const saveInput = {
    code: "adm_person",
    name: "人员表",
    kind: "sql" as const,
    topic: "",
    enabled: true,
    intervalDuration: "30s",
    batchSize: 500,
    spec: { datasource: "adm", cursor_column: "updated_at,id" },
    remark: "",
  };

  it("create 把 kind 的字符串转成 #[dic] 的 INT2，并去掉空 topic/remark", async () => {
    const calls = capture(sourceVo);
    await liveSources.create(saveInput);

    expect(calls[0].url).toBe("/syn/source");
    expect(calls[0].init.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.kind).toBe(0); // sql
    expect(body.intervalDuration).toBe("30s");
    expect(body.spec.cursor_column).toBe("updated_at,id"); // JSONB 内部保持 snake_case
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("topic");
    expect(body).not.toHaveProperty("remark");
  });

  it("http 来源的 kind 是 1；写字符串会被后端 serde 挡掉", async () => {
    const calls = capture(sourceVo);
    await liveSources.create({ ...saveInput, kind: "http" });
    expect(JSON.parse(String(calls[0].init.body)).kind).toBe(1);
  });

  it("update 走 PUT /syn/source/{id}，id 不进 body", async () => {
    const calls = capture(sourceVo);
    await liveSources.update("18446744073709551615", { ...saveInput, id: "18446744073709551615" });
    expect(calls[0].url).toBe("/syn/source/18446744073709551615"); // U64 不截断
    expect(calls[0].init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty("id");
  });

  it("remove 走 DELETE，Vo 里的 remark 回到前端实体", async () => {
    const calls = capture(undefined, [{ ...sourceVo, remark: "联调用" }]);
    await expect(liveSources.remove("42")).resolves.toBeNull();
    expect(calls[0].init.method).toBe("DELETE");
    const [source] = await liveSources.list();
    expect(source.remark).toBe("联调用");
  });
});

describe("liveDatasources", () => {
  it("只读清单把 camelCase 转成前端实体，脱敏目标原样透出", async () => {
    const calls = capture([
      { name: "dtw", target: "pgsql:5432/dtwrs_ui", maxConnections: 4 },
      { name: "adm", target: null, maxConnections: "8" },
    ]);
    const rows = await liveDatasources.list();
    expect(calls[0].url).toBe("/syn/datasource/list");
    expect(rows).toEqual([
      { name: "dtw", target: "pgsql:5432/dtwrs_ui", maxConnections: 4 },
      { name: "adm", target: null, maxConnections: 8 },
    ]);
  });
});

describe("liveDeliveries / liveIdem / liveOverview", () => {
  it("投递记录 camelCase → snake_case，可空字段缺省补 null/空串", async () => {
    stubFetch({
      total: "1",
      list: [
        {
          id: "9",
          taskCode: "person_to_dtw",
          verdict: "success",
          code: "ok",
          stage: "verdict",
          recordKey: "adm.person:0:17",
          latencyMs: 0,
          httpStatus: 200,
          createMs: "1763000000000",
        },
      ],
    });
    const page = await liveDeliveries.page({ task_code: "person_to_dtw" });
    expect(page.list[0]).toMatchObject({
      task_code: "person_to_dtw",
      record_key: "adm.person:0:17",
      latency_ms: 0,
      http_status: 200,
      create_ms: "1763000000000",
      topic: "",
      op: null,
      detail: null,
    });
  });

  it("投递查询的 task_code 要改名成 taskCode", async () => {
    const urls = stubFetch({ total: "0", list: [] });
    await liveDeliveries.page({ task_code: "abc", verdict: "fatal" });
    expect(urls[0]).toContain("taskCode=abc");
    expect(urls[0]).not.toContain("task_code");
  });

  it("幂等台账 INT2 verdict → 字符串，一行一个键所以 hits = 1", async () => {
    stubFetch({
      total: "2",
      list: [
        {
          id: "1",
          taskCode: "t1",
          idemKey: "k1",
          verdict: 2,
          code: "bad",
          createMs: "1763000000000",
          updateMs: "1763000001000",
        },
        {
          id: "2",
          taskCode: "t2",
          idemKey: "k2",
          verdict: 3,
          code: "retry",
          createMs: "1763000000000",
          updateMs: "1763000002000",
        },
      ],
    });
    const page = await liveIdem.page();
    expect(page.list[0]).toEqual({
      id: "1",
      task_code: "t1",
      idem_key: "k1",
      hits: 1,
      verdict: "fatal",
      first_ms: "1763000000000",
      last_ms: "1763000001000",
    });
    expect(page.list[1].verdict).toBe("retriable");
  });

  it("总览：统计列回 snake_case，hourMs 从 U64 字符串转成画图用的 number", async () => {
    stubFetch({
      window: "24h",
      total: 100,
      success: 95,
      skip: 2,
      fatal: 2,
      retriable: 1,
      p95Ms: 0,
      tasks: 4,
      enabledTasks: 3,
      sources: 2,
      stalledSources: 1,
      series: [{ hourMs: "1762999200000", success: 10, fatal: 1, retriable: 0 }],
      topFailures: [{ code: "GUARD_FAILED", taskCode: "t1", count: 2 }],
    });
    const data = await liveOverview.get("24h");
    expect(data).toMatchObject({
      p95_ms: 0,
      enabled_tasks: 3,
      stalled_sources: 1,
      top_failures: [{ code: "GUARD_FAILED", task_code: "t1", count: 2 }],
    });
    expect(data.series[0]).toEqual({
      hour_ms: 1762999200000,
      success: 10,
      fatal: 1,
      retriable: 0,
    });
  });
});
