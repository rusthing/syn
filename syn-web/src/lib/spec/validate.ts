/**
 * 结构校验（与 `syn-api/src/spec.rs` 的 `TaskSpec::validate` 同构）。
 *
 * 前端这份的目的不是「替代后端」，而是**在输入时就能定位到单元格**：每条问题带
 * `path`（`mapping.rows[3].fn[0]`），编辑器直接标在那一行上。后端保存时仍会再校验一次，
 * 两边结论不一致就说明规则漏写了 —— 那种情况应当改代码，不是放宽前端。
 */

import type { Assert, Condition, Scope, TaskSpec } from "@/lib/api/types";
import { isAssert } from "./defaults";
import { TRANSFORMS } from "./transforms";

export type IssueKind = "missing" | "conflict" | "invalid" | "unknown_transform";

export interface SpecIssue {
  path: string;
  kind: IssueKind;
  message: string;
}

const NEEDS_VALUE = new Set([
  "eq",
  "ne",
  "in",
  "not_in",
  "starts_with",
  "contains",
  "regex",
  "gt",
  "gte",
  "lt",
  "lte",
]);

/** 与 `syn-api::MAX_CONDITION_DEPTH / MAX_CONDITION_NODES` 对齐 */
const MAX_CONDITION_DEPTH = 8;
const MAX_CONDITION_NODES = 200;

function validateCondition(
  at: string,
  c: Condition,
  fallback: Scope,
  into: SpecIssue[],
  depth: number,
  counter: { n: number },
): void {
  counter.n += 1;
  if (depth > MAX_CONDITION_DEPTH) {
    into.push({ path: at, kind: "invalid", message: "条件分组最多嵌套 8 层" });
    return;
  }
  if (counter.n > MAX_CONDITION_NODES) {
    into.push({ path: at, kind: "invalid", message: "条件节点超过 200 个" });
    return;
  }
  if (isAssert(c)) {
    validateAssert(at, c, fallback, into);
    return;
  }
  if ("all" in c) {
    validateChildren(`${at}.all`, c.all, fallback, into, depth, counter);
  } else if ("any" in c) {
    validateChildren(`${at}.any`, c.any, fallback, into, depth, counter);
  } else {
    validateCondition(`${at}.not`, c.not, fallback, into, depth + 1, counter);
  }
}

function validateChildren(
  path: string,
  children: Condition[],
  fallback: Scope,
  into: SpecIssue[],
  depth: number,
  counter: { n: number },
): void {
  // 空 all 恒真、空 any 恒假，都能绕过「末条兜底」的意图
  if (children.length === 0) {
    into.push({ path, kind: "invalid", message: "分组里至少要有一条条件" });
    return;
  }
  children.forEach((c, i) =>
    validateCondition(`${path}[${i}]`, c, fallback, into, depth + 1, counter),
  );
}

function validateAssert(at: string, a: Assert, fallback: Scope, into: SpecIssue[]): void {
  const scope = a.scope ?? fallback;
  if (scope === "status" && a.field) {
    into.push({ path: at, kind: "conflict", message: "status 作用域的断言不能带 field" });
  }
  if (scope !== "status" && !(a.field ?? "").trim()) {
    into.push({ path: at, kind: "missing", message: "该作用域的断言必须写 field" });
  }
  if (NEEDS_VALUE.has(a.op) && a.value === undefined) {
    into.push({ path: at, kind: "missing", message: `操作符 ${a.op} 需要 value` });
  }
  if ((a.op === "in" || a.op === "not_in") && !Array.isArray(a.value)) {
    into.push({ path: at, kind: "invalid", message: "in / not_in 的 value 必须是数组" });
  }
}

function validateConditions(
  path: string,
  conds: Condition[],
  fallback: Scope,
  into: SpecIssue[],
): void {
  const counter = { n: 0 };
  conds.forEach((c, i) =>
    validateCondition(`${path}[${i}]`, c, fallback, into, 0, counter),
  );
}

/** 兜底规则：只由不带 field 的 eq / in 叶子与 all 分组组成 */
export function isFallbackConditions(conds: Condition[]): boolean {
  return conds.every((c) => {
    if (isAssert(c)) return !c.field && (c.op === "in" || c.op === "eq");
    if ("all" in c) return c.all.length > 0 && isFallbackConditions(c.all);
    return false;
  });
}

