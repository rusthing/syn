import { Plus, Trash2, TriangleAlert } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { Input } from "@/components/ui/Field";
import { cn } from "@/lib/utils";
import type { Assert, Condition, Scope } from "@/lib/api/types";
import {
  GROUP_META,
  OPERATORS,
  SCOPES,
  groupChildren,
  groupKindOf,
  isAssert,
  makeGroup,
  operatorMeta,
  type GroupKind,
} from "@/lib/spec/defaults";
import { issuesUnder, type SpecIssue } from "@/lib/spec/validate";
import { ValueInput } from "./ValueInput";

/**
 * 条件表。
 *
 * 五段里有三段（匹配、守卫、判定）用的都是这张表，区别只在默认作用域与是否
 * 允许改 scope。**条件数组本身就是 AND 根节点**，元素既可以是叶子断言，也可以是
 * `all` / `any` / `not` 分组，分组内再递归用同一张表 —— 所以编辑器也只有一套控件，
 * 不会出现「匹配段能分组、判定段不能」这种前后不一致。
 *
 * 每条叶子可以单独选作用域：判定段想同时判状态码和响应体，就是同一条规则里
 * 两行分别选 status / 报文体，不需要额外的表达式。
 */
export function AssertEditor({
  conditions,
  onChange,
  pathPrefix,
  issues,
  defaultScope,
  showScope = true,
  emptyHint,
  depth = 0,
}: {
  conditions: Condition[];
  onChange: (next: Condition[]) => void;
  pathPrefix: string;
  issues?: Map<string, SpecIssue[]>;
  defaultScope: Scope;
  showScope?: boolean;
  emptyHint?: string;
  depth?: number;
}) {
  const colSpan = showScope ? 5 : 4;

  const leaf = (): Assert => ({ field: "$.", op: "eq", value: "", scope: defaultScope });

  const update = (index: number, patch: Partial<Assert>) => {
    const c = conditions[index];
    if (!isAssert(c)) return;
    onChange(conditions.map((x, i) => (i === index ? { ...c, ...patch } : x)));
  };

  const replace = (index: number, next: Condition) => {
    onChange(conditions.map((x, i) => (i === index ? next : x)));
  };

  const add = () => onChange([...conditions, leaf()]);
  const addGroup = (kind: GroupKind) => onChange([...conditions, makeGroup(kind, [leaf()])]);

  if (conditions.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-sunken/50 px-3 py-4">
        <p className="text-[12px] text-muted">{emptyHint ?? "没有条件，这一段恒通过"}</p>
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
          {conditions.map((cond, i) => {
            const at = `${pathPrefix}[${i}]`;
            const rowIssues = issues ? issuesUnder(issues, at) : [];
            const kind = groupKindOf(cond);

            if (kind) {
              const children = groupChildren(cond, kind);
              const childPrefix =
                kind === "not" ? `${at}.not.all` : `${at}.${kind}`;
              return (
                <tr key={i} className="border-t border-line/70">
                  <td colSpan={colSpan} className="px-2 py-1.5">
                    <div className="rounded-md border border-accent/35 bg-accent-soft/25">
                      <div className="flex items-center gap-2 border-b border-accent/20 px-2 py-1">
                        <Select
                          value={kind}
                          aria-label="分组连接词"
                          className="h-7 w-[104px] text-[11px]"
                          onChange={(e) => replace(i, makeGroup(e.target.value as GroupKind, children))}
                        >
                          {(Object.keys(GROUP_META) as GroupKind[]).map((k) => (
                            <option key={k} value={k}>
                              {GROUP_META[k].label}
                            </option>
                          ))}
                        </Select>
                        <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted">
                          {GROUP_META[kind].hint}
                        </span>
                        <IconButton
                          label="删除这个分组"
                          tone="danger"
                          onClick={() => onChange(conditions.filter((_, k) => k !== i))}
                        >
                          <Trash2 className="size-3.5" />
                        </IconButton>
                      </div>
                      <div className="p-1.5">
                        <AssertEditor
                          conditions={children}
                          onChange={(next) => replace(i, makeGroup(kind, next))}
                          pathPrefix={childPrefix}
                          issues={issues}
                          defaultScope={defaultScope}
                          showScope={showScope}
                          depth={depth + 1}
                        />
                      </div>
                    </div>
                  </td>
                </tr>
              );
            }

            const assert = cond as Assert;
            const meta = operatorMeta(assert.op);
            // scope 缺省是继承：继承成 status 时「取值路径」整列都不该填
            const effectiveScope = assert.scope ?? defaultScope;
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
                      title={SCOPES.find((s) => s.value === effectiveScope)?.hint}
                      className="h-8 w-full text-[11px]"
                      onChange={(e) =>
                        update(i, { scope: (e.target.value || undefined) as Scope | undefined })
                      }
                    >
                      <option value="">继承</option>
                      {SCOPES.map((s) => (
                        <option key={s.value} value={s.value} title={s.hint}>
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
                    onClick={() => onChange(conditions.filter((_, k) => k !== i))}
                  >
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line bg-sunken/40 px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-1">
          <Button size="xs" variant="ghost" icon={<Plus className="size-3" />} onClick={add}>
            加一条断言
          </Button>
          {depth < 3 && (
            <>
              <Button size="xs" variant="ghost" onClick={() => addGroup("any")}>
                加「任意满足」分组
              </Button>
              <Button size="xs" variant="ghost" onClick={() => addGroup("all")}>
                加「全部满足」分组
              </Button>
              <Button size="xs" variant="ghost" onClick={() => addGroup("not")}>
                加「取反」分组
              </Button>
            </>
          )}
        </div>
        <span className="text-[10.5px] text-muted">
          多条之间是「并且」；每条可单独选作用域（判定段的「报文体」是下游响应体）
        </span>
      </div>
      {issues && conditions.some((_, i) => issuesUnder(issues, `${pathPrefix}[${i}]`).length > 0) && (
        <ul className="space-y-1 border-t border-line bg-danger-soft/60 px-3 py-2">
          {conditions.flatMap((_, i) =>
            issuesUnder(issues, `${pathPrefix}[${i}]`).map((issue, k) => (
              <li key={`${i}-${k}`} className="text-[11px] leading-snug text-danger">
                {issue.path.replace(`${pathPrefix}[${i}]`, `第 ${i + 1} 项`)}：{issue.message}
              </li>
            )),
          )}
        </ul>
      )}
    </div>
  );
}
