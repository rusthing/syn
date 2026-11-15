/**
 * 「全貌」面板：判定段的自检结果。
 *
 * 默认收起 —— 它是检查，不是主编辑面。展开后回答三个问题：
 * 1. 这段判定一共几条语句、最深几层；
 * 2. 每个结论分别有多少条可达语句会给出（某个结论 0 条，多半是漏配）；
 * 3. 哪些东西与意图不一致（被包含的分支、重复取值、轮不到的语句、矛盾条件）。
 *
 * 每一条都能点「定位」跳回那条语句 —— 检查面板最大的失败是「说了问题却不告诉你在哪」。
 */
import { AlertTriangle, CheckCircle2, CornerDownRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { VERDICTS } from "@/lib/spec/defaults";
import type { Finding, RuleAnalysis } from "@/lib/spec/analyze";

export function RuleOverview({
  analysis,
  onLocate,
}: {
  analysis: RuleAnalysis;
  onLocate: (path: string) => void;
}) {
  const errors = analysis.findings.filter((f) => f.severity === "error");
  const warns = analysis.findings.filter((f) => f.severity === "warn");

  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line/70 bg-sunken/50 px-2.5 py-1.5">
        <span className="text-[11px] font-medium text-ink">全貌检查</span>
        <span className="text-[10.5px] text-muted">
          {analysis.statements} 条语句 · 最深 {analysis.depth} 层
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[10.5px]">
          {errors.length > 0 && <span className="text-danger">{errors.length} 个必须改</span>}
          {warns.length > 0 && <span className="text-warn">{warns.length} 个要确认</span>}
          {analysis.findings.length === 0 && (
            <span className="flex items-center gap-1 text-success">
              <CheckCircle2 className="size-3" />
              没发现互相包含、重复取值或轮不到的语句
            </span>
          )}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-1.5">
        <span className="text-[10.5px] text-muted">结论分布</span>
        {VERDICTS.map((v) => {
          const hit = analysis.verdicts.find((x) => x.verdict === v.value);
          const count = hit?.count ?? 0;
          return (
            <span
              key={v.value}
              title={count === 0 ? "判定段里没有语句会给出这个结论（守卫的 on_fail 另算）" : `${count} 条语句给出「${v.label}」`}
              className={cn(
                "rounded border px-1.5 py-px text-[10.5px]",
                count === 0
                  ? "border-dashed border-line text-muted/70"
                  : v.tone === "success"
                    ? "border-success/40 bg-success-soft text-success"
                    : v.tone === "danger"
                      ? "border-danger/40 bg-danger-soft text-danger"
                      : v.tone === "warn"
                        ? "border-warn/40 bg-warn-soft text-warn"
                        : "border-line-strong/60 bg-sunken text-ink-soft",
              )}
            >
              {v.label} ×{count}
            </span>
          );
        })}
        <span className="text-[10px] text-muted/80">同一结论有多条语句给出是正常的，它只是一个兜底位置的分布</span>
      </div>

      {analysis.findings.length > 0 && (
        <ul className="divide-y divide-line/60 border-t border-line/70">
          {[...errors, ...warns].map((f, i) => (
            <FindingRow key={`${f.path}-${f.kind}-${i}`} finding={f} onLocate={onLocate} />
          ))}
        </ul>
      )}

      <p className="border-t border-line/70 px-2.5 py-1.5 text-[10.5px] leading-snug text-muted">
        纯静态推导：只认 <code className="font-mono">eq</code> / <code className="font-mono">in</code> / 范围比较。
        含 <code className="font-mono">ne</code> / <code className="font-mono">contains</code> /{" "}
        <code className="font-mono">regex</code> / 分组的条件一律跳过 —— 宁可少报，也不误报。
      </p>
    </div>
  );
}

function FindingRow({ finding, onLocate }: { finding: Finding; onLocate: (path: string) => void }) {
  const error = finding.severity === "error";
  return (
    <li className={cn("flex items-start gap-1.5 px-2.5 py-1.5", error && "bg-danger-soft/40")}>
      <AlertTriangle className={cn("mt-px size-3.5 shrink-0", error ? "text-danger" : "text-warn")} />
      <div className="min-w-0 flex-1">
        <p className={cn("text-[11px] leading-snug", error ? "text-danger" : "text-ink-soft")}>{finding.message}</p>
        <p className="mt-0.5 font-mono text-[10px] text-muted">{finding.path}</p>
      </div>
      <button
        type="button"
        onClick={() => onLocate(finding.path)}
        className="flex shrink-0 items-center gap-0.5 rounded border border-line bg-surface px-1.5 py-0.5 text-[10.5px] text-ink-soft hover:border-accent/40 hover:text-accent"
      >
        <CornerDownRight className="size-3" />
        定位
      </button>
    </li>
  );
}
