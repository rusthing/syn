/**
 * 演示数据。
 *
 * 不连后端时整站靠它跑起来，所以数字要经得起看：分布、耗时、失败码都必须像真的，
 * 否则「看一眼界面对不对」这件事就没意义。
 *
 * 写操作只改内存，刷新即还原 —— 顶栏与侧栏都明确写着「演示数据」，不会让人误以为
 * 已经保存到库里。
 */

import type {
  DatasourceInfo,
  Delivery,
  IdemRecord,
  Overview,
  Page,
  PullResult,
  SourceSaveInput,
  SyncSource,
  SyncTask,
  TaskSpec,
  Verdict,
} from "./types";

/* ------------------------------ 确定性随机 ------------------------------ */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261112);
const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];

const NOW = Date.now();
const MIN = 60_000;

/** 北京某处的一块面：Debezium 给的就是这个十六进制 WKB，5 个点闭合 */
const POLYGON_WKB =
  "010300000001000000050000001B2FDD2406195D406ABC749318F44340C520B07268195D406ABC749318F44340C520B07268195D40DBF97E6ABCF443401B2FDD2406195D40DBF97E6ABCF443401B2FDD2406195D406ABC749318F44340";

const REGION_SAMPLE = {
  op: "c",
  ts_ms: NOW - 42_000,
  before: null,
  after: {
    id: 8821,
    name: "  一号围栏  ",
    area_code: "110108",
    polygon_location: { wkb: POLYGON_WKB },
    create_by: 100237,
    update_time: Math.floor((NOW - 42_000) / 1000),
    is_deleted: "0",
    remark: "",
  },
};

const PERSON_SAMPLE = {
  op: "u",
  ts_ms: NOW - 15_000,
  before: { id: 3312, name: "张伟" },
  after: {
    id: 3312,
    name: "张伟",
    id_card: "110108199003071234",
    sex: 1,
    phone: "13800001111",
    dept_id: 88,
    locator_id: 5521,
    is_deleted: 0,
    update_time: Math.floor((NOW - 15_000) / 1000),
  },
};

const BIND_SAMPLE = {
  op: "d",
  ts_ms: NOW - 90_000,
  before: { id: 771, person_id: 3312, locator_id: 5521 },
  after: null,
};

/* -------------------------------- 任务 -------------------------------- */

let idSeq = 0;

function task(
  code: string,
  name: string,
  topic: string,
  priority: number,
  enabled: boolean,
  spec: TaskSpec,
  stats: Partial<SyncTask["stats"]>,
  version = 3,
): SyncTask {
  const base = NOW - 26 * 24 * 60 * MIN;
  const total = stats.total ?? 1200;
  const fatal = stats.fatal ?? Math.round(total * 0.004);
  const retriable = stats.retriable ?? Math.round(total * 0.002);
  const skip = stats.skip ?? Math.round(total * 0.03);
  return {
    id: String(19_0000_0000 + (idSeq += 1)),
    code,
    name,
    topic,
    priority,
    enabled,
    version,
    spec,
    stats: {
      total,
      success: stats.success ?? total - fatal - retriable - skip,
      skip,
      fatal,
      retriable,
      p95_ms: stats.p95_ms ?? 180,
      last_hit_ms: "last_hit_ms" in stats ? stats.last_hit_ms! : NOW - 2 * MIN,
    },
    creater_id: "100237",
    create_ms: String(base),
    updater_id: "100237",
    update_ms: String(NOW - 3 * 24 * 60 * MIN),
  };
}

