/**
 * 判定段顶层编辑器：方案 1「缩进树形决策表」的入口。
 *
 * 职责边界：这里只持有展示态（折叠集合、试跑命中行），数据仍完全由外层
 * `spec.rules` 决定 —— onChange 依旧是一次不可变替换，外层照旧
 * patch({ rules, outcomes: undefined })。判定逻辑一律复用 lib/spec。
 */
import { useMemo, useState } from "react";
import { Braces, FlaskConical, Plus } from "lucide-react";
import type { Rule, TaskSpec } from "@/lib/api/types";
import type { SpecIssue } from "@/lib/spec/validate";
import { analyzeRules, anchorOf, statementPathOf } from "@/lib/spec/analyze";
import {
  RULE_PRESETS,
  newFallbackRule,
  newIfRule,
  newOutcomeRule,
  newSwitchRule,
} from "@/lib/spec/rules";
import { cn } from "@/lib/utils";
import { DecisionTable } from "./DecisionTable";
import { appendStatement } from "./ops";
import { RuleOverview } from "./RuleOverview";
import { TrialPanel, type TrialResult } from "./TrialPanel";

export function VerdictEditor({
  spec,
  rules,
  onChange,
  issues,
  onOpenJson,
}: {
  spec: TaskSpec;
  rules: Rule[];
  onChange: (next: Rule[]) => void;
  issues: Map<string, SpecIssue[]>;
  /** 让外层切到 JSON 页签，不在判定段复制一份 JSON 编辑框 */
  onOpenJson?: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [hitId, setHitId] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const analysis = useMemo(() => analyzeRules(rules), [rules]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const collapseAll = () => setCollapsed(foldableIds(rules));
  const expandAll = () => setCollapsed(new Set<string>());

  const onResult = (result: TrialResult | null) => {
    if (!result || result.fallback || result.index < 1) {
      setHitId(null);
      return;
    }
    const id = `rules[${result.index - 1}]`;
    setHitId(id);
    // 命中的子树必须可见：把这条顶层语句下面的折叠状态全部解开
    setCollapsed((prev) => new Set([...prev].filter((x) => !x.startsWith(id))));
  };

  const locate = (target: string) => {
    const id = anchorOf(statementPathOf(target));
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.style.boxShadow = "0 0 0 2px var(--color-accent)";
      window.setTimeout(() => {
        el.style.boxShadow = "";
      }, 1400);
    });
  };

  const insert = (rule: Rule) => {
    // 不能直接 push 到末尾：最后一条通常是兜底结论，追加在它后面就永远轮不到
    onChange(appendStatement(rules, rule));
    setShowMore(false);
  };

  return (
    <div className="space-y-2">
      {/* 常驻工具条：三个入口，其余收进「新增」下拉 */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-md border border-line/70 bg-surface/95 px-2 py-1.5 backdrop-blur">
        <span className="text-[11px] text-ink-soft">
          自上而下 · 首个命中即停 · <span className="font-medium text-accent">行序 = 优先级</span>
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            title="滚到实时试跑"
            onClick={() => document.getElementById("verdict-trial")?.scrollIntoView({ block: "nearest", behavior: "smooth" })}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2 text-[11px] text-ink-soft transition-colors hover:border-accent/40 hover:text-accent"
          >
            <FlaskConical className="size-3.5" />
            试跑
          </button>
          {onOpenJson && (
            <button
              type="button"
              onClick={onOpenJson}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2 text-[11px] text-ink-soft transition-colors hover:border-accent/40 hover:text-accent"
            >
              <Braces className="size-3.5" />
              查看 JSON
            </button>
          )}
          <div className="relative">
            <button
              type="button"
              aria-expanded={showMore}
              onClick={() => setShowMore((v) => !v)}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors",
                showMore ? "border-accent/40 bg-accent-soft text-accent" : "border-line bg-surface text-ink-soft hover:border-accent/40 hover:text-accent",
              )}
            >
              <Plus className="size-3.5" />
              新增
            </button>
            {showMore && (
              <div className="absolute right-0 top-8 z-20 w-[264px] rounded-lg border border-line-strong bg-surface p-1 shadow-panel">
                <div className="px-1.5 py-1 text-[10px] font-medium text-muted">语句</div>
                <DropdownItem onClick={() => insert(newIfRule())}>如果 if</DropdownItem>
                <DropdownItem onClick={() => insert(newSwitchRule())}>分流 switch</DropdownItem>
                <DropdownItem onClick={() => insert(newOutcomeRule())}>结论</DropdownItem>
                <DropdownItem onClick={() => insert(newFallbackRule())}>兜底结论 · fatal / unclassified</DropdownItem>
                <div className="my-1 border-t border-line" />
                <div className="px-1.5 py-1 text-[10px] font-medium text-muted">快速插入模板</div>
                {RULE_PRESETS.map((preset) => (
                  <DropdownItem key={preset.label} title={preset.hint} onClick={() => insert(preset.build())}>
                    {preset.label}
                  </DropdownItem>
                ))}
                <p className="px-1.5 pt-1 text-[10px] leading-snug text-muted">
                  只插在顶层，且落在末尾兜底结论之前。要往分支体里加语句，用那一行右侧的「＋」。
                </p>
              </div>
            )}
          </div>
        </span>
      </div>

      <RuleOverview analysis={analysis} onLocate={locate} />

      <DecisionTable
        rules={rules}
        onChange={onChange}
        issues={issues}
        findings={analysis.findings}
        hitId={hitId}
        collapsed={collapsed}
        onToggle={toggle}
        onExpandAll={expandAll}
        onCollapseAll={collapseAll}
      />

      <TrialPanel spec={spec} rules={rules} onResult={onResult} />
    </div>
  );
}

function DropdownItem({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="block w-full rounded px-1.5 py-1 text-left text-[11px] text-ink-soft transition-colors hover:bg-accent-soft hover:text-accent"
    >
      {children}
    </button>
  );
}

/** 所有「有子树」的行 id —— 全部收起时只折叠这些，叶子行本来就没有可收的东西 */
function foldableIds(rules: Rule[]): Set<string> {
  const ids = new Set<string>();
  const walk = (block: Rule[], path: string) => {
    block.forEach((rule, i) => {
      const id = `${path}[${i}]`;
      if (rule.kind === "if") {
        ids.add(id);
        rule.branches.forEach((b, j) => {
          const bid = `${id}.branches[${j}]`;
          if ((b.then ?? []).length > 0) {
            ids.add(bid);
            walk(b.then ?? [], `${bid}.then`);
          }
        });
      } else if (rule.kind === "switch") {
        ids.add(id);
        rule.cases.forEach((c, j) => {
          const cid = `${id}.cases[${j}]`;
          if ((c.then ?? []).length > 0) {
            ids.add(cid);
            walk(c.then ?? [], `${cid}.then`);
          }
        });
        if ((rule.default ?? []).length > 0) {
          const did = `${id}.default`;
          ids.add(did);
          walk(rule.default ?? [], did);
        }
      }
    });
  };
  walk(rules, "rules");
  return ids;
}
