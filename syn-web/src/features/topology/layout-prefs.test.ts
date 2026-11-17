/**
 * 版面偏好的单测。只锁三件真会把人坑到的事：
 * 1. 没存过 / 存坏了 → 回到与改版前一致的默认，控制面板照样打得开；
 * 2. 越界值按每列的区间收，不会出现一列吃掉整屏；
 * 3. 长度不对的旧值按位置补齐，多的忽略。
 */
import { describe, expect, it } from "vitest";
import {
  clampInspectorWidth,
  clampLaneColumn,
  DEFAULT_INSPECTOR_WIDTH,
  DEFAULT_LANE_COLUMNS,
  normalizeInspectorPrefs,
  normalizeLaneColumns,
  INSPECTOR_WIDTH_MAX,
  INSPECTOR_WIDTH_MIN,
} from "./layout-prefs";

describe("泳道列宽", () => {
  it("没存过（null / 非数组）就是默认四列", () => {
    expect(normalizeLaneColumns(null)).toEqual([...DEFAULT_LANE_COLUMNS]);
    expect(normalizeLaneColumns({ a: 1 })).toEqual([...DEFAULT_LANE_COLUMNS]);
    expect(normalizeLaneColumns("268,292")).toEqual([...DEFAULT_LANE_COLUMNS]);
  });

  it("按位置补齐：只存了两列，后两列回默认", () => {
    expect(normalizeLaneColumns([300, 400])).toEqual([300, 400, 220, 620]);
  });

  it("多余的列忽略，不改变前四列", () => {
    expect(normalizeLaneColumns([300, 400, 250, 700, 999])).toEqual([300, 400, 250, 700]);
  });

  it("单列越界收进该列区间", () => {
    expect(clampLaneColumn(0, 100)).toBe(180);
    expect(clampLaneColumn(0, 5000)).toBe(560);
    expect(clampLaneColumn(3, 100)).toBe(320);
    expect(clampLaneColumn(3, 2400)).toBe(1600);
  });

  it("非数字 / 0 / 负数回落到该列默认，而不是压成 0 宽", () => {
    expect(clampLaneColumn(2, Number.NaN)).toBe(220);
    expect(clampLaneColumn(2, 0)).toBe(220);
    expect(clampLaneColumn(1, -40)).toBe(292);
  });

  it("存进去的值本身就是越界的（比如手改了 localStorage）也照样收", () => {
    expect(normalizeLaneColumns([12, 900, 40, 8000])).toEqual([180, 640, 150, 1600]);
  });
});

describe("属性栏偏好", () => {
  it("没存过：默认宽度 + 展开", () => {
    expect(normalizeInspectorPrefs(null)).toEqual({
      width: DEFAULT_INSPECTOR_WIDTH,
      collapsed: false,
    });
  });

  it("宽度两头都收在区间里", () => {
    expect(clampInspectorWidth(10)).toBe(INSPECTOR_WIDTH_MIN);
    expect(clampInspectorWidth(2000)).toBe(INSPECTOR_WIDTH_MAX);
  });

  it("width 坏了只影响宽度，收起状态保住", () => {
    expect(normalizeInspectorPrefs({ width: "wide", collapsed: true })).toEqual({
      width: DEFAULT_INSPECTOR_WIDTH,
      collapsed: true,
    });
  });

  it("collapsed 只认 boolean：字符串 false 不算收起", () => {
    expect(normalizeInspectorPrefs({ width: 320, collapsed: "false" }).collapsed).toBe(false);
  });
});
