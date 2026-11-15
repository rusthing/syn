/**
 * 判定语句的第二种画法：矩阵。
 *
 * 同一份 `spec.rules`，块视图看「执行顺序与嵌套」，矩阵看「每个判别字段上到底允许什么」。
 * 互相包含的分支、重复的取值、写错的字面量，在表上一眼就能看出来 —— 这些在阶梯里
 * 要一行行读条件才能发现。
 *
 * 两种矩阵的定位不同，所以能力也不同：
 * - `switch` 只有一个判别字段，表格就是它的自然形态，**可以直接改取值**；
 * - `if` 的条件散在多个字段上，表格把「哪个分支在哪些列上放行」摊平，**只读**：
 *   一个格子可能对应多条断言，就地改会悄悄改掉别的断言。改条件回块视图。
 */
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { cn } from "@/lib/utils";
import type { IfRule, SwitchRule } from "@/lib/api/types";
import { formatCaseValues, newCaseArm, parseCaseValues } from "@/lib/spec/rules";
import { matrixOfIf, matrixOfSwitch, type MatrixCell } from "@/lib/spec/analyze";
import { issuesUnder, type SpecIssue } from "@/lib/spec/validate";

const CELL_TONE: Record<MatrixCell["tone"], string> = {
  value: "font-mono text-ink",
  any: "text-muted",
  unknown: "italic text-muted",
  conflict: "font-medium text-danger",
};

/* --------------------------------- if ---------------------------------- */