const REGION_SPEC: TaskSpec = {
  id: "dtw_region",
  topic: "dtw.region",
  priority: 100,
  enabled: true,
  exclusive: true,
  target: { service: "dtw-rs-svr", base: "/dtw/region" },
  match: [{ field: "$.op", op: "in", value: ["c", "r", "u", "d"], scope: "record" }],
  mapping: {
    omit_null: true,
    rows: [
      { to: "id", from: "$.after.id" },
      { to: "name", from: "$.after.name", fn: ["trim"] },
      { to: "area_code", from: "$.after.area_code" },
      { to: "polygon_wkt", from: "$.after.polygon_location.wkb", fn: ["wkb_to_wkt"] },
      {
        to: "is_deleted",
        from: "$.after.is_deleted",
        fn: ["to_bool_01"],
        on_empty: "omit",
        on_error: { verdict: "fatal", code: "BAD_FLAG" },
      },
      { to: "update_time", from: "$.after.update_time", fn: ["to_ms"] },
      { to: "source", const: "dtw" },
    ],
  },
  actions: [
    { op: "c", method: "POST", path: "", body: "mapped" },
    { op: "r", method: "POST", path: "/snapshot", body: "mapped" },
    { op: "u", method: "PUT", path: "", body: "mapped" },
    { op: "d", method: "DELETE", path: "", body: "none", query: [{ name: "id", from: "$.before.id" }] },
  ],
  guards: [
    {
      when: { field: "$.op", op: "in", value: ["c", "u"], scope: "record" },
      assert: [
        { field: "$.after.id", op: "exists", scope: "record" },
        { field: "$.name", op: "present", scope: "body" },
      ],
      on_fail: { verdict: "fatal", code: "EMPTY_NAME", message: "围栏名称为空，无法下发" },
    },
  ],
  outcomes: [
    {
      scope: "body",
      assert: [
        { field: "$.extra.code", op: "eq", value: "RTW00001", scope: "body" },
      ],
      verdict: "skip",
      code: "duplicate",
    },
    {
      scope: "body",
      assert: [{ field: "$.result", op: "lt", value: 0, scope: "body" }],
      verdict: "fatal",
      code: "business_error",
    },
    { scope: "status", assert: [{ op: "in", value: [200, 201, 204] }], verdict: "success", code: "ok" },
    { scope: "status", assert: [{ op: "in", value: [500, 502, 503, 504] }], verdict: "retriable", code: "upstream_unavailable" },
  ],
};

const PERSON_SPEC: TaskSpec = {
  id: "dtw_person",
  topic: "dtw.person",
  priority: 100,
  enabled: true,
  // 一份人员数据要同时进定位库与报警库：前一个任务不独占，走完继续往下匹配
  exclusive: false,
  target: { service: "dtw-rs-svr", base: "/dtw/person" },
  match: [{ field: "$.op", op: "in", value: ["c", "r", "u", "d"], scope: "record" }],
  mapping: {
    omit_null: true,
    rows: [
      { to: "id", from: "$.after.id" },
      { to: "name", from: "$.after.name", fn: ["trim", "truncate(32)"] },
      { to: "id_card", from: "$.after.id_card" },
      { to: "locator_id", from: "$.after.locator_id" },
      { to: "dept.code", from: "$.after.dept_id" },
      { to: "update_time", from: "$.after.update_time", fn: ["to_ms"] },
    ],
  },
  actions: [
    { op: "c", method: "POST", path: "", body: "mapped", headers: [{ name: "X-User-Id", from: "$.after.create_by", default: "0" }] },
    { op: "r", method: "POST", path: "/snapshot", body: "mapped" },
    { op: "u", method: "PUT", path: "", body: "mapped" },
    { op: "d", method: "DELETE", path: "", body: "none", query: [{ name: "id", from: "$.before.id" }] },
  ],
  guards: [],
  outcomes: [
    { scope: "body", assert: [{ field: "$.result", op: "lt", value: 0, scope: "body" }], verdict: "fatal", code: "business_error" },
    { scope: "status", assert: [{ op: "in", value: [200, 201, 204] }], verdict: "success", code: "ok" },
    { scope: "status", assert: [{ op: "in", value: [500, 502, 503] }], verdict: "retriable", code: "upstream_unavailable" },
  ],
};

