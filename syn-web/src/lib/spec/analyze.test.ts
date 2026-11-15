/**
 * 静态检查的契约。
 *
 * 这里钉的是「哪些错误必须被抓到、哪些必须老实说不知道」：
 * 抓错的代价比抓不到更高 —— 一条会误报的检查，用户很快会学会无视整个面板。
 */
import { describe, expect, it } from "vitest";
import type { IfRule, Rule, SwitchRule } from "@/lib/api/types";
import {
  analyzeRules,
  anchorOf,
  findingsUnder,
  intersectDomain,
  isTotal,
  matrixOfIf,
  matrixOfSwitch,
  shapeOf,
  statementPathOf,
  subsetDomain,
  type Domain,
} from "./analyze";

const ok = (code = "ok") => ({ kind: "outcome" as const, verdict: "success" as const, code });
const success = () => ({ kind: "outcome" as const, verdict: "success" as const, code: "ok" });
const retriable = () => ({ kind: "outcome" as const, verdict: "retriable" as const, code: "busy" });
const fallback = () => ({ kind: "outcome" as const, verdict: "fatal" as const, code: "unclassified" });

const statusIn = (...values: number[]) => ({ scope: "status" as const, op: "in" as const, value: values });
const statusEq = (value: number) => ({ scope: "status" as const, op: "eq" as const, value });
const bodyCmp = (op: "gt" | "gte" | "lt" | "lte", value: number) => ({
  scope: "body" as const,
  field: "$.result",
  op,
  value,
});

describe("值域代数", () => {
  it("集合求交：数字按数值比，其余按 JSON 比", () => {
    const both = intersectDomain({ tag: "set", values: [200, 201] }, { tag: "set", values: [201, 204] });
    expect(both).toEqual({ tag: "set", values: [201] });
  });

  it("不相交的集合求交得到 empty", () => {
    expect(intersectDomain({ tag: "set", values: [200] }, { tag: "set", values: [500] })).toEqual({
      tag: "empty",
    });
  });

  it("区间与集合都能求交", () => {
    const range: Domain = { tag: "range", lo: 0, loInc: false, hiInc: false };
    expect(intersectDomain(range, { tag: "set", values: [0, 5] })).toEqual({ tag: "set", values: [5] });
  });

  it("推不出来的操作符一律 unknown，不当成「不相交」", () => {
    const ne = shapeOf([{ scope: "status", op: "ne", value: 200 }], "body");
    expect(ne.keys.get("状态码")).toEqual({ tag: "unknown" });
    // 与任何东西求交都是 unknown，不会误报「矛盾」
    expect(intersectDomain({ tag: "unknown" }, { tag: "set", values: [200] })).toEqual({ tag: "unknown" });
  });

  it("子集判断：范围包住范围、集合包住集合，交叉关系不算", () => {
    const gte: Domain = { tag: "range", lo: 0, loInc: true, hiInc: false };
    const gt: Domain = { tag: "range", lo: 100, loInc: false, hiInc: false };
    expect(subsetDomain(gt, gte)).toBe(true);
    expect(subsetDomain(gte, gt)).toBe(false);
    expect(subsetDomain({ tag: "set", values: [200] }, { tag: "set", values: [200, 201] })).toBe(true);
    // 两个集合各有对方没有的值：不构成包含
    expect(subsetDomain({ tag: "set", values: [200, 500] }, { tag: "set", values: [500, 503] })).toBe(false);
  });
});

