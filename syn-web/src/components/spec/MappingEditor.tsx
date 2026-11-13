import { Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { cn } from "@/lib/utils";
import type { MappingRow, OnEmpty } from "@/lib/api/types";
import { ON_EMPTY } from "@/lib/spec/defaults";
import { TRANSFORMS } from "@/lib/spec/transforms";
import { issuesUnder, type SpecIssue } from "@/lib/spec/validate";
import { ValueInput } from "./ValueInput";

/**
 * 映射表。
 *
 * 一行 = 一个目标字段。`来源类型` 只决定第三列长什么样：填路径还是填常量。
 * 后端用「from / const 二选一」表达同一件事，这里做成显式的选择，避免两边都填
 * 之后要靠校验去猜用户想要哪个。
 */
export function MappingEditor({
  rows,
  omitNull,
  onChange,
  pathPrefix,
  issues,
}: {
  rows: MappingRow[];
  omitNull: boolean;
  onChange: (rows: MappingRow[]) => void;
  pathPrefix: string;
  issues?: Map<string, SpecIssue[]>;
}) {
  const update = (index: number, patch: Partial<MappingRow>) => {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const add = () => {
    onChange([...rows, { to: "", from: "$.", on_empty: "keep" }]);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-sunken/70">
            <th className="w-[19%] px-2 py-1.5 text-left text-[10.5px] font-medium text-muted">目标字段</th>
            <th className="w-[68px] px-2 py-1.5 text-left text-[10.5px] font-medium text-muted">来源</th>
            <th className="px-2 py-1.5 text-left text-[10.5px] font-medium text-muted">路径 / 常量</th>
            <th className="w-[21%] px-2 py-1.5 text-left text-[10.5px] font-medium text-muted">变换链</th>
            <th className="w-[86px] px-2 py-1.5 text-left text-[10.5px] font-medium text-muted">为空</th>
            <th className="w-[96px] px-2 py-1.5 text-left text-[10.5px] font-medium text-muted">失败码</th>
            <th className="w-9 px-1 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isConst = row.const !== undefined;
            const rowIssues = issues ? issuesUnder(issues, `${pathPrefix}[${i}]`) : [];
            return (
              <tr key={i} className={cn("border-t border-line/70", rowIssues.length > 0 && "bg-danger-soft/40")}>
                <td className="px-2 py-1.5">
                  <Input
                    value={row.to}
                    placeholder="name 或 addr.city"
                    spellCheck={false}
                    aria-label="目标字段"
                    className="h-8 font-mono text-[11.5px]"
                    onChange={(e) => update(i, { to: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <Select
                    value={isConst ? "const" : "from"}
                    aria-label="来源类型"
                    className="h-8 w-full text-[11px]"
                    onChange={(e) => {
                      if (e.target.value === "const") update(i, { from: undefined, const: "" });
                      else update(i, { const: undefined, from: "$." });
                    }}
                  >
                    <option value="from">路径</option>
                    <option value="const">常量</option>
                  </Select>
                </td>
                <td className="px-2 py-1.5">
                  {isConst ? (
                    <ValueInput
                      value={row.const}
                      ariaLabel="常量值"
                      placeholder="dtw"
                      onChange={(value) => update(i, { const: value })}
                    />
                  ) : (
                    <Input
                      value={row.from ?? ""}
                      placeholder="$.after.id"
                      spellCheck={false}
                      aria-label="取值路径"
                      className="h-8 font-mono text-[11.5px]"
                      onChange={(e) => update(i, { from: e.target.value || undefined })}
                    />
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    value={(row.fn ?? []).join(", ")}
                    placeholder="trim, truncate(32)"
                    disabled={isConst}
                    spellCheck={false}
                    aria-label="变换链"
                    className="h-8 font-mono text-[11px]"
                    onChange={(e) => {
                      const fn = e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean);
                      update(i, { fn: fn.length > 0 ? fn : undefined });
                    }}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <Select
                    value={row.on_empty ?? "keep"}
                    aria-label="为空时"
                    className="h-8 w-full text-[11px]"
                    onChange={(e) => update(i, { on_empty: e.target.value as OnEmpty })}
                  >
                    {ON_EMPTY.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    value={row.on_error?.code ?? ""}
                    placeholder="默认 fatal"
                    disabled={(row.fn ?? []).length === 0}
                    spellCheck={false}
                    aria-label="变换失败码"
                    className="h-8 font-mono text-[11px]"
                    onChange={(e) => {
                      const code = e.target.value.trim();
                      update(i, { on_error: code ? { verdict: "fatal", code } : undefined });
                    }}
                  />
                </td>
                <td className="px-1 py-1.5">
                  <IconButton
                    label="删除这行映射"
                    tone="danger"
                    onClick={() => onChange(rows.filter((_, k) => k !== i))}
                  >
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-sunken/40 px-2 py-1.5">
        <Button size="xs" variant="ghost" icon={<Plus className="size-3" />} onClick={add}>
          加一行
        </Button>
        <div className="flex items-center gap-2 text-[10.5px] text-muted">
          <span>来源为 null 时{omitNull ? "整行省略" : "写成 null"}；可用变换：</span>
          <span className="font-mono text-[10px] text-muted/90">{TRANSFORMS.join(" · ")}</span>
        </div>
      </div>

      {issues && rows.some((_, i) => issuesUnder(issues, `${pathPrefix}[${i}]`).length > 0) && (
        <ul className="space-y-1 border-t border-line bg-danger-soft/60 px-3 py-2">
          {rows.flatMap((_, i) =>
            issuesUnder(issues, `${pathPrefix}[${i}]`).map((issue, k) => (
              <li key={`${i}-${k}`} className="text-[11px] leading-snug text-danger">
                第 {i + 1} 行：{issue.message}
              </li>
            )),
          )}
        </ul>
      )}
    </div>
  );
}
