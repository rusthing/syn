/**
 * 判定语句树（`spec.rules`）的纯逻辑。
 *
 * 判定段不是「一张规则表」，而是**一串按顺序执行的语句**：`if` / `switch` / `结论`。
 * 界面把它画成可嵌套的块，但语义只有这一处定义，与后端 `syn-core/src/verdict.rs`
 * 逐行对应；渲染层只做投影，不许自己解释顺序或兜底。
 *
 * 这里放的全是纯函数（默认语句、句子摘要、case 取值解析、兜底判断），
 * 之所以单列成文件：它们同时被编辑器和校验器用，散在组件里就会长出第二份语义。
 */
import type {
  Branch,
  CaseArm,
  Condition,
  IfRule,
  OutcomeRule,
  Rule,
  Scope,
  SwitchRule,
  TaskSpec,
  Verdict,
} from "@/lib/api/types";
import { SCOPES, isAssert, operatorMeta, verdictMeta } from "./defaults";

/** 与 `syn-api::MAX_RULE_DEPTH` 对齐：根块算 0 层，最深允许嵌到 3 层 */
export const MAX_RULE_DEPTH = 3;

/* ------------------------------ 默认语句 ------------------------------ */

export function newOutcomeRule(verdict: Verdict = "success", code = "ok"): OutcomeRule {
  return { kind: "outcome", verdict, code };
}

/** 新 if：一个条件分支，**不带否则** —— 中间的 if 不必兜底，兜底由块的最后一条语句负责 */
export function newIfRule(): IfRule {
  return {
    kind: "if",
    branches: [
      {
        assert: [{ scope: "status", op: "in", value: [200, 201, 204] }],
        then: [newOutcomeRule("success", "ok")],
      },
    ],
  };
}

/** 新分支（否则如果）：条件给个能改的起点，免得一插就报「条件不能为空」 */
export function newBranch(): Branch {
  return {
    assert: [{ scope: "status", op: "eq", value: 200 }],
    then: [newOutcomeRule("success", "ok")],
  };
}

/** 新 switch：带一个 case 与 default —— default 是硬要求，预填比留空好 */
export function newSwitchRule(on = "$.result"): SwitchRule {
  return {
    kind: "switch",
    on,
    scope: "body",
    cases: [{ values: [0], then: [newOutcomeRule("success", "ok")] }],
    default: [newOutcomeRule("fatal", "unclassified")],
  };
}

export function newCaseArm(): CaseArm {
  return { values: [], then: [newOutcomeRule()] };
}

/* ------------------------------ 句子与标签 ------------------------------ */

export function fmtValue(value: unknown): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return `[${value.map((v) => String(v)).join(", ")}]`;
  if (typeof value === "string") return `"${value}"`;
  return String(value);
}

export const scopeLabel = (scope: Scope): string =>
  SCOPES.find((s) => s.value === scope)?.label ?? scope;

/** 条件数组读成一句话：多条之间是「并且」，分组递归 */
export function conditionText(conds: Condition[], fallback: Scope): string {
  return conds
    .map((c) => {
      if (isAssert(c)) {
        const scope = c.scope ?? fallback;
        const op = operatorMeta(c.op).label;
        const value = fmtValue(c.value);
        // 状态码断言没有字段名作主语，不写「状态码」就只剩「属于 [200]」，读不成句子
        return (scope === "status" ? `状态码 ${op} ${value}` : `${c.field ?? ""} ${op} ${value}`).trim();
      }
      if ("all" in c) return `(${conditionText(c.all, fallback)})`;
      if ("any" in c) return `(${c.any.map((x) => conditionText([x], fallback)).join(" 或者 ")})`;
      return `非${conditionText([c.not], fallback)}`;
    })
    .join(" 并且 ");
}

/** 分支头的中文标签：第一项「如果」，中间「否则如果」，空条件的最后一项「否则」 */
export function branchLabel(branch: Branch, index: number): string {
  if ((branch.assert ?? []).length === 0) return "否则";
  return index === 0 ? "如果" : "否则如果";
}

export function caseLabel(arm: CaseArm): string {
  if (arm.values.length === 0) return "（未填取值）";
  return arm.values.map((v) => (typeof v === "string" ? `"${v}"` : fmtValue(v))).join(" / ");
}

