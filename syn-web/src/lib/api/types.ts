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
  | "gte"
  | "lt"
  | "lte";

export type Scope = "record" | "body" | "status";

/**
 * 启停接口的返回值。只回一个权威布尔值，不回完整任务 ——
 * 开关按钮不该因为 `Ro.extra` 里少了几个字段就被判成失败，见 `liveTasks.toggle`。
 */
export interface TaskToggleResult {
  id: string;
  enabled: boolean;
}

/** CDC 四态。`r` 是快照读，必须显式配置 */
export type Op = "c" | "r" | "u" | "d";

export type Method = "POST" | "PUT" | "PATCH" | "DELETE" | "GET";

export type BodyMode = "mapped" | "none" | "raw";

export type OnEmpty = "keep" | "keep_original" | "omit" | "null";

/** 结论 → HTTP 状态码：success/skip 200、fatal 400、retriable 503 */
export type Verdict = "success" | "skip" | "fatal" | "retriable";

/** 条件树的叶子：取值 + 操作符 + 期望值 */
export interface Assert {
  field?: string;
  op: Operator;
  value?: unknown;
  scope?: Scope;
}

/** 布尔分组。条件数组本身就是根节点 AND，分组只在同一层里组合 */
export interface AllGroup {
  all: Condition[];
}
export interface AnyGroup {
  any: Condition[];
}
export interface NotGroup {
  not: Condition;
}

/**
 * 条件节点：与 `syn_api::Condition` 一一对应。
 * 老配置里 `assert: Assert[]` 仍是合法的条件数组，不需要迁移。
 */
export type Condition = Assert | AllGroup | AnyGroup | NotGroup;

export interface OnError {
  verdict: Verdict;
  code: string;
}

/** 来源为 null（含路径不存在）时的处理：`omit` 省略字段（默认），`keep` 显式写 null，`fallback` 写 default 兜底值 */
export type OnNull = "omit" | "keep" | "fallback";

export interface MappingRow {
  to: string;
  from?: string;
  const?: unknown;
  fn?: string[];
  on_empty?: OnEmpty;
  on_null?: OnNull;
  /** on_null=fallback 时的兜底值 */
  default?: unknown;
  on_error?: OnError;
}

export interface Mapping {
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
  assert: Condition[];
  on_fail: OnFail;
}

export interface Outcome {
  scope: Scope;
  /** 后端 serde 的 key 是 `assert`，不是 `asserts` */
  assert: Condition[];
  verdict: Verdict;
  code?: string;
}

/**
 * 判定语句：与 `syn_api::Rule` 一一对应。
 *
 * 判定段是一串按顺序执行的语句，首个命中即返回。语句只有三种，`if` 的 else-if 链
 * 就是 `branches` 里连续的项，`switch` 是「按一个字段的值分流」的同义写法。
 * 分支体 `then` / `default` 里还是语句列表，所以嵌套不需要单独语法。
 */
export type Rule = IfRule | SwitchRule | OutcomeRule;

export interface IfRule {
  kind: "if";
  /** 至少一项；最后一项 `assert` 为空表示 else */
  branches: Branch[];
}

export interface Branch {
  /** 条件（顶层合取）；为空表示「其余全部」，只能在最后 */
  assert?: Condition[];
  /** 条件里叶子断言的默认作用域，缺省 body */
  scope?: Scope;
  /** 命中后执行的语句，必须以「必然给出结论」的语句收尾 */
  then?: Rule[];
}

export interface SwitchRule {
  kind: "switch";
  /** 判别字段（JSON 路径） */
  on: string;
  /** 判别字段的作用域，缺省 body */
  scope?: Scope;
  /** 取值臂，任一枚举值相等即命中 */
  cases: CaseArm[];
  /** 兜底臂，必须非空 */
  default?: Rule[];
}

export interface CaseArm {
  /** 命中取值集合，不允许为空 */
  values: unknown[];
  then?: Rule[];
}