const PERSON_ALARM_SPEC: TaskSpec = {
  id: "dtw_person_alarm",
  topic: "dtw.person",
  priority: 200,
  enabled: true,
  exclusive: true,
  target: { service: "alarm-svr", base: "/alarm/person" },
  match: [
    { field: "$.op", op: "in", value: ["c", "u"], scope: "record" },
    { field: "$.after.locator_id", op: "exists", scope: "record" },
  ],
  mapping: {
    omit_null: true,
    rows: [
      { to: "personId", from: "$.after.id" },
      { to: "personName", from: "$.after.name", fn: ["trim"] },
      { to: "locatorId", from: "$.after.locator_id" },
      { to: "bizType", const: 2 },
    ],
  },
  actions: [
    { op: "c", method: "POST", path: "/upsert", body: "mapped" },
    { op: "r", method: "POST", path: "/upsert", body: "mapped" },
    { op: "u", method: "POST", path: "/upsert", body: "mapped" },
  ],
  guards: [],
  outcomes: [
    // 业务失败排在状态码之前：它属于「HTTP 200 里的失败」，越具体越靠前
    { scope: "body", assert: [{ field: "$.result", op: "lt", value: 0, scope: "body" }], verdict: "fatal", code: "business_error" },
    { scope: "status", assert: [{ op: "in", value: [200, 201] }], verdict: "success", code: "ok" },
    { scope: "status", assert: [{ op: "in", value: [429, 500, 502, 503] }], verdict: "retriable", code: "upstream_busy" },
  ],
};

const BIND_SPEC: TaskSpec = {
  id: "dtw_locator_bind",
  topic: "dtw.locator_bind",
  priority: 100,
  enabled: true,
  exclusive: true,
  target: { service: "dtw-rs-svr", base: "/dtw/locator/bind" },
  match: [{ field: "$.op", op: "in", value: ["c", "r", "u", "d"], scope: "record" }],
  mapping: {
    omit_null: true,
    rows: [
      { to: "person_id", from: "$.after.person_id" },
      { to: "locator_id", from: "$.after.locator_id" },
      { to: "bind_time", from: "$.after.bind_time", fn: ["to_ms"] },
    ],
  },
  actions: [
    { op: "c", method: "POST", path: "", body: "mapped" },
    { op: "r", method: "POST", path: "/snapshot", body: "mapped" },
    { op: "u", method: "PUT", path: "", body: "mapped" },
    { op: "d", method: "DELETE", path: "", body: "none", query: [{ name: "id", from: "$.before.id" }] },
  ],
  guards: [
    {
      // 删除动作没有 after，不该过「必须有定位器」这道闸
      when: { field: "$.op", op: "in", value: ["c", "u"], scope: "record" },
      assert: [{ field: "locator_id", op: "present", scope: "body" }],
      on_fail: { verdict: "skip", code: "no_locator", message: "未绑定定位器，跳过" },
    },
  ],
  outcomes: [
    { scope: "status", assert: [{ op: "in", value: [200, 201, 404] }], verdict: "success", code: "ok" },
    { scope: "status", assert: [{ op: "in", value: [500, 503] }], verdict: "retriable", code: "upstream_unavailable" },
  ],
};

const ORDERS_SPEC: TaskSpec = {
  id: "adt_orders_archive",
  topic: "source:adt_orders",
  priority: 300,
  enabled: false,
  exclusive: true,
  target: { service: "oss-rs", base: "/oss/order" },
  match: [],
  mapping: {
    omit_null: true,
    rows: [
      { to: "orderNo", from: "$.order_no" },
      { to: "amount", from: "$.amount" },
      { to: "paidAt", from: "$.paid_at", fn: ["to_ms"] },
    ],
  },
  actions: [{ op: "r", method: "POST", path: "/archive", body: "mapped" }],
  guards: [],
  outcomes: [
    { scope: "status", assert: [{ op: "in", value: [200, 201] }], verdict: "success", code: "ok" },
    { scope: "status", assert: [{ op: "in", value: [500, 503] }], verdict: "retriable", code: "upstream_unavailable" },
  ],
};

