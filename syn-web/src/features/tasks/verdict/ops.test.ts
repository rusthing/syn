import { describe, expect, it } from "vitest";
import type { Rule } from "@/lib/api/types";
import { newFallbackRule, newIfRule, newOutcomeRule } from "@/lib/spec/rules";
import { appendStatement, dropIndex, moveItem } from "./ops";

const ok = () => newOutcomeRule("success", "ok");

describe("appendStatement", () => {
  it("空块直接追加", () => {
    const rule = newIfRule();
    expect(appendStatement([], rule)).toEqual([rule]);
  });

  it("块还没收尾时追加到末尾", () => {
    const ifRule = newIfRule();
    const next = appendStatement([ifRule], ok());
    expect(next.map((r) => r.kind)).toEqual(["if", "outcome"]);
  });

  it("末尾是兜底结论时插在它前面 —— 否则新语句永远轮不到", () => {
    const ifRule = newIfRule();
    const fallback = newFallbackRule();
    const next = appendStatement([ifRule, fallback], ok());
    // 新结论在前，兜底仍在最后：块末必须「必然给出结论」
    expect(next.map((r) => r.kind)).toEqual(["if", "outcome", "outcome"]);
    expect(next[2]).toEqual(fallback);
  });

  it("末尾是带 else 的 if 时同样插在前面", () => {
    const total: Rule = { kind: "if", branches: [{ assert: [{ scope: "status", op: "eq", value: 200 }], then: [ok()] }, { then: [newFallbackRule()] }] };
    const next = appendStatement([total], newIfRule());
    expect(next.map((r) => r.kind)).toEqual(["if", "if"]);
    expect(next[1]).toBe(total);
  });
});

describe("moveItem / dropIndex", () => {
  it("往下拖一位：移除来源后落点前移", () => {
    const arr = ["a", "b", "c", "d"];
    expect(moveItem(arr, 0, dropIndex(0, 2))).toEqual(["b", "a", "c", "d"]);
  });

  it("往上拖一位", () => {
    const arr = ["a", "b", "c", "d"];
    expect(moveItem(arr, 2, dropIndex(2, 0))).toEqual(["c", "a", "b", "d"]);
  });

  it("原位不动时返回同一个数组引用，避免无意义的重渲染", () => {
    const arr = ["a", "b"];
    expect(moveItem(arr, 1, dropIndex(1, 1))).toBe(arr);
  });

  it("越界落点夹到两端", () => {
    expect(moveItem(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, -5)).toEqual(["c", "a", "b"]);
  });
});
