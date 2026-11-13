import { Plus, Trash2, TriangleAlert } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { Input } from "@/components/ui/Field";
import { cn } from "@/lib/utils";
import type { Assert, Scope } from "@/lib/api/types";
import { OPERATORS, SCOPES, operatorMeta } from "@/lib/spec/defaults";
import { issuesUnder, type SpecIssue } from "@/lib/spec/validate";
import { ValueInput } from "./ValueInput";

/**
 * 断言表。
 *
 * 五段里有三段（匹配、守卫、判定）用的都是这张表，区别只在默认作用域与是否
 * 允许改 scope。让它们共用一套输入控件，才不会出现「匹配段能选正则、判定段不能」
 * 这种前后不一致。
 */
export function AssertEditor({
  asserts,
  onChange,
  pathPrefix,
  issues,
  defaultScope,
  showScope = true,
  emptyHint,
}: {
  asserts: Assert[];
  onChange: (next: Assert[]) => void;
  pathPrefix: string;
  issues?: Map<string, SpecIssue[]>;
  defaultScope: Scope;
  showScope?: boolean;
  emptyHint?: string;
}) {
  const update = (index: number, patch: Partial<Assert>) => {
    onChange(asserts.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  };

  const add = () => {
    onChange([...asserts, { field: "$.", op: "eq", value: "", scope: defaultScope }]);
  };

  if (asserts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-sunken/50 px-3 py-4">
        <p className="text-[12px] text-muted">{emptyHint ?? "没有断言，这一段恒通过"}</p>
        <Button size="xs" variant="secondary" icon={<Plus className="size-3" />} className="mt-2" onClick={add}>
          加一条
        </Button>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-sunken/70">
            <th className="w-[38%] px-2 py-1.5 text-left text-[10.5px] font-medium text-muted">取值路径</th>
            <th className="w-[110px] px-2 py-1.5 text-left text-[10.5px] font-medium text-muted">操作符</th>
            <th className="px-2 py-1.5 text-left text-[10.5px] font-medium text-muted">期望值</th>
            {showScope && (
              <th className="w-[86px] px-2 py-1.5 text-left text-[10.5px] font-medium text-muted">作用域</th>
            )}
            <th className="w-9 px-1 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {asserts.map((assert, i) => {
            const meta = operatorMeta(assert.op);
            // scope 缺省是继承：继承成 status 时「取值路径」整列都不该填
            const effectiveScope = assert.scope ?? defaultScope;
            const rowIssues = issues ? issuesUnder(issues, `${pathPrefix}[${i}]`) : [];
            return (
              <tr key={i} className={cn("border-t border-line/70", rowIssues.length > 0 && "bg-danger-soft/40")}>
                <td className="px-2 py-1.5">
                  <Input
                    value={assert.field ?? ""}
                    placeholder={effectiveScope === "status" ? "状态码不需要路径" : "$.after.id"}
                    disabled={effectiveScope === "status"}
                    spellCheck={false}
                    aria-label="取值路径"
                    className="h-8 font-mono text-[11.5px]"
                    onChange={(e) => update(i, { field: e.target.value || undefined })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <Select
                    value={assert.op}
                    aria-label="操作符"
                    className="h-8 w-full text-[11.5px]"
                    onChange={(e) => update(i, { op: e.target.value as Assert["op"] })}
                  >
                    {OPERATORS.map((op) => (
                      <option key={op.value} value={op.value}>
                        {op.label}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-1">
                    <ValueInput
                      value={assert.value}
                      disabled={!meta.needsValue}
                      ariaLabel="期望值"
                      placeholder={!meta.needsValue ? "不需要" : meta.value === "in" || meta.value === "not_in" ? '["c","u"]' : "值"}
                      onChange={(value) => update(i, { value })}
                    />
                    {meta.textual && (
                      <span
                        title="按文本匹配：上游改一个字就可能失效，长期应改成错误码"
                        className="shrink-0 text-warn"
                      >
                        <TriangleAlert className="size-3.5" />
                      </span>
                    )}
                  </div>
                </td>
                {showScope && (
                  <td className="px-2 py-1.5">
                    <Select
                      value={assert.scope ?? ""}
                      aria-label="作用域"
                      className="h-8 w-full text-[11px]"
                      onChange={(e) =>
                        update(i, { scope: (e.target.value || undefined) as Scope | undefined })
                      }
                    >
                      <option value="">继承</option>
                      {SCOPES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </Select>
                  </td>
                )}
                <td className="px-1 py-1.5">
                  <IconButton
                    label="删除这条断言"
                    tone="danger"
                    onClick={() => onChange(asserts.filter((_, k) => k !== i))}
                  >
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex items-center justify-between gap-2 border-t border-line bg-sunken/40 px-2 py-1.5">
        <Button size="xs" variant="ghost" icon={<Plus className="size-3" />} onClick={add}>
          加一条断言
        </Button>
        {asserts.length > 1 && (
          <span className="text-[10.5px] text-muted">多条之间是「并且」；要表达「或」，请拆成两个任务</span>
        )}
      </div>
      {issues && asserts.some((_, i) => issuesUnder(issues, `${pathPrefix}[${i}]`).length > 0) && (
        <ul className="space-y-1 border-t border-line bg-danger-soft/60 px-3 py-2">
          {asserts.flatMap((_, i) =>
            issuesUnder(issues, `${pathPrefix}[${i}]`).map((issue, k) => (
              <li key={`${i}-${k}`} className="text-[11px] leading-snug text-danger">
                第 {i + 1} 条：{issue.message}
              </li>
            )),
          )}
        </ul>
      )}
    </div>
  );
}