let TASKS: SyncTask[] = [
  task("dtw_region", "区域同步", "dtw.region", 100, true, REGION_SPEC, {
    total: 18_420,
    skip: 512,
    fatal: 31,
    retriable: 8,
    p95_ms: 164,
    last_hit_ms: NOW - 18_000,
  }),
  task("dtw_person", "人员同步", "dtw.person", 100, true, PERSON_SPEC, {
    total: 9_860,
    skip: 204,
    fatal: 12,
    retriable: 3,
    p95_ms: 142,
    last_hit_ms: NOW - 51_000,
  }),
  task("dtw_person_alarm", "人员→报警库", "dtw.person", 200, true, PERSON_ALARM_SPEC, {
    total: 9_402,
    skip: 0,
    fatal: 47,
    retriable: 19,
    p95_ms: 231,
    last_hit_ms: NOW - 51_000,
  }),
  task("dtw_locator_bind", "定位器绑定", "dtw.locator_bind", 100, true, BIND_SPEC, {
    total: 3_106,
    skip: 120,
    fatal: 2,
    retriable: 0,
    p95_ms: 118,
    last_hit_ms: NOW - 6 * MIN,
  }),
  task("adt_orders_archive", "订单归档（自拉）", "source:adt_orders", 300, false, ORDERS_SPEC, {
    total: 0,
    skip: 0,
    fatal: 0,
    retriable: 0,
    p95_ms: 0,
    last_hit_ms: null,
  }, 1),
];

/* -------------------------------- 来源 -------------------------------- */

/** http 全量源在演示数据里翻几页算完（后端是「翻到空页为止」） */
const MOCK_HTTP_TOTAL_PAGES = 3;
/** 每个 http 源已经翻到第几页；reset 时清掉 */
const MOCK_HTTP_PAGES = new Map<string, number>();

let SOURCES: SyncSource[] = [
  {
    id: "1900000000000000011",
    code: "dtw_src_region",
    name: "区域增量拉取",
    kind: "sql",
    topic: "source:dtw_region",
    enabled: true,
    interval_duration: "60s",
    batch_size: 500,
    spec: {
      datasource: "dtw",
      select:
        "select id, name, area_code, st_asbinary(polygon_location) as polygon_wkb, update_time\nfrom dtw_task.region\nwhere (update_time, id) > ($1, $2)\norder by update_time, id\nlimit $3",
      cursor_column: "update_time,id",
      wrap: "cdc",
    },
    cursor: { position: "1763003520,8821", updated_ms: String(NOW - 42_000), rows_total: 184_320 },
    last_run_ms: String(NOW - 42_000),
    last_rows: 500,
    last_error: null,
    creater_id: "100237",
    create_ms: String(NOW - 20 * 24 * 60 * MIN),
    updater_id: "100237",
    update_ms: String(NOW - 2 * 24 * 60 * MIN),
  },
  {
    id: "1900000000000000012",
    code: "dtw_src_locator",
    name: "定位器绑定增量拉取",
    kind: "sql",
    topic: "source:dtw_locator_bind",
    enabled: true,
    interval_duration: "30s",
    batch_size: 200,
    spec: {
      datasource: "dtw",
      select:
        "select id, person_id, locator_id, bind_time, update_time\nfrom dtw_task.locator_bind\nwhere (update_time, id) > ($1, $2)\norder by update_time, id\nlimit $3",
      cursor_column: "update_time,id",
      wrap: "cdc",
    },
    cursor: { position: "1763003550,771", updated_ms: String(NOW - 6 * MIN), rows_total: 31_204 },
    last_run_ms: String(NOW - 6 * MIN),
    last_rows: 200,
    last_error: null,
    creater_id: "100237",
    create_ms: String(NOW - 20 * 24 * 60 * MIN),
    updater_id: "100237",
    update_ms: String(NOW - 9 * 24 * 60 * MIN),
  },
  {
    id: "1900000000000000013",
    code: "adt_src_person",
    name: "人员主数据（HTTP 分页）",
    kind: "http",
    topic: "source:adt_person",
    enabled: false,
    interval_duration: "300s",
    batch_size: 1000,
    spec: {
      url: "http://adt-svr/person/page?cursor={cursor}&size={size}",
      next_path: "$.extra.nextCursor",
      page_size: 1000,
      wrap: "row",
    },
    cursor: { position: "c-88213", updated_ms: String(NOW - 3 * 60 * MIN), rows_total: 9_860 },
    last_run_ms: String(NOW - 3 * 60 * MIN),
    last_rows: 0,
    last_error: "上游 504：adt-svr 分页接口超时（连续 3 次）",
    creater_id: "100237",
    create_ms: String(NOW - 12 * 24 * 60 * MIN),
    updater_id: "100237",
    update_ms: String(NOW - 3 * 60 * MIN),
  },
];

/* ------------------------------ 投递记录 ------------------------------ */

