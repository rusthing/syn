import { Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import type { Guard, Operator, Verdict } from "@/lib/api/types";
import type { SpecIssue } from "@/lib/spec/validate";
import { AssertEditor } from "./AssertEditor";

/**
 * 发送前守卫。
 *
 * 只回答「这条能不能发」：能发就继续，不能发就直接给结论（`fatal` 进死信，
 * `skip` 当噪音吞掉）。**不在这里改数据** —— 字段带不带属于映射段。
 */
export function GuardEditor({
  guards,
  onChange,
  pathPrefix,
  issues,
}: {
  guards: Guard[];
  onChange: (guards: Guard[]) => void;
  pathPrefix: string;
  issues?: Map<string, SpecIssue[]>;
}) {
  const update = (index: number, patch: Partial<Guard>) => {
    onChange(guards.map((g, i) => (i === index ? { ...g, ...patch } : g)));
  };

  const add = () => {
    onChange([
      ...guards,
      {
        assert: [{ field: "$.", op: "present", scope: "body" }],
        on_fail: { verdict: "fatal", code: "GUARD_FAILED", message: "" },
      },
    ]);
  };

  return (
    <div className="space-y-2">
      {guards.length === 0 && (
        <div className="rounded-lg border border-dashed border-line bg-sunken/50 px-3 py-4 text-[12px] text-muted">
          没有守卫：映射出来的报文直接发出去。需要「名称为空就不发」这类判断时再加。
        </div>
      )}

      {guards.map((guard, i) => (
        <div key={i} className="rounded-lg border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line/70 px-2.5 py-1.5">
            <span className="text-[12px] font-medium text-ink">守卫 {i + 1}</span>
            <IconButton
              label="删除这个守卫"
              tone="danger"
              onClick={() => onChange(guards.filter((_, k) => k !== i))}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </div>

          <div className="space-y-2 px-2.5 py-2">
            <div>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-[11px] font-medium text-ink-soft">适用条件 when</span>
                <span className="text-[10.5px] text-muted">不满足则整条守卫跳过；留空表示总是适用</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  value={guard.when?.field ?? ""}
                  placeholder="$.op（留空表示总是适用）"
                  spellCheck={false}
                  aria-label="适用条件路径"
                  className="h-8 font-mono text-[11.5px]"
                  onChange={(e) => {
                    const field = e.target.value.trim();
                    update(i, {
                      when: field
                        ? { field, op: guard.when?.op ?? "in", value: guard.when?.value ?? ["c", "u"], scope: "record" }
                        : undefined,
                    });
                  }}
                />
                {guard.when && (
                  <Select
                    value={guard.when.op}
                    aria-label="适用条件操作符"
                    className="h-8 w-[92px] text-[11px]"
                    onChange={(e) =>
                      update(i, { when: { ...guard.when!, op: e.target.value as Operator } })
                    }
                  >
                    <option value="in">属于</option>
                    <option value="eq">等于</option>
                  </Select>
                )}
              </div>
            </div>

            <div>
              <div className="mb-1 text-[11px] font-medium text-ink-soft">断言（全部满足才放行）</div>
              <AssertEditor
                asserts={guard.assert}
                onChange={(assert) => update(i, { assert })}
                pathPrefix={`${pathPrefix}[${i}].assert`}
                issues={issues}
                defaultScope="record"
              />
            </div>

            <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2">
              <Field label="结论" hint="fatal 进死信，skip 当噪音">
                <Select
                  value={guard.on_fail.verdict}
                  className="h-8 text-[11.5px]"
                  onChange={(e) =>
                    update(i, { on_fail: { ...guard.on_fail, verdict: e.target.value as Verdict } })
                  }
                >
                  <option value="fatal">fatal</option>
                  <option value="skip">skip</option>
                </Select>
              </Field>
              <Field label="分类码">
                <Input
                  value={guard.on_fail.code}
                  spellCheck={false}
                  className="h-8 font-mono text-[11.5px]"
                  onChange={(e) => update(i, { on_fail: { ...guard.on_fail, code: e.target.value } })}
                />
              </Field>
            </div>

            <Field label="说明" hint="会进入死信的 detail，排障时第一眼看到的就是它">
              <Input
                value={guard.on_fail.message ?? ""}
                placeholder="围栏名称为空，无法下发"
                className="h-8 text-[11.5px]"
                onChange={(e) =>
                  update(i, {
                    on_fail: { ...guard.on_fail, message: e.target.value || undefined },
                  })
                }
              />
            </Field>
          </div>
        </div>
      ))}

      <Button size="xs" variant="secondary" icon={<Plus className="size-3" />} onClick={add}>
        加一个守卫
      </Button>
    </div>
  );
}