export function validateSpec(spec: TaskSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];

  if (!(spec.id ?? "").trim()) {
    issues.push({ path: "id", kind: "missing", message: "任务标识不能为空" });
  }
  if (!spec.topic.trim()) {
    issues.push({ path: "topic", kind: "missing", message: "topic 不能为空" });
  }
  // target 按 kind 分支校验，与后端 TaskSpec::validate 逐条对齐。
  // db 目标不需要 service/base，http 目标不需要 datasource/table/key —— 两边都填
  // 反而会让人以为「两个出口都生效」。
  const isIdent = (v: string) => /^[a-z_][a-z0-9_]*$/.test(v);
  if (spec.target.kind === "db") {
    if (!(spec.target.datasource ?? "").trim()) {
      issues.push({
        path: "target.datasource",
        kind: "missing",
        message: "db 目标必须写数据源名（对应 [syn.datasources.<name>]）",
      });
    }
    const table = (spec.target.table ?? "").trim();
    if (!table) {
      issues.push({ path: "target.table", kind: "missing", message: "db 目标必须写目标表" });
    } else if (!table.split(".").every(isIdent) || table.split(".").length > 2) {
      issues.push({
        path: "target.table",
        kind: "invalid",
        message: "表名只能是「表」或「模式.表」，小写字母/数字/下划线",
      });
    }
    const keys = spec.target.key ?? [];
    if (keys.length === 0) {
      issues.push({
        path: "target.key",
        kind: "missing",
        message: "db 目标必须写冲突键：没有它无法 upsert，也无法删除",
      });
    }
    keys.forEach((k, i) => {
      if (!isIdent(k)) {
        issues.push({
          path: `target.key[${i}]`,
          kind: "invalid",
          message: "键列名只能是小写字母/数字/下划线",
        });
      }
    });
  } else {
    if (!(spec.target.service ?? "").trim()) {
      issues.push({
        path: "target.service",
        kind: "missing",
        message: "目标服务不能为空：host 由服务发现提供，这里只写服务名",
      });
    }
    if (!(spec.target.base ?? "").startsWith("/")) {
      issues.push({ path: "target.base", kind: "invalid", message: "路径前缀必须以 / 开头" });
    }
  }

  validateConditions("match", spec.match ?? [], "record", issues);

  // 映射
  const rows = spec.mapping.rows;
  if (rows.length === 0) {
    issues.push({ path: "mapping.rows", kind: "missing", message: "至少要有一行映射，否则请求体恒为空" });
  }
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const at = `mapping.rows[${i}]`;
    if (!row.to.trim()) {
      issues.push({ path: at, kind: "missing", message: "目标字段不能为空" });
    }
    if (seen.has(row.to)) {
      issues.push({ path: at, kind: "conflict", message: `目标字段 ${row.to} 重复` });
    }
    seen.add(row.to);

    const hasFrom = row.from !== undefined && row.from !== "";
    const hasConst = row.const !== undefined;
    if (hasFrom && hasConst) {
      issues.push({ path: at, kind: "conflict", message: "from 与 const 只能有一个" });
    } else if (!hasFrom && !hasConst) {
      issues.push({ path: at, kind: "missing", message: "from 与 const 必须有一个" });
    }
    if (hasConst && (row.fn ?? []).length > 0) {
      issues.push({
        path: at,
        kind: "conflict",
        message: "常量行不需要变换：变换链会让常量失去「常量」的意义",
      });
    }
    (row.fn ?? []).forEach((t, k) => {
      const name = t.split("(")[0].trim();
      if (!(TRANSFORMS as readonly string[]).includes(name)) {
        issues.push({
          path: `${at}.fn[${k}]`,
          kind: "unknown_transform",
          message: `未注册的变换 ${name}：变换是封闭集合，新增需改代码`,
        });
      }
    });
  });

  // 动作
  const actions = spec.actions ?? [];
  if (actions.length === 0) {
    issues.push({ path: "actions", kind: "missing", message: "至少要有一个动作，否则任务无法发出任何请求" });
  }
  const ops = new Set<string>();
  actions.forEach((a, i) => {
    const at = `actions[${i}]`;
    if (ops.has(a.op)) {
      issues.push({ path: at, kind: "conflict", message: `op=${a.op} 重复` });
    }
    ops.add(a.op);
    if ((a.body ?? "mapped") === "mapped" && rows.length === 0) {
      issues.push({ path: at, kind: "conflict", message: "body=mapped 但没有任何映射行" });
    }
    if (spec.target.kind !== "db" && a.method === "GET" && (a.body ?? "mapped") !== "none") {
      issues.push({ path: at, kind: "invalid", message: "GET 不应带请求体" });
    }
  });
  // 快照重放是最容易被漏掉的一条：漏了它，历史数据永远补不上，而且不报错
  if (actions.length > 0 && !ops.has("r")) {
    issues.push({
      path: "actions",
      kind: "invalid",
      message: "未配置 r（快照读）动作，快照重放的记录会找不到动作",
    });
  }

  // 守卫
  (spec.guards ?? []).forEach((g, i) => {
    const at = `guards[${i}]`;
    if (g.assert.length === 0) {
      issues.push({ path: at, kind: "missing", message: "守卫没有断言，等于没写" });
    }
    if (g.on_fail.verdict !== "fatal" && g.on_fail.verdict !== "skip") {
      issues.push({
        path: `${at}.on_fail.verdict`,
        kind: "invalid",
        message: "守卫的结论只能是 fatal 或 skip",
      });
    }
    if (g.when) validateConditions(`${at}.when`, [g.when], "record", issues);
    validateConditions(`${at}.assert`, g.assert, "record", issues);
  });

  // 判定
  const outcomes = spec.outcomes ?? [];
  if (outcomes.length === 0) {
    issues.push({ path: "outcomes", kind: "missing", message: "没有判定规则：响应将无法分类" });
  } else {
    outcomes.forEach((o, i) => {
      validateConditions(`outcomes[${i}].assert`, o.assert, o.scope, issues);
    });
    const last = outcomes[outcomes.length - 1];
    const isFallback = isFallbackConditions(last.assert);
    if (!isFallback) {
      issues.push({
        path: `outcomes[${outcomes.length - 1}]`,
        kind: "invalid",
        message: "最后一条必须是兜底规则（不带 field）：响应不认识时必须失败，不能静默成功",
      });
    }
  }

  return issues;
}

/** 按 path 建索引，方便逐行标红 */
export function issuesByPath(issues: SpecIssue[]): Map<string, SpecIssue[]> {
  const map = new Map<string, SpecIssue[]>();
  for (const issue of issues) {
    const list = map.get(issue.path);
    if (list) list.push(issue);
    else map.set(issue.path, [issue]);
  }
  return map;
}

/** 取某个前缀下的全部问题（`mapping.rows[2]` 也能吃到 `mapping.rows[2].fn[0]`） */
export function issuesUnder(map: Map<string, SpecIssue[]>, prefix: string): SpecIssue[] {
  const out: SpecIssue[] = [];
  for (const [path, list] of map) {
    if (path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`)) {
      out.push(...list);
    }
  }
  return out;
}