const FAILURE_CODES = [
  { code: "business_error", stage: "verdict", status: 200, detail: '{"result":-1,"msg":"区域编码不存在"}' },
  { code: "EMPTY_NAME", stage: "guard", status: null, detail: "围栏名称为空，无法下发" },
  { code: "upstream_unavailable", stage: "verdict", status: 503, detail: "gatex 返回 503：dtw-rs-svr 全部实例不可用" },
  { code: "unexpected_status", stage: "verdict", status: 418, detail: "响应未命中任何规则，按失败处理" },
  { code: "BAD_FLAG", stage: "mapping", status: null, detail: "to_bool_01: 2 不是 0/1" },
];

function buildDeliveries(): Delivery[] {
  const out: Delivery[] = [];
  const enabled = TASKS.filter((t) => t.enabled);
  for (let i = 0; i < 160; i += 1) {
    const t = pick(enabled);
    const roll = rand();
    const verdict: Verdict = roll < 0.972 ? "success" : roll < 0.988 ? "skip" : roll < 0.996 ? "fatal" : "retriable";
    const failure = FAILURE_CODES[Math.floor(rand() * FAILURE_CODES.length)];
    const create = NOW - Math.floor(rand() * 6 * 60 * MIN);
    const op = pick(["c", "u", "u", "u", "d", "r"] as const);
    const id = 8000 + Math.floor(rand() * 2000);
    out.push({
      id: `dlv-${String(i).padStart(5, "0")}`,
      task_code: t.code,
      topic: t.topic,
      op,
      verdict,
      code:
        verdict === "success"
          ? "ok"
          : verdict === "skip"
            ? pick(["duplicate", "no_match", "not_found", "no_locator"])
            : failure.code,
      stage: verdict === "success" ? "verdict" : verdict === "skip" ? "match" : (failure.stage as Delivery["stage"]),
      record_key: `${t.topic}#${id}`,
      latency_ms:
        verdict === "retriable" ? 3_000 + Math.floor(rand() * 2_000) : 40 + Math.floor(rand() * 260),
      http_status: verdict === "success" ? 200 : verdict === "skip" ? 200 : failure.status,
      create_ms: String(create),
      detail: verdict === "success" || verdict === "skip" ? null : failure.detail,
    });
  }
  return out.sort((a, b) => Number(b.create_ms) - Number(a.create_ms));
}

const DELIVERIES = buildDeliveries();

/* ------------------------------- 幂等台账 ------------------------------- */

function buildIdem(): IdemRecord[] {
  const out: IdemRecord[] = [];
  for (let i = 0; i < 24; i += 1) {
    const t = pick(TASKS);
    const first = NOW - Math.floor(rand() * 12 * 60 * MIN);
    out.push({
      id: `idem-${String(i).padStart(5, "0")}`,
      task_code: t.code,
      idem_key: `${t.topic}:${8000 + Math.floor(rand() * 2000)}:${Math.floor(rand() * 9)}`,
      hits: 1 + Math.floor(rand() * 4),
      verdict: rand() < 0.9 ? "success" : "skip",
      first_ms: String(first),
      last_ms: String(first + Math.floor(rand() * 4 * MIN)),
    });
  }
  return out.sort((a, b) => Number(b.last_ms) - Number(a.last_ms));
}

const IDEM = buildIdem();

/* -------------------------------- 聚合 -------------------------------- */

function buildSeries(): Overview["series"] {
  const r = mulberry32(77);
  const nowHour = Math.floor(NOW / 3_600_000) * 3_600_000;
  return Array.from({ length: 24 }, (_, i) => {
    const hour = nowHour - (23 - i) * 3_600_000;
    const hourOfDay = new Date(hour).getHours();
    // 白天多、深夜少：曲线要像人作息，不像白噪声
    const base = 260 + Math.round(420 * Math.sin(((hourOfDay - 4) / 24) * Math.PI * 2) ** 2);
    const success = base + Math.floor(r() * 120);
    const fatal = Math.floor(r() * 9) + (r() < 0.15 ? 12 : 0);
    const retriable = Math.floor(r() * 4);
    return { hour_ms: hour, success, fatal, retriable };
  });
}

