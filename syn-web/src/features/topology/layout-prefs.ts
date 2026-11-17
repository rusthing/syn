/**
 * # 控制面板的版面偏好（纯函数 + localStorage 读写）
 *
 * 两处可调尺寸都是「本机的看图习惯」，不该进库：
 * 1. **泳道四列的宽度**：不同人盯的列不一样 —— 有人只看任务卡（六段写得很长），
 *    有人只看数据源（连接串很长），固定 268/292/220/620 总有一列不够用；
 * 2. **右侧属性栏的宽度与收起**：248px 装得下概览，装不下一条长连接串；想临时
 *    把画布铺满时又要能收回去。
 *
 * ## 为什么只写 localStorage
 *
 * 尺寸是「这台机器、这块屏」的事，不是配置：同一套数据源在 27 寸上该宽、在 13 寸
 * 上该窄，存进库反而会让换机的人一脸问号。跟居中窗体的尺寸（`components/ui/Drawer.tsx`）
 * 同一个口径 —— 本机记，换机重来。
 *
 * ## 为什么要 clamp 两次
 *
 * 拖动时 clamp 一次是防「拖出屏幕」，读取时再 clamp 一次是因为**存的是像素、窗口可能
 * 已经变了**：27 寸拖到 620px 的任务列，到 13 寸上就是半屏。读取时按当前上限收一次，
 * 才不会有「重开就一列吃掉整屏」这种事。
 *
 * ## 为什么脏数据一律回落默认
 *
 * localStorage 是用户和别的版本共用的抽屉，谁都能往里塞东西。解析函数只认「四个
 * 有限的正数」，其余（NaN、字符串、长度不对、JSON 坏了、隐私模式读不到）全部按位置
 * 回落默认值：一处脏数据最多让某列变宽窄，不会让控制面板打不开。
 */

/** 泳道四列宽度在 localStorage 的键 */
export const LANE_COLUMNS_KEY = "syn.panel.lane-cols";
/** 属性栏宽度与收起状态在 localStorage 的键 */
export const INSPECTOR_KEY = "syn.panel.inspector";

/** 数据源 → 数据抽取 → 主题 → 任务。与改版前 styles.css 里的固定列宽一字不差 */
export const DEFAULT_LANE_COLUMNS: readonly number[] = [268, 292, 220, 620];

/**
 * 每列的 [下限, 上限]。
 * 下限是「卡片还放得下标题 + 一行按钮」，再窄就不是调宽窄而是把字挤成竖排了；
 * 上限只是防误拖到几千像素，任务列给得宽是因为六段详情和条件列表确实长。
 */
export const LANE_COLUMN_BOUNDS: ReadonlyArray<readonly [number, number]> = [
  [180, 560],
  [200, 640],
  [150, 420],
  [320, 1600],
];

/** 属性栏默认宽度，与改版前 xl 断点的 292px 一致：老用户重开看到的是原样 */
export const DEFAULT_INSPECTOR_WIDTH = 292;
export const INSPECTOR_WIDTH_MIN = 220;
/** 再宽就只剩一条缝给画布了；要看长串折行，220~640 足够 */
export const INSPECTOR_WIDTH_MAX = 640;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** 单列宽度收到该列的区间里；非数字回落到该列默认值（不是 0，避免卡片被压没） */
export function clampLaneColumn(index: number, width: number): number {
  const fallback = DEFAULT_LANE_COLUMNS[index] ?? 240;
  if (!isFiniteNumber(width) || width <= 0) return fallback;
  const bounds = LANE_COLUMN_BOUNDS[index] ?? [140, 1600];
  return Math.round(Math.min(bounds[1], Math.max(bounds[0], width)));
}

/**
 * 把 localStorage 里读出来的东西整成「恰好四列的合法宽度」。
 * 长度不足按位置补默认，多出来的忽略 —— 将来加列时旧值也能继续用。
 */
export function normalizeLaneColumns(value: unknown): number[] {
  const list = Array.isArray(value) ? value : [];
  return DEFAULT_LANE_COLUMNS.map((fallback, index) =>
    isFiniteNumber(list[index]) ? clampLaneColumn(index, list[index] as number) : fallback,
  );
}

export function clampInspectorWidth(width: number): number {
  if (!isFiniteNumber(width) || width <= 0) return DEFAULT_INSPECTOR_WIDTH;
  return Math.round(Math.min(INSPECTOR_WIDTH_MAX, Math.max(INSPECTOR_WIDTH_MIN, width)));
}

export interface InspectorPrefs {
  width: number;
  collapsed: boolean;
}

export function normalizeInspectorPrefs(value: unknown): InspectorPrefs {
  const raw = (value ?? {}) as Partial<InspectorPrefs>;
  return {
    width: clampInspectorWidth(raw.width as number),
    // 只认真的 boolean：字符串 "false" 是「假值里最像真值」的那种坑
    collapsed: typeof raw.collapsed === "boolean" ? raw.collapsed : false,
  };
}

/** 读一条偏好；读不到、被禁、值坏了都返回 null（调用方按「没存过」处理） */
export function readPref(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** 写一条偏好；写不进去也不算错，本次会话照常生效 */
export function writePref(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage 被禁：这次调整只在本会话有效 */
  }
}
