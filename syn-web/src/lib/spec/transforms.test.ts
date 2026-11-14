import { describe, expect, it } from "vitest";
import { wkbToWkt } from "./transforms";

describe("wkbToWkt", () => {
  it("十六进制 WKB 照常解析", () => {
    // POINT (1 2)，LE：字节序 01 + 类型 1 + 两个 double
    const h = "01" + "01000000" + "000000000000f03f" + "0000000000000040";
    expect(wkbToWkt(h)).toBe("POINT (1 2)");
  });

  it("Debezium base64（线上 dtw_polygon 死信的真实记录）能解析", () => {
    // POLYGON Z，1 环 9 点闭合，229 字节
    const b64 =
      "AQMAAIABAAAACQAAAAAAAKCgMj5AAAAAwACXU8AAAAAAAAA0QAAAAKCgMj5AAAAAwACXU8AAAAAAAAA0QAAAAGBag1pAAAAAAA0NP8AAAAAAAAA0QAAAAGBag1pAAAAAAA0NP8AAAAAAAAA0QAAAAODGrV9AAAAAQCfOT8AAAAAAAAA0QAAAAODGrV9AAAAAQCfOT8AAAAAAAAA0QAAAAMBi5klAAAAAQIgZXMAAAAAAAAA0QAAAAMBi5klAAAAAQIgZXMAAAAAAAAA0QAAAAKCgMj5AAAAAwACXU8AAAAAAAAA0QA==";
    const wkt = wkbToWkt(b64);
    expect(wkt.startsWith("POLYGON Z ((")).toBe(true);
    expect(wkt.endsWith("))")).toBe(true);
    const inner = wkt.slice(wkt.indexOf("((") + 2, wkt.lastIndexOf("))"));
    const first = inner.split(",")[0].trim();
    const last = inner.split(",").at(-1)!.trim();
    expect(first).toBe(last); // 首尾闭合
  });

  it("非法输入报错", () => {
    expect(() => wkbToWkt("")).toThrow("WKB 为空");
    expect(() => wkbToWkt("!!!")).toThrow();
    expect(() => wkbToWkt("0103")).toThrow();
  });
});