const SERIES = buildSeries();

export async function overview(query: { window?: string } = {}): Promise<Overview> {
  const window = query.window ?? "24h";
  const scale = window === "1h" ? 1 / 24 : window === "7d" ? 7 : 1;
  const total = DELIVERIES.length * 120;
  const byVerdict = { success: 0, skip: 0, fatal: 0, retriable: 0 };
  for (const d of DELIVERIES) byVerdict[d.verdict] += 1;
  const sum = DELIVERIES.length;

  const failureMap = new Map<string, { code: string; task_code: string; count: number }>();
  for (const d of DELIVERIES) {
    if (d.verdict !== "fatal" && d.verdict !== "retriable") continue;
    const key = `${d.task_code}|${d.code}`;
    const hit = failureMap.get(key);
    if (hit) hit.count += 3;
    else failureMap.set(key, { code: d.code, task_code: d.task_code, count: 3 });
  }

  return {
    window,
    total: Math.round(total * scale),
    success: Math.round((byVerdict.success / sum) * total * scale),
    skip: Math.round((byVerdict.skip / sum) * total * scale),
    fatal: Math.round((byVerdict.fatal / sum) * total * scale),
    retriable: Math.round((byVerdict.retriable / sum) * total * scale),
    p95_ms: 214,
    tasks: TASKS.length,
    enabled_tasks: TASKS.filter((t) => t.enabled).length,
    sources: SOURCES.length,
    stalled_sources: SOURCES.filter((s) => s.enabled && s.last_error).length,
    series: SERIES.map((s) => ({
      hour_ms: s.hour_ms,
      success: Math.round(s.success * scale),
      fatal: Math.round(s.fatal * scale),
      retriable: Math.round(s.retriable * scale),
    })),
    top_failures: [...failureMap.values()].sort((a, b) => b.count - a.count).slice(0, 6),
  };
}

/* ------------------------------- 查询 API ------------------------------- */

export interface TaskQuery {
  keyword?: string;
  topic?: string;
  enabled?: boolean;
  pageNum?: number;
  pageSize?: number;
}

function paginate<T>(items: T[], pageNum = 1, pageSize = 20): Page<T> {
  const start = (pageNum - 1) * pageSize;
  return { total: items.length, list: items.slice(start, start + pageSize) };
}

export const mockTasks = {
  async page(query: TaskQuery = {}): Promise<Page<SyncTask>> {
    const keyword = query.keyword?.trim().toLowerCase();
    const list = TASKS.filter((t) => {
      if (query.topic && t.topic !== query.topic) return false;
      if (query.enabled !== undefined && t.enabled !== query.enabled) return false;
      if (!keyword) return true;
      return (
        t.code.toLowerCase().includes(keyword) ||
        t.name.toLowerCase().includes(keyword) ||
        t.topic.toLowerCase().includes(keyword)
      );
    });
    return paginate(list, query.pageNum, query.pageSize);
  },

  async list(): Promise<SyncTask[]> {
    return TASKS;
  },

  async get(id: string): Promise<SyncTask> {
    const hit = TASKS.find((t) => t.id === id || t.code === id);
    if (!hit) throw new Error(`任务 ${id} 不存在`);
    return hit;
  },

  async create(input: { name: string; spec: TaskSpec }): Promise<SyncTask> {
    const created = task(
      input.spec.id ?? "new_task",
      input.name,
      input.spec.topic,
      input.spec.priority,
      input.spec.enabled ?? false,
      input.spec,
      { total: 0, skip: 0, fatal: 0, retriable: 0, p95_ms: 0, last_hit_ms: null },
      1,
    );
    created.id = String(19_0000_0000 + (idSeq += 1));
    TASKS = [...TASKS, created];
    return created;
  },

  async update(id: string, patch: { name: string; spec: TaskSpec }): Promise<SyncTask> {
    const current = await mockTasks.get(id);
    const next: SyncTask = {
      ...current,
      name: patch.name,
      topic: patch.spec.topic,
      priority: patch.spec.priority,
      enabled: patch.spec.enabled ?? current.enabled,
      version: current.version + 1,
      spec: patch.spec,
      updater_id: "100237",
      update_ms: String(Date.now()),
    };
    TASKS = TASKS.map((t) => (t.id === current.id ? next : t));
    return next;
  },

  async toggle(id: string, enabled: boolean): Promise<SyncTask> {
    const current = await mockTasks.get(id);
    const next: SyncTask = {
      ...current,
      enabled,
      spec: { ...current.spec, enabled },
      version: current.version + 1,
      update_ms: String(Date.now()),
    };
    TASKS = TASKS.map((t) => (t.id === current.id ? next : t));
    return next;
  },

  async remove(id: string): Promise<null> {
    TASKS = TASKS.filter((t) => t.id !== id);
    return null;
  },

  async reload(): Promise<{ count: number }> {
    return { count: TASKS.filter((t) => t.enabled).length };
  },
};

