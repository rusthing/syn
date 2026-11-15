/**
 * 判定语句树的静态检查。
 *
 * 与 `validate.ts` 分工明确：validate 只管「能不能存」（空块、缺兜底、超层数），
 * 这里管「存下去了，但它和你的意图不是一回事」—— 互相包含的分支、永远轮不到的
 * 语句、重复的 case 取值、自相矛盾的条件。全部是纯静态推导，**不需要任何样例数据**。
 *
 * 一条自我约束：只算能算准的。`eq` / `in` / 范围比较可以求交与包含；
 * `ne` / `not_in` / `contains` / `regex` / `starts_with` / `any` / `not` 一律回
 * 「无法判定」，绝不假装全能 —— 会误报的检查比没有检查更糟，用户很快会学会无视它。
 *
 * 顺带产出两种「矩阵」投影：`if` 的分支 × 判别字段表、`switch` 的取值表。
 * 它们和块视图读的是同一份 `spec.rules`，只是换一种画法，不产生第二套语义。
 */
import type {
  Assert,
  Branch,
  Condition,
  IfRule,
  Operator,
  Rule,
  Scope,
  SwitchRule,
  Verdict,
} from "@/lib/api/types";
import { VERDICTS, isAssert } from "./defaults";
import { blockConcludes, branchLabel, blockOutcomeText, countRules, fmtValue, rulesDepth } from "./rules";

/* -------------------------------- 值域 -------------------------------- */

type RangeDomain = { tag: "range"; lo?: number; hi?: number; loInc: boolean; hiInc: boolean };

/**
 * 一个判别键上允许的取值集合。
 * `empty` 表示「已推导出自相矛盾」，`unknown` 表示「约束存在但推不出来」。
 */
export type Domain =
  | { tag: "empty" }
  | { tag: "any" }
  | { tag: "set"; values: unknown[] }
  | RangeDomain
  | { tag: "unknown" };

const EMPTY: Domain = { tag: "empty" };
const ANY: Domain = { tag: "any" };
const UNKNOWN: Domain = { tag: "unknown" };

/** 与 `syn-core::assertion::json_eq` 同义：数字按数值比，其余按 JSON 比 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 能当数字用的值（`"200"` 也算，配置里引号很容易多打一个） */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function inRange(v: number, d: RangeDomain): boolean {
  if (d.lo !== undefined && (d.loInc ? v < d.lo : v <= d.lo)) return false;
  if (d.hi !== undefined && (d.hiInc ? v > d.hi : v >= d.hi)) return false;
  return true;
}

function rangeEmpty(d: RangeDomain): boolean {
  if (d.lo === undefined || d.hi === undefined) return false;
  if (d.lo > d.hi) return true;
  if (d.lo === d.hi) return !(d.loInc && d.hiInc);
  return false;
}

function dedupe(values: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const v of values) if (!out.some((x) => jsonEqual(x, v))) out.push(v);
  return out;
}

/** 操作符 → 值域。推不出来的（ne / contains / regex / exists…）一律 unknown */
function domainOf(op: Operator, value: unknown): Domain {
  switch (op) {
    case "eq":
      return value === undefined ? UNKNOWN : { tag: "set", values: [value] };
    case "in": {
      if (!Array.isArray(value)) return UNKNOWN;
      const values = dedupe(value);
      return values.length === 0 ? EMPTY : { tag: "set", values };
    }
    case "gt":
      return num(value) === null ? UNKNOWN : { tag: "range", lo: num(value)!, loInc: false, hiInc: false };
    case "gte":
      return num(value) === null ? UNKNOWN : { tag: "range", lo: num(value)!, loInc: true, hiInc: false };
    case "lt":
      return num(value) === null ? UNKNOWN : { tag: "range", hi: num(value)!, loInc: false, hiInc: false };
    case "lte":
      return num(value) === null ? UNKNOWN : { tag: "range", hi: num(value)!, loInc: false, hiInc: true };
    default:
      return UNKNOWN;
  }
}

