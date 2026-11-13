/**
 * 实时接口适配层。
 *
 * `http.ts` 的 `request` 已经把 `Ro<T>` 拆成 `extra`，这一层只负责**形状**：
 * 后端 VO 是 camelCase、`U64` 是字符串、字典枚举是 INT2；控制台的实体
 * （`types.ts`）是 snake_case、数字用 number、枚举用小写字符串。两边都是各自
 * 语境里最合理的表示，谁也不该为对方改，转换集中在这里。
 *
 * 三条不变量，改之前先想清楚：
 *
 * 1. **不编数据**。后端没有的东西就是 0 / null：`SynTaskVo` 没有统计 → `stats` 全 0，
 *    `syn_idem` 一行就是一个键 → `hits = 1`，台账不落耗时 → `p95_ms = 0` / `latency_ms = 0`。
 *    界面显示「暂无数据」比显示一个好看的假数有用。
 * 2. **U64 不转 number**。雪花 ID 有 19 位，超过 `Number.MAX_SAFE_INTEGER`；只有
 *    用来算数/画图的值（`total` / `hour_ms` / 计数）才 `Number(...)`。
 * 3. **写请求按 DTO 的 camelCase 发**，查询参数也一样（后端 QueryDto 带
 *    `#[serde(rename_all = "camelCase")]`），别把前端实体的 `task_code` 直接塞进 query。
 *
 * 路径见 `doc/syn-开发规范.md` §7；所有接口都已在 `syn-svr` 落地，404 只可能是
 * 网关前缀没配对，由 `ApiError.isMissing` 给出明确提示。
 */

import { request } from "./http";
import type {
  DatasourceInfo,
  Delivery,
  IdemRecord,
  Op,
  Overview,
  Page,
  PullResult,
  SourceKind,
  SourceSaveInput,
  SourceSpec,
  SyncSource,
  SyncTask,
  TaskSpec,
  TaskStats,
  Verdict,
} from "./types";

/* ------------------------------ wire 形状 ------------------------------ */

/** `Ro<PageRx<T>>.extra`。`pageNum` / `total` 是 `U64`，序列化成字符串 */
interface WirePage<T> {
  pageNum?: string;
  total: string | number;
  list: T[];
}

interface WireTask {
  id: string;
  code: string;
  name: string;
  topic: string;
  priority: number;
  enabled: boolean;
  exclusive: boolean;
  version: number;
  spec: TaskSpec;
  remark?: string;
  createrId: string;
  createMs: string;
  updaterId: string;
  updateMs: string;
}

interface WireCursor {
  /** `skip_serializing_none`：没跑过时字段直接不出现 */
  position?: string | null;
  rowsSynced: number;
  lastRunMs?: string | null;
  lastError?: string | null;
}

interface WireSource {
  id: string;
  code: string;
  name: string;
  /** 字典枚举，`#[dic]` 序列化成 INT2：0 = sql，1 = http */
  kind: number;
  topic: string;
  enabled: boolean;
  intervalDuration: string;
  batchSize: number;
  spec: SourceSpec;
  version: number;
  remark?: string;
  cursor?: WireCursor | null;
  createrId: string;
  createMs: string;
  updaterId: string;
  updateMs: string;
}

/** `SynDatasourceVo`：连接串不出现在报文里，只有脱敏目标 */
interface WireDatasource {
  name: string;
  target?: string | null;
  maxConnections: number;
}

interface WirePull {
  rows: number;
  durationMs: number;
  success: number;
  skip: number;
  fatal: number;
  retriable: number;
  position?: string | null;
  stalled?: string | null;
}

interface WireDelivery {
  id: string;
  taskCode: string;
  topic?: string | null;
  op?: string | null;
  verdict: Verdict;
  code: string;
  stage: string;
  recordKey: string;
  latencyMs: number;
  httpStatus: number;
  createMs: string;
  detail?: string | null;
}

interface WireIdem {
  id: string;
  taskCode: string;
  idemKey: string;
  /** `SyncVerdict` 是 `#[dic]`：0=success 1=skip 2=fatal 3=retriable */
  verdict: number;
  code: string;
  createMs: string;
  updateMs: string;
}

interface WireHour {
  hourMs: string;
  success: number;
  fatal: number;
  retriable: number;
}

interface WireFailure {
  code: string;
  taskCode: string;
  count: number;
}

interface WireOverview {
  window: string;
  total: number;
  success: number;
  skip: number;
  fatal: number;
  retriable: number;
  p95Ms: number;
  tasks: number;
  enabledTasks: number;
  sources: number;
  stalledSources: number;
  series: WireHour[];
  topFailures: WireFailure[];
}

/* ------------------------------ 转换函数 ------------------------------ */

