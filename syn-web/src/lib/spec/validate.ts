/**
 * 结构校验（与 `syn-api/src/spec.rs` 的 `TaskSpec::validate` 同构）。
 *
 * 前端这份的目的不是「替代后端」，而是**在输入时就能定位到单元格**：每条问题带
 * `path`（`mapping.rows[3].fn[0]`），编辑器直接标在那一行上。后端保存时仍会再校验一次，
 * 两边结论不一致就说明规则漏写了 —— 那种情况应当改代码，不是放宽前端。
 */

import type { Assert, Condition, Rule, Scope, TaskSpec } from "@/lib/api/types";
import { isAssert } from "./defaults";
import { MAX_RULE_DEPTH, blockConcludes } from "./rules";
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

  if (!spec.topic.trim()) {
    issues.push({ path: "topic", kind: "missing", message: "topic 不能为空" });
  }
  // target 按 kind 分支校验，与后端 TaskSpec::validate 逐条对齐。
  // db 目标不需要 service/base，http 目标不需要 datasource/table/key —— 两边都填
  // 反而会让人以为「两个出口都生效」。
  // 目标库的标识符跟着目标库走：大小写都收，写库时按方言包引号，大小写原样保留
  const isIdent = (v: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
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
        message: "表名只能是「表」或「模式.表」，字母（大小写）/数字/下划线",
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
          message: "键列名只能是字母（大小写）/数字/下划线",
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
    if (row.on_null === "fallback" && row.default === undefined) {
      issues.push({ path: at, kind: "missing", message: "on_null=fallback 时必须填 default 兜底值" });
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

  // 动作：只在 http 出口存在。db 直写不读它（op 由记录自带、写库形状看 on_conflict），
  // 后端保存期也要求为空 —— 留着就是一份永远不会生效的配置。
  const actions = spec.actions ?? [];
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
  if (spec.target.kind === "db") {
    if (actions.length > 0) {
      issues.push({
        path: "actions",
        kind: "invalid",
        message: "db 直写不读动作：op 由记录自带、写库形状由 target.on_conflict 决定，把动作清空",
      });
    }
  } else {
    if (actions.length === 0) {
      issues.push({ path: "actions", kind: "missing", message: "至少要有一个动作，否则任务无法发出任何请求" });
    }
    // 快照重放是最容易被漏掉的一条：漏了它，历史数据永远补不上，而且不报错
    if (actions.length > 0 && !ops.has("r")) {
      issues.push({
        path: "actions",
        kind: "invalid",
        message: "未配置 r（快照读）动作，快照重放的记录会找不到动作",
      });
    }
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

  // 判定：rules 与 outcomes 只会活下来一个（同后端 validate_outcomes）
  const rules = spec.rules ?? [];
  const outcomes = spec.outcomes ?? [];
  if (rules.length > 0) {
    if (outcomes.length > 0) {
      issues.push({
        path: "outcomes",
        kind: "invalid",
        message: "判定同时写了 outcomes 与 rules：保存只认 rules，把 outcomes 删掉",
      });
    }
    validateRuleBlock("rules", rules, issues, 0);
  } else if (outcomes.length === 0) {
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

  // db 直写：判定段的输入是合成响应，只能看 affected（同后端 validate_db_verdict）
  if (spec.target.kind === "db") {
    if (rules.length > 0) {
      checkDbBlock("rules", rules, issues);
    } else {
      outcomes.forEach((o, i) => {
        o.assert.forEach((c, j) => {
          checkDbCondition(`outcomes[${i}].assert[${j}]`, c, o.scope, issues);
        });
      });
    }
  }

  return issues;
}

/**
 * db 直写的判定：只能看合成响应里的 `$.affected`。
 *
 * 执行器写库成功后合成 `200 + { affected: n }` 再交给判定段，所以 status 恒为 200、
 * 记录为空、报文只有 affected。写 status / record 或别的字段，都是恒真或恒假的死配置，
 * 恒假的那条还会让整串规则不命中、落成 UNCLASSIFIED 致命。与后端 `validate_db_verdict` 同构。
 */
function checkDbScope(at: string, field: string, scope: Scope, issues: SpecIssue[]): void {
  if (scope === "status") {
    issues.push({
      path: at,
      kind: "invalid",
      message: "db 直写没有真实响应：status 恒为 200，判定只能看 $.affected",
    });
    return;
  }
  if (scope === "record") {
    issues.push({
      path: at,
      kind: "invalid",
      message: "db 直写的判定看不到记录：能看的只有合成响应里的 $.affected",
    });
    return;
  }
  if (field.trim().replace(/^\$\./, "") !== "affected") {
    issues.push({
      path: at,
      kind: "invalid",
      message: "db 直写只有合成响应 { affected: n }：判定只能看 $.affected（写进去的行数）",
    });
  }
}

function checkDbCondition(at: string, c: Condition, fallback: Scope, issues: SpecIssue[]): void {
  if (isAssert(c)) {
    checkDbScope(at, c.field ?? "", c.scope ?? fallback, issues);
    return;
  }
  if ("all" in c) {
    c.all.forEach((x, i) => checkDbCondition(`${at}.all[${i}]`, x, fallback, issues));
  } else if ("any" in c) {
    c.any.forEach((x, i) => checkDbCondition(`${at}.any[${i}]`, x, fallback, issues));
  } else {
    checkDbCondition(`${at}.not`, c.not, fallback, issues);
  }
}

function checkDbBlock(at: string, block: Rule[], issues: SpecIssue[]): void {
  block.forEach((rule, i) => {
    const rat = `${at}[${i}]`;
    if (rule.kind === "outcome") return;
    if (rule.kind === "if") {
      rule.branches.forEach((b, j) => {
        const bat = `${rat}.branches[${j}]`;
        (b.assert ?? []).forEach((c, k) => checkDbCondition(`${bat}.assert[${k}]`, c, b.scope ?? "body", issues));
        checkDbBlock(`${bat}.then`, b.then ?? [], issues);
      });
      return;
    }
    checkDbScope(`${rat}.on`, rule.on, rule.scope ?? "body", issues);
    rule.cases.forEach((c, j) => checkDbBlock(`${rat}.cases[${j}].then`, c.then ?? [], issues));
    checkDbBlock(`${rat}.default`, rule.default ?? [], issues);
  });
}

function validateRuleBlock(at: string, block: Rule[], issues: SpecIssue[], depth: number): void {
  if (depth > MAX_RULE_DEPTH) {
    issues.push({
      path: at,
      kind: "invalid",
      message: `判定最多嵌套 ${MAX_RULE_DEPTH} 层：再深就读不懂了，把外层条件前移`,
    });
    return;
  }
  if (block.length === 0) {
    issues.push({ path: at, kind: "missing", message: "判定块是空的：命中这里之后拿不到结论" });
    return;
  }
  block.forEach((rule, i) => validateRule(`${at}[${i}]`, rule, issues, depth));
  if (!blockConcludes(block)) {
    issues.push({
      path: at,
      kind: "invalid",
      message:
        "判定块必须以「必然给出结论」的语句收尾（结论 / 带否则的 if / 带 default 的 switch）：没命中的响应会变成 UNCLASSIFIED 致命",
    });
  }
}

function validateRule(at: string, rule: Rule, issues: SpecIssue[], depth: number): void {
  if (rule.kind === "outcome") return;
  if (rule.kind === "if") {
    if (rule.branches.length === 0) {
      issues.push({ path: `${at}.branches`, kind: "missing", message: "if 至少要有一个分支" });
      return;
    }
    rule.branches.forEach((b, i) => {
      const bat = `${at}.branches[${i}]`;
      const conds = b.assert ?? [];
      if (conds.length === 0 && i + 1 !== rule.branches.length) {
        issues.push({
          path: bat,
          kind: "invalid",
          message: "只有最后一个分支可以省条件（否则分支）：中间的省了，后面分支永远进不去",
        });
      }
      validateConditions(`${bat}.assert`, conds, b.scope ?? "body", issues);
      validateRuleBlock(`${bat}.then`, b.then ?? [], issues, depth + 1);
    });
    return;
  }
  if (!rule.on.trim()) {
    issues.push({ path: `${at}.on`, kind: "missing", message: "switch 必须写判别字段" });
  }
  if (rule.cases.length === 0) {
    issues.push({ path: `${at}.cases`, kind: "missing", message: "switch 至少要有一个 case" });
  }
  rule.cases.forEach((c, i) => {
    if (c.values.length === 0) {
      issues.push({
        path: `${at}.cases[${i}].values`,
        kind: "missing",
        message: "case 的取值不能为空",
      });
    }
    validateRuleBlock(`${at}.cases[${i}].then`, c.then ?? [], issues, depth + 1);
  });
  const dft = rule.default ?? [];
  if (dft.length === 0) {
    issues.push({
      path: `${at}.default`,
      kind: "missing",
      message: "switch 必须有 default：没有臂匹配时不能没有结论",
    });
  }
  validateRuleBlock(`${at}.default`, dft, issues, depth + 1);
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
