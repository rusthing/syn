/**
 * 五段的本地预演（与 `syn-core/src/{assertion,mapping,verdict,engine}.rs` 同构）。
 *
 * 为什么不直接调后端：图形化配置最怕「点了保存才发现规则写错」。试跑必须在**改库之前**
 * 就能给出答案，所以这里把五段在浏览器里跑一遍。真发请求是可选项（走 `/syn/sync/{topic}`），
 * 只有用户勾了「真实投递」才会碰下游。
 *
 * 语义上有一处必须照抄后端的取舍：守卫的断言**默认对记录求值**，要看请求体得显式
 * `scope: body`。前端要是「贴心」地改成默认看请求体，两边就会对同一份配置给出不同结论。
 */

import type {
  Action,
  Assert,
  Condition,
  Guard,
  MappingRow,
  OnEmpty,
  Rule,
  Scope,
  TaskSpec,
  Verdict,
} from "@/lib/api/types";
import { isAssert } from "./defaults";
import { getPath, insertPath, scalarText } from "./jsonpath";
import { verdictRules } from "./rules";
import { applyTransform, TransformError } from "./transforms";

export type Stage = "match" | "mapping" | "guard" | "action" | "verdict" | "transport";

export interface Context {
  record: unknown;
  body?: Record<string, unknown>;
  status?: number;
}

export interface AssertResult {
  assert: Assert;
  ok: boolean;
  lhs: unknown;
  /** 所属分组名：OR 分组里单条不成立不代表整组失败，试跑页据此标注 */
  group?: string;
}

export interface MappedRow {
  to: string;
  note: string;
  value?: unknown;
  ok: boolean;
  error?: string;
  omitted?: boolean;
}

export interface StepResult {
  stage: Stage;
  ok: boolean;
  title: string;
  detail?: string;
  asserts?: AssertResult[];
  rows?: MappedRow[];
}

export interface RequestPreview {
  method: string;
  url: string;
  query: Array<[string, string]>;
  headers: Array<[string, string]>;
  body?: unknown;
}

export interface PreviewResult {
  task: string;
  verdict: Verdict;
  code: string;
  stage: Stage;
  detail?: string;
  steps: StepResult[];
  body?: Record<string, unknown>;
  request?: RequestPreview;
  judgement?: { index: number; verdict: Verdict; code: string; fallback: boolean };
  /** 需要真实投递时用的 op，避免 UI 再解析一次记录 */
  op: string | null;
}

const OP_NAMES = ["c", "r", "u", "d"] as const;

export function opOf(record: unknown): string | null {
  if (!record || typeof record !== "object") return null;
  const value = (record as Record<string, unknown>).op;
  return typeof value === "string" && (OP_NAMES as readonly string[]).includes(value) ? value : null;
}

/* ------------------------------- 断言求值 ------------------------------- */

function isNullish(v: unknown): boolean {
  return v === null || v === undefined;
}

