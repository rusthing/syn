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
  CanvasNodeKind,
  CanvasNodePos,
  DatasourceInfo,
  DatasourceQuery,
  DatasourceSaveInput,
  Delivery,
  IdemRecord,
  Op,
  Overview,
  Page,
  PullResult,
  ServiceOption,
  SourceKind,
  SourceSaveInput,
  SourceSpec,
  SyncSource,
  SyncTask,
  TaskSpec,
  TaskStats,
  TaskToggleResult,
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

/**
 * `SynDatasourceVo`（camelCase）。`id` 与审计列是 `U64`，序列化成字符串；
 * **连接串明文不出现在报文里**，只有脱敏后的 `target`。
 *
 * 按契约这里的字段是「全集」：真实 VO 目前只保证前六项，remark/version/审计列可能
 * 缺省。全部标成可选，`toDatasource` 用诚实缺省（0 / null / ""）兜住形状漂移 ——
 * 后端没给的不编数，界面显示「—」比显示错值有用。
 */
interface WireDatasource {
  id: string;
  code: string;
  name: string;
  target?: string | null;
  maxConnections: number | string;
  enabled: boolean;
  remark?: string | null;
  version?: number | string;
  createrId?: string | null;
  createMs?: string | null;
  updaterId?: string | null;
  updateMs?: string | null;
}

/** `GET /syn/registry/services` 的候选项，已是 camelCase 的简单结构 */
/** `syn_canvas_layout` 的行：`nodeType` 是 `#[dic]` 的 INT2（1..4） */
interface WireCanvasNode {
  nodeType: number;
  nodeKey: string;
  x: number;
  y: number;
}

interface WireService {
  name: string;
  healthy?: number | string | null;
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
  fullDone?: boolean | null;
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
    // U64 雪花 ID 绝不 Number()：19 位超过 MAX_SAFE_INTEGER
    id: v.id,
    code: v.code,
    name: v.name,
    target: v.target ?? null,
    maxConnections: num(v.maxConnections),
    enabled: v.enabled ?? false,
    version: num(v.version),
    remark: v.remark ?? null,
    // 真实 VO 可能没有审计列：映射成 snake_case，缺省留空串（不编数）
    creater_id: v.createrId ?? "",
    create_ms: v.createMs ?? "",
    updater_id: v.updaterId ?? "",
    update_ms: v.updateMs ?? "",
  };
}

/**
 * `SynDatasourceSaveDto` 本身就是 camelCase，保存入参同形，可原样发。
 * 唯一要处理的是 `url`：新增必填；修改留空 / 不传表示「不改连接串」，这时必须
 * 把字段从 body 里省掉 —— 发空串会被后端当成要清空连接串或过不了长度校验。
 */
function toDatasourceSaveBody(input: DatasourceSaveInput) {
  const url = input.url?.trim();
  return {
    code: input.code.trim(),
    name: input.name.trim(),
    ...(url ? { url } : {}),
    maxConnections: num(input.maxConnections),
    enabled: input.enabled,
    remark: input.remark?.trim() ?? "",
  };
}

