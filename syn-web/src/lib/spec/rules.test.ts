/**
 * 判定语句树的纯逻辑契约。
 *
 * 这里钉的三件事，任何一件松了都会让「界面上看着对、跑起来结论不同」：
 * 1. 兜底判断（`blockConcludes`）与后端 `block_concludes` 同一套结论；
 * 2. 语句模板**不带否则**，插到中间才不会把后面的语句全部吃掉；
 * 3. case 取值的「数字 / 字符串」能往返，`200` 与 `"200"` 不是一回事。
 */
import { describe, expect, it } from "vitest";
import type { Rule, TaskSpec } from "@/lib/api/types";
import { newTask } from "./defaults";
import {
  RULE_PRESETS,
  blockConcludes,
  blockOutcomeText,
  countRules,
  formatCaseValues,
  newBranch,
  newCaseArm,
  newFallbackRule,
  newIfRule,
  newOutcomeRule,
  newSwitchRule,
  parseCaseValues,
  ruleSummary,
  rulesDepth,
  rulesForEditing,
} from "./rules";

describe("blockConcludes", () => {
  it("空块不给结论", () => {
    expect(blockConcludes([])).toBe(false);
  });

  it("结论语句恒给结论", () => {
    expect(blockConcludes([newOutcomeRule()])).toBe(true);
  });

  it("if 必须靠最后的否则收尾，没有否则就不算兜底", () => {
    const ifRule = newIfRule();
    expect(blockConcludes([ifRule])).toBe(false);
    expect(blockConcludes([{ kind: "if", branches: [...ifRule.branches, { then: [newOutcomeRule()] }] }])).toBe(
      true,
    );
  });

  it("switch 靠 default 收尾", () => {
    const sw = newSwitchRule();
    expect(blockConcludes([sw])).toBe(true);
    expect(blockConcludes([{ ...sw, default: [] }])).toBe(false);
  });

  it("只看最后一条：前面有没有兜底不影响" , () => {
    expect(blockConcludes([newOutcomeRule(), newIfRule()])).toBe(false);
    expect(blockConcludes([newIfRule(), newFallbackRule()])).toBe(true);
  });
});

describe("模板不吃掉后续语句", () => {
  it("每条模板都不带否则 / 空 default，插到中间后续语句仍然可达", () => {
    for (const preset of RULE_PRESETS) {
      const rule = preset.build();
      if (rule.kind === "if") {
        expect(
          rule.branches.every((b) => (b.assert ?? []).length > 0),
          `${preset.label} 不该自带否则`,
        ).toBe(true);
      }
      if (rule.kind === "switch") {
        // switch 必须有 default，但 default 是「这个 switch 自己」的兜底，
        // 只影响 switch 之后不会继续走 —— 这是 switch 的语义，不是模板的锅。
        expect(rule.default?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it("新分支自带一个条件，插进去不会立刻报「条件不能为空」", () => {
    expect((newBranch().assert ?? []).length).toBeGreaterThan(0);
    expect((newCaseArm().then ?? []).length).toBeGreaterThan(0);
  });
});

describe("case 取值往返", () => {
  it("裸词当字符串，数字当数字", () => {
    expect(parseCaseValues("OK, 200, -2")).toEqual(["OK", 200, -2]);
  });

  it("加引号的数字仍是字符串", () => {
    expect(parseCaseValues('"200", 200')).toEqual(["200", 200]);
  });

  it("格式化后能原样解析回来", () => {
    const values: unknown[] = ["OK", 200, -2, true, null, "200"];
    expect(parseCaseValues(formatCaseValues(values))).toEqual(values);
  });

  it("空文本解析成空数组（校验会拦「取值不能为空」）", () => {
    expect(parseCaseValues("  ,  ")).toEqual([]);
  });
});

describe("旧形状升级", () => {
  it("扁平 outcomes 映射成单分支 if，并补一条兜底结论（与运行时 UNCLASSIFIED 同义）", () => {
    const spec: TaskSpec = { ...newTask() };
    delete spec.rules;
    spec.outcomes = [{ scope: "status", assert: [{ op: "eq", value: 200 }], verdict: "success", code: "ok" }];

    const rules = rulesForEditing(spec);
    expect(rules).toHaveLength(2);
    expect(rules[0].kind).toBe("if");
    expect(rules[1]).toEqual({ kind: "outcome", verdict: "fatal", code: "unclassified" });
    expect(blockConcludes(rules)).toBe(true);
  });

  it("已经是语句树就原样返回：缺兜底是错误，界面不能替用户悄悄补上", () => {
    const spec: TaskSpec = { ...newTask(), rules: [newIfRule()] };
    expect(rulesForEditing(spec)).toHaveLength(1);
    expect(blockConcludes(rulesForEditing(spec))).toBe(false);
  });
});

describe("摘要与统计", () => {
  const tree: Rule[] = [
    newIfRule(),
    {
      kind: "if",
      branches: [
        { assert: [{ scope: "status", op: "eq", value: 404 }], then: [newOutcomeRule("skip", "not_found")] },
        { then: [{ kind: "switch", on: "$.result", cases: [], default: [newFallbackRule()] }] },
      ],
    },
    newFallbackRule(),
  ];

  it("条数与层数都算嵌套", () => {
    // 2（if + 结论） + 4（if + 结论 + switch + default 结论） + 1（兜底结论）
    expect(countRules(tree)).toBe(7);
    expect(rulesDepth(tree)).toBe(3); // 根块 → if 分支体 → switch 的 default 体
    expect(rulesDepth([newFallbackRule()])).toBe(1);
  });

  it("句子头说清「拦什么」，不含结论（结论在叶子上）", () => {
    expect(ruleSummary(tree[0])).toContain("状态码 属于 [200, 201, 204]");
    expect(ruleSummary(newOutcomeRule("skip", "duplicate"))).toBe("→ 跳过 · duplicate");
    expect(ruleSummary(newSwitchRule())).toBe("按 $.result 分流 · 1 个 case");
  });

  it("块头摘要取最后一条语句给出的结论", () => {
    expect(blockOutcomeText([newIfRule(), newFallbackRule()])).toBe("失败 · unclassified");
    expect(blockOutcomeText([])).toBe("尚未给出结论");
  });
});