/** 演示模式下的可选连接名，与实时接口返回同样的形状 */
export const mockDatasources = {
  async list(): Promise<DatasourceInfo[]> {
    return [
      { name: "dtw", target: "pgsql:5432/dtwrs_ui", maxConnections: 4 },
      { name: "adm", target: "pgsql:5432/admrs", maxConnections: 4 },
    ];
  },
};

export const mockSources = {
  async list(): Promise<SyncSource[]> {
    return SOURCES;
  },

  async save(input: SourceSaveInput): Promise<SyncSource> {
    const now = String(Date.now());
    const code = input.code.trim();
    if (!input.id && SOURCES.some((s) => s.code === code)) {
      throw new Error(`来源编码 ${code} 已存在`);
    }
    const current = input.id ? SOURCES.find((s) => s.id === input.id) : undefined;
    if (input.id && !current) throw new Error(`来源 ${input.id} 不存在`);
    if (current && current.code !== code) {
      throw new Error("来源编码不可修改：虚拟 topic 与游标都按它指代");
    }
    const next: SyncSource = {
      id: current?.id ?? String(19_0000_0000 + (idSeq += 1)),
      code,
      name: input.name.trim(),
      kind: input.kind,
      topic: input.topic?.trim() || `source:${code}`,
      enabled: input.enabled,
      interval_duration: input.intervalDuration.trim(),
      batch_size: input.batchSize,
      spec: input.spec,
      // 改配置不动水位：停用再启用应该从原水位继续
      cursor: current?.cursor ?? null,
      last_run_ms: current?.last_run_ms ?? null,
      last_rows: current?.last_rows ?? 0,
      last_error: current?.last_error ?? null,
      creater_id: current?.creater_id ?? "100237",
      create_ms: current?.create_ms ?? now,
      updater_id: "100237",
      update_ms: now,
    };
    SOURCES = current
      ? SOURCES.map((s) => (s.id === current.id ? next : s))
      : [...SOURCES, next];
    return next;
  },

  async remove(id: string): Promise<null> {
    if (!SOURCES.some((s) => s.id === id)) throw new Error(`来源 ${id} 不存在`);
    SOURCES = SOURCES.filter((s) => s.id !== id);
    return null;
  },

  /**
   * 拉取一轮。
   *
   * http 全是**全量分页**：一轮推一页，三页翻完标 `full_done`，此后直接返回完成；
   * `reset` 先把页数清回第一页（对应后端 `pull?reset=true`）。
   */
  async pull(id: string, reset = false): Promise<PullResult> {
    const source = SOURCES.find((s) => s.id === id);
    if (!source) throw new Error(`来源 ${id} 不存在`);
    if (!source.enabled) throw new Error("来源已停用，先启用再拉取");

    if (source.kind !== "http") {
      const rows = Math.floor(rand() * source.batch_size * 0.4);
      SOURCES = SOURCES.map((s) =>
        s.id === id
          ? { ...s, last_run_ms: String(Date.now()), last_rows: rows, last_error: null }
          : s,
      );
      return { rows, duration_ms: 120 + Math.floor(rand() * 300), full_done: null };
    }

    if (reset) MOCK_HTTP_PAGES.delete(id);
    const page = MOCK_HTTP_PAGES.get(id) ?? 0;
    if (page >= MOCK_HTTP_TOTAL_PAGES) {
      return { rows: 0, duration_ms: 40, full_done: true };
    }
    const rows = Math.ceil(source.batch_size * 0.3);
    const next = page + 1;
    MOCK_HTTP_PAGES.set(id, next);
    const full_done = next >= MOCK_HTTP_TOTAL_PAGES;
    SOURCES = SOURCES.map((s) =>
      s.id === id
        ? { ...s, last_run_ms: String(Date.now()), last_rows: rows, last_error: null }
        : s,
    );
    return {
      rows,
      duration_ms: 120 + Math.floor(rand() * 300),
      full_done,
      position: full_done ? '{"http":{"done":true}}' : `{"http":{"next":"${next + 1}"}}`,
    };
  },

  async toggle(id: string, enabled: boolean): Promise<SyncSource> {
    const source = SOURCES.find((s) => s.id === id);
    if (!source) throw new Error(`来源 ${id} 不存在`);
    const next = { ...source, enabled, update_ms: String(Date.now()) };
    SOURCES = SOURCES.map((s) => (s.id === id ? next : s));
    return next;
  },
};

