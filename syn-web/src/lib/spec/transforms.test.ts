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

  it("ISO WKB（ST_AsBinary 直出的 1003）与 EWKB 给同一份 WKT", () => {
    // 线上 dtw_polygon（id 1339415198966743040）同一几何的两种直出编码：
    // ISO 类型码 1003，EWKB 类型码 3 + Z 标志位。ISO 以前会被判成「不支持 1003」。
    const iso =
      "01eb0300000100000005000000000000a0142d37c000000000b1d56c400000000000000000000000c008132d40000000c07d076540000000000000000000000020ace65240000000c0d2d8694000000000000000000000002053434240000000c0a6c570400000000000000000000000a0142d37c000000000b1d56c400000000000000000";
    const ewkb =
      "01030000800100000005000000000000a0142d37c000000000b1d56c400000000000000000000000c008132d40000000c07d076540000000000000000000000020ace65240000000c0d2d8694000000000000000000000002053434240000000c0a6c570400000000000000000000000a0142d37c000000000b1d56c400000000000000000";
    const fromIso = wkbToWkt(iso);
    expect(fromIso.startsWith("POLYGON Z ((")).toBe(true);
    expect(fromIso).toBe(wkbToWkt(ewkb));
  });

  it("非法输入报错", () => {
    expect(() => wkbToWkt("")).toThrow("WKB 为空");
    expect(() => wkbToWkt("!!!")).toThrow();
    expect(() => wkbToWkt("0103")).toThrow();
  });

  it("base64 里的非法字符显式报错，不再静默丢弃", () => {
    expect(() => wkbToWkt("AQM!")).toThrow("非法字符「!」");
    expect(() => wkbToWkt("AQ=M")).toThrow("非法字符「=」");
  });
});
