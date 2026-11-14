/**
 * 契约类型：与 `syn-api` 的 `spec.rs` 一一对应（serde 的 key 已按原样抄）。
 *
 * 这里**不做**宽松处理：字段名写错就是编译错。前后端同名同义是这套配置能长期
 * 维护的前提，前端为了少打字把 `match` 改成 `conditions` 只会让两边的文档各说一套。
 */

export type Operator =
  | "eq"
  | "ne"
  | "in"
  | "not_in"
  | "exists"
  | "absent"
  | "present"
  | "starts_with"
  | "contains"
  | "regex"
  | "gt"
  | "lt";

export type Scope = "record" | "body" | "status";

/** CDC 四态。`r` 是快照读，必须显式配置 */
export type Op = "c" | "r" | "u" | "d";

export type Method = "POST" | "PUT" | "PATCH" | "DELETE" | "GET";

export type BodyMode = "mapped" | "none" | "raw";

export type OnEmpty = "keep" | "keep_original" | "omit" | "null";

/** 结论 → HTTP 状态码：success/skip 200、fatal 400、retriable 503 */
export type Verdict = "success" | "skip" | "fatal" | "retriable";

export interface Assert {
  field?: string;
  op: Operator;
  value?: unknown;
  scope?: Scope;
}

export interface OnError {
  verdict: Verdict;
  code: string;
}

export interface MappingRow {
  to: string;
  from?: string;
  const?: unknown;
  fn?: string[];
  on_empty?: OnEmpty;
  on_error?: OnError;
}

export interface Mapping {
  omit_null?: boolean;
  rows: MappingRow[];
}

export interface Target {
  /** 投递方式，缺省 http。db = 直写下游库表，前四段与 http 完全共用 */
  kind?: "http" | "db";
  /** kind=http：目标服务名（host 由执行器按环境解析） */
  service: string;
  /** kind=http：路径前缀，必须以 / 开头 */
  base: string;
  /** kind=db：数据源名，取 [syn.datasources.<name>] */
  datasource?: string;
  /** kind=db：目标表，table 或 schema.table */
  table?: string;
  /** kind=db：冲突键列；c/r/u 走 on conflict，d 按它删除 */
  key?: string[];
  /** kind=db：冲突处理 */
  on_conflict?: "update" | "nothing" | "error";
}

export interface Binding {
  name: string;
  from: string;
}

export interface Header {
  name: string;
  from: string;
  default?: string;
}

export interface Action {
  op: Op;
  method: Method;
  path?: string;
  body?: BodyMode;
  query?: Binding[];
  headers?: Header[];
}

export interface OnFail {
  verdict: Verdict;
  code: string;
  message?: string;
}

export interface Guard {
  when?: Assert;
  assert: Assert[];
  on_fail: OnFail;
}

export interface Outcome {
  scope: Scope;
  /** 后端 serde 的 key 是 `assert`，不是 `asserts` */
  assert: Assert[];
  verdict: Verdict;
  code?: string;
}

export interface TaskSpec {
  /** 与 `syn_task.code` 同值；库里以列为准 */
  id?: string;
  topic: string;
  priority: number;
  enabled?: boolean;
  /** 默认 true：命中后停止匹配后续任务 */
  exclusive?: boolean;
  target: Target;
  match?: Assert[];
  mapping: Mapping;
  actions?: Action[];
  guards?: Guard[];
  outcomes?: Outcome[];
}

/* ---------- 拓扑画布 ---------- */

/**
 * 画布节点类型，与后端 `CanvasNodeType`（`syn_canvas_layout.node_type`，INT2 1..4）
 * 一一对应。字符串只在适配层出现，落库与接口一律用整数。
 */
export type CanvasNodeKind = "datasource" | "source" | "topic" | "task";

/** 一个节点的世界坐标（与缩放无关） */
export interface CanvasNodePos {
  kind: CanvasNodeKind;
  /** 数据源 / 取数来源 / 任务填 code，主题填 topic 名 */
  key: string;
  x: number;
  y: number;
}

/* ---------- 实体（syn_task / syn_source / 运行记录） ---------- */

export interface Audit {
  creater_id: string;
  create_ms: string;
  updater_id: string;
  update_ms: string;
}

/** 一个任务在统计窗口内的命中情况 */
export interface TaskStats {
  total: number;
  success: number;
  skip: number;
  fatal: number;
  retriable: number;
  /** P95 端到端耗时（毫秒） */
  p95_ms: number;
  last_hit_ms: number | null;
}

export interface SyncTask extends Audit {
  id: string;
  code: string;
  name: string;
  topic: string;
  priority: number;
  enabled: boolean;
  version: number;
  spec: TaskSpec;
  stats: TaskStats;
}

export interface SourceCursor {
  position: string;
  updated_ms: string;
  rows_total: number;
}

export type SourceKind = "sql" | "http";