export interface DeliveryQuery {
  task_code?: string;
  verdict?: Verdict;
  keyword?: string;
  pageNum?: number;
  pageSize?: number;
}

export const mockDeliveries = {
  async page(query: DeliveryQuery = {}): Promise<Page<Delivery>> {
    const keyword = query.keyword?.trim().toLowerCase();
    const list = DELIVERIES.filter((d) => {
      if (query.task_code && d.task_code !== query.task_code) return false;
      if (query.verdict && d.verdict !== query.verdict) return false;
      if (!keyword) return true;
      return (
        d.record_key.toLowerCase().includes(keyword) ||
        d.code.toLowerCase().includes(keyword) ||
        d.task_code.toLowerCase().includes(keyword)
      );
    });
    return paginate(list, query.pageNum, query.pageSize);
  },
};

export const mockIdem = {
  async page(query: { keyword?: string; pageNum?: number; pageSize?: number } = {}): Promise<Page<IdemRecord>> {
    const keyword = query.keyword?.trim().toLowerCase();
    const list = IDEM.filter(
      (r) =>
        !keyword ||
        r.idem_key.toLowerCase().includes(keyword) ||
        r.task_code.toLowerCase().includes(keyword),
    );
    return paginate(list, query.pageNum, query.pageSize);
  },
};

/** 试跑用的样例报文，按 topic 分组 */
export const SAMPLE_RECORDS: Record<string, Array<{ label: string; record: unknown }>> = {
  "dtw.region": [
    { label: "新增（带 WKB 面）", record: REGION_SAMPLE },
    {
      label: "修改（名称带空格）",
      record: { ...REGION_SAMPLE, op: "u", before: { id: 8821 }, after: { ...REGION_SAMPLE.after, name: " 二号围栏 " } },
    },
    {
      label: "删除（after 为 null）",
      record: { op: "d", ts_ms: NOW - 30_000, before: { id: 8821 }, after: null },
    },
    {
      label: "脏数据（is_deleted=2）",
      record: { op: "c", ts_ms: NOW - 10_000, before: null, after: { ...REGION_SAMPLE.after, is_deleted: "2" } },
    },
  ],
  "dtw.person": [
    { label: "修改（带定位器）", record: PERSON_SAMPLE },
    {
      label: "新增（无定位器）",
      record: { ...PERSON_SAMPLE, op: "c", before: null, after: { ...PERSON_SAMPLE.after, id: 3313, locator_id: null } },
    },
  ],
  "dtw.locator_bind": [
    {
      label: "新增绑定",
      record: {
        op: "c",
        ts_ms: NOW - 20_000,
        before: null,
        after: { id: 772, person_id: 3312, locator_id: 5521, bind_time: Math.floor((NOW - 20_000) / 1000) },
      },
    },
    {
      label: "删除绑定（after 为 null）",
      record: BIND_SAMPLE,
    },
  ],
  "source:adt_orders": [
    {
      label: "订单行（拉取形态）",
      record: { order_no: "ADT2026111200031", amount: 128.5, paid_at: Math.floor((NOW - 90 * MIN) / 1000) },
    },
  ],
};

export const mockTopics = (): string[] => [...new Set(TASKS.map((t) => t.topic))];