function setInRange(values: unknown[], d: RangeDomain): Domain {
  const nums = values.map(num);
  // 有一个不能当数字看的，就不敢说「一定不相交」
  if (nums.some((n) => n === null)) return UNKNOWN;
  const kept = values.filter((_, i) => inRange(nums[i]!, d));
  return kept.length === 0 ? EMPTY : { tag: "set", values: kept };
}

function intersectRange(a: RangeDomain, b: RangeDomain): Domain {
  const lo = Math.max(a.lo ?? -Infinity, b.lo ?? -Infinity);
  const hi = Math.min(a.hi ?? Infinity, b.hi ?? Infinity);
  const loInc =
    (a.lo ?? -Infinity) > (b.lo ?? -Infinity)
      ? a.loInc
      : (a.lo ?? -Infinity) < (b.lo ?? -Infinity)
        ? b.loInc
        : a.loInc && b.loInc;
  const hiInc =
    (a.hi ?? Infinity) < (b.hi ?? Infinity)
      ? a.hiInc
      : (a.hi ?? Infinity) > (b.hi ?? Infinity)
        ? b.hiInc
        : a.hiInc && b.hiInc;
  const out: RangeDomain = {
    tag: "range",
    lo: Number.isFinite(lo) ? lo : undefined,
    hi: Number.isFinite(hi) ? hi : undefined,
    loInc,
    hiInc,
  };
  return rangeEmpty(out) ? EMPTY : out;
}

export function intersectDomain(a: Domain, b: Domain): Domain {
  if (a.tag === "empty" || b.tag === "empty") return EMPTY;
  if (a.tag === "unknown" || b.tag === "unknown") return UNKNOWN;
  if (a.tag === "any") return b;
  if (b.tag === "any") return a;
  if (a.tag === "set" && b.tag === "set") {
    const values = a.values.filter((v) => b.values.some((w) => jsonEqual(v, w)));
    return values.length === 0 ? EMPTY : { tag: "set", values };
  }
  if (a.tag === "set" && b.tag === "range") return setInRange(a.values, b);
  if (a.tag === "range" && b.tag === "set") return setInRange(b.values, a);
  if (a.tag === "range" && b.tag === "range") return intersectRange(a, b);
  // 上面已覆盖 set / range 的全部组合
  return UNKNOWN;
}

/** `null` = 推不出来。用于「后一个分支是否被前一个完全包含」 */
export function subsetDomain(a: Domain, b: Domain): boolean | null {
  if (b.tag === "any" || a.tag === "empty") return true;
  if (a.tag === "unknown" || b.tag === "unknown") return null;
  if (b.tag === "empty" || a.tag === "any") return false;
  if (a.tag === "set" && b.tag === "set") {
    return a.values.every((v) => b.values.some((w) => jsonEqual(v, w)));
  }
  if (a.tag === "set" && b.tag === "range") {
    return a.values.every((v) => {
      const n = num(v);
      return n !== null && inRange(n, b);
    });
  }
  if (a.tag === "range" && b.tag === "range") {
    if (b.lo !== undefined) {
      if (a.lo === undefined || a.lo < b.lo) return false;
      if (a.lo === b.lo && !a.loInc && b.loInc) return false;
    }
    if (b.hi !== undefined) {
      if (a.hi === undefined || a.hi > b.hi) return false;
      if (a.hi === b.hi && !a.hiInc && b.hiInc) return false;
    }
    return true;
  }
  // range ⊆ set：无限集不可能是有限集的子集
  return false;
}

/* ------------------------------ 分支形状 ------------------------------ */

/**
 * 一条分支条件在「判别键」上的合取约束。
 * 键是给人看的列名（`状态码` / `$.result` / `记录 $.op`），重复出现的同一个键会求交。
 */
export interface Shape {
  keys: Map<string, Domain>;
  /** 含静态推不出来的逻辑（any / not / 缺 field） */
  opaque: boolean;
  /** 求交求空的键，说明条件自相矛盾 */
  contradiction: string | null;
}