export interface SourceSpec {
  /** 数据源名，取 [syn.datasources.<name>] */
  datasource?: string;
  /** 游标列类型：拼 SQL 时决定 ::timestamptz / ::int8 / ::text */
  cursor_type?: "timestamp" | "int" | "text";
  /** sql：select 语句，必须带 (updated_at, id) 复合游标占位 */
  select?: string;
  /** sql：游标列，复合时按 `updated_at,id` 写 */
  cursor_column?: string;
  /** http：分页地址模板 */
  url?: string;
  /** http：取下一页的游标路径；有它就按 token 翻页，没有就按页码 1,2,3… */
  next_path?: string;
  /** http：数据数组在响应里的取值路径，缺省 `$`（响应体本身就是数组） */
  data_path?: string;
  /** http：请求方法，缺省 GET */
  method?: "GET" | "POST";
  /** http：请求头，鉴权用（后端不落日志） */
  headers?: Record<string, string>;
  /** 单页条数 */
  page_size?: number;
  /** 是否把拉到的行包装成虚拟 topic 记录 */
  wrap?: "row" | "cdc";
}

/**
 * 保存取数来源的入参（对应后端 `SynSourceSaveDto`）。
 * 顶层字段是 camelCase，`spec` 是 JSONB 原样、内部保持 snake_case ——
 * 一个请求里两种风格，是后端 DTO 与 JSONB 的边界，不是笔误。
 */
export interface SourceSaveInput {
  /** 有 id 走 PUT 修改，没有走 POST 新增；不会发给后端，仅给门面选路由 */
  id?: string;
  code: string;
  name: string;
  kind: SourceKind;
  /** 留空由服务端按 `source:{code}` 生成 */
  topic?: string;
  enabled: boolean;
  intervalDuration: string;
  batchSize: number;
  spec: SourceSpec;
  remark?: string;
}

/**
 * 一个已配置的 DB 数据源（完整实体）。
 *
 * 连接串明文只在写入口收，读接口一律返回脱敏后的 `target`（host:port/db），
 * **绝不返回 url** —— 控制台不持有、也拿不到能还原连接串的字段。
 *
 * 字段命名有两处历史差异，别"顺手统一"：
 * - `maxConnections` / `version` 沿用早期 camelCase，任务/来源实体却是 snake_case；
 * - 审计四列走 `Audit`（snake_case），与 `SyncTask` / `SyncSource` 对齐。
 * `id` 是 U64 雪花 ID，前端一律当字符串，不能转 number（会丢精度）。
 */
export interface DatasourceInfo extends Audit {
  id: string;
  code: string;
  name: string;
  /** 脱敏后的目标；连接串解析不出来时为 null */
  target?: string | null;
  maxConnections: number;
  enabled: boolean;
  version: number;
  remark?: string | null;
}

/**
 * 保存数据源的入参（对应后端 `SynDatasourceSaveDto`，本身就是 camelCase）。
 * `url` 含账号密码：新增必填；编辑留空 / 不传表示「不修改连接串」，
 * 适配层会把它从 body 里省掉。其余字段没有"留空即不改"的语义。
 */
export interface DatasourceSaveInput {
  code: string;
  name: string;
  url?: string;
  maxConnections: number;
  enabled: boolean;
  remark?: string;
}

/** `GET /syn/datasource/page` 的查询参数（后端 `SynDatasourceQueryDto`，camelCase） */
export interface DatasourceQuery {
  keyword?: string;
  enabled?: boolean;
  pageNum?: number;
  pageSize?: number;
}

/** `GET /syn/registry/services` 的服务名候选项 */
export interface ServiceOption {
  name: string;
  /** 健康实例数；注册中心没给就不显示数字 */
  healthy?: number;
}

export interface SyncSource extends Audit {
  id: string;
  code: string;
  name: string;
  kind: SourceKind;
  topic: string;
  enabled: boolean;
  interval_duration: string;
  batch_size: number;
  spec: SourceSpec;
  remark?: string | null;
  cursor: SourceCursor | null;
  last_run_ms: string | null;
  last_rows: number;
  last_error: string | null;
}

/** 一次投递（执行记录） */
export interface Delivery {
  id: string;
  task_code: string;
  topic: string;
  op: Op | null;
  verdict: Verdict;
  code: string;
  stage: "match" | "mapping" | "guard" | "action" | "verdict";
  record_key: string;
  latency_ms: number;
  http_status: number | null;
  create_ms: string;
  detail: string | null;
}

/** 幂等台账 */
export interface IdemRecord {
  id: string;
  task_code: string;
  idem_key: string;
  hits: number;
  verdict: Verdict;
  first_ms: string;
  last_ms: string;
}

export interface Overview {
  window: string;
  total: number;
  success: number;
  skip: number;
  fatal: number;
  retriable: number;
  p95_ms: number;
  tasks: number;
  enabled_tasks: number;
  sources: number;
  stalled_sources: number;
  /** 最近 24 小时的每小时桶，用于吞吐曲线 */
  series: Array<{ hour_ms: number; success: number; fatal: number; retriable: number }>;
  /** 失败分类 Top */
  top_failures: Array<{ code: string; task_code: string; count: number }>;
}

export interface Page<T> {
  total: number;
  list: T[];
}

/** 「立即拉取」一轮的结果（对应 `SynSourcePullVo`） */
export interface PullResult {
  /** 本轮推进成功的行数 */
  rows: number;
  duration_ms: number;
  /** 被一条坏数据卡住的原因；正常推进为 null */
  stalled?: string | null;
  /** 推进到的水位；一行都没成功为 null */
  position?: string | null;
  /** 仅 http 全量源：本轮结束后是否已翻到底；sql 源为 null */
  full_done?: boolean | null;
}

/** 试跑请求的返回（对应 ctrl 的 reply） */
export interface SyncReply {
  result: Verdict;
  code: string;
  task: string | null;
  stage: string;
  detail: string | null;
}
