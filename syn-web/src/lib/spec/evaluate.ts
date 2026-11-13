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
  Guard,
  MappingRow,
  OnEmpty,
  Scope,
  TaskSpec,
  Verdict,
} from "@/lib/api/types";
import { getPath, insertPath, scalarText } from "./jsonpath";
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
    case "lt": {
      const pair = numericPair(lhs, expected);
      return pair !== null && pair[0] < pair[1];
    }
    default:
      return false;
  }
}

export function evalAsserts(
  asserts: Assert[],
  ctx: Context,
  defaultScope: Scope,
): AssertResult[] {
  return asserts.map((a) => ({
    assert: a,
    ok: evalAssert(a, ctx, defaultScope),
    lhs:
      (a.scope ?? defaultScope) === "body"
        ? a.field
          ? getPath(ctx.body, a.field)
          : undefined
        : (a.scope ?? defaultScope) === "status"
          ? ctx.status
          : a.field
            ? getPath(ctx.record, a.field)
            : undefined,
  }));
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
  const omitNull = spec.mapping.omit_null ?? true;
  const body: Record<string, unknown> = {};
  const rows: MappedRow[] = [];

  for (const row of spec.mapping.rows) {
    const { value, note } = resolveRow(row, record);

    if (isNullish(value)) {
      if (omitNull) {
        rows.push({ to: row.to, note: `${note}（null 省略）`, ok: true, omitted: true });
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
  const rules = spec.outcomes ?? [];
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    if (rule.assert.every((a) => evalAssert(a, ctx, rule.scope))) {
      return { index: i + 1, verdict: rule.verdict, code: rule.code ?? "", fallback: false };
    }
  }
  // 校验要求最后一条兜底，正常走不到这里。真走到了按失败处理：
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
}

export function preview(spec: TaskSpec, record: unknown, options: PreviewOptions = {}): PreviewResult {
  const task = spec.id ?? "";
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
  const matchAsserts = evalAsserts(spec.match ?? [], ctx, "record");
  const matched = matchAsserts.every((a) => a.ok);
  steps.push({
    stage: "match",
    ok: matched,
    title: matched ? "命中匹配条件" : "未命中匹配条件",
    asserts: matchAsserts,
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
    if (guard.when && !evalAssert(guard.when, ctx, "record")) {
      steps.push({
        stage: "guard",
        ok: true,
        title: `守卫 ${i + 1} 不适用`,
        detail: "when 条件不满足，整条守卫跳过",
      });
      continue;
    }
    const results = evalAsserts(guard.assert, guardCtx, "record");
    const passed = results.every((r) => r.ok);
    steps.push({
      stage: "guard",
      ok: passed,
      title: passed ? `守卫 ${i + 1} 放行` : `守卫 ${i + 1} 拒绝`,
      asserts: results,
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
 * 与服务端同一套规则：按 priority 升序，命中即停；任务标了 `exclusive: false`
 * 就继续往下找。扇出判断必须和线上一致，否则试跑会把「两个任务都会收到」说成一个。
 */
export function selectTasks(tasks: TaskSpec[], record: unknown): TaskSpec[] {
  const ordered = [...tasks].sort((a, b) => a.priority - b.priority || (a.id ?? "").localeCompare(b.id ?? ""));
  const chosen: TaskSpec[] = [];
  const ctx: Context = { record };
  for (const task of ordered) {
    if (task.enabled === false) continue;
    if ((task.match ?? []).every((a) => evalAssert(a, ctx, "record"))) {
      chosen.push(task);
      if (task.exclusive !== false) break;
    }
  }
  return chosen;
}