function jsonEquals(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (a === b) return true;
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function numericPair(a: unknown, b: unknown): [number, number] | null {
  if (typeof a !== "number" || typeof b !== "number") return null;
  return [a, b];
}

/** 取用于文本匹配的形式；null 视为没有文本 */
function textOf(value: unknown): string | null {
  if (isNullish(value)) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function evalAssert(a: Assert, ctx: Context, defaultScope: Scope): boolean {
  const scope = a.scope ?? defaultScope;
  if (scope === "status") {
    if (a.field) return false; // 配置错误，validate 会拦；这里按不匹配
    return evalValue(a, ctx.status ?? undefined);
  }
  const lhs =
    scope === "body"
      ? a.field && ctx.body
        ? getPath(ctx.body, a.field)
        : undefined
      : a.field
        ? getPath(ctx.record, a.field)
        : undefined;
  return evalValue(a, lhs);
}

function evalValue(a: Assert, lhs: unknown): boolean {
  const expected = a.value;
  switch (a.op) {
    case "exists":
      return !isNullish(lhs);
    case "absent":
      return isNullish(lhs);
    case "present":
      if (typeof lhs === "string") return lhs.trim().length > 0;
      if (Array.isArray(lhs)) return lhs.length > 0;
      if (lhs && typeof lhs === "object") return Object.keys(lhs).length > 0;
      if (isNullish(lhs)) return false;
      return true;
    case "eq":
      return jsonEquals(lhs, expected);
    case "ne":
      return !jsonEquals(lhs, expected);
    case "in":
      return Array.isArray(expected) && expected.some((e) => jsonEquals(lhs, e));
    case "not_in":
      return Array.isArray(expected) && !expected.some((e) => jsonEquals(lhs, e));
    case "starts_with":
      return typeof lhs === "string" && typeof expected === "string" && lhs.startsWith(expected);
    case "contains": {
      if (typeof expected !== "string") return false;
      const text = textOf(lhs);
      return text !== null && text.includes(expected);
    }
    case "regex": {
      if (typeof expected !== "string") return false;
      // 正则写错按不匹配处理：配置错误不该让整条记录的处理崩掉
      try {
        return new RegExp(expected).test(textOf(lhs) ?? "");
      } catch {
        return false;
      }
    }
    case "gt": {
      const pair = numericPair(lhs, expected);
      return pair !== null && pair[0] > pair[1];
    }
    case "gte": {
      const pair = numericPair(lhs, expected);
      return pair !== null && pair[0] >= pair[1];
    }
    case "lt": {
      const pair = numericPair(lhs, expected);
      return pair !== null && pair[0] < pair[1];
    }
    case "lte": {
      const pair = numericPair(lhs, expected);
      return pair !== null && pair[0] <= pair[1];
    }
    default:
      return false;
  }
}

function lhsOf(a: Assert, ctx: Context, defaultScope: Scope): unknown {
  const scope = a.scope ?? defaultScope;
  if (scope === "status") return ctx.status;
  if (scope === "body") return a.field ? getPath(ctx.body, a.field) : undefined;
  return a.field ? getPath(ctx.record, a.field) : undefined;
}

/** 求值一个条件节点（与 `syn-core::eval_condition` 同构） */
export function evalCondition(c: Condition, ctx: Context, defaultScope: Scope): boolean {
  if (isAssert(c)) return evalAssert(c, ctx, defaultScope);
  if ("all" in c) return c.all.every((x) => evalCondition(x, ctx, defaultScope));
  if ("any" in c) return c.any.some((x) => evalCondition(x, ctx, defaultScope));
  return !evalCondition(c.not, ctx, defaultScope);
}

/**
 * 顶层条件数组恒为 AND。除了整体结果，还把叶子逐条收集下来给试跑页展示：
 * 分组内即使某条不成立也照常收集，别让短路把结果列表削掉几行。
 */
export function evalConditions(
  conditions: Condition[],
  ctx: Context,
  defaultScope: Scope,
): { ok: boolean; results: AssertResult[] } {
  const results: AssertResult[] = [];
  const walk = (c: Condition, group?: string): boolean => {
    if (isAssert(c)) {
      const ok = evalAssert(c, ctx, defaultScope);
      results.push({ assert: c, ok, lhs: lhsOf(c, ctx, defaultScope), group });
      return ok;
    }
    if ("all" in c) {
      const flags = c.all.map((x) => walk(x, "全部满足"));
      return flags.every(Boolean);
    }
    if ("any" in c) {
      const flags = c.any.map((x) => walk(x, "任意满足"));
      return flags.some(Boolean);
    }
    return !walk(c.not, "取反");
  };
  const ok = conditions.map((c) => walk(c)).every(Boolean);
  return { ok, results };
}

/** 兼容试跑页：只要逐条结果 */
export function evalAsserts(
  conditions: Condition[],
  ctx: Context,
  defaultScope: Scope,
): AssertResult[] {
  return evalConditions(conditions, ctx, defaultScope).results;
}

/* -------------------------------- 映射 -------------------------------- */

interface MapOutcome {
  body: Record<string, unknown>;
  rows: MappedRow[];
  failure?: { field: string; verdict: Verdict; code: string; detail: string };
}

function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim().length === 0;
  return false;
}

function applyOnEmpty(value: unknown, original: unknown, mode: OnEmpty | undefined): unknown {
  switch (mode ?? "keep") {
    case "keep_original":
      return original;
    case "null":
      return null;
    default:
      return value;
  }
}

export function mapRecord(spec: TaskSpec, record: unknown): MapOutcome {
  const body: Record<string, unknown> = {};
  const rows: MappedRow[] = [];

  for (const row of spec.mapping.rows) {
    const { value, note } = resolveRow(row, record);

    if (isNullish(value)) {
      const mode = row.on_null ?? "omit";
      if (mode === "omit") {
        rows.push({ to: row.to, note: `${note}（null 省略）`, ok: true, omitted: true });
        continue;
      }
      if (mode === "fallback") {
        const fb = row.default ?? null;
        insertPath(body, row.to, fb);
        rows.push({ to: row.to, note: `${note}（null 兜底默认值）`, ok: true, value: fb });
        continue;
      }
      insertPath(body, row.to, null);
      rows.push({ to: row.to, note: `${note}（null 保留）`, ok: true, value: null });
      continue;
    }

    const original = value;
    let current = value;
    try {
      for (const t of row.fn ?? []) {
        current = applyTransform(current, t);
      }
    } catch (error) {
      const detail = error instanceof TransformError ? error.message : String(error);
      const verdict = row.on_error?.verdict ?? "fatal";
      const code = row.on_error?.code ?? "TRANSFORM_ERROR";
      rows.push({ to: row.to, note, ok: false, error: `${detail}` });
      return { body, rows, failure: { field: row.to, verdict, code, detail } };
    }

    if (isBlank(current)) {
      if ((row.on_empty ?? "keep") === "omit") {
        rows.push({ to: row.to, note: `${note}（空，省略）`, ok: true, omitted: true });
        continue;
      }
      current = applyOnEmpty(current, original, row.on_empty);
    }

    insertPath(body, row.to, current);
    rows.push({ to: row.to, note, ok: true, value: current });
  }

  return { body, rows };
}

function resolveRow(row: MappingRow, record: unknown): { value: unknown; note: string } {
  if (row.const !== undefined) return { value: row.const, note: "常量" };
  if (!row.from) return { value: null, note: "未配置来源" };
  const value = getPath(record, row.from);
  if (value === undefined) return { value: null, note: "路径不存在" };
  const fn = row.fn ?? [];
  return { value, note: fn.length === 0 ? "直传" : fn.join(" → ") };
}

/* -------------------------------- 判定 -------------------------------- */

// 语句树的形状、映射与兜底判断都在 `rules.ts`（编辑器与校验器共用同一份）；
// 这里只负责求值，避免「谁有资格解释规则」出现第二个答案。
export { verdictRules } from "./rules";

type Hit = { verdict: Verdict; code: string };

function evalBlock(block: Rule[] | undefined, ctx: Context): Hit | null {
  for (const rule of block ?? []) {
    const hit = evalRule(rule, ctx);
    if (hit) return hit;
  }
  return null;
}

function evalRule(rule: Rule, ctx: Context): Hit | null {
  switch (rule.kind) {
    case "outcome":
      return { verdict: rule.verdict, code: rule.code ?? "" };
    case "if": {
      // 空条件数组恒真，这就是「否则」分支
      for (const b of rule.branches) {
        if (evalConditions(b.assert ?? [], ctx, b.scope ?? "body").ok) {
          return evalBlock(b.then, ctx);
        }
      }
      return null;
    }
    case "switch": {
      const scope = rule.scope ?? "body";
      const lhs =
        scope === "status" ? ctx.status : scope === "body" ? getPath(ctx.body, rule.on) : getPath(ctx.record, rule.on);
      for (const c of rule.cases) {
        if (c.values.some((v) => jsonEquals(lhs, v))) return evalBlock(c.then, ctx);
      }
      return evalBlock(rule.default, ctx);
    }
  }
}

export function judge(
  spec: TaskSpec,
  status: number,
  body: unknown,
): { index: number; verdict: Verdict; code: string; fallback: boolean } {
  const ctx: Context = {
    record: null,
    body: body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined,
    status,
  };
  const rules = verdictRules(spec);
  for (let i = 0; i < rules.length; i += 1) {
    const hit = evalRule(rules[i], ctx);
    // index 是**顶层**语句序号：嵌套里命中也算「第几条语句管住了这条响应」
    if (hit) return { index: i + 1, verdict: hit.verdict, code: hit.code, fallback: false };
  }
  // 校验要求每层块都以兜底收尾，正常走不到这里。真走到了按失败处理：
  // 「不认识的响应」被当成成功，是这条链路上最贵的一种错误。
  return { index: 0, verdict: "fatal", code: "UNCLASSIFIED", fallback: true };
}

/* ------------------------------ 请求渲染 ------------------------------ */

const UNRESERVED = /[A-Za-z0-9\-_.~]/;

function encode(value: string): string {
  let out = "";
  for (const ch of value) {
    if (UNRESERVED.test(ch)) out += ch;
    else {
      const bytes = new TextEncoder().encode(ch);
      for (const b of bytes) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function joinUrl(baseUrl: string, spec: TaskSpec, path: string): string {
  let url = baseUrl.replace(/\/+$/, "") + spec.target.base.replace(/\/+$/, "");
  if (path) {
    if (!path.startsWith("/")) url += "/";
    url += path;
  }
  return url;
}

/** 渲染一次请求。`baseUrl` 只是给人看的占位地址，试跑不真的连它 */
export function renderRequest(
  spec: TaskSpec,
  record: unknown,
  body: Record<string, unknown>,
  action: Action,
  baseUrl = "http://«service»",
): RequestPreview {
  let url = joinUrl(baseUrl, spec, action.path ?? "");

  const query: Array<[string, string]> = [];
  for (const q of action.query ?? []) {
    const v = getPath(record, q.from);
    // 取不到或为 null 都不拼进 query：`?a=null` 和「没传 a」在下游是两件事
    if (!isNullish(v)) query.push([q.name, scalarText(v)]);
  }
  if (query.length > 0) {
    const qs = query.map(([k, v]) => `${encode(k)}=${encode(v)}`).join("&");
    url += (url.includes("?") ? "&" : "?") + qs;
  }

  const headers: Array<[string, string]> = [];
  for (const h of action.headers ?? []) {
    const v = getPath(record, h.from);
    if (!isNullish(v)) headers.push([h.name, scalarText(v)]);
    else if (h.default !== undefined) headers.push([h.name, h.default]);
  }

  const mode = action.body ?? "mapped";
  const requestBody = mode === "none" ? undefined : mode === "raw" ? record : body;

  return { method: action.method, url, query, headers, body: requestBody };
}

/* ------------------------------ 五段预演 ------------------------------ */

export interface PreviewOptions {
  /** 只看匹配，不往下跑（任务列表里给「能不能命中」用） */
  matchOnly?: boolean;
  /** 结果里回显的任务标签（名称）；不传就留空，别拿它当身份 */
  task?: string;
}

export function preview(spec: TaskSpec, record: unknown, options: PreviewOptions = {}): PreviewResult {
  const task = options.task ?? "";
  const steps: StepResult[] = [];
  const stop = (verdict: Verdict, code: string, stage: Stage, detail: string): PreviewResult => ({
    task,
    verdict,
    code,
    stage,
    detail,
    steps,
    op: opOf(record),
  });

  if (spec.enabled === false) {
    steps.push({ stage: "match", ok: false, title: "任务已停用", detail: "停用任务不参与匹配" });
    return stop("skip", "disabled", "match", "任务已停用");
  }

  // 1 匹配
  const ctx: Context = { record };
  const matchResult = evalConditions(spec.match ?? [], ctx, "record");
  const matched = matchResult.ok;
  steps.push({
    stage: "match",
    ok: matched,
    title: matched ? "命中匹配条件" : "未命中匹配条件",
    asserts: matchResult.results,
    detail: matched ? undefined : "该任务不会处理这条记录",
  });
  if (!matched) return stop("skip", "no_match", "match", "记录不满足匹配条件");

  if (options.matchOnly) {
    return { task, verdict: "skip", code: "match_only", stage: "match", steps, op: opOf(record) };
  }

  // 2 映射
  const mapped = mapRecord(spec, record);
  steps.push({
    stage: "mapping",
    ok: !mapped.failure,
    title: mapped.failure ? "映射失败" : `映射出 ${Object.keys(mapped.body).length} 个字段`,
    rows: mapped.rows,
    detail: mapped.failure ? `${mapped.failure.field}: ${mapped.failure.detail}` : undefined,
  });
  if (mapped.failure) {
    return {
      ...stop(mapped.failure.verdict, mapped.failure.code, "mapping", mapped.failure.detail),
      body: mapped.body,
    };
  }

  // 3 守卫
  const guardCtx: Context = { record, body: mapped.body };
  for (let i = 0; i < (spec.guards ?? []).length; i += 1) {
    const guard: Guard = (spec.guards ?? [])[i];
    // when 与 assert 用同一份上下文：显式 scope: body 时看映射后的请求体，
    // 否则会被静默跳过（守卫等于没配）
    if (guard.when && !evalAssert(guard.when, guardCtx, "record")) {
      steps.push({
        stage: "guard",
        ok: true,
        title: `守卫 ${i + 1} 不适用`,
        detail: "when 条件不满足，整条守卫跳过",
      });
      continue;
    }
    const guardResult = evalConditions(guard.assert, guardCtx, "record");
    const passed = guardResult.ok;
    steps.push({
      stage: "guard",
      ok: passed,
      title: passed ? `守卫 ${i + 1} 放行` : `守卫 ${i + 1} 拒绝`,
      asserts: guardResult.results,
      detail: passed ? undefined : (guard.on_fail.message ?? guard.on_fail.code),
    });
    if (!passed) {
      return {
        ...stop(guard.on_fail.verdict, guard.on_fail.code, "guard", guard.on_fail.message ?? ""),
        body: mapped.body,
      };
    }
  }

  // 4 选动作
  const op = opOf(record);
  if (!op) {
    steps.push({ stage: "action", ok: false, title: "记录缺少 op", detail: "op 必须是 c/r/u/d 之一" });
    return { ...stop("fatal", "NO_OP", "action", "记录缺少 op 或取值不合法"), body: mapped.body };
  }
  // db 直写没有动作段：op 由记录自带，写库形状看 on_conflict（同 execute_db）
  if (spec.target.kind === "db") {
    const ds = spec.target.datasource?.trim() || "«数据源»";
    const table = spec.target.table?.trim() || "«表»";
    const request: RequestPreview = {
      method: "POST",
      url: `db://${ds}/${table}`,
      query: [],
      headers: [],
      body: mapped.body,
    };
    steps.push({
      stage: "action",
      ok: true,
      title: `写库 · op=${op}`,
      detail: `${spec.target.on_conflict ?? "update"} · ${request.url}`,
    });
    steps.push({
      stage: "transport",
      ok: true,
      title: "待真实写库",
      detail: "本地预演不连库；勾选「真实投递」由服务端写，判定只看 affected",
    });
    return {
      task,
      verdict: "success",
      code: "preview_only",
      stage: "transport",
      steps,
      body: mapped.body,
      request,
      op,
    };
  }

  const action = (spec.actions ?? []).find((a) => a.op === op);
  if (!action) {
    steps.push({ stage: "action", ok: false, title: `未配置 op=${op} 的动作` });
    return {
      ...stop("fatal", "NO_ACTION_FOR_OP", "action", `未配置 op=${op} 的动作`),
      body: mapped.body,
    };
  }
  const request = renderRequest(spec, record, mapped.body, action, `http://«${spec.target.service}»`);
  steps.push({
    stage: "action",
    ok: true,
    title: `选中 ${op} 的动作`,
    detail: `${request.method} ${request.url}`,
  });

  // 5 结论：没有真实响应时，只能给出「待判定」
  steps.push({
    stage: "transport",
    ok: true,
    title: "待真实投递",
    detail: "本地预演不发送请求；勾选「真实投递」由服务端判定",
  });

  return {
    task,
    verdict: "success",
    code: "preview_only",
    stage: "transport",
    steps,
    body: mapped.body,
    request,
    op,
  };
}

/**
 * 只回答「这条记录会被哪些任务接走」。
 *
 * 与服务端同一套规则：按 sort_order 升序，命中即停；任务标了 `exclusive: false`
 * 就继续往下找。扇出判断必须和线上一致，否则试跑会把「两个任务都会收到」说成一个。
 *
 * 泛型 + `specOf` 是为了让调用方直接传 `SyncTask`：返回值仍是原对象，调用方
 * 拿得到 id / 名称，不必把身份塞进 `spec` 再反查。
 */
export function selectTasks<T>(
  tasks: T[],
  record: unknown,
  specOf: (task: T) => TaskSpec,
): T[] {
  // Array#sort 是稳定排序：sort_order 相同时保持调用方给的顺序（通常是 id 升序）
  const ordered = [...tasks].sort((a, b) => specOf(a).sort_order - specOf(b).sort_order);
  const chosen: T[] = [];
  const ctx: Context = { record };
  for (const item of ordered) {
    const spec = specOf(item);
    if (spec.enabled === false) continue;
    if (evalConditions(spec.match ?? [], ctx, "record").ok) {
      chosen.push(item);
      if (spec.exclusive !== false) break;
    }
  }
  return chosen;
}