const num = (v: string | number | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** `PageRx<T>` → 控制台的 `Page<U>`；`total` 是 `U64` 字符串，要转成 number */
function toPage<T, U>(raw: WirePage<T>, map: (row: T) => U): Page<U> {
  return { total: num(raw?.total), list: (raw?.list ?? []).map(map) };
}

const ZERO_STATS: TaskStats = {
  total: 0,
  success: 0,
  skip: 0,
  fatal: 0,
  retriable: 0,
  p95_ms: 0,
  last_hit_ms: null,
};

function toTask(v: WireTask): SyncTask {
  // 库里以 code 列为准：老配置的 spec 可能没写 id，加载时补齐，
  // 否则编辑器会把它当成「还没起名的任务」，保存时触发「编码不可修改」。
  const spec: TaskSpec = { ...(v.spec ?? ({} as TaskSpec)), id: v.spec?.id || v.code };
  return {
    id: v.id,
    code: v.code,
    name: v.name,
    topic: v.topic,
    priority: v.priority,
    enabled: v.enabled,
    version: v.version,
    spec,
    stats: { ...ZERO_STATS },
    creater_id: v.createrId,
    create_ms: v.createMs,
    updater_id: v.updaterId,
    update_ms: v.updateMs,
  };
}

function verdictFromCode(code: number | string): Verdict {
  if (code === 0 || code === "success") return "success";
  if (code === 1 || code === "skip") return "skip";
  if (code === 3 || code === "retriable") return "retriable";
  return "fatal";
}

/**
 * 后端游标不存「上一轮拉了几行」（只有累计 `rows_synced`）。手动拉取的返回值里有
 * 本轮成功行数，按数据源 ID 记在这里，等列表刷新时回填 `last_rows`。
 * 不知道就留 0，界面不显示「· N 行」，比编一个数诚实。刷新页面后自然清空。
 */
const lastPullRows = new Map<string, number>();

function toSource(v: WireSource): SyncSource {
  const cursor = v.cursor;
  return {
    id: v.id,
    code: v.code,
    name: v.name,
    kind: (v.kind === 1 ? "http" : "sql") as SourceKind,
    topic: v.topic,
    enabled: v.enabled,
    interval_duration: v.intervalDuration,
    batch_size: v.batchSize,
    spec: v.spec ?? {},
    remark: v.remark ?? null,
    cursor: cursor
      ? {
          position: cursor.position ?? "",
          updated_ms: cursor.lastRunMs ?? v.updateMs,
          rows_total: num(cursor.rowsSynced),
        }
      : null,
    last_run_ms: cursor?.lastRunMs ?? null,
    last_rows: lastPullRows.get(v.id) ?? 0,
    last_error: cursor?.lastError ?? null,
    creater_id: v.createrId,
    create_ms: v.createMs,
    updater_id: v.updaterId,
    update_ms: v.updateMs,
  };
}

function toDatasource(v: WireDatasource): DatasourceInfo {
  return {
    name: v.name,
    target: v.target ?? null,
    maxConnections: num(v.maxConnections),
  };
}

/**
 * `SynSourceSaveDto` 的 `kind` 是 `#[dic]` 枚举，线上是 **INT2**（0=sql / 1=http），
 * 不是字符串。表单里用 `"sql" | "http"` 更顺手，只在这一层转成数字。
 * 写成 `"sql"` 会被 serde 静默当成缺省值或直接 400，是这类接口最容易踩的坑。
 */
function toSourceSaveBody(input: SourceSaveInput) {
  const { id: _id, ...rest } = input;
  void _id;
  return {
    ...rest,
    kind: input.kind === "http" ? 1 : 0,
    topic: input.topic?.trim() || undefined,
    remark: input.remark?.trim() || undefined,
  };
}

function toDelivery(v: WireDelivery): Delivery {
  return {
    id: v.id,
    task_code: v.taskCode,
    topic: v.topic ?? "",
    op: (v.op ?? null) as Op | null,
    verdict: v.verdict,
    code: v.code,
    stage: v.stage as Delivery["stage"],
    record_key: v.recordKey,
    latency_ms: v.latencyMs,
    http_status: v.httpStatus ?? null,
    create_ms: v.createMs,
    detail: v.detail ?? null,
  };
}

function toIdem(v: WireIdem): IdemRecord {
  return {
    id: v.id,
    task_code: v.taskCode,
    idem_key: v.idemKey,
    // 一个 (task_id, idem_key) 只有一行，表里没有命中次数字段；
    // 重投命中刷新 update_ms，不会插第二行。
    hits: 1,
    verdict: verdictFromCode(v.verdict),
    first_ms: v.createMs,
    last_ms: v.updateMs,
  };
}

function toOverview(v: WireOverview): Overview {
  return {
    window: v.window,
    total: num(v.total),
    success: num(v.success),
    skip: num(v.skip),
    fatal: num(v.fatal),
    retriable: num(v.retriable),
    p95_ms: num(v.p95Ms),
    tasks: num(v.tasks),
    enabled_tasks: num(v.enabledTasks),
    sources: num(v.sources),
    stalled_sources: num(v.stalledSources),
    series: (v.series ?? []).map((h) => ({
      hour_ms: num(h.hourMs),
      success: num(h.success),
      fatal: num(h.fatal),
      retriable: num(h.retriable),
    })),
    top_failures: (v.topFailures ?? []).map((f) => ({
      code: f.code,
      task_code: f.taskCode,
      count: num(f.count),
    })),
  };
}

/* -------------------------------- 接口 -------------------------------- */

export interface TaskQuery {
  keyword?: string;
  topic?: string;
  enabled?: boolean;
  pageNum?: number;
  pageSize?: number;
}

export const liveTasks = {
  page: (query: TaskQuery = {}): Promise<Page<SyncTask>> =>
    request<WirePage<WireTask>>("/syn/task/page", { query: { ...query } }).then((p) =>
      toPage(p, toTask),
    ),

  list: (): Promise<SyncTask[]> =>
    request<WireTask[]>("/syn/task/list").then((rows) => (rows ?? []).map(toTask)),

  get: (id: string): Promise<SyncTask> =>
    request<WireTask>(`/syn/task/${encodeURIComponent(id)}`).then(toTask),

  create: (input: { name: string; spec: TaskSpec }): Promise<SyncTask> =>
    request<WireTask>("/syn/task", { method: "POST", body: input }).then(toTask),

  update: (id: string, input: { name: string; spec: TaskSpec }): Promise<SyncTask> =>
    request<WireTask>(`/syn/task/${encodeURIComponent(id)}`, { method: "PUT", body: input }).then(
      toTask,
    ),

  toggle: (id: string, enabled: boolean): Promise<SyncTask> =>
    request<WireTask>(`/syn/task/${encodeURIComponent(id)}/enabled`, {
      method: "PUT",
      body: { enabled },
    }).then(toTask),

  remove: (id: string): Promise<null> =>
    request<void>(`/syn/task/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => null),

  /** `Ro<u64>.extra` 是生效任务数，顶栏要显示成 `{ count }` */
  reload: (): Promise<{ count: number }> =>
    request<number | string>("/syn/task/reload", { method: "POST" }).then((n) => ({
      count: num(n),
    })),
};

/** 数据源连接清单：只读，连接串在 toml / consul 里维护 */
export const liveDatasources = {
  list: (): Promise<DatasourceInfo[]> =>
    request<WireDatasource[]>("/syn/datasource/list").then((rows) =>
      (rows ?? []).map(toDatasource),
    ),
};

export const liveSources = {
  list: (): Promise<SyncSource[]> =>
    request<WireSource[]>("/syn/source/list").then((rows) => (rows ?? []).map(toSource)),

  create: (input: SourceSaveInput): Promise<SyncSource> =>
    request<WireSource>("/syn/source", {
      method: "POST",
      body: toSourceSaveBody(input),
    }).then(toSource),

  update: (id: string, input: SourceSaveInput): Promise<SyncSource> =>
    request<WireSource>(`/syn/source/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: toSourceSaveBody(input),
    }).then(toSource),

  remove: (id: string): Promise<null> =>
    request<void>(`/syn/source/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => null),

  pull: (id: string): Promise<PullResult> =>
    request<WirePull>(`/syn/source/${encodeURIComponent(id)}/pull`, { method: "POST" }).then(
      (r) => {
        const rows = num(r?.rows);
        lastPullRows.set(id, rows);
        return {
          rows,
          duration_ms: num(r?.durationMs),
          stalled: r?.stalled ?? null,
          position: r?.position ?? null,
        };
      },
    ),

  toggle: (id: string, enabled: boolean): Promise<SyncSource> =>
    request<WireSource>(`/syn/source/${encodeURIComponent(id)}/enabled`, {
      method: "PUT",
      body: { enabled },
    }).then(toSource),
};

export interface DeliveryQuery {
  task_code?: string;
  verdict?: Verdict;
  keyword?: string;
  pageNum?: number;
  pageSize?: number;
}

export const liveDeliveries = {
  page: (query: DeliveryQuery = {}): Promise<Page<Delivery>> =>
    request<WirePage<WireDelivery>>("/syn/delivery/page", {
      // QueryDto 是 camelCase，前端实体是 snake_case，只有这里需要改名
      query: {
        keyword: query.keyword,
        taskCode: query.task_code,
        verdict: query.verdict,
        pageNum: query.pageNum,
        pageSize: query.pageSize,
      },
    }).then((p) => toPage(p, toDelivery)),
};

export const liveIdem = {
  page: (query: { keyword?: string; pageNum?: number; pageSize?: number } = {}): Promise<
    Page<IdemRecord>
  > =>
    request<WirePage<WireIdem>>("/syn/idem/page", { query: { ...query } }).then((p) =>
      toPage(p, toIdem),
    ),
};

export const liveOverview = {
  get: (window = "24h"): Promise<Overview> =>
    request<WireOverview>("/syn/overview", { query: { window } }).then(toOverview),
};
