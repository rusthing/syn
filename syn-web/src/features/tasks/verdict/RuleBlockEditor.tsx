/**
 * 判定语句块的渲染层。
 *
 * 判定段是一串**按顺序执行的语句**，语句只有三种：`if` / `switch` / `结论`。
 * `if-elseif-else` 不是第四种 —— 它是同一个 `if` 的多个分支；`switch` 单列是因为
 * 「按一个字段的取值分流」值得把重复出现的字段名收成一处。分支体里还是语句列表，
 * 所以嵌套不需要另一套语法：块里再放块，缩进就是作用域。
 *
 * 三条必须由界面守住的语义（与 `syn-core/src/verdict.rs` 一致）：
 * 1. 首个命中即返回，顺序就是优先级；
 * 2. 一个块必须以「必然给出结论」的语句收尾，否则没命中的响应会变成
 *    UNCLASSIFIED 致命 —— 校验会拦，但界面要提前说清（块底部常驻提示）；
 * 3. 只有最后一个分支可以省条件（否则）；`switch` 必须有 default。
 *
 * 渲染层只做投影：编辑动作都是对 `spec.rules` 的不可变替换，不产生第二套语义。
 */
import { useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { cn } from "@/lib/utils";
import type { Branch, CaseArm, Rule, Scope, Verdict } from "@/lib/api/types";
import { SCOPES, VERDICTS, verdictMeta } from "@/lib/spec/defaults";
import {
  MAX_RULE_DEPTH,
  RULE_PRESETS,
  blockConcludes,
  blockOutcomeText,
  branchLabel,
  caseLabel,
  conditionText,
  countRules,
  formatCaseValues,
  newBranch,
  newCaseArm,
  newFallbackRule,
  newIfRule,
  newOutcomeRule,
  newSwitchRule,
  ruleSummary,
} from "@/lib/spec/rules";
import { analyzeRules, anchorOf, findingsUnder, statementPathOf, type Finding } from "@/lib/spec/analyze";
import { issuesUnder, type SpecIssue } from "@/lib/spec/validate";
import { AssertEditor } from "@/components/spec/AssertEditor";
import { CaseValuesInput, IfMatrix, SwitchMatrix } from "./RuleMatrix";
import { RuleOverview } from "./RuleOverview";

/* --------------------------------- 入口 --------------------------------- */

export function RuleBlockEditor({
  rules,
  onChange,
  path,
  issues,
  findings,
  depth = 0,
}: {
  rules: Rule[];
  onChange: (next: Rule[]) => void;
  /** 校验问题的路径前缀，例如 `rules` / `rules[0].branches[1].then` */
  path: string;
  issues?: Map<string, SpecIssue[]>;
  /** 根块算出来的静态检查结果，往下传只为了在语句头上标一个小黄点 */
  findings?: Finding[];
  /** 当前块深度：根块 0，分支体 1……到 MAX_RULE_DEPTH 就不再允许插 if / switch */
  depth?: number;
}) {
  // 「全部收起 / 展开」靠换 key 重挂语句：折叠是每条语句自己的状态，
  // 想把它们一起改，最省事且不会出现「一半收一半开」的办法就是重挂。
  // `open` 是「全部展开」的强制态，用于从检查面板跳过来时把深层块也打开。
  const [fold, setFold] = useState<"none" | "all" | "open">("none");
  const [showOverview, setShowOverview] = useState(false);
  const blockIssues = issues ? issuesUnder(issues, path) : [];
  // 挂在块本身的问题（空块、缺兜底）不属于某条语句，单独在底部说
  const ownIssues = blockIssues.filter((i) => i.path === path);
  const canNest = depth < MAX_RULE_DEPTH;
  const root = depth === 0;

  // 只在根块算一次：检查是整棵树的事，子块再算一遍会重复报同样的问题
  const analysis = useMemo(() => (root ? analyzeRules(rules) : null), [root, rules]);

  const replace = (i: number, next: Rule) => onChange(rules.map((r, k) => (k === i ? next : r)));
  const remove = (i: number) => onChange(rules.filter((_, k) => k !== i));
  const insert = (next: Rule, at = rules.length) => {
    onChange([...rules.slice(0, at), next, ...rules.slice(at)]);
    // 刚加的语句要能立刻看见，不然「点了没反应」
    setFold("none");
  };
  const move = (i: number, delta: number) => {
    const target = i + delta;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[i], next[target]] = [next[target], next[i]];
    onChange(next);
  };

  /** 从检查面板跳到出问题的语句：先全部展开，再滚动 + 短暂描边 */
  const locate = (target: string) => {
    const id = anchorOf(statementPathOf(target));
    setFold("open");
    // 换 key 会重挂子树，等两帧再找元素才拿得到新的 DOM
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = document.getElementById(id);
        if (!el) return;
        // 语句展开后可能很高，`center` 会把标题滚出视口；对齐顶部，并让开吸顶工具条。
        // 不用 `scroll-margin-top`：它要滚动容器自己支持，这里手动算一次更稳，
        // 而且窄窗口下工具条会折成两行，高度得现测。
        const bar = document.getElementById("rule-toolbar");
        const pad = (bar?.getBoundingClientRect().height ?? 0) + 8;
        const scroller = scrollParentOf(el);
        if (scroller) {
          const top =
            el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - pad;
          scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        } else {
          el.scrollIntoView({ block: "start", behavior: "smooth" });
        }
        el.style.boxShadow = "0 0 0 2px var(--color-accent)";
        window.setTimeout(() => {
          el.style.boxShadow = "";
        }, 1400);
      }),
    );
  };

  return (
    <div className="space-y-2">
      {/* 常驻工具条：块长了以后底部按钮要滚很久才够得着，所以新增入口钉在顶部 */}
      <div
        id={root ? "rule-toolbar" : undefined}
        className={cn(
          "flex flex-wrap items-center gap-1 rounded-md border border-line/70 bg-sunken/60 px-1.5 py-1",
          root && "sticky top-0 z-10 bg-surface/95 backdrop-blur",
        )}
      >
        {canNest ? (
          <>
            <Button size="xs" variant="secondary" icon={<Plus className="size-3" />} onClick={() => insert(newIfRule())}>
              如果
            </Button>
            <Button
              size="xs"
              variant="secondary"
              icon={<Plus className="size-3" />}
              title="按一个字段的取值分流：把重复出现的字段名收成一处"
              onClick={() => insert(newSwitchRule())}
            >
              分流 switch
            </Button>
          </>
        ) : (
          <span className="px-1 text-[10.5px] text-muted">
            已到 {MAX_RULE_DEPTH} 层上限：把外层条件前移，别再往下嵌
          </span>
        )}
        <Button size="xs" variant="secondary" icon={<Plus className="size-3" />} onClick={() => insert(newOutcomeRule())}>
          结论
        </Button>
        {!blockConcludes(rules) && (
          <Button
            size="xs"
            variant="ghost"
            icon={<Plus className="size-3" />}
            title="一条不带条件的结论：把剩下的所有响应都收在这里。块的最后一条通常就是它"
            onClick={() => insert(newFallbackRule())}
          >
            兜底结论
          </Button>
        )}
        <span className="ml-auto flex items-center gap-1.5 pl-1">
          <span className="text-[10.5px] text-muted">{countRules(rules)} 条</span>
          {root && analysis && (
            <button
              type="button"
              aria-expanded={showOverview}
              title="静态检查：被包含的分支、重复的取值、轮不到的语句、某结论永远不产生"
              onClick={() => setShowOverview((v) => !v)}
              className={cn(
                "rounded border px-1.5 py-0.5 text-[10.5px] transition-colors",
                showOverview
                  ? "border-accent/40 bg-accent-soft text-accent"
                  : "border-line bg-surface text-ink-soft hover:border-accent/40 hover:text-accent",
              )}
            >
              全貌
              {analysis.findings.length > 0 && (
                <span
                  className={cn(
                    "ml-1 tnum",
                    analysis.findings.some((f) => f.severity === "error") ? "text-danger" : "text-warn",
                  )}
                >
                  {analysis.findings.length}
                </span>
              )}
            </button>
          )}
          {rules.length > 1 && (
            <button
              type="button"
              onClick={() => setFold((f) => (f === "all" ? "open" : "all"))}
              className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10.5px] text-ink-soft hover:border-accent/40 hover:text-accent"
            >
              {fold === "all" ? "全部展开" : "全部收起"}
            </button>
          )}
        </span>
      </div>

      {root && showOverview && analysis && <RuleOverview analysis={analysis} onLocate={locate} />}

      {rules.length === 0 && (
        <div className="rounded-lg border border-dashed border-line bg-sunken/40 px-3 py-3">
          <p className="text-[11.5px] leading-relaxed text-muted">
            这个块里还没有语句。空的块 = 命中之后拿不到结论，等于把响应判成 UNCLASSIFIED 致命。
          </p>
        </div>
      )}

      {rules.map((rule, i) => (
        <Statement
          key={`${fold}-${i}`}
          rule={rule}
          index={i}
          count={rules.length}
          defaultCollapsed={fold === "all" ? rule.kind !== "outcome" : fold === "open" ? false : depth >= 2}
          onChange={(next) => replace(i, next)}
          onMove={(delta) => move(i, delta)}
          onRemove={() => remove(i)}
          path={`${path}[${i}]`}
          issues={issues}
          findings={findings ?? analysis?.findings}
          depth={depth}
        />
      ))}

      {root && (
        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          <span className="text-[10.5px] text-muted">模板：</span>
          {RULE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              title={preset.hint}
              onClick={() => insert(preset.build())}
              className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10.5px] text-ink-soft transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-accent"
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}

      {ownIssues.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-danger-soft px-3 py-2">
          {ownIssues.map((issue, k) => (
            <li key={k} className="text-[11px] leading-snug text-danger">
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------- 一条语句 ------------------------------- */

function Statement({
  rule,
  index,
  count,
  defaultCollapsed,
  onChange,
  onMove,
  onRemove,
  path,
  issues,
  findings,
  depth,
}: {
  rule: Rule;
  index: number;
  count: number;
  defaultCollapsed: boolean;
  onChange: (next: Rule) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  path: string;
  issues?: Map<string, SpecIssue[]>;
  findings?: Finding[];
  depth: number;
}) {
  // 深层的块默认收起：一层层展开是阅读顺序，全部摊开反而看不出结构
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  // 同一份数据的两种画法。默认块视图（写条件），矩阵只在「想核对分流」时切过去
  const [view, setView] = useState<"blocks" | "matrix">("blocks");
  const rowIssues = issues ? issuesUnder(issues, path) : [];
  const foldable = rule.kind !== "outcome";
  const headIssues = rowIssues.filter((i) => i.path === path);
  const related = findings ? findingsUnder(findings, path) : [];
  const matrix = view === "matrix" && foldable;

  return (
    <div
      id={anchorOf(path)}
      className={cn(
        "overflow-hidden rounded-lg border bg-surface transition-shadow",
        rowIssues.length > 0 ? "border-danger/45" : "border-line",
      )}
    >
      <div
        className="flex items-center gap-1.5 px-2 py-1.5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-2px] focus-visible:outline-accent/50"
        tabIndex={0}
        role="group"
        aria-label={`第 ${index + 1} 条语句：${ruleSummary(rule)}`}
        onKeyDown={(event) => {
          // Alt+↑/↓ 移动语句：顺序就是优先级，改顺序比删了重加常见
          if (!event.altKey) return;
          if (event.key === "ArrowUp") {
            event.preventDefault();
            onMove(-1);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            onMove(1);
          }
        }}
      >
        {foldable ? (
          <button
            type="button"
            aria-label={collapsed ? "展开这条语句" : "收起这条语句"}
            aria-expanded={!collapsed}
            onClick={() => {
              // 收起时回到块视图：折叠头只写一句摘要，停在表格视图会「收不起来」
              if (!collapsed) setView("blocks");
              setCollapsed((v) => !v);
            }}
            className="shrink-0 rounded p-0.5 text-muted hover:bg-ink/[0.05] hover:text-ink"
          >
            {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <span className="tnum flex size-4 shrink-0 items-center justify-center font-mono text-[10.5px] text-muted">
          {index + 1}
        </span>
        <KindTag rule={rule} />
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-soft" title={ruleSummary(rule)}>
          {ruleSummary(rule)}
        </span>
        {related.length > 0 && (
          <span
            title={related.map((f) => f.message).join("\n")}
            className="flex shrink-0 items-center gap-0.5 rounded bg-warn-soft px-1 text-[10px] text-warn"
          >
            <AlertTriangle className="size-3" />
            {related.length}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {foldable && (
            <button
              type="button"
              aria-pressed={matrix}
              title={matrix ? "回到块视图：条件在那里改" : "矩阵视图：看每个分支在每个字段上放行了什么"}
              onClick={() => {
                setCollapsed(false);
                setView((v) => (v === "matrix" ? "blocks" : "matrix"));
              }}
              className={cn(
                "rounded border px-1 py-0.5 text-[10px] transition-colors",
                matrix
                  ? "border-accent/40 bg-accent-soft text-accent"
                  : "border-line bg-surface text-ink-soft hover:border-accent/40 hover:text-accent",
              )}
            >
              {matrix ? "块" : "表"}
            </button>
          )}
          <IconButton label="上移（更早命中）" disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp className="size-3.5" />
          </IconButton>
          <IconButton label="下移" disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDown className="size-3.5" />
          </IconButton>
          <IconButton label="删除这条语句" tone="danger" onClick={onRemove}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
      </div>

      {collapsed && foldable ? (
        <div className="flex items-center gap-2 border-t border-line/70 bg-sunken/40 px-2 py-1 pl-[54px]">
          <span className="text-[10.5px] text-muted">
            {rule.kind === "if"
              ? `${rule.branches.length} 个分支 · 共 ${countRules([rule]) - 1} 条子语句`
              : `${rule.cases.length} 个 case · 共 ${countRules([rule]) - 1} 条子语句`}
          </span>
          <span className="text-line-strong">|</span>
          <span className="text-[10.5px] text-ink-soft">最终给出：{blockOutcomeText(branchTail(rule))}</span>
        </div>
      ) : (
        <div className="border-t border-line/70 px-2 py-2">
          {matrix && rule.kind === "if" && <IfMatrix rule={rule} />}
          {matrix && rule.kind === "switch" && (
            <SwitchMatrix rule={rule} onChange={onChange} path={path} issues={issues} />
          )}
          {!matrix && rule.kind === "outcome" && <OutcomeBody rule={rule} onChange={onChange} />}
          {!matrix && rule.kind === "if" && (
            <IfBody rule={rule} onChange={onChange} path={path} issues={issues} findings={findings} depth={depth} />
          )}
          {!matrix && rule.kind === "switch" && (
            <SwitchBody rule={rule} onChange={onChange} path={path} issues={issues} findings={findings} depth={depth} />
          )}
        </div>
      )}

      {headIssues.length > 0 && (
        <ul className="space-y-1 border-t border-line bg-danger-soft/60 px-2 py-1.5">
          {headIssues.map((issue, k) => (
            <li key={k} className="text-[11px] leading-snug text-danger">
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 最近的可滚动祖先：滚动定位只认它，别让整页跟着跳 */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const style = window.getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
    node = node.parentElement;
  }
  return null;
}

/** 折叠头要展示「最终给出什么」，取各分支体最后一条里最保守的那个说法 */
function branchTail(rule: Rule): Rule[] {  if (rule.kind === "if") {
    const last = rule.branches[rule.branches.length - 1];
    return last?.then ?? [];
  }
  if (rule.kind === "switch") return rule.default ?? [];
  return [rule];
}

/* -------------------------------- 结论叶子 ------------------------------- */

function OutcomeBody({ rule, onChange }: { rule: Extract<Rule, { kind: "outcome" }>; onChange: (next: Rule) => void }) {
  const meta = verdictMeta(rule.verdict);
  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
      <div>
        <span className="mb-1 block text-[10.5px] font-medium text-muted">结论</span>
        <VerdictPicker
          value={rule.verdict}
          onChange={(verdict) => onChange({ ...rule, verdict })}
        />
      </div>
      <div className="min-w-[200px] flex-1">
        <span className="mb-1 block text-[10.5px] font-medium text-muted">
          分类码
          <span className="ml-1 font-normal text-muted/70">自定义名字，进死信；前端靠它判断能否改报文重投</span>
        </span>
        <Input
          value={rule.code ?? ""}
          placeholder="duplicate / fk_missing / business_error"
          spellCheck={false}
          className="h-8 font-mono text-[11.5px]"
          onChange={(e) => onChange({ ...rule, code: e.target.value })}
        />
      </div>
      <p className="w-full text-[10.5px] leading-snug text-muted">
        {meta.label} · {meta.note}
        <span className="ml-2 text-muted/70">
          分类码里的数字含义（如 <code className="font-mono">-2</code>）由下游约定，换个下游就得重看一遍
        </span>
      </p>
    </div>
  );
}

const VERDICT_TONE: Record<"success" | "muted" | "danger" | "warn", string> = {
  success: "border-success/50 bg-success-soft text-success",
  muted: "border-line-strong/70 bg-sunken text-ink-soft",
  danger: "border-danger/50 bg-danger-soft text-danger",
  warn: "border-warn/50 bg-warn-soft text-warn",
};

function VerdictPicker({ value, onChange }: { value: Verdict; onChange: (v: Verdict) => void }) {
  return (
    <div role="radiogroup" aria-label="结论" className="flex gap-1">
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
              "h-7 rounded-md border px-2 text-[11.5px] transition-colors",
              active ? cn("font-medium", VERDICT_TONE[v.tone]) : "border-line bg-surface text-ink-soft hover:bg-sunken",
            )}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
}

function KindTag({ rule }: { rule: Rule }) {
  if (rule.kind === "if") {
    return <Tag className="border-info/40 bg-info-soft text-info">if</Tag>;
  }
  if (rule.kind === "switch") {
    return <Tag className="border-violet/40 bg-violet-soft text-violet">switch</Tag>;
  }
  const meta = verdictMeta(rule.verdict);
  return <Tag className={VERDICT_TONE[meta.tone]}>{meta.label}</Tag>;
}

function Tag({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded border px-1 py-px text-[10px] font-medium leading-[16px]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ---------------------------------- if ---------------------------------- */

function IfBody({
  rule,
  onChange,
  path,
  issues,
  findings,
  depth,
}: {
  rule: Extract<Rule, { kind: "if" }>;
  onChange: (next: Rule) => void;
  path: string;
  issues?: Map<string, SpecIssue[]>;
  findings?: Finding[];
  depth: number;
}) {
  const branches = rule.branches;
  const last = branches[branches.length - 1];
  const hasElse = (last?.assert ?? []).length === 0;

  const patchBranch = (i: number, patch: Partial<Branch>) =>
    onChange({ ...rule, branches: branches.map((b, k) => (k === i ? { ...b, ...patch } : b)) });

  const addElseIf = () => {
    // 否则如果插在「否则」之前 —— 「否则」永远是最后一项，这是 blockConcludes 的前提
    const at = hasElse ? branches.length - 1 : branches.length;
    onChange({ ...rule, branches: [...branches.slice(0, at), newBranch(), ...branches.slice(at)] });
  };

  const addElse = () => {
    if (hasElse) return;
    onChange({ ...rule, branches: [...branches, { then: [newFallbackRule()] }] });
  };

  const removeBranch = (i: number) => {
    if (branches.length <= 1) return;
    onChange({ ...rule, branches: branches.filter((_, k) => k !== i) });
  };

  return (
    <div className="space-y-1.5">
      {branches.map((branch, i) => {
        const isElse = (branch.assert ?? []).length === 0;
        const branchPath = `${path}.branches[${i}]`;
        const branchIssues = issues ? issuesUnder(issues, branchPath).filter((x) => x.path === branchPath) : [];
        return (
          <div
            key={i}
            className={cn(
              "rounded-md border",
              branchIssues.length > 0 ? "border-danger/45" : isElse ? "border-line-strong/60" : "border-line/85",
              isElse ? "bg-sunken/50" : "bg-surface",
            )}
          >
            <div className="flex items-center gap-1.5 border-b border-line/60 px-2 py-1">
              <span
                className={cn(
                  "shrink-0 rounded px-1 py-px text-[10px] font-medium",
                  isElse ? "bg-ink/[0.06] text-muted" : "bg-info-soft text-info",
                )}
              >
                {branchLabel(branch, i)}
              </span>
              {isElse ? (
                <span className="flex-1 text-[10.5px] text-muted">其余所有情况（上面都没命中）</span>
              ) : (
                <span className="flex-1 text-[10.5px] text-muted">
                  当 {conditionText(branch.assert ?? [], branch.scope ?? "body")}
                </span>
              )}
              <IconButton
                label="删除这个分支"
                tone="danger"
                disabled={branches.length <= 1}
                onClick={() => removeBranch(i)}
              >
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>

            {!isElse && (
              <div className="px-1.5 pt-1.5">
                <AssertEditor
                  conditions={branch.assert ?? []}
                  onChange={(assert) => patchBranch(i, { assert })}
                  pathPrefix={`${branchPath}.assert`}
                  issues={issues}
                  defaultScope={branch.scope ?? "body"}
                  showScope
                />
              </div>
            )}

            <div className="px-1.5 pb-1.5 pt-1.5">
              <div className="mb-1 flex items-center gap-1.5">
                <span className="text-[10.5px] font-medium text-muted">则</span>
                <span className="text-[10px] text-muted/70">命中后执行这些语句，最终必须给出结论</span>
              </div>
              <div className="border-l-2 border-line-strong/50 pl-2">
                <RuleBlockEditor
                  rules={branch.then ?? []}
                  onChange={(then) => patchBranch(i, { then })}
                  path={`${branchPath}.then`}
                  issues={issues}
                  findings={findings}
                  depth={depth + 1}
                />
              </div>
            </div>

            {branchIssues.length > 0 && (
              <ul className="space-y-1 border-t border-line bg-danger-soft/60 px-2 py-1.5">
                {branchIssues.map((issue, k) => (
                  <li key={k} className="text-[11px] leading-snug text-danger">
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-1 pl-0.5">
        <Button size="xs" variant="ghost" icon={<Plus className="size-3" />} onClick={addElseIf}>
          否则如果
        </Button>
        {!hasElse && (
          <Button
            size="xs"
            variant="ghost"
            icon={<Plus className="size-3" />}
            title="补上「否则」：块的最后一条 if 没有否则时，没命中的响应会变成 UNCLASSIFIED 致命"
            onClick={addElse}
          >
            否则
          </Button>
        )}
        {!hasElse && (
          <span className="text-[10.5px] text-warn">最后一层 if 没有「否则」时，它是块的最后一条就必须补上</span>
        )}
      </div>
    </div>
  );
}

/* -------------------------------- switch -------------------------------- */

function SwitchBody({
  rule,
  onChange,
  path,
  issues,
  findings,
  depth,
}: {
  rule: Extract<Rule, { kind: "switch" }>;
  onChange: (next: Rule) => void;
  path: string;
  issues?: Map<string, SpecIssue[]>;
  findings?: Finding[];
  depth: number;
}) {
  const scope = (rule.scope ?? "body") as Scope;
  const patchCase = (i: number, patch: Partial<CaseArm>) =>
    onChange({ ...rule, cases: rule.cases.map((c, k) => (k === i ? { ...c, ...patch } : c)) });

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-line/85 bg-sunken/40 px-2 py-1.5">
        <span className="text-[10.5px] font-medium text-muted">按</span>
        <Select
          value={scope}
          aria-label="判别字段的作用域"
          className="h-7 w-[92px] text-[11px]"
          onChange={(e) => onChange({ ...rule, scope: e.target.value as Scope })}
        >
          {SCOPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
        {scope === "status" ? (
          <span className="text-[11px] text-ink-soft">状态码分流（不需要填字段）</span>
        ) : (
          <Input
            value={rule.on}
            placeholder="$.result"
            spellCheck={false}
            aria-label="判别字段"
            className="h-7 w-[220px] font-mono text-[11.5px]"
            onChange={(e) => onChange({ ...rule, on: e.target.value })}
          />
        )}
        <span className="text-[10.5px] text-muted">的取值分流</span>
        <span className="ml-auto text-[10.5px] text-muted">
          命中后执行臂里的语句；没有任何臂命中就走 default
        </span>
      </div>

      {rule.cases.map((arm, i) => {
        const armPath = `${path}.cases[${i}]`;
        const armIssues = issues ? issuesUnder(issues, armPath).filter((x) => x.path === armPath) : [];
        return (
          <div
            key={i}
            className={cn(
              "rounded-md border bg-surface",
              armIssues.length > 0 ? "border-danger/45" : "border-line/85",
            )}
          >
            <div className="flex items-center gap-1.5 border-b border-line/60 px-2 py-1">
              <span className="shrink-0 rounded bg-violet-soft px-1 py-px text-[10px] font-medium text-violet">
                case
              </span>
              <span className="shrink-0 text-[10.5px] text-muted">取值</span>
              <CaseValuesInput
                key={formatCaseValues(arm.values)}
                values={arm.values}
                invalid={armIssues.some((x) => x.path.endsWith(".values"))}
                onChange={(values) => patchCase(i, { values })}
              />
              <span className="ml-auto shrink-0 text-[10.5px] text-muted" title={caseLabel(arm)}>
                {arm.values.length} 个
              </span>
              <IconButton
                label="删除这个 case"
                tone="danger"
                onClick={() => onChange({ ...rule, cases: rule.cases.filter((_, k) => k !== i) })}
              >
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
            <div className="px-1.5 py-1.5">
              <div className="mb-1 flex items-center gap-1.5">
                <span className="text-[10.5px] font-medium text-muted">则</span>
                <span className="text-[10px] text-muted/70">取值命中后执行，最终必须给出结论</span>
              </div>
              <div className="border-l-2 border-violet/25 pl-2">
                <RuleBlockEditor
                  rules={arm.then ?? []}
                  onChange={(then) => patchCase(i, { then })}
                  path={`${armPath}.then`}
                  issues={issues}
                  findings={findings}
                  depth={depth + 1}
                />
              </div>
            </div>
            {armIssues.length > 0 && (
              <ul className="space-y-1 border-t border-line bg-danger-soft/60 px-2 py-1.5">
                {armIssues.map((issue, k) => (
                  <li key={k} className="text-[11px] leading-snug text-danger">
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      <div className="rounded-md border border-line-strong/60 bg-sunken/50">
        <div className="flex items-center gap-1.5 border-b border-line/60 px-2 py-1">
          <span className="shrink-0 rounded bg-ink/[0.06] px-1 py-px text-[10px] font-medium text-muted">default</span>
          <span className="text-[10.5px] text-muted">没有任何 case 命中时走这里（必须有）</span>
        </div>
        <div className="px-1.5 py-1.5">
          <div className="border-l-2 border-line-strong/50 pl-2">
            <RuleBlockEditor
              rules={rule.default ?? []}
              onChange={(dft) => onChange({ ...rule, default: dft })}
              path={`${path}.default`}
              issues={issues}
              findings={findings}
              depth={depth + 1}
            />
          </div>
        </div>
      </div>

      <div className="pl-0.5">
        <Button
          size="xs"
          variant="ghost"
          icon={<Plus className="size-3" />}
          onClick={() => onChange({ ...rule, cases: [...rule.cases, newCaseArm()] })}
        >
          加一个 case
        </Button>
      </div>
    </div>
  );
}