function keyOf(a: Assert, scope: Scope): string {
  if (scope === "status") return a.field ? "" : "状态码";
  const field = (a.field ?? "").trim();
  if (!field) return "";
  // record 与 body 的路径可能同名，记录侧加前缀避免并到一列
  return scope === "record" ? `记录 ${field}` : field;
}

export function shapeOf(conds: Condition[], fallback: Scope): Shape {
  const keys = new Map<string, Domain>();
  let opaque = false;
  let contradiction: string | null = null;

  const add = (key: string, d: Domain) => {
    const next = intersectDomain(keys.get(key) ?? ANY, d);
    keys.set(key, next);
    if (next.tag === "empty" && contradiction === null) contradiction = key;
  };

  const walk = (list: Condition[], fb: Scope) => {
    for (const c of list) {
      if (isAssert(c)) {
        const scope = c.scope ?? fb;
        const key = keyOf(c, scope);
        if (!key) {
          opaque = true;
          continue;
        }
        add(key, domainOf(c.op, c.value));
        continue;
      }
      if ("all" in c) {
        walk(c.all, fb);
        continue;
      }
      // any 是析取、not 是取反：都无法用「键 → 值域」表达
      opaque = true;
    }
  };

  walk(conds, fallback);
  return { keys, opaque, contradiction };
}

function subsetShape(a: Shape, b: Shape): boolean | null {
  if (a.opaque || b.opaque) return null;
  let unclear = false;
  for (const [key, db] of b.keys) {
    const da = a.keys.get(key);
    // b 约束了 a 没约束的键 —— a 范围更宽，不可能是子集
    if (!da) return false;
    const r = subsetDomain(da, db);
    if (r === null) unclear = true;
    else if (!r) return false;
  }
  return unclear ? null : true;
}

type Relation = "disjoint" | "contains" | "overlap" | "unknown";

/** `earlier` 在前、`later` 在后时，两者输入空间的关系 */
function relate(earlier: Shape, later: Shape): Relation {
  if (earlier.opaque || later.opaque) return "unknown";
  let unclear = false;
  for (const [key, dl] of later.keys) {
    const de = earlier.keys.get(key);
    if (!de) continue;
    const inter = intersectDomain(de, dl);
    // 有一个键确定不相交，就永远不可能同时命中
    if (inter.tag === "empty") return "disjoint";
    if (inter.tag === "unknown") unclear = true;
  }
  const sub = subsetShape(later, earlier);
  if (sub === true) return "contains";
  if (sub === null || unclear) return "unknown";
  return "overlap";
}

/* -------------------------------- 检查 -------------------------------- */

export type FindingKind =
  | "unreachable"
  | "shadowed"
  | "overlap"
  | "contradiction"
  | "duplicate-case"
  | "unmatchable-case"
  | "no-conclusion";

export interface Finding {
  /** 与校验问题同一套路径（`rules[0].branches[1]`），可直接定位 */
  path: string;
  kind: FindingKind;
  severity: "warn" | "error";
  message: string;
}

export interface RuleAnalysis {
  findings: Finding[];
  /** 语句总数（含嵌套） */
  statements: number;
  /** 最深几层 */
  depth: number;
  /** 每个结论会被多少条可达语句给出：用来发现「某个结论永远不产生」 */
  verdicts: Array<{ verdict: Verdict; label: string; count: number }>;
}

/** 一条语句是否「必然给出结论」：是则它后面的同级语句永远轮不到 */
export function isTotal(rule: Rule): boolean {
  if (rule.kind === "outcome") return true;
  if (rule.kind === "if") {
    const branches = rule.branches ?? [];
    return ((branches[branches.length - 1]?.assert ?? []).length === 0);
  }
  return ((rule.default ?? []).length > 0);
}

export function analyzeRules(block: Rule[] | undefined): RuleAnalysis {
  const findings: Finding[] = [];
  const counts = new Map<Verdict, number>();
  const rules = block ?? [];
  if (rules.length > 0) analyzeBlock(rules, "rules", 0, findings, counts);
  return {
    findings,
    statements: countRules(rules),
    depth: rulesDepth(rules),
    verdicts: VERDICTS.map((v) => ({ verdict: v.value, label: v.label, count: counts.get(v.value) ?? 0 })),
  };
}

