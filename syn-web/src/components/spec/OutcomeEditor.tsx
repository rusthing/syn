import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { cn } from "@/lib/utils";
import type { Assert, Outcome, Scope, Verdict } from "@/lib/api/types";
import { SCOPES, VERDICTS, operatorMeta, verdictMeta } from "@/lib/spec/defaults";
import { issuesUnder, type SpecIssue } from "@/lib/spec/validate";
import { AssertEditor } from "./AssertEditor";

/**
 * 判定规则编辑器（重设计版）。
 *
 * 一条规则读起来是一个句子：**当响应满足什么 → 判什么结论 → 记什么分类码**。
 * 旧版把条件表格、结论下拉、分类码输入框平铺在一起，看不出三者的主从关系；
 * 这里把「句子」提到卡片头上实时生成，条件、结论、分类码各归各位。
 *
 * 两个语义要点必须在界面上说清楚：
 * 1. **有序、首命中即停**：顺序是配置的一部分，具体的放前面，兜底放最后；
 * 2. **分类码是自定义名字**：`$.result = -2 → skip(duplicate)` 里的 -2 只是
 *    dtw-rs 的约定，换个下游未必 —— 数字与名字都是自己配的，别把约定当协议。
 */
export function OutcomeEditor({
  outcomes,
  onChange,
  pathPrefix,
  issues,
}: {
  outcomes: Outcome[];
  onChange: (outcomes: Outcome[]) => void;
  pathPrefix: string;
  issues?: Map<string, SpecIssue[]>;
}) {
  const update = (index: number, patch: Partial<Outcome>) => {
    onChange(outcomes.map((o, i) => (i === index ? { ...o, ...patch } : o)));
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= outcomes.length) return;
    const next = [...outcomes];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const add = () => {
    onChange([
      ...outcomes,
      { scope: "status", assert: [{ op: "eq", value: 200 }], verdict: "success", code: "ok" },
    ]);
  };

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-line/80 bg-sunken/50 px-3 py-2">
        <p className="text-[11.5px] leading-relaxed text-muted">
          每条规则是一个句子：<span className="font-medium text-ink-soft">当响应满足条件 → 判什么结论 → 记什么分类码</span>。
          分类码是自己起的名字，只用于死信归类和前端「能否改报文重投」的判断；条件里的数字
          （比如 <code className="font-mono">$.result = -2</code>）是什么含义由下游约定 ——
          换个下游就得重看一遍，别把约定当协议。规则从上往下首命中即停。
        </p>
      </div>

      {outcomes.map((outcome, i) => {
        const isLast = i === outcomes.length - 1;
        const isFallback = outcome.assert.every((a) => !a.field);
        const rowIssues = issues ? issuesUnder(issues, `${pathPrefix}[${i}]`) : [];
        return (
          <div
            key={i}
            className={cn(
              "rounded-lg border bg-surface",
              rowIssues.length > 0 ? "border-danger/45" : isLast && !isFallback ? "border-warn/45" : "border-line",
            )}
          >
            {/* 句子头：实时生成的可读描述 + 排序/删除 */}
            <div className="flex items-center gap-2 border-b border-line/70 px-2.5 py-1.5">
              <span className="tnum flex size-5 shrink-0 items-center justify-center rounded bg-ink/[0.05] font-mono text-[10.5px] text-muted">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-soft">
                <RuleSentence outcome={outcome} />
              </span>
              {isFallback && (
                <span className="shrink-0 rounded bg-ink/[0.05] px-1.5 py-0.5 text-[10px] text-muted">兜底</span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <IconButton label="上移（更早命中）" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp className="size-3.5" />
                </IconButton>
                <IconButton label="下移" disabled={i === outcomes.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown className="size-3.5" />
                </IconButton>
                <IconButton
                  label="删除这条规则"
                  tone="danger"
                  onClick={() => onChange(outcomes.filter((_, k) => k !== i))}
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            </div>

            <div className="space-y-2 px-2.5 py-2">
              {/* 条件：作用域 + 断言（多条之间「并且」） */}
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[10.5px] font-medium text-muted">当</span>
                <Select
                  value={outcome.scope}
                  aria-label="作用域"
                  className="h-7 w-[92px] text-[11px]"
                  onChange={(e) => update(i, { scope: e.target.value as Scope })}
                >
                  {SCOPES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
                <span className="text-[10.5px] text-muted">满足</span>
              </div>
              <AssertEditor
                asserts={outcome.assert}
                onChange={(assert) => update(i, { assert })}
                pathPrefix={`${pathPrefix}[${i}].assert`}
                issues={issues}
                defaultScope={outcome.scope}
                showScope
              />

              {/* 结论 + 分类码 */}
              <div className="flex flex-wrap items-end gap-x-3 gap-y-2 pl-[64px]">
                <div>
                  <span className="mb-1 block text-[10.5px] font-medium text-muted">结论</span>
                  <VerdictPicker value={outcome.verdict} onChange={(verdict) => update(i, { verdict })} />
                </div>
                <div className="min-w-[220px] flex-1">
                  <span className="mb-1 block text-[10.5px] font-medium text-muted">
                    分类码<span className="ml-1 font-normal text-muted/70">自定义名字，进死信；前端靠它判断能否改报文重投</span>
                  </span>
                  <Input
                    value={outcome.code ?? ""}
                    placeholder="duplicate / fk_missing / business_error"
                    spellCheck={false}
                    className="h-8 font-mono text-[11.5px]"
                    onChange={(e) => update(i, { code: e.target.value })}
                  />
                </div>
              </div>
              {verdictMeta(outcome.verdict).note && (
                <p className="pl-[64px] text-[10.5px] text-muted">
                  {verdictMeta(outcome.verdict).label}：{verdictMeta(outcome.verdict).note}
                </p>
              )}
            </div>
          </div>
        );
      })}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Button size="xs" variant="secondary" icon={<Plus className="size-3" />} onClick={add}>
            加一条规则
          </Button>
          <span className="text-[10.5px] text-muted">常用模板：</span>
          {PRESETS.map((preset) => (
            <button
              key={preset.code}
              type="button"
              title={preset.hint}
              onClick={() => onChange([...outcomes, structuredClone(preset.outcome)])}
              className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10.5px] text-ink-soft hover:border-accent/40 hover:bg-accent-soft hover:text-accent"
            >
              {preset.label}
            </button>
          ))}
        </div>
        <span className="text-[10.5px] leading-snug text-muted">
          最后一条不带 field 即兜底；不写兜底时，没枚举到的响应按 UNCLASSIFIED 失败
        </span>
      </div>
    </div>
  );
}

/* ------------------------------ 句子生成 ------------------------------ */

function fmtValue(value: unknown): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return `[${value.map((v) => String(v)).join(", ")}]`;
  if (typeof value === "string") return `"${value}"`;
  return String(value);
}

const scopeLabel = (scope: Scope) => SCOPES.find((s) => s.value === scope)?.label ?? scope;

function conditionText(asserts: Assert[], fallback: Scope): string {
  return asserts
    .map((a) => {
      const scope = a.scope ?? fallback;
      const op = operatorMeta(a.op).label;
      const value = fmtValue(a.value);
      if (scope === "status") return `${op} ${value}`.trim();
      return `${a.field ?? ""} ${op} ${value}`.trim();
    })
    .join(" 并且 ");
}

/** 卡片头上的实时句子：`请求体 $.result < 0 → 失败 · business_error` */
function RuleSentence({ outcome }: { outcome: Outcome }) {
  const isFallback = outcome.assert.every((a) => !a.field);
  const condition = isFallback ? "其余所有响应" : `${scopeLabel(outcome.scope)} ${conditionText(outcome.assert, outcome.scope)}`;
  const verdict = verdictMeta(outcome.verdict);
  return (
    <>
      当 <span className="font-medium text-ink">{condition}</span>
      <span className="mx-1 text-line-strong">→</span>
      <span className="font-medium text-ink">{verdict.label}</span>
      {outcome.code && <span className="font-mono text-muted"> · {outcome.code}</span>}
    </>
  );
}

/* ------------------------------ 结论选择 ------------------------------ */

const VERDICT_TONE: Record<"success" | "muted" | "danger" | "warn", string> = {
  success: "border-success/50 bg-success-soft text-success",
  muted: "border-line-strong/70 bg-surface text-ink-soft",
  danger: "border-danger/50 bg-danger-soft text-danger",
  warn: "border-warn/50 bg-warn-soft text-warn",
};

function VerdictPicker({ value, onChange }: { value: Verdict; onChange: (v: Verdict) => void }) {
  return (
    <div role="radiogroup" aria-label="结论" className="flex gap-1.5">
      {VERDICTS.map((v) => {
        const active = v.value === value;
        return (
          <button
            key={v.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={v.note}
            onClick={() => onChange(v.value)}
            className={cn(
              "h-8 rounded-md border px-2.5 text-[12px] transition-colors",
              active
                ? cn("font-medium", VERDICT_TONE[v.tone])
                : "border-line bg-surface text-ink-soft hover:bg-sunken",
            )}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------ 常用模板 ------------------------------ */

const PRESETS: Array<{ label: string; code: string; hint: string; outcome: Outcome }> = [
  {
    label: "状态码成功",
    code: "ok",
    hint: "200/201/204 都算提交成功",
    outcome: { scope: "status", assert: [{ op: "in", value: [200, 201, 204] }], verdict: "success", code: "ok" },
  },
  {
    label: "业务码为负",
    code: "business_error",
    hint: "响应体里的业务码 < 0 时判失败；字段名按你的下游改",
    outcome: {
      scope: "body",
      assert: [{ field: "$.result", op: "lt", value: 0 }],
      verdict: "fatal",
      code: "business_error",
    },
  },
  {
    label: "下游不可用",
    code: "upstream_unavailable",
    hint: "5xx 交还 sink 重试，不算死信",
    outcome: {
      scope: "status",
      assert: [{ op: "in", value: [500, 502, 503, 504] }],
      verdict: "retriable",
      code: "upstream_unavailable",
    },
  },
  {
    label: "重复跳过",
    code: "duplicate",
    hint: "例：$.result = -2 → skip。-2 是 dtw-rs 的约定值，按你的下游实际改",
    outcome: {
      scope: "body",
      assert: [{ field: "$.result", op: "eq", value: -2 }],
      verdict: "skip",
      code: "duplicate",
    },
  },
];
