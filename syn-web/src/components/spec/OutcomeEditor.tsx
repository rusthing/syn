import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { cn } from "@/lib/utils";
import type { Outcome, Scope, Verdict } from "@/lib/api/types";
import { SCOPES, VERDICTS } from "@/lib/spec/defaults";
import type { SpecIssue } from "@/lib/spec/validate";
import { AssertEditor } from "./AssertEditor";

/**
 * 判定规则表。
 *
 * **有序，首命中即停**。所以顺序本身是配置的一部分：具体的错误码放前面，
 * 笼统的 `result < 0` 放后面，最后一条必须是无 `field` 的兜底。
 * 没有兜底时「不认识的响应」会被当成成功，这是这条链路上最贵的一种错误。
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
      {outcomes.map((outcome, i) => {
        const isLast = i === outcomes.length - 1;
        const isFallback = outcome.assert.every((a) => !a.field);
        return (
          <div
            key={i}
            className={cn(
              "rounded-lg border bg-surface",
              isLast && !isFallback ? "border-warn/45" : "border-line",
            )}
          >
            <div className="flex items-center gap-2 border-b border-line/70 px-2.5 py-1.5">
              <span className="tnum flex size-5 items-center justify-center rounded bg-ink/[0.05] font-mono text-[10.5px] text-muted">
                {i + 1}
              </span>
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
              <div className="ml-auto flex items-center gap-1">
                <IconButton label="上移（更早命中）" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp className="size-3.5" />
                </IconButton>
                <IconButton
                  label="下移"
                  disabled={i === outcomes.length - 1}
                  onClick={() => move(i, 1)}
                >
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
              <AssertEditor
                asserts={outcome.assert}
                onChange={(assert) => update(i, { assert })}
                pathPrefix={`${pathPrefix}[${i}].assert`}
                issues={issues}
                defaultScope={outcome.scope}
                showScope
              />

              <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-2">
                <div>
                  <span className="mb-1 block text-[10.5px] font-medium text-muted">结论</span>
                  <Select
                    value={outcome.verdict}
                    aria-label="结论"
                    className="h-8 text-[11.5px]"
                    onChange={(e) => update(i, { verdict: e.target.value as Verdict })}
                  >
                    {VERDICTS.map((v) => (
                      <option key={v.value} value={v.value}>
                        {v.label} · {v.http}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <span className="mb-1 block text-[10.5px] font-medium text-muted">
                    分类码<span className="ml-1 text-muted/70">进死信，也是前端「能否改报文重投」的依据</span>
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
            </div>
          </div>
        );
      })}

      <div className="flex items-center justify-between gap-2">
        <Button size="xs" variant="secondary" icon={<Plus className="size-3" />} onClick={add}>
          加一条规则
        </Button>
        <span className="text-[10.5px] leading-snug text-muted">
          从上往下首命中即停；最后一条不要带 field，否则「响应不认识」会按 UNCLASSIFIED 失败
        </span>
      </div>
    </div>
  );
}
