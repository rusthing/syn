import { Plus, Trash2 } from "lucide-react";
import { IconButton } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/utils";
import type { Action, Binding, BodyMode, Header, Method, Op } from "@/lib/api/types";
import { BODY_MODES, METHODS, OPS } from "@/lib/spec/defaults";
import { issuesUnder, type SpecIssue } from "@/lib/spec/validate";

/**
 * 动作矩阵。
 *
 * 四个 op 各一行，**不是**一张「有就发、没有就跳过」的自由列表：CDC 只有这四态，
 * 每种至多一个动作。没有配的那一态等于「该操作明确不支持」，执行时会以
 * `NO_ACTION_FOR_OP` 失败 —— 这是有意为之，静默跳过会让丢数据变得无声无息。
 *
 * `r`（快照读）单独标了提示：漏了它，历史数据永远补不上，而且不报错。
 */
export function ActionEditor({
  actions,
  onChange,
  pathPrefix,
  issues,
}: {
  actions: Action[];
  onChange: (actions: Action[]) => void;
  pathPrefix: string;
  issues?: Map<string, SpecIssue[]>;
}) {
  const find = (op: Op) => actions.find((a) => a.op === op);

  const setAction = (op: Op, patch: Partial<Action> | null) => {
    if (patch === null) {
      onChange(actions.filter((a) => a.op !== op));
      return;
    }
    const existing = find(op);
    if (existing) onChange(actions.map((a) => (a.op === op ? { ...a, ...patch } : a)));
    else onChange([...actions, { op, method: "POST", path: "", body: "mapped", ...patch }]);
  };

  return (
    <div className="space-y-2">
      {OPS.map((op) => {
        const action = find(op.value);
        const enabled = Boolean(action);
        const rowIssues = issues
          ? issuesUnder(issues, `${pathPrefix}[${actions.findIndex((a) => a.op === op.value)}]`)
          : [];
        return (
          <div
            key={op.value}
            className={cn(
              "rounded-lg border bg-surface",
              enabled ? "border-line" : "border-dashed border-line/80 bg-sunken/30",
              rowIssues.length > 0 && "border-danger/40",
            )}
          >
            <div className="flex items-center gap-2 px-2.5 py-2">
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded font-mono text-[12px] font-semibold",
                  enabled ? "bg-accent-soft text-accent-strong" : "bg-ink/[0.05] text-muted",
                )}
              >
                {op.value}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[12.5px] font-medium text-ink">{op.label}</span>
                  <span className="truncate text-[10.5px] text-muted">{op.note}</span>
                </div>
                {op.value === "r" && !enabled && (
                  <p className="text-[10.5px] text-warn">建议配置：快照重放靠它，漏了不报错但数据补不上</p>
                )}
              </div>
              <Switch
                checked={enabled}
                size="sm"
                label={`启用 ${op.label} 动作`}
                onChange={(next) => setAction(op.value, next ? {} : null)}
              />
            </div>

            {action && (
              <div className="border-t border-line/70 px-2.5 py-2">
                <div className="grid grid-cols-[86px_minmax(0,1fr)_112px] gap-2">
                  <Select
                    value={action.method}
                    aria-label={`${op.label} 方法`}
                    className="h-8 text-[11.5px]"
                    onChange={(e) => setAction(op.value, { method: e.target.value as Method })}
                  >
                    {METHODS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </Select>
                  <Input
                    value={action.path ?? ""}
                    placeholder="相对 target.base 的路径，可空"
                    spellCheck={false}
                    aria-label={`${op.label} 路径`}
                    className="h-8 font-mono text-[11.5px]"
                    onChange={(e) => setAction(op.value, { path: e.target.value })}
                  />
                  <Select
                    value={action.body ?? "mapped"}
                    aria-label={`${op.label} 请求体`}
                    className="h-8 text-[11.5px]"
                    onChange={(e) => setAction(op.value, { body: e.target.value as BodyMode })}
                  >
                    {BODY_MODES.map((b) => (
                      <option key={b.value} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </Select>
                </div>

                <details className="mt-1.5 group">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted hover:text-ink">
                    <span className="transition-transform group-open:rotate-90">›</span>
                    查询参数 {(action.query ?? []).length} · 请求头 {(action.headers ?? []).length}
                  </summary>
                  <div className="mt-2 space-y-2">
                    <BindingList
                      label="查询参数"
                      items={action.query ?? []}
                      onChange={(query) => setAction(op.value, { query })}
                    />
                    <HeaderList
                      items={action.headers ?? []}
                      onChange={(headers) => setAction(op.value, { headers })}
                    />
                  </div>
                </details>

                {rowIssues.length > 0 && (
                  <ul className="mt-1.5 space-y-1 rounded bg-danger-soft/60 px-2 py-1.5">
                    {rowIssues.map((issue, k) => (
                      <li key={k} className="text-[11px] leading-snug text-danger">
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })}
      <p className="text-[11px] leading-relaxed text-muted">
        没启用的 op 表示「明确不支持」：记录带这个 op 时会以 <code className="font-mono">NO_ACTION_FOR_OP</code> 失败，
        不会静默跳过。真正不归本任务管的记录，应该在匹配段就排除掉。
      </p>
    </div>
  );
}

function BindingList({
  label,
  items,
  onChange,
}: {
  label: string;
  items: Binding[];
  onChange: (items: Binding[]) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10.5px] font-medium text-muted">{label}</span>
        <button
          type="button"
          className="inline-flex items-center gap-0.5 text-[10.5px] text-accent hover:text-accent-strong"
          onClick={() => onChange([...items, { name: "", from: "$." }])}
        >
          <Plus className="size-3" />
          加一项
        </button>
      </div>
      {items.length === 0 ? (
        <p className="text-[10.5px] text-muted/80">无</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item, i) => (
            <li key={i} className="flex items-center gap-1">
              <Input
                value={item.name}
                placeholder="name"
                aria-label={`${label}名`}
                className="h-7 w-[38%] font-mono text-[11px]"
                onChange={(e) => onChange(items.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))}
              />
              <Input
                value={item.from}
                placeholder="$.after.id"
                aria-label={`${label}取值路径`}
                className="h-7 flex-1 font-mono text-[11px]"
                onChange={(e) => onChange(items.map((x, k) => (k === i ? { ...x, from: e.target.value } : x)))}
              />
              <IconButton label="删除" tone="danger" onClick={() => onChange(items.filter((_, k) => k !== i))}>
                <Trash2 className="size-3" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HeaderList({ items, onChange }: { items: Header[]; onChange: (items: Header[]) => void }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10.5px] font-medium text-muted">请求头</span>
        <button
          type="button"
          className="inline-flex items-center gap-0.5 text-[10.5px] text-accent hover:text-accent-strong"
          onClick={() => onChange([...items, { name: "", from: "$." }])}
        >
          <Plus className="size-3" />
          加一项
        </button>
      </div>
      {items.length === 0 ? (
        <p className="text-[10.5px] text-muted/80">无</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item, i) => (
            <li key={i} className="flex items-center gap-1">
              <Input
                value={item.name}
                placeholder="X-User-Id"
                aria-label="头名"
                className="h-7 w-[32%] font-mono text-[11px]"
                onChange={(e) => onChange(items.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))}
              />
              <Input
                value={item.from}
                placeholder="$.after.create_by"
                aria-label="头取值路径"
                className="h-7 flex-1 font-mono text-[11px]"
                onChange={(e) => onChange(items.map((x, k) => (k === i ? { ...x, from: e.target.value } : x)))}
              />
              <Input
                value={item.default ?? ""}
                placeholder="兜底"
                aria-label="兜底值"
                className="h-7 w-[22%] font-mono text-[11px]"
                onChange={(e) =>
                  onChange(
                    items.map((x, k) =>
                      k === i ? { ...x, default: e.target.value || undefined } : x,
                    ),
                  )
                }
              />
              <IconButton label="删除" tone="danger" onClick={() => onChange(items.filter((_, k) => k !== i))}>
                <Trash2 className="size-3" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