describe("条件形状", () => {
  it("同一个键被要求成两个值就是自相矛盾", () => {
    const shape = shapeOf([statusEq(200), statusEq(500)], "body");
    expect(shape.contradiction).toBe("状态码");
    expect(shape.keys.get("状态码")).toEqual({ tag: "empty" });
  });

  it("any / not 分组让整个形状变成「推不出来」", () => {
    expect(shapeOf([{ any: [statusEq(200), statusEq(201)] }], "body").opaque).toBe(true);
    expect(shapeOf([{ not: statusEq(200) }], "body").opaque).toBe(true);
  });

  it("all 分组是合取，能摊平进同一个键", () => {
    const shape = shapeOf([{ all: [statusIn(200, 201), statusEq(200)] }], "body");
    expect(shape.keys.get("状态码")).toEqual({ tag: "set", values: [200] });
    expect(shape.opaque).toBe(false);
  });

  it("record 与 body 的同名字段不并到一列", () => {
    const shape = shapeOf(
      [
        { scope: "record", field: "$.op", op: "eq", value: "c" },
        { scope: "body", field: "$.op", op: "eq", value: "c" },
      ],
      "body",
    );
    expect([...shape.keys.keys()]).toEqual(["记录 $.op", "$.op"]);
  });
});

describe("语句级可达性", () => {
  it("前面一条结论接住全部，后面的语句就是死的", () => {
    const block: Rule[] = [
      { kind: "if", branches: [{ assert: [statusEq(200)], then: [success()] }] },
      fallback(),
      { kind: "outcome", verdict: "skip", code: "never" },
    ];
    const { findings, verdicts } = analyzeRules(block);
    const dead = findings.filter((f) => f.kind === "unreachable");
    expect(dead.map((f) => f.path)).toEqual(["rules[2]"]);
    // 不可达的结论不参与统计，否则「某结论永远不产生」就看不出来了
    expect(verdicts.find((v) => v.verdict === "skip")?.count).toBe(0);
  });

  it("带否则的 if 也是「接住全部」，后面的语句同样轮不到", () => {
    const block: Rule[] = [
      { kind: "if", branches: [{ then: [fallback()] }] },
      { kind: "outcome", verdict: "skip", code: "never" },
    ];
    expect(analyzeRules(block).findings.filter((f) => f.kind === "unreachable")).toHaveLength(1);
  });

  it("只报「最后一条不给结论」：中间某条全覆盖也照实报错，由 unreachable 提示怎么改", () => {
    const block: Rule[] = [fallback(), { kind: "if", branches: [{ assert: [statusEq(200)], then: [success()] }] }];
    const { findings } = analyzeRules(block);
    expect(findings.some((f) => f.kind === "unreachable" && f.path === "rules[1]")).toBe(true);
    expect(findings.some((f) => f.kind === "no-conclusion" && f.path === "rules")).toBe(true);
  });
});

describe("分支之间", () => {
  const withBranches = (branches: IfRule["branches"]): Rule[] => [{ kind: "if", branches }];

  it("被前面的宽条件完全包含时，这个分支永远轮不到", () => {
    const { findings } = analyzeRules(
      withBranches([
        { assert: [statusIn(200, 201, 204)], then: [success()] },
        { assert: [statusEq(200)], then: [{ kind: "outcome", verdict: "skip", code: "dup" }] },
        { then: [fallback()] },
      ]),
    );
    const shadowed = findings.find((f) => f.kind === "shadowed");
    expect(shadowed?.path).toBe("rules[0].branches[1]");
    expect(shadowed?.message).toContain("第 1 个分支");
  });

  it("部分重叠只提示顺序有影响，不判成死代码", () => {
    const { findings } = analyzeRules(
      withBranches([
        { assert: [statusIn(200, 500)], then: [success()] },
        { assert: [statusIn(500, 503)], then: [retriable()] },
        { then: [fallback()] },
      ]),
    );
    expect(findings.filter((f) => f.kind === "shadowed")).toHaveLength(0);
    expect(findings.find((f) => f.kind === "overlap")?.path).toBe("rules[0].branches[1]");
  });

  it("确定不相交就一句话都不说", () => {
    const { findings } = analyzeRules(
      withBranches([
        { assert: [statusIn(200)], then: [success()] },
        { assert: [statusIn(500)], then: [retriable()] },
        { then: [fallback()] },
      ]),
    );
    expect(findings).toHaveLength(0);
  });

  it("范围也参与判断：gte 0 之后的 gt 100 是死分支", () => {
    const { findings } = analyzeRules(
      withBranches([
        { assert: [bodyCmp("gte", 0)], then: [success()] },
        { assert: [bodyCmp("gt", 100)], then: [retriable()] },
        { then: [fallback()] },
      ]),
    );
    expect(findings.find((f) => f.kind === "shadowed")?.path).toBe("rules[0].branches[1]");
  });

  it("自相矛盾的条件单独报，不重复报包含", () => {
    const { findings } = analyzeRules(withBranches([{ assert: [statusEq(200), statusEq(500)], then: [success()] }, { then: [fallback()] }]));
    expect(findings.filter((f) => f.kind === "contradiction")).toHaveLength(1);
    expect(findings.filter((f) => f.kind === "shadowed")).toHaveLength(0);
  });

  it("否则后面的分支进不去（校验也会拦，这里给一句人话）", () => {
    const { findings } = analyzeRules(
      withBranches([
        { assert: [statusEq(200)], then: [success()] },
        { then: [fallback()] },
        { assert: [statusEq(500)], then: [retriable()] },
      ]),
    );
    expect(findings.find((f) => f.kind === "unreachable")?.path).toBe("rules[0].branches[2]");
  });
});