/** 已经被前面的语句接走的输入区间，用来抓「后面的语句永远轮不到」 */
interface Consumed {
  label: string;
  shape: Shape;
}

function analyzeBlock(
  block: Rule[],
  path: string,
  depth: number,
  out: Finding[],
  counts: Map<Verdict, number>,
): void {
  // 前面已经有一条把所有情况接住了，后面全部轮不到
  let coveredBy = 0;
  // 逐条语句接走的取值范围：分支/取值区间被它完全包含的，就是死配置
  const consumed: Consumed[] = [];

  block.forEach((rule, i) => {
    const at = `${path}[${i}]`;
    const no = i + 1;
    if (coveredBy > 0) {
      out.push({
        path: at,
        kind: "unreachable",
        severity: "warn",
        message: `永远轮不到：第 ${coveredBy} 条已经把所有情况接住了。删掉它，或上移到第 ${coveredBy} 条之前`,
      });
      return;
    }
    if (rule.kind === "outcome") {
      counts.set(rule.verdict, (counts.get(rule.verdict) ?? 0) + 1);
      coveredBy = no;
      return;
    }
    if (rule.kind === "if") {
      analyzeIf(rule, at, no, depth, out, counts, consumed);
      if (isTotal(rule)) coveredBy = no;
      return;
    }
    analyzeSwitch(rule, at, no, depth, out, counts, consumed);
    if ((rule.default ?? []).length > 0) coveredBy = no;
  });

  // 只报「最后一条不保证结论」。中间某条已经全覆盖虽然能兜住，但校验和运行时
  // 都不认这种写法（两边都只看最后一条），所以照实报错，由 unreachable 提示怎么改。
  if (block.length > 0 && !blockConcludes(block)) {
    out.push({
      path,
      kind: "no-conclusion",
      severity: "error",
      message: "块的最后一条不是「必然给出结论」的语句：没命中的响应会变成 UNCLASSIFIED 致命",
    });
  }
}

function analyzeIf(
  rule: IfRule,
  at: string,
  no: number,
  depth: number,
  out: Finding[],
  counts: Map<Verdict, number>,
  consumed: Consumed[],
): void {
  const branches: Branch[] = rule.branches ?? [];
  const earlier: Array<{ no: number; shape: Shape }> = [];
  let allAt = 0;

  branches.forEach((b, j) => {
    const bat = `${at}.branches[${j}]`;
    const conds = b.assert ?? [];

    if (allAt > 0) {
      out.push({
        path: bat,
        kind: "unreachable",
        severity: "warn",
        message: `永远轮不到：第 ${allAt} 个分支没有条件（等于否则），它后面的分支都进不去`,
      });
      return;
    }
    if (conds.length === 0) {
      allAt = j + 1;
    } else {
      const shape = shapeOf(conds, b.scope ?? "body");
      if (shape.contradiction) {
        out.push({
          path: bat,
          kind: "contradiction",
          severity: "warn",
          message: `条件自相矛盾：${shape.contradiction} 同时被要求成两个不同的值，这个分支永远不会命中`,
        });
      }
      let shadowed = 0;
      let overlapped = 0;
      for (const prev of earlier) {
        const rel = relate(prev.shape, shape);
        if (rel === "contains" && shadowed === 0) shadowed = prev.no;
        else if (rel === "overlap" && overlapped === 0) overlapped = prev.no;
      }
      if (shadowed > 0) {
        out.push({
          path: bat,
          kind: "shadowed",
          severity: "warn",
          message: `条件被第 ${shadowed} 个分支完全包含：那个分支范围更宽又会先命中，这里永远轮不到`,
        });
      } else if (overlapped > 0) {
        out.push({
          path: bat,
          kind: "overlap",
          severity: "warn",
          message: `与第 ${overlapped} 个分支有重叠：两边可能同时成立，谁命中取决于顺序。是有意的就忽略`,
        });
      } else {
        // 同一个 if 内不冲突，再看前面几条语句是不是已经把这段输入接走了
        const takenBy = consumed.find((c) => relate(c.shape, shape) === "contains");
        if (takenBy) {
          out.push({
            path: bat,
            kind: "shadowed",
            severity: "warn",
            message: `条件被${takenBy.label}完全包含：语句从上往下执行，这里的响应在那一处就已经有结论了`,
          });
        }
      }
      earlier.push({ no: j + 1, shape });
      consumed.push({ label: `第 ${no} 条语句的第 ${j + 1} 个分支`, shape });
    }

    analyzeBlock(b.then ?? [], `${bat}.then`, depth + 1, out, counts);
  });
}

