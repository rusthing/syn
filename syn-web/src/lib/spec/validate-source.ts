/**
 * 取数来源的保存前校验。
 *
 * 镜像后端两处规则：`SynSourceSaveDto` 的 `validator` 注解 +
 * `SourceSpec::validate` / `SynSourceSvc::parse_spec`。
 * 后端始终是权威（它还要跟真的源库打交道），这里只负责**在打字时就挡住**
 * 明显不合格的配置，别让人点保存才知道「游标列只能写小写下划线」。
 *
 * 与 `validate.ts` 一样：只查自相矛盾，不查「这条 SQL 跑不跑得通」——
 * 那要连源库，属于「立即拉取」。
 */

import type { SourceSaveInput } from "@/lib/api/types";

export interface SourceIssue {
  /** DTO 字段路径：`code` / `intervalDuration` / `spec.cursor_column` … */
  path: string;
  message: string;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

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
  else if (!IDENT.test(code)) push("code", "编码只能用小写字母、数字、下划线，且不能以数字开头");
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
    if (!(spec.datasource ?? "").trim()) push("spec.datasource", "库表取数必须选数据源（来自部署配置，见下方说明）");

    const sql = (spec.select ?? "").trim();
    if (!sql) {
      push("spec.select", "sql 取数必须写 select");
    } else {
      const lower = sql.toLowerCase();
      if (!lower.startsWith("select") && !lower.startsWith("with")) {
        push("spec.select", "只支持 select / with 查询：自拉是只读的");
      }
      if (sql.replace(/;+$/, "").includes(";")) {
        push("spec.select", "不允许多条语句：拼进子查询后会语法错");
      }
    }

    const cols = (spec.cursor_column ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    if (cols.length === 0) push("spec.cursor_column", "必须写游标列：没有它无法增量拉取");
    if (cols.length > 2) push("spec.cursor_column", "游标列最多两列（时间戳 + ID）");
    cols.forEach((c, i) => {
      if (!IDENT.test(c)) push(`spec.cursor_column[${i}]`, "列名只能是小写字母/数字/下划线");
    });
    // serde 的 #[serde(default)] 让 cursor_type 缺省即 timestamp，别把「没写」当错
    if (cols.length === 2 && (spec.cursor_type ?? "timestamp") !== "timestamp") {
      push("spec.cursor_type", "两列游标的第一列是时间戳，类型必须选 timestamp");
    }
  } else {
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
    if (spec.select) push("spec.select", "http 取数不使用该字段：分页拉接口没有取数 SQL");
    if (spec.cursor_column) push("spec.cursor_column", "http 取数不使用该字段：没有游标列的概念");
  }

  return issues;
}

/** 按字段取第一条错误，表单里显示就够，不用把同一个输入框刷成一片红 */
export function sourceIssue(issues: SourceIssue[], path: string): string | null {
  return issues.find((i) => i.path === path)?.message ?? null;
}
