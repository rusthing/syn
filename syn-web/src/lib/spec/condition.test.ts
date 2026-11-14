/**
 * 条件树的前后端同构契约。
 *
 * 后端对应 `syn-api/src/spec.rs` 的 validate 与 `syn-core/src/assertion.rs` 的
 * eval_condition：同一份 JSON 在两边必须给出同样的 true/false 和同类校验错误。
 * 这里固定住最容易被「顺手优化」改坏的几点：顶层数组恒为 AND、旧格式零迁移、
 * OR/取反的短路语义、gte/lte 的边界、兜底规则不许含 any/not。
 */

import { describe, expect, it } from "vitest";
import type { Condition, TaskSpec } from "@/lib/api/types";
import { evalConditions } from "./evaluate";
import { isFallbackConditions, validateSpec } from "./validate";

function baseSpec(): TaskSpec {
  return {
    id: "t",
    topic: "tp",
    priority: 1,
    target: { service: "s", base: "/b" },
    mapping: { rows: [{ to: "id", from: "$.id" }] },
    actions: [
      { op: "c", method: "POST" },
      { op: "r", method: "POST" },
    ],
    outcomes: [{ scope: "status", assert: [{ op: "in", value: [200] }], verdict: "success" }],
  };
}

function ctx(body: Record<string, unknown> = {}, status = 200) {
  return { record: null, body, status };
}

describe("条件树求值", () => {
  it("旧格式断言数组仍是顶层 AND", () => {
    const conds: Condition[] = [
      { op: "eq", value: 200 },
      { scope: "body", field: "$.ok", op: "eq", value: true },
    ];
    expect(evalConditions(conds, ctx({ ok: true }), "status").ok).toBe(true);
    expect(evalConditions(conds, ctx({ ok: false }), "status").ok).toBe(false);
    expect(evalConditions(conds, ctx({ ok: true }, 500), "status").ok).toBe(false);
  });

  it("状态码 200 且响应体 $.result > 0", () => {
    const conds: Condition[] = [
      { op: "eq", value: 200 },
      { scope: "body", field: "$.result", op: "gt", value: 0 },
    ];
    expect(evalConditions(conds, ctx({ result: 1 }), "status").ok).toBe(true);
    expect(evalConditions(conds, ctx({ result: 0 }), "status").ok).toBe(false);
    expect(evalConditions(conds, ctx({ result: 1 }, 503), "status").ok).toBe(false);
  });

  it("any 分组命中一条即可，not 取反整组", () => {
    const conds: Condition[] = [
      { op: "eq", value: 200 },
      {
        any: [
          { scope: "body", field: "$.extra.code", op: "eq", value: "OK" },
          { scope: "body", field: "$.extra.code", op: "absent" },
        ],
      },
      { not: { all: [{ scope: "body", field: "$.blocked", op: "eq", value: true }] } },
    ];
    expect(evalConditions(conds, ctx({ blocked: false }), "status").ok).toBe(true);
    expect(evalConditions(conds, ctx({ extra: { code: "OK" }, blocked: false }), "status").ok).toBe(true);
    expect(evalConditions(conds, ctx({ extra: { code: "X" }, blocked: false }), "status").ok).toBe(false);
    expect(evalConditions(conds, ctx({ blocked: true }), "status").ok).toBe(false);
  });

  it("嵌套分组也能逐条收集叶子，OR 里失败的行不消失", () => {
    const conds: Condition[] = [
      { any: [{ op: "eq", value: 200 }, { op: "eq", value: 201 }] },
    ];
    const r = evalConditions(conds, ctx({}, 500), "status");
    expect(r.ok).toBe(false);
    expect(r.results).toHaveLength(2);
    expect(r.results.every((x) => x.group === "任意满足")).toBe(true);
  });

  it("gte / lte 含边界，非数字不参与比较", () => {
    const c = { record: { n: 10, s: "10" } };
    expect(evalConditions([{ field: "$.n", op: "gte", value: 10 }], c, "record").ok).toBe(true);
    expect(evalConditions([{ field: "$.n", op: "gte", value: 11 }], c, "record").ok).toBe(false);
    expect(evalConditions([{ field: "$.n", op: "lte", value: 10 }], c, "record").ok).toBe(true);
    expect(evalConditions([{ field: "$.n", op: "lte", value: 9 }], c, "record").ok).toBe(false);
    expect(evalConditions([{ field: "$.s", op: "gte", value: 1 }], c, "record").ok).toBe(false);
  });
});

describe("条件树校验", () => {
  it("分组内叶子的问题带嵌套 path", () => {
    const spec = baseSpec();
    spec.match = [{ any: [{ op: "eq" }, { field: "$.a", op: "in", value: 1 }] }];
    const issues = validateSpec(spec);
    expect(issues.some((i) => i.path === "match[0].any[0]" && i.message.includes("需要 value"))).toBe(true);
    expect(issues.some((i) => i.path === "match[0].any[1]" && i.message.includes("数组"))).toBe(true);
  });

  it("空分组与超过 8 层嵌套被拦", () => {
    const spec = baseSpec();
    spec.match = [{ any: [] }];
    expect(validateSpec(spec).some((i) => i.message.includes("至少要有一条"))).toBe(true);

    let nested: Condition = { op: "eq", value: 200 };
    for (let i = 0; i < 10; i += 1) nested = { all: [nested] };
    spec.match = [nested];
    expect(validateSpec(spec).some((i) => i.message.includes("8 层"))).toBe(true);
  });

  it("gte / lte 也要求 value", () => {
    const spec = baseSpec();
    spec.match = [{ field: "$.n", op: "gte" }];
    expect(validateSpec(spec).some((i) => i.message.includes("gte 需要 value"))).toBe(true);
  });

  it("兜底规则不能含 any / not，可以含 all 分组", () => {
    expect(isFallbackConditions([{ op: "in", value: [200] }])).toBe(true);
    expect(isFallbackConditions([{ all: [{ op: "eq", value: 200 }] }])).toBe(true);
    expect(isFallbackConditions([{ any: [{ op: "eq", value: 200 }] }])).toBe(false);
    expect(isFallbackConditions([{ not: { op: "eq", value: 200 } }])).toBe(false);
    expect(isFallbackConditions([{ field: "$.result", op: "eq", value: 0 }])).toBe(false);

    const spec = baseSpec();
    spec.outcomes = [
      { scope: "status", assert: [{ any: [{ op: "eq", value: 200 }] }], verdict: "fatal" },
    ];
    expect(validateSpec(spec).some((i) => i.message.includes("兜底"))).toBe(true);
  });
});