function switchKeyOf(rule: SwitchRule): string {
  const scope = rule.scope ?? "body";
  if (scope === "status") return "状态码";
  return scope === "record" ? `记录 ${rule.on}` : rule.on;
}

function analyzeSwitch(
  rule: SwitchRule,
  at: string,
  no: number,
  depth: number,
  out: Finding[],
  counts: Map<Verdict, number>,
  consumed: Consumed[],
): void {
  const scope = rule.scope ?? "body";
  const key = switchKeyOf(rule);
  const taken: Array<{ value: unknown; no: number }> = [];

  (rule.cases ?? []).forEach((arm, j) => {
    const cat = `${at}.cases[${j}]`;
    const values = arm.values ?? [];
    const dups: string[] = [];

    for (const v of values) {
      const hit = taken.find((t) => jsonEqual(t.value, v));
      if (hit) dups.push(`${fmtValue(v)}（已被第 ${hit.no} 个 case 拿走）`);
      else taken.push({ value: v, no: j + 1 });
    }
    if (dups.length > 0) {
      out.push({
        path: `${cat}.values`,
        kind: "duplicate-case",
        severity: "error",
        message: `取值 ${dups.join("、")} 永远命中不了：switch 从上往下取第一个相等的臂`,
      });
    }
    if (scope === "status") {
      const bad = values.filter((v) => typeof v !== "number");
      if (bad.length > 0) {
        out.push({
          path: `${cat}.values`,
          kind: "unmatchable-case",
          severity: "error",
          message: `状态码是数字，${bad.map((v) => fmtValue(v)).join("、")} 是字符串，永远匹配不上：写 200 而不是 "200"`,
        });
      }
    }

    if (dups.length === 0 && values.length > 0 && key) {
      const shape: Shape = { keys: new Map([[key, { tag: "set", values }]]), opaque: false, contradiction: null };
      const takenBy = consumed.find((c) => relate(c.shape, shape) === "contains");
      if (takenBy) {
        out.push({
          path: cat,
          kind: "shadowed",
          severity: "warn",
          message: `这些取值被${takenBy.label}完全包含：语句从上往下执行，这里的响应在那一处就已经有结论了`,
        });
      }
      consumed.push({ label: `第 ${no} 条语句的 case ${j + 1}`, shape });
    }

    analyzeBlock(arm.then ?? [], `${cat}.then`, depth + 1, out, counts);
  });

  analyzeBlock(rule.default ?? [], `${at}.default`, depth + 1, out, counts);
}

/* -------------------------------- 矩阵 -------------------------------- */

export interface MatrixCell {
  text: string;
  tone: "value" | "any" | "unknown" | "conflict";
  title?: string;
}

export interface IfMatrixRow {
  no: number;
  label: string;
  cells: MatrixCell[];
  /** 分支体最终给出的结论 */
  note: string;
  /** 被前面哪个分支吃掉 */
  flags: string[];
}

export interface IfMatrixData {
  columns: string[];
  rows: IfMatrixRow[];
}