describe("跨语句的包含", () => {
  it("前一条语句的分支已经接走这段状态码，后面那条 if 是死配置", () => {
    const block: Rule[] = [
      { kind: "if", branches: [{ assert: [statusIn(429, 500, 502, 503)], then: [retriable()] }] },
      { kind: "if", branches: [{ assert: [statusEq(500)], then: [{ kind: "outcome", verdict: "fatal", code: "busy_as_fatal" }] }] },
      fallback(),
    ];
    const { findings } = analyzeRules(block);
    const dead = findings.find((f) => f.kind === "shadowed");
    expect(dead?.path).toBe("rules[1].branches[0]");
    expect(dead?.message).toContain("第 1 条语句的第 1 个分支");
  });

  it("switch 的取值被前面的 if 接走也算死配置", () => {
    const block: Rule[] = [
      { kind: "if", branches: [{ assert: [statusEq(404)], then: [{ kind: "outcome", verdict: "skip", code: "nf" }] }] },
      { kind: "switch", on: "", scope: "status", cases: [{ values: [404], then: [retriable()] }], default: [fallback()] },
    ];
    const { findings } = analyzeRules(block);
    expect(findings.find((f) => f.kind === "shadowed")?.path).toBe("rules[1].cases[0]");
  });

  it("不相交的两条语句不互相指责", () => {
    const block: Rule[] = [
      { kind: "if", branches: [{ assert: [statusIn(200, 201)], then: [success()] }] },
      { kind: "if", branches: [{ assert: [statusIn(500, 503)], then: [retriable()] }] },
      fallback(),
    ];
    expect(analyzeRules(block).findings).toHaveLength(0);
  });
});

describe("switch 的取值", () => {
  const sw = (cases: SwitchRule["cases"], dft: SwitchRule["default"] = [fallback()]): Rule[] => [
    { kind: "switch", on: "$.result", scope: "body", cases, default: dft },
  ];

  it("同一个值出现在两个 case 里，后面那个永远拿不到", () => {
    const { findings } = analyzeRules(
      sw([
        { values: [0], then: [success()] },
        { values: [0, 1], then: [{ kind: "outcome", verdict: "skip", code: "dup" }] },
      ]),
    );
    const dup = findings.find((f) => f.kind === "duplicate-case");
    expect(dup?.path).toBe("rules[0].cases[1].values");
    expect(dup?.message).toContain("第 1 个 case");
  });

  it("状态码写成字符串永远匹配不上", () => {
    const { findings } = analyzeRules([
      { kind: "switch", on: "", scope: "status", cases: [{ values: ["200"], then: [success()] }], default: [fallback()] },
    ]);
    expect(findings.find((f) => f.kind === "unmatchable-case")?.path).toBe("rules[0].cases[0].values");
  });

  it("嵌套块里缺兜底会被递归抓到，路径指到那一层", () => {
    const { findings } = analyzeRules(
      sw([{ values: [0], then: [success()] }], [{ kind: "if", branches: [{ assert: [statusEq(500)], then: [retriable()] }] }]),
    );
    expect(findings.find((f) => f.kind === "no-conclusion")?.path).toBe("rules[0].default");
  });
});