function toService(v: WireService): ServiceOption {
  return {
    name: v.name,
    healthy: v.healthy == null ? undefined : num(v.healthy),
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

  /**
   * 启停只关心「服务端最终认了哪个值」。
   *
   * 这里刻意不 `toTask(extra)`：开关是按钮，返回体哪怕少几个字段、`extra` 为 null
   * （不同版本 Ro 的包装差异）也不该让一次成功的启停在转换函数里抛错、进而被
   * React Query 判成失败把乐观值回滚。真要完整实体，调 `tasks.get(id)`。
   */
  toggle: (id: string, enabled: boolean): Promise<TaskToggleResult> =>
    request<{ enabled?: boolean } | null>(`/syn/task/${encodeURIComponent(id)}/enabled`, {
      method: "PUT",
      body: { enabled },
    }).then((extra) => ({
      id,
      enabled: typeof extra?.enabled === "boolean" ? extra.enabled : enabled,
    })),

  remove: (id: string): Promise<null> =>
    request<void>(`/syn/task/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => null),

  /** `Ro<u64>.extra` 是生效任务数，顶栏要显示成 `{ count }` */
  reload: (): Promise<{ count: number }> =>
    request<number | string>("/syn/task/reload", { method: "POST" }).then((n) => ({
      count: num(n),
    })),
};

/** 数据源连接的 CRUD：读接口一律是脱敏 VO，写接口才收 `url` 明文 */
export const liveDatasources = {
  list: (): Promise<DatasourceInfo[]> =>
    request<WireDatasource[]>("/syn/datasource/list").then((rows) =>
      (rows ?? []).map(toDatasource),
    ),

  page: (query: DatasourceQuery = {}): Promise<Page<DatasourceInfo>> =>
    request<WirePage<WireDatasource>>("/syn/datasource/page", { query: { ...query } }).then((p) =>
      toPage(p, toDatasource),
    ),

  get: (id: string): Promise<DatasourceInfo> =>
    request<WireDatasource>(`/syn/datasource/${encodeURIComponent(id)}`).then(toDatasource),

  create: (input: DatasourceSaveInput): Promise<DatasourceInfo> =>
    request<WireDatasource>("/syn/datasource", {
      method: "POST",
      body: toDatasourceSaveBody(input),
    }).then(toDatasource),

  update: (id: string, input: DatasourceSaveInput): Promise<DatasourceInfo> =>
    request<WireDatasource>(`/syn/datasource/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: toDatasourceSaveBody(input),
    }).then(toDatasource),

  setEnabled: (id: string, enabled: boolean): Promise<DatasourceInfo> =>
    request<WireDatasource>(`/syn/datasource/${encodeURIComponent(id)}/enabled`, {
      method: "PUT",
      body: { enabled },
    }).then(toDatasource),

  remove: (id: string): Promise<null> =>
    request<void>(`/syn/datasource/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => null),
};

/** 整数 → 前端节点类型；认不出就当没有（旧版本多出来的类型不该画出来） */
const CANVAS_KIND_OF: Record<number, CanvasNodeKind> = {
  1: "datasource",
  2: "source",
  3: "topic",
  4: "task",
};

const CANVAS_TYPE_OF: Record<CanvasNodeKind, number> = {
  datasource: 1,
  source: 2,
  topic: 3,
  task: 4,
};

function toCanvasNode(v: WireCanvasNode): CanvasNodePos | null {
  const kind = CANVAS_KIND_OF[num(v.nodeType)];
  if (!kind) return null;
  return { kind, key: v.nodeKey, x: num(v.x), y: num(v.y) };
}

/**
 * 画布布局：只读写节点坐标，节点本身由任务 / 来源 / 数据源三张表现拼。
 * 保存按 `(kind, key)` upsert，只提交拖动过的节点。
 */
export const liveCanvas = {
  layout: (): Promise<CanvasNodePos[]> =>
    request<WireCanvasNode[]>("/syn/canvas/layout").then((rows) =>
      (rows ?? []).flatMap((v) => {
        const node = toCanvasNode(v);
        return node ? [node] : [];
      }),
    ),

  save: (nodes: CanvasNodePos[]): Promise<CanvasNodePos[]> =>
    request<WireCanvasNode[]>("/syn/canvas/layout", {
      method: "PUT",
      body: {
        nodes: nodes.map((n) => ({
          nodeType: CANVAS_TYPE_OF[n.kind],
          nodeKey: n.key,
          x: Math.round(n.x),
          y: Math.round(n.y),
        })),
      },
    }).then((rows) =>
      (rows ?? []).flatMap((v) => {
        const node = toCanvasNode(v);
        return node ? [node] : [];
      }),
    ),
};

/**
 * 注册中心里已登记的服务名候选。后端接口还没落地（404）是预期内的：
 * `useServices` 会把失败兜成空数组，配置页仍可手输服务名，不依赖它。
 */
export const liveRegistry = {
  services: (): Promise<ServiceOption[]> =>
    request<WireService[]>("/syn/registry/services").then((rows) => (rows ?? []).map(toService)),
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

  pull: (id: string, reset = false): Promise<PullResult> =>
    request<WirePull>(
      `/syn/source/${encodeURIComponent(id)}/pull${reset ? "?reset=true" : ""}`,
      { method: "POST" },
    ).then(
      (r) => {
        const rows = num(r?.rows);
        lastPullRows.set(id, rows);
        return {
          rows,
          duration_ms: num(r?.durationMs),
          stalled: r?.stalled ?? null,
          position: r?.position ?? null,
          full_done: r?.fullDone ?? null,
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