export interface OutcomeRule {
  kind: "outcome";
  verdict: Verdict;
  code?: string;
}

export interface TaskSpec {
  topic: string;
  /** 同一主题内的排序值，升序；首命中即停 */
  sort_order: number;
  enabled?: boolean;
  /** 默认 true：命中后停止匹配后续任务 */
  exclusive?: boolean;
  target: Target;
  match?: Condition[];
  mapping: Mapping;
  actions?: Action[];
  guards?: Guard[];
  outcomes?: Outcome[];
  /** 判定语句树（新形状），优先于 outcomes */
  rules?: Rule[];
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
  /** 数据源 / 数据抽取填 code，任务填 id，主题填 topic 名 */
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
  name: string;
  topic: string;
  sort_order: number;
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

/** 抽取模式：sql 内部再分「游标增量 / 全量快照」 */
export type SourceMode = "cursor" | "snapshot";

export interface SourceSpec {
  /** 数据源名，取 [syn.datasources.<name>] */
  datasource?: string;
  /** sql：游标增量 / 全量快照 */
  mode?: SourceMode;
  /** sql：源表名，允许 schema.table。填了 sql 时可省略 */
  table?: string;
  /** sql：手写 SQL（可选），单条 select / with；填了就替代表名，输出需含主游标与决胜字段 */
  sql?: string;
  /** sql 游标增量：主游标字段（时间戳 / 自增 ID / 编码） */
  cursor_field?: string;
  /** 主游标类型：拼 SQL 时决定 ::int8 / ::timestamptz / ::text */
  cursor_type?: "bigint" | "timestamptz" | "varchar";
  /** sql 游标增量：决胜字段（必须唯一），解决同一主游标值并发写入 */
  tie_field?: string;
  /** 决胜字段类型：拼 SQL 时决定 ::int8 / ::uuid / ::text */
  tie_type?: "bigint" | "uuid" | "varchar";
  /** sql 全量快照：true = 按 batchSize 分批拉完，false = 一条 SQL 拉全表 */
  snapshot_batched?: boolean;
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
 * 保存数据抽取的入参（对应后端 `SynSourceSaveDto`）。
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

/**
 * 连接测试的入参（后端 `SynDatasourceTestDto`）。
 *
 * 两种用法：给 `url` 就测这条草稿（新增时还没保存）；不给 `url` 就给 `id`，
 * 测库里已存的那条（编辑时不想为了测试重输密码）。
 */
export interface DatasourceTestInput {
  id?: string;
  url?: string;
}

/**
 * 一次连接测试的结果（后端 `SynDatasourceTestVo`）。
 *
 * 连不上也是**正常响应**：`ok: false` + `message` 交给状态栏显示，
 * 不走错误通道 —— 否则界面只能弹一个 toast，看不到「连到哪个库、多久」。
 */
export interface DatasourceTestResult {
  ok: boolean;
  elapsedMs: number;
  /** 服务端版本，例如 `PostgreSQL 16.4`；连不上时没有 */
  server?: string;
  message: string;
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
  /** 保存响应里的提示（如「抽取定义变更，水位已清空」），列表/详情不带 */
  notice?: string | null;
}

/** 一次投递（执行记录） */
export interface Delivery {
  id: string;
  /** 数据来源：`idem` = 幂等台账（成功/跳过）；`log` = 投递明细（失败/重试） */
  source: "idem" | "log";
  task_name: string;
  topic: string;
  op: Op | null;
  verdict: Verdict;
  code: string;
  stage: "match" | "mapping" | "guard" | "action" | "transport" | "verdict";
  /** 记录键；自拉链路的失败明细没有 */
  record_key: string | null;
  latency_ms: number;
  http_status: number | null;
  create_ms: string;
  detail: string | null;
}

/** 幂等台账 */
export interface IdemRecord {
  id: string;
  task_name: string;
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
  top_failures: Array<{ code: string; task_name: string; count: number }>;
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