function rangeText(d: RangeDomain): string {
  const parts: string[] = [];
  if (d.lo !== undefined) parts.push(`${d.loInc ? "≥" : ">"} ${d.lo}`);
  if (d.hi !== undefined) parts.push(`${d.hiInc ? "≤" : "<"} ${d.hi}`);
  return parts.join(" 且 ");
}

function cellText(d: Domain | undefined): MatrixCell {
  if (!d) return { text: "*", tone: "any", title: "这一列不关心" };
  switch (d.tag) {
    case "empty":
      return { text: "矛盾", tone: "conflict", title: "两条条件要求同一个键取不同的值" };
    case "unknown":
      return { text: "无法判定", tone: "unknown", title: "含 ne / contains / regex / 分组，静态推不出来" };
    case "any":
      return { text: "*", tone: "any" };
    case "set":
      return { text: d.values.map((v) => fmtValue(v)).join(" / "), tone: "value" };
    case "range":
      return { text: rangeText(d), tone: "value" };
  }
}

/** `if` 的分支 × 判别字段表。只读投影：条件仍然在块视图里改 */
export function matrixOfIf(rule: IfRule): IfMatrixData {
  const branches: Branch[] = rule.branches ?? [];
  const shapes = branches.map((b) => shapeOf(b.assert ?? [], b.scope ?? "body"));
  const columns: string[] = [];
  for (const s of shapes) for (const key of s.keys.keys()) if (!columns.includes(key)) columns.push(key);

  const rows = branches.map((b, i) => {
    const isElse = (b.assert ?? []).length === 0;
    const shape = shapes[i];
    const cells = columns.map((col) => (isElse ? { text: "其余", tone: "any" as const } : cellText(shape.keys.get(col))));
    const flags: string[] = [];
    if (!isElse) {
      for (let k = 0; k < i; k += 1) {
        if ((branches[k].assert ?? []).length === 0) {
          flags.push(`被第 ${k + 1} 个分支（否则）完全包含`);
          break;
        }
        if (relate(shapes[k], shape) === "contains") {
          flags.push(`被第 ${k + 1} 个分支完全包含`);
          break;
        }
      }
    }
    return { no: i + 1, label: branchLabel(b, i), cells, note: blockOutcomeText(b.then ?? []), flags };
  });

  return { columns, rows };
}

export interface SwitchRow {
  no: number;
  values: unknown[];
  note: string;
  /** 被前面 case 拿走的取值 */
  dup: string[];
}

export interface SwitchMatrixData {
  column: string;
  rows: SwitchRow[];
  defaultNote: string;
}

export function matrixOfSwitch(rule: SwitchRule): SwitchMatrixData {
  const column = (rule.scope ?? "body") === "status" ? "状态码" : rule.on || "（未填字段）";
  const taken: Array<{ value: unknown; no: number }> = [];
  const rows = (rule.cases ?? []).map((arm, i) => {
    const dup: string[] = [];
    for (const v of arm.values ?? []) {
      const hit = taken.find((t) => jsonEqual(t.value, v));
      if (hit) dup.push(fmtValue(v));
      else taken.push({ value: v, no: i + 1 });
    }
    return { no: i + 1, values: arm.values ?? [], note: blockOutcomeText(arm.then ?? []), dup };
  });
  return { column, rows, defaultNote: blockOutcomeText(rule.default ?? []) };
}

/* -------------------------------- 定位 -------------------------------- */

/** 某个路径下的全部问题（`rules[0]` 也能吃到 `rules[0].branches[1]`） */
export function findingsUnder(findings: Finding[], path: string): Finding[] {
  return findings.filter(
    (f) => f.path === path || f.path.startsWith(`${path}[`) || f.path.startsWith(`${path}.`),
  );
}

/** 把问题路径收敛到最近的一条语句上，用于滚动定位 */
export function statementPathOf(path: string): string {
  let p = path;
  for (;;) {
    const next = p
      .replace(/\.(values|assert|on|then|default)$/, "")
      .replace(/\.(branches|cases)\[\d+\]$/, "");
    if (next === p) return p;
    p = next;
  }
}

export const anchorOf = (path: string): string => `rule-anchor-${path}`;