export function IfMatrix({ rule }: { rule: IfRule }) {
  const data = matrixOfIf(rule);
  const hasFlags = data.rows.some((r) => r.flags.length > 0);

  return (
    <div className="space-y-1.5">
      <div className="overflow-x-auto rounded-md border border-line/85">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="bg-sunken/70 text-left text-[10.5px] text-muted">
              <th className="whitespace-nowrap px-2 py-1 font-medium">分支</th>
              {data.columns.map((col) => (
                <th key={col} className="whitespace-nowrap px-2 py-1 font-mono font-medium">
                  {col}
                </th>
              ))}
              <th className="whitespace-nowrap px-2 py-1 font-medium">最终给出</th>
              {hasFlags && <th className="whitespace-nowrap px-2 py-1 font-medium">检查</th>}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr
                key={row.no}
                className={cn("border-t border-line/70 align-top", row.flags.length > 0 && "bg-warn-soft/50")}
              >
                <td className="whitespace-nowrap px-2 py-1">
                  <span className="tnum mr-1 font-mono text-[10.5px] text-muted">{row.no}</span>
                  <span className="text-ink-soft">{row.label}</span>
                </td>
                {row.cells.map((cell, i) => (
                  <td key={i} className="px-2 py-1">
                    <span className={CELL_TONE[cell.tone]} title={cell.title}>
                      {cell.text}
                    </span>
                  </td>
                ))}
                <td className="whitespace-nowrap px-2 py-1 text-ink-soft">{row.note}</td>
                {hasFlags && (
                  <td className="px-2 py-1">
                    {row.flags.length === 0 ? (
                      <span className="text-muted">—</span>
                    ) : (
                      row.flags.map((flag) => (
                        <span key={flag} className="block text-[10.5px] leading-snug text-warn">
                          {flag}
                        </span>
                      ))
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10.5px] leading-snug text-muted">
        只读投影：条件在块视图里改。
        <span className="ml-1 text-muted/80">
          <code className="font-mono">*</code> = 这一列不关心；
          <code className="ml-1 font-mono">ne</code> / <code className="font-mono">contains</code> /{" "}
          <code className="font-mono">regex</code> / 分组推不出来，显「无法判定」。
        </span>
      </p>
    </div>
  );
}

/* -------------------------------- switch -------------------------------- */

export function SwitchMatrix({
  rule,
  onChange,
  path,
  issues,
}: {
  rule: SwitchRule;
  onChange: (next: SwitchRule) => void;
  path: string;
  issues?: Map<string, SpecIssue[]>;
}) {
  const data = matrixOfSwitch(rule);
  const cases = rule.cases ?? [];

  const setValues = (i: number, values: unknown[]) =>
    onChange({ ...rule, cases: cases.map((c, k) => (k === i ? { ...c, values } : c)) });
  const remove = (i: number) => onChange({ ...rule, cases: cases.filter((_, k) => k !== i) });
  const move = (i: number, delta: number) => {
    const target = i + delta;
    if (target < 0 || target >= cases.length) return;
    const next = [...cases];
    [next[i], next[target]] = [next[target], next[i]];
    onChange({ ...rule, cases: next });
  };

  return (
    <div className="space-y-1.5">
      <div className="overflow-x-auto rounded-md border border-line/85">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="bg-sunken/70 text-left text-[10.5px] text-muted">
              <th className="w-[40px] px-2 py-1 font-medium">#</th>
              <th className="px-2 py-1 font-mono font-medium">{data.column}</th>
              <th className="whitespace-nowrap px-2 py-1 font-medium">最终给出</th>
              <th className="w-[84px] px-2 py-1 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => {
              const armPath = `${path}.cases[${i}]`;
              const bad = issues ? issuesUnder(issues, `${armPath}.values`).filter((x) => x.path.endsWith(".values")) : [];
              return (
                <tr key={row.no} className={cn("border-t border-line/70", (bad.length > 0 || row.dup.length > 0) && "bg-danger-soft/40")}>
                  <td className="px-2 py-1 font-mono text-[10.5px] text-muted">{row.no}</td>
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-1">
                      <CaseValuesInput
                        key={formatCaseValues(row.values)}
                        values={row.values}
                        invalid={bad.length > 0 || row.dup.length > 0}
                        onChange={(values) => setValues(i, values)}
                      />
                    </div>
                    {row.dup.length > 0 && (
                      <span className="mt-0.5 block text-[10.5px] text-danger">
                        {row.dup.join("、")} 已被前面的 case 拿走，这里永远命中不了
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-ink-soft">{row.note}</td>
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-0.5">
                      <IconButton label="上移（更早命中）" disabled={i === 0} onClick={() => move(i, -1)}>
                        <ArrowUp className="size-3.5" />
                      </IconButton>
                      <IconButton label="下移" disabled={i === cases.length - 1} onClick={() => move(i, 1)}>
                        <ArrowDown className="size-3.5" />
                      </IconButton>
                      <IconButton label="删除这个 case" tone="danger" onClick={() => remove(i)}>
                        <Trash2 className="size-3.5" />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              );
            })}
            <tr className="border-t border-line-strong/60 bg-sunken/50">
              <td className="px-2 py-1 font-mono text-[10.5px] text-muted">—</td>
              <td className="px-2 py-1 text-ink-soft">
                <span className="rounded bg-ink/[0.06] px-1 py-px text-[10px] font-medium text-muted">default</span>
                <span className="ml-1.5 text-[10.5px] text-muted">其余所有取值</span>
              </td>
              <td className="whitespace-nowrap px-2 py-1 text-ink-soft">{data.defaultNote}</td>
              <td className="px-2 py-1 text-[10.5px] text-muted">必须有</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant="ghost"
          icon={<Plus className="size-3" />}
          onClick={() => onChange({ ...rule, cases: [...cases, newCaseArm()] })}
        >
          加一个 case
        </Button>
        <span className="text-[10.5px] text-muted">
          取值按逗号分隔：<code className="font-mono">200</code> 是数字、
          <code className="ml-1 font-mono">"200"</code> 是字符串，两者匹配不上
        </span>
      </div>
    </div>
  );
}

/**
 * case 取值：`OK, 200` 这样一行写完。
 *
 * 非受控 + 失焦提交：受控的话每敲一个字符都会把文本重新格式化（`1,` 立刻变成 `1`），
 * 第二个值根本输不进去。`key` 由父级按外部值给出，外部改了才重挂。
 */
export function CaseValuesInput({
  values,
  onChange,
  invalid,
}: {
  values: unknown[];
  onChange: (next: unknown[]) => void;
  invalid?: boolean;
}) {
  return (
    <Input
      defaultValue={formatCaseValues(values)}
      placeholder="0 / OK, DONE / 200"
      spellCheck={false}
      aria-label="case 取值，逗号分隔"
      aria-invalid={invalid || undefined}
      className={cn("h-7 min-w-[120px] flex-1 font-mono text-[11.5px]", invalid && "border-danger/60")}
      onBlur={(e) => {
        const next = parseCaseValues(e.target.value);
        if (JSON.stringify(next) !== JSON.stringify(values)) onChange(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}
