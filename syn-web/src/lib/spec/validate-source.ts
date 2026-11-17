/**
 * 数据抽取的保存前校验。
 *
 * 镜像后端两处规则：`SynSourceSaveDto` 的 `validator` 注解 +
 * `SourceSpec::validate` / `SynSourceSvc::parse_spec`。
 * 后端始终是权威（它还要跟真的源库打交道），这里只负责**在打字时就挡住**
 * 明显不合格的配置，别让人点保存才知道「表名里不能带分号」。
 *
 * 与 `validate.ts` 一样：只查自相矛盾，不查「这条 SQL 跑不跑得通」——
 * 那要连源库，属于「立即拉取」。
 */

import type { SourceSaveInput, SourceSpec } from "@/lib/api/types";

export interface SourceIssue {
  /** DTO 字段路径：`code` / `intervalDuration` / `spec.table` … */
  path: string;
  message: string;
}

/** 编码是 syn 自己的标识（topic、配置名），仍只认小写，避免大小写两份配置并存 */
const CODE_IDENT = /^[a-z_][a-z0-9_]*$/;
/**
 * 表名与字段名是**源库**的标识符，跟着源库走：工业库、从别的系统迁过来的库
 * 常有大写列名（`WS_DEVICE` / `UPDATE_TIME`），这里只挡引号、分号这类注入字符。
 * 后端拼 SQL 时按方言包引号（`"WS_DEVICE"` / `` `WS_DEVICE` ``），大小写原样保留。
 */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 表名允许 `schema.table`，两段都必须是合法标识符 */
const QUALIFIED_IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

const CURSOR_TYPES = ["bigint", "timestamptz", "varchar"] as const;
const TIE_TYPES = ["bigint", "uuid", "varchar"] as const;

/** 只认 humantime 最常用的几档；后端才是权威，这里挡住明显写错的即可 */
const DURATION = /^(\d+)\s*(ms|s|m|min|h|d)$/;
const DURATION_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 };

export function validateSource(input: SourceSaveInput): SourceIssue[] {
  const issues: SourceIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });

  // 一个字段只报第一条错：空值同时触发「必填」和「格式不对」会把错误数刷成两倍
  const code = input.code.trim();
  if (!code) push("code", "编码必填，最长 64 字符");
  else if (code.length > 64) push("code", "编码最长 64 字符");
  else if (!CODE_IDENT.test(code)) push("code", "编码只能用小写字母、数字、下划线，且不能以数字开头");
  const name = input.name.trim();
  if (!name) push("name", "名称必填，最长 100 字");
  else if (name.length > 100) push("name", "名称最长 100 字");
  if ((input.topic ?? "").length > 255) push("topic", "topic 最长 255 字符");
  if ((input.remark ?? "").length > 500) push("remark", "备注最长 500 字");

  const interval = input.intervalDuration.trim();
  if (!interval || interval.length > 30) {
    push("intervalDuration", "调度间隔必填，最长 30 字符（如 60s / 5m / 1h）");
  } else {
    const m = DURATION.exec(interval);
    if (!m) push("intervalDuration", "格式不合法：写成 60s / 5m / 1h 这类时长");
    else if (Number(m[1]) * DURATION_MS[m[2]] < 1000) push("intervalDuration", "调度间隔不能小于 1s");
  }
  if (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 5000) {
    push("batchSize", "单批行数需在 1..=5000 之间");
  }

  const spec = input.spec ?? {};
  if (input.kind === "sql") {
    if (!(spec.datasource ?? "").trim()) push("spec.datasource", "库表抽取必须选数据源（来自部署配置，见下方说明）");

    const table = (spec.table ?? "").trim();
    const customMode = spec.sql !== undefined;
    const customSql = (spec.sql ?? "").trim();
    if (customMode) {
      if (!customSql) push("spec.sql", "手写 SQL 不能为空；不想手写就切回按表名生成");
      else if (!isSingleSelect(customSql)) push("spec.sql", "手写 SQL 只能是单条 select / with，不能带分号或写操作");
    } else if (!table) {
      push("spec.table", "必须写源表名或手写 SQL：取数语句按它生成");
    } else if (!QUALIFIED_IDENT.test(table)) {
      push("spec.table", "表名只能用字母（大小写）/数字/下划线，可用 schema.table");
    }

    // serde 的 #[serde(default)] 让 mode 缺省即 cursor，别把「没写」当错
    if ((spec.mode ?? "cursor") === "cursor") validateCursor(spec, push);
  } else {
    validateHttp(spec, push);
  }

  return issues;
}