/**
 * 一条语句的摘要，用在折叠头与概览里。
 * 只描述「它拦什么」，不描述「它会判成什么」—— 后者要到叶子才确定。
 */
export function ruleSummary(rule: Rule): string {
  switch (rule.kind) {
    case "outcome":
      return `→ ${verdictMeta(rule.verdict).label}${rule.code ? ` · ${rule.code}` : ""}`;
    case "if": {
      const parts = rule.branches.map((b, i) => {
        const conds = b.assert ?? [];
        if (conds.length === 0) return branchLabel(b, i);
        return `${branchLabel(b, i)} ${conditionText(conds, b.scope ?? "body")}`;
      });
      return parts.join(" ， ");
    }
    case "switch": {
      const on = (rule.scope ?? "body") === "status" ? "状态码" : rule.on || "（未填字段）";
      return `按 ${on} 分流 · ${rule.cases.length} 个 case`;
    }
  }
}

/** 折叠头上的结论摘要：这个分支体最终会给出什么（只取第一层，够看） */
export function blockOutcomeText(block: Rule[]): string {
  const last = block[block.length - 1];
  if (!last) return "尚未给出结论";
  if (last.kind === "outcome") {
    return `${verdictMeta(last.verdict).label}${last.code ? ` · ${last.code}` : ""}`;
  }
  return last.kind === "if" ? "分支判断" : "分流判断";
}

/* ------------------------------ 结构检查 ------------------------------ */

/**
 * 一个语句块是否「必然给出结论」：兜底只能靠最后一条语句。
 *
 * 结论语句恒成立；`if` 靠最后的「否则」；`switch` 靠 `default`。
 * 这条与后端 `block_concludes` 同构 —— 不满足时保存会被拦，而不是上线后
 * 「不认识的响应」静默变成 UNCLASSIFIED 致命。
 */
export function blockConcludes(block: Rule[]): boolean {
  const last = block[block.length - 1];
  if (!last) return false;
  if (last.kind === "outcome") return true;
  if (last.kind === "if") return (last.branches[last.branches.length - 1]?.assert ?? []).length === 0;
  return (last.default ?? []).length > 0;
}

/** 语句总数（含嵌套），给左侧轨道写概要 */
export function countRules(block: Rule[] | undefined): number {
  let n = 0;
  for (const rule of block ?? []) {
    n += 1;
    if (rule.kind === "if") {
      for (const b of rule.branches) n += countRules(b.then);
    } else if (rule.kind === "switch") {
      for (const c of rule.cases) n += countRules(c.then);
      n += countRules(rule.default);
    }
  }
  return n;
}

/* ------------------------------ 旧形状映射 ------------------------------ */

/**
 * 判定段的有效语句树，与后端 `TaskSpec::verdict_rules` 逐行对应。
 *
 * `rules` 非空就用它；否则把扁平的 `outcomes` 一条条映射成「单分支 if」。
 * 求值只认这一个入口 —— 两边各读一个字段，迟早对同一份配置给出不同结论。
 */
export function verdictRules(spec: TaskSpec): Rule[] {
  const rules = spec.rules ?? [];
  if (rules.length > 0) return rules;
  return (spec.outcomes ?? []).map((o) => ({
    kind: "if" as const,
    branches: [
      {
        assert: o.assert,
        scope: o.scope,
        then: [{ kind: "outcome" as const, verdict: o.verdict, code: o.code ?? "" }],
      },
    ],
  }));
}

/**
 * 编辑面用的语句树：旧 `outcomes` 映射成树之后，末尾补一条兜底结论。
 *
 * 旧模型没有「否则」的概念 —— 没被任何一条命中的响应由执行器按
 * `fatal · UNCLASSIFIED` 兜底。树模型要求每个块必须以「必然给出结论」的语句收尾，
 * 所以映射时把那条隐式兜底显式化：**补一条 fatal · UNCLASSIFIED，与运行时逐字等价**，
 * 不改变任何判定结果，只是让它在界面上看得见。
 *
 * 只对旧形状补。`spec.rules` 里本来就没兜底属于配置错误，要照实报出来，
 * 不能替用户「修好」再让他以为没事。
 */
