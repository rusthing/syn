/** 时间与时长格式化。所有入参兼容后端返回的字符串毫秒时间戳。 */

export type TimeInput = string | number | null | undefined;

export function toMs(value: TimeInput): number | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = typeof value === "number" ? value : Number(value);
  return Number.isFinite(ms) ? ms : null;
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

export function formatDate(value: TimeInput): string {
  const ms = toMs(value);
  if (ms === null) return "--";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatTime(value: TimeInput, withSeconds = true): string {
  const ms = toMs(value);
  if (ms === null) return "--";
  const d = new Date(ms);
  return withSeconds
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDateTime(value: TimeInput, withSeconds = true): string {
  const ms = toMs(value);
  if (ms === null) return "--";
  return `${formatDate(ms)} ${formatTime(ms, withSeconds)}`;
}

/** 10-21 14:32 —— 表格里用的紧凑格式，同年省略年份 */
export function formatCompact(value: TimeInput): string {
  const ms = toMs(value);
  if (ms === null) return "--";
  const d = new Date(ms);
  const now = new Date();
  const date =
    d.getFullYear() === now.getFullYear()
      ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      : formatDate(ms);
  return `${date} ${formatTime(ms, false)}`;
}

/** 「3 分钟后」「2 小时前」—— 面向运维的第一读数 */
export function formatRelative(value: TimeInput, now = Date.now()): string {
  const ms = toMs(value);
  if (ms === null) return "--";
  const delta = ms - now;
  const abs = Math.abs(delta);

  if (abs < 5_000) return "刚刚";

  const units: Array<[number, string]> = [
    [86_400_000, "天"],
    [3_600_000, "小时"],
    [60_000, "分钟"],
    [1_000, "秒"],
  ];

  for (const [size, label] of units) {
    if (abs >= size) {
      const amount = Math.floor(abs / size);
      const text = `${amount} ${label}`;
      return delta > 0 ? `${text}后` : `${text}前`;
    }
  }
  return "刚刚";
}

/** 倒计时：< 1 小时显示 mm:ss，否则显示 1h 04m */
export function formatCountdown(value: TimeInput, now = Date.now()): string {
  const ms = toMs(value);
  if (ms === null) return "--";
  const delta = ms - now;
  if (delta <= 0) return "已到点";
  if (delta >= 86_400_000) return `${Math.floor(delta / 86_400_000)} 天`;
  if (delta >= 3_600_000) {
    const hours = Math.floor(delta / 3_600_000);
    const minutes = Math.floor((delta % 3_600_000) / 60_000);
    return `${hours}h ${pad(minutes)}m`;
  }
  const minutes = Math.floor(delta / 60_000);
  const seconds = Math.floor((delta % 60_000) / 1_000);
  return `${pad(minutes)}:${pad(seconds)}`;
}

export function formatDuration(value: TimeInput): string {
  const ms = toMs(value);
  // 负耗时只可能来自数据异常（结束时刻早于开始），不要显示成 "-3 ms"
  if (ms === null || ms < 0) return "--";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1_000);
    return `${minutes}m ${pad(seconds)}s`;
  }
  // 保留时长动辄以天计（7 天 = 168h），超过一天先按天说，读起来才不像天文数字
  if (ms >= 86_400_000) {
    const days = Math.floor(ms / 86_400_000);
    const hours = Math.floor((ms % 86_400_000) / 3_600_000);
    return hours ? `${days}d ${hours}h` : `${days}d`;
  }
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${pad(minutes)}m`;
}

/** 把毫秒拆成便于表单编辑的「数量 + 单位」 */
export function splitDuration(ms: number | null | undefined): { amount: number; unit: DurationUnit } {
  if (!ms || ms <= 0) return { amount: 300, unit: "s" };
  if (ms % 86_400_000 === 0) return { amount: ms / 86_400_000, unit: "d" };
  if (ms % 3_600_000 === 0) return { amount: ms / 3_600_000, unit: "h" };
  if (ms % 60_000 === 0) return { amount: ms / 60_000, unit: "m" };
  if (ms % 1_000 === 0) return { amount: ms / 1_000, unit: "s" };
  return { amount: ms, unit: "ms" };
}

export type DurationUnit = "ms" | "s" | "m" | "h" | "d";

export const DURATION_UNIT_MS: Record<DurationUnit, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** 用于 `<input type="datetime-local">` 的本地时间字符串 */
export function toDateTimeLocal(value: TimeInput): string {
  const ms = toMs(value);
  if (ms === null) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

export function fromDateTimeLocal(value: string): string | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? String(ms) : null;
}

/** 向下取整到整点，用于趋势图的桶 */
export function floorToHour(ms: number): number {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}
