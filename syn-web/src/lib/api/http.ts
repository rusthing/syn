/**
 * HTTP 基座。
 *
 * 这里有两套响应约定，必须分开处理：
 * - CRUD 接口走框架的 `Ro<T>`：`{ result: 1|-1|-2|-3, msg, extra }`；
 * - `POST /syn/sync/{topic}` 是给 sink 用的，`result` 是**结论字符串**
 *   （`success / skip / fatal / retriable`），HTTP 状态码同时表达结论。
 * 把它们塞进同一个解析器，出错时永远说不清是谁的问题。
 */

import { authHeaders, handleUnauthorized } from "../auth-core";
import type { SyncReply } from "./types";

const RAW_API_BASE = (import.meta.env.VITE_API_BASE ?? "").trim();

/** 接口基址。生产是同源前缀（`/syn-svr`），开发期由 Vite 反代 `/api` */
export const API_BASE = (RAW_API_BASE || "").replace(/\/+$/, "");

/** 是否配了后端地址。没配就整站走演示数据 */
export const HAS_API = RAW_API_BASE.length > 0;

const TOKEN = (import.meta.env.VITE_SYN_TOKEN ?? "").trim();

export interface Ro<T> {
  result: 1 | -1 | -2 | -3;
  msg?: string;
  timestamp?: string;
  extra?: T;
  detail?: string;
  code?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** 网络层完全没通（区别于服务端返回的业务错误） */
  get isNetworkError() {
    return this.status === 0;
  }

  /** 后端还没有这个接口：多半是五件套还没落地，不是用户操作错 */
  get isMissing() {
    return this.status === 404 || this.status === 405;
  }
}

const RESULT_PREFIX: Record<number, string> = {
  [-1]: "参数不合法：",
  [-2]: "",
  [-3]: "服务处理失败：",
};

export function describeApiError(
  status: number,
  result: number | undefined,
  msg: string | undefined,
  detail: string | undefined,
): string {
  if (status === 401) return "登录状态已失效，请重新登录";
  if (status === 403) return "无权访问该接口";
  if (status === 404 || status === 405) {
    return `接口不存在（HTTP ${status}）：syn-svr 尚未提供该能力，或网关前缀没配对`;
  }
  if (status === 429) return "请求过于频繁，请稍后重试";
  if (status >= 500) return msg || detail || `服务端异常（HTTP ${status}）`;
  const text = msg || detail || "请求失败";
  return `${RESULT_PREFIX[result ?? 0] ?? ""}${text}`;
}

type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function rawFetch(
  path: string,
  options: RequestOptions & { token?: boolean } = {},
): Promise<{ response: Response; text: string }> {
  const { method = "GET", query, body, signal, timeoutMs = 15_000, token } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

  // 与其余六站同口径：required 模式带 Bearer + 真实 X-User-Id，
  // disabled（开发）模式固定系统账号 0。X-Syn-Token 是执行器自己的业务令牌，与会话无关。
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...authHeaders(),
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token && TOKEN) headers["X-Syn-Token"] = TOKEN;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      signal: composed,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(timeout.aborted ? "请求超时" : "无法连接到 syn 服务", 0);
  }

  // 401 不是业务结论：清掉本地会话并广播，由 AuthGate 统一送回登录页。
  // 同步入口 /syn/sync/{topic} 的非 2xx 也是结论，但 401 必须例外。
  if (response.status === 401) {
    handleUnauthorized();
    throw new ApiError("登录状态已失效，请重新登录", 401);
  }

  return { response, text: await response.text() };
}

/** CRUD 请求：拆 `Ro<T>`，非 1 一律抛错 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { response, text } = await rawFetch(path, options);

  let payload: Ro<T> | null = null;
  if (text) {
    try {
      payload = JSON.parse(text) as Ro<T>;
    } catch {
      payload = null;
    }
  }

  if (!payload) {
    if (response.ok && response.status === 204) return undefined as T;
    throw new ApiError(
      `服务返回了非 JSON 响应（HTTP ${response.status}），检查 ${API_BASE || "接口前缀"} 是否被正确反代`,
      response.status,
    );
  }

  // 网关可能把令牌失效包成 200 + ADM00005，也要走同一套清会话流程。
  if (payload.code === "ADM00005") {
    handleUnauthorized();
    throw new ApiError("登录状态已失效，请重新登录", 401, payload.code);
  }

  if (!response.ok || payload.result !== 1) {
    throw new ApiError(
      describeApiError(response.status, payload.result, payload.msg, payload.detail),
      response.status,
      payload.code,
      payload.detail,
    );
  }

  return payload.extra as T;
}

/**
 * 同步入口：返回体是 `{ result: "success", code, task, stage, detail }`，
 * 状态码与 `result` 同时表达结论。非 2xx **不是**异常，是业务结论。
 */
export async function syncRecord(topic: string, record: unknown): Promise<SyncReply> {
  const { response, text } = await rawFetch(`/syn/sync/${encodeURIComponent(topic)}`, {
    method: "POST",
    body: record,
    token: true,
    timeoutMs: 30_000,
  });

  let payload: Partial<SyncReply> | null = null;
  if (text) {
    try {
      payload = JSON.parse(text) as Partial<SyncReply>;
    } catch {
      payload = null;
    }
  }

  if (!payload) {
    throw new ApiError(
      `非 JSON 响应（HTTP ${response.status}）：多半是网关把 /syn/sync 兜底成了页面`,
      response.status,
    );
  }

  return {
    result: (payload.result ?? (response.ok ? "success" : "fatal")) as SyncReply["result"],
    code: payload.code ?? `HTTP_${response.status}`,
    task: payload.task ?? null,
    stage: payload.stage ?? "match",
    detail: payload.detail ?? null,
  };
}
