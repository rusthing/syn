/** 一些琐碎但处处要用的工具。 */

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

/**
 * macOS 风格 widget 网格：固定列宽、从左往右排、排不下换行，右侧留白。
 * 不用 `1fr` 等分，否则宽屏会把卡片拉长变形。
 */
export const WIDGET_GRID = "grid gap-3 grid-cols-[repeat(auto-fill,220px)] max-sm:grid-cols-1";

/** 内容较多的卡片（数据抽取等）：固定 480，行内不强行等高，避免展开详情时整行被撑高 */
export const WIDE_WIDGET_GRID =
  "grid items-start gap-3 grid-cols-[repeat(auto-fill,480px)] max-sm:grid-cols-1";

/** 把可能是 JSON 的字符串格式化成带缩进的文本；不是 JSON 就原样返回 */
export function prettyJson(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function isJsonObject(value: string | null | undefined): boolean {
  if (!value) return true;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

export function jsonError(value: string | null | undefined): string | null {
  if (!value || !value.trim()) return null;
  try {
    JSON.parse(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "JSON 格式错误";
  }
}

/** 19 位雪花 ID 的展示形式：头 6 位 … 尾 4 位 */
export function shortId(id: string | null | undefined): string {
  if (!id) return "--";
  if (id.length <= 10) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

export function compactNumber(value: number): string {
  if (Math.abs(value) >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function percent(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

export function groupBy<T, K extends string | number>(
  items: T[],
  keyOf: (item: T) => K,
): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}