export function rulesForEditing(spec: TaskSpec): Rule[] {
  const rules = verdictRules(spec);
  const isLegacy = (spec.rules ?? []).length === 0;
  if (!isLegacy || rules.length === 0 || blockConcludes(rules)) return rules;
  return [...rules, newFallbackRule()];
}

/** 语句树的实际层数（1 = 只有平铺语句） */
export function rulesDepth(block: Rule[] | undefined): number {
  let deepest = 0;
  for (const rule of block ?? []) {
    if (rule.kind === "outcome") continue;
    const children =
      rule.kind === "if" ? rule.branches.map((b) => b.then) : [...rule.cases.map((c) => c.then), rule.default];
    for (const child of children) deepest = Math.max(deepest, rulesDepth(child));
  }
  return deepest + 1;
}

/* ------------------------------ case 取值 ------------------------------ */

/**
 * case 取值按逗号分隔解析：`OK, 200` 读成 `["OK", 200]`。
 *
 * 裸词当字符串（不用给 `OK` 打引号），其余按 JSON 字面量 —— `"200"` 是字符串、
 * `200` 是数字，两者在 `switch` 里命中与否不同，所以这里必须能区分。
 */
export function parseCaseValues(text: string): unknown[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((token) => {
      try {
        return JSON.parse(token) as unknown;
      } catch {
        return token;
      }
    });
}

/** 反向：一行文本，保证 `parseCaseValues(formatCaseValues(v))` 回到同一组值 */
export function formatCaseValues(values: unknown[]): string {
  return values
    .map((v) => {
      if (typeof v === "string") return JSON.stringify(v);
      if (v === undefined) return "null";
      return JSON.stringify(v) ?? String(v);
    })
    .join(", ");
}

/* ------------------------------ 常用模板 ------------------------------ */

export interface RulePreset {
  label: string;
  hint: string;
  build: () => Rule;
}

/**
 * 最常配的几条，点一下长出一条完整语句（条件 + 结论）。
 * 注意：这里**都不带否则** —— 模板插到中间时若自带否则，后面的语句永远进不去。
 */
export const RULE_PRESETS: RulePreset[] = [
  {
    label: "状态码成功",
    hint: "200/201/204 都算提交成功",
    build: () => ({
      kind: "if",
      branches: [
        { assert: [{ scope: "status", op: "in", value: [200, 201, 204] }], then: [newOutcomeRule("success", "ok")] },
      ],
    }),
  },
  {
    label: "200 且业务码 > 0",
    hint: "跨作用域合取：状态码 200 且响应体 $.result > 0 才成功",
    build: () => ({
      kind: "if",
      branches: [
        {
          assert: [
            { scope: "status", op: "eq", value: 200 },
            { scope: "body", field: "$.result", op: "gt", value: 0 },
          ],
          then: [newOutcomeRule("success", "ok")],
        },
      ],
    }),
  },
  {
    label: "业务码为负",
    hint: "响应体里的业务码 < 0 时判失败；字段名按你的下游改",
    build: () => ({
      kind: "if",
      branches: [
        { assert: [{ scope: "body", field: "$.result", op: "lt", value: 0 }], then: [newOutcomeRule("fatal", "business_error")] },
      ],
    }),
  },
  {
    label: "重复跳过",
    hint: "例：$.result = -2 → skip。-2 是 dtw-rs 的约定值，按你的下游实际改",
    build: () => ({
      kind: "if",
      branches: [
        { assert: [{ scope: "body", field: "$.result", op: "eq", value: -2 }], then: [newOutcomeRule("skip", "duplicate")] },
      ],
    }),
  },
  {
    label: "下游不可用",
    hint: "5xx 交还 sink 重试，不算死信",
    build: () => ({
      kind: "if",
      branches: [
        { assert: [{ scope: "status", op: "in", value: [500, 502, 503, 504] }], then: [newOutcomeRule("retriable", "upstream_unavailable")] },
      ],
    }),
  },
  {
    label: "按业务码分流",
    hint: "switch：同一个字段的多个取值各走各的，比连写几条 if 更清楚",
    build: () => newSwitchRule(),
  },
];

/** 结论兜底语句：块的最后一条必须是它（或带否则的 if / 带 default 的 switch） */
export function newFallbackRule(): OutcomeRule {
  return newOutcomeRule("fatal", "unclassified");
}