function validateCursor(spec: SourceSpec, push: (path: string, message: string) => void) {
  const cursor = (spec.cursor_field ?? "").trim();
  const tie = (spec.tie_field ?? "").trim();

  if (!cursor) push("spec.cursor_field", "游标增量必须写主游标字段（时间戳 / 自增 ID）");
  else if (!IDENT.test(cursor)) push("spec.cursor_field", "字段名只能用字母（大小写）/数字/下划线");

  if (!tie) push("spec.tie_field", "游标增量必须写决胜字段：同一主游标值靠它排出唯一顺序");
  else if (!IDENT.test(tie)) push("spec.tie_field", "字段名只能用字母（大小写）/数字/下划线");

  if (cursor && cursor === tie) push("spec.tie_field", "决胜字段必须与主游标字段不同");

  if (!CURSOR_TYPES.includes((spec.cursor_type ?? "bigint") as (typeof CURSOR_TYPES)[number])) {
    push("spec.cursor_type", "主游标不支持该类型：只能选 bigint / timestamptz / varchar");
  }
  if (!TIE_TYPES.includes((spec.tie_type ?? "bigint") as (typeof TIE_TYPES)[number])) {
    push("spec.tie_type", "决胜字段不支持该类型：只能选 bigint / uuid / varchar");
  }
}

function validateHttp(spec: SourceSpec, push: (path: string, message: string) => void) {
  if (!(spec.url ?? "").trim()) push("spec.url", "http 取数必须写分页地址");
  if (spec.page_size !== undefined && spec.page_size <= 0) push("spec.page_size", "单页条数必须大于 0");

  // 取值路径与后端同一个解析器（只认 `$.a.b[0]`）：写错的后果是每页都取不到数据、
  // 全量立刻「完成」，比报错更难发现
  for (const [path, value] of [
    ["spec.data_path", spec.data_path],
    ["spec.next_path", spec.next_path],
  ] as const) {
    const p = (value ?? "").trim();
    if (p && !p.startsWith("$")) push(path, "取值路径要以 $ 开头，例如 $.data.list");
  }

  const method = (spec.method ?? "").trim().toUpperCase();
  if (method && method !== "GET" && method !== "POST") {
    push("spec.method", "只支持 GET / POST：全量取数是只读的");
  }

  // 复制 sql 源的配置改成 http 时最容易留下这些字段：后端按 http 跑会静默忽略
  if (spec.datasource) push("spec.datasource", "http 取数不使用该字段：分页拉接口没有库表的概念");
  if (spec.table) push("spec.table", "http 取数不使用该字段：分页拉接口没有表名");
  if (spec.sql !== undefined) push("spec.sql", "http 取数不使用该字段：分页拉接口没有 SQL");
  if (spec.cursor_field || spec.tie_field) {
    push("spec.cursor_field", "http 取数不使用该字段：分页拉接口没有游标字段");
  }
}

/** 按字段取第一条错误，表单里显示就够，不用把同一个输入框刷成一片红 */
export function sourceIssue(issues: SourceIssue[], path: string): string | null {
  return issues.find((i) => i.path === path)?.message ?? null;
}

/** 与后端 `is_single_select` 同规则：首词是 select/with，去掉结尾分号后内部不能再有分号 */
function isSingleSelect(sql: string): boolean {
  const s = sql.trim().replace(/;$/, "").trim();
  const first = s.split(/\s+/)[0]?.toLowerCase() ?? "";
  return (first === "select" || first === "with") && !s.includes(";");
}