describe("矩阵投影", () => {
  it("if 的分支 × 判别字段：不关心的列显 *，否则行显「其余」", () => {
    const rule: IfRule = {
      kind: "if",
      branches: [
        { assert: [statusEq(200), bodyCmp("gt", 0)], then: [success()] },
        { assert: [statusIn(500, 503)], then: [retriable()] },
        { then: [fallback()] },
      ],
    };
    const data = matrixOfIf(rule);
    expect(data.columns).toEqual(["状态码", "$.result"]);
    expect(data.rows[0].cells.map((c) => c.text)).toEqual(["200", "> 0"]);
    expect(data.rows[1].cells.map((c) => c.text)).toEqual(["500 / 503", "*"]);
    expect(data.rows[2].cells.map((c) => c.text)).toEqual(["其余", "其余"]);
    expect(data.rows[2].note).toContain("失败");
  });

  it("矩阵里也标出被包含的分支", () => {
    const data = matrixOfIf({
      kind: "if",
      branches: [
        { assert: [statusIn(200, 201)], then: [success()] },
        { assert: [statusEq(200)], then: [retriable()] },
        { then: [fallback()] },
      ],
    });
    expect(data.rows[1].flags[0]).toContain("第 1 个分支");
  });

  it("switch 的表格按顺序标出重复取值", () => {
    const data = matrixOfSwitch({
      kind: "switch",
      on: "$.result",
      cases: [
        { values: [0], then: [success()] },
        { values: [0, 1], then: [retriable()] },
      ],
      default: [fallback()],
    });
    expect(data.column).toBe("$.result");
    expect(data.rows[0].dup).toEqual([]);
    expect(data.rows[1].dup).toEqual(["0"]);
  });
});

describe("定位", () => {
  it("问题路径收敛到最近的一条语句", () => {
    expect(statementPathOf("rules[0].branches[1]")).toBe("rules[0]");
    expect(statementPathOf("rules[0].cases[1].values")).toBe("rules[0]");
    expect(statementPathOf("rules[0].default")).toBe("rules[0]");
    // 已经是语句本身就不再往上收
    expect(statementPathOf("rules[0].branches[1].then[2]")).toBe("rules[0].branches[1].then[2]");
  });

  it("findingsUnder 能吃到子路径", () => {
    const findings = [
      { path: "rules[0].branches[1]", kind: "shadowed" as const, severity: "warn" as const, message: "x" },
      { path: "rules[1]", kind: "unreachable" as const, severity: "warn" as const, message: "y" },
    ];
    expect(findingsUnder(findings, "rules[0]")).toHaveLength(1);
    expect(findingsUnder(findings, "rules[1]")).toHaveLength(1);
  });

  it("锚点带完整路径，深层的语句也能滚到", () => {
    expect(anchorOf("rules[0].branches[1].then[2]")).toBe("rule-anchor-rules[0].branches[1].then[2]");
  });
});

describe("isTotal", () => {
  it("结论 / 带否则的 if / 带 default 的 switch 才叫接住全部", () => {
    expect(isTotal(ok())).toBe(true);
    expect(isTotal({ kind: "if", branches: [{ assert: [statusEq(200)], then: [success()] }] })).toBe(false);
    expect(isTotal({ kind: "if", branches: [{ assert: [statusEq(200)], then: [success()] }, { then: [fallback()] }] })).toBe(
      true,
    );
    expect(isTotal({ kind: "switch", on: "$.x", cases: [], default: [fallback()] })).toBe(true);
    expect(isTotal({ kind: "switch", on: "$.x", cases: [], default: [] })).toBe(false);
  });
});
