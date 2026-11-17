/**
 * 树形决策表（方案 1 的落地实现）。
 *
 * 一张连续的「条件维度 × 结论」表，行序 = 优先级。语句树被投影成扁平行：
 * 顶层语句在第 0 层，它的分支 / case 在第 1 层，分支体里的语句再往下一层。
 * 逐级缩进 + 竖线表达父子关系，缩进最多 2 层，更深的行只多一个 L{n} 标签。
 *
 * 折叠只影响显示：整棵树仍是一份 spec.rules，收起子树不改数据、不改判定结果。
 * 编辑落在就地展开的编辑行上，所有变更仍是对 rules 的不可变替换。
 */
import { Fragment, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { AssertEditor } from "@/components/spec/AssertEditor";
import { cn } from "@/lib/utils";
import type { Branch, CaseArm, Condition, Rule, Scope, Verdict } from "@/lib/api/types";
import { SCOPES, VERDICTS, isAssert, operatorMeta } from "@/lib/spec/defaults";
import {
  MAX_RULE_DEPTH,
  blockOutcomeText,
  branchLabel,
  conditionText,
  fmtValue,
  formatCaseValues,
  newBranch,
  newCaseArm,
  newFallbackRule,
  newIfRule,
  newOutcomeRule,
  newSwitchRule,
  ruleSummary,
  scopeLabel,
} from "@/lib/spec/rules";
import { findingsUnder, type Finding } from "@/lib/spec/analyze";
import { issuesUnder, type SpecIssue } from "@/lib/spec/validate";
import { CaseValuesInput } from "./RuleMatrix";
import { VerdictBadge } from "./VerdictBadge";
import { appendStatement, dropIndex, moveItem } from "./ops";

/* ------------------------------ 扁平行 ------------------------------ */

interface BaseRow {
  id: string;
  path: string;
  depth: number;
  /** 每一层祖先是否还有后续兄弟：true 才画竖线，让连线在末端收住 */
  guides: boolean[];
  ancestorIds: string[];
  childIds: string[];
  /**
   * 同一个语句块内的重排能力。只有块里 ≥2 条语句时才有；
   * 跨块拖动一律不允许 —— 挪动子树到别的分支里是「改结构」，不是「调顺序」。
   */
  order?: {
    /** 同一父块的行共用一个 group，拖拽只认同组 */
    group: string;
    /** 在所属块里的下标 */
    index: number;
    /** 所属块的长度 */
    count: number;
    /** 允许落点的最大下标（分支块里「否则」必须收尾，非否则分支最多落到此） */
    max: number;
    reorder: (from: number, to: number) => Rule[];
  };
}

type Row =
  | (BaseRow & { kind: "rule"; rule: Rule; set: (next: Rule) => Rule[]; remove: () => Rule[] })
  | (BaseRow & { kind: "branch"; branch: Branch; set: (next: Branch) => Rule[]; remove: () => Rule[] })
  | (BaseRow & { kind: "case"; arm: CaseArm; set: (next: CaseArm) => Rule[]; remove: () => Rule[] })
  | (BaseRow & { kind: "default"; block: Rule[]; set: (next: Rule[]) => Rule[] });

/**
 * 把语句树摊平成行。每一层都拿到一个 `commitBlock(nextBlock)` 闭包：
 * 它负责把改完的块写回父节点，所以子层不需要知道自己在整棵树里的下标。
 */
function flatten(
  block: Rule[],
  path: string,
  depth: number,
  guides: boolean[],
  ancestorIds: string[],
  commitBlock: (next: Rule[]) => Rule[],
  out: Row[],
): void {
  block.forEach((rule, i) => {
    const id = `${path}[${i}]`;
    const rowGuides = [...guides, i < block.length - 1];
    const ids = [...ancestorIds, id];
    const setRule = (next: Rule) => commitBlock(block.map((r, k) => (k === i ? next : r)));
    const removeRule = () => commitBlock(block.filter((_, k) => k !== i));
    // `path` 唯一标识一个语句块，正好当 group 用
    const order =
      block.length > 1
        ? {
            group: path,
            index: i,
            count: block.length,
            max: block.length - 1,
            reorder: (from: number, to: number) => commitBlock(moveItem(block, from, to)),
          }
        : undefined;
    const base: BaseRow = {
      id,
      path: id,
      depth,
      guides: rowGuides,
      ancestorIds,
      childIds: [],
      order,
    };

    if (rule.kind === "outcome") {
      out.push({ ...base, kind: "rule", rule, set: setRule, remove: removeRule });
      return;
    }
    // 先放父行，再往 childIds 里追加：React key 与顺序都跟 DOM 一致
    const row: Row = { ...base, kind: "rule", rule, set: setRule, remove: removeRule };
    out.push(row);

    if (rule.kind === "if") {
      rule.branches.forEach((branch, j) => {
        const bid = `${id}.branches[${j}]`;
        const bGuides = [...rowGuides, j < rule.branches.length - 1];
        const setBranch = (next: Branch) =>
          setRule({ ...rule, branches: rule.branches.map((b, k) => (k === j ? next : b)) });
        const removeBranch = () =>
          setRule({ ...rule, branches: rule.branches.filter((_, k) => k !== j) });
        // 「否则」（空条件）必须收尾：它最后一位，且别的分支不能拖到它后面
        const hasElse = (rule.branches[rule.branches.length - 1]?.assert ?? []).length === 0;
        const lastMovable = hasElse ? rule.branches.length - 2 : rule.branches.length - 1;
        const branchOrder =
          rule.branches.length > 1 && j <= lastMovable
            ? {
                group: `${id}|branches`,
                index: j,
                count: rule.branches.length,
                max: Math.max(0, lastMovable),
                reorder: (from: number, to: number) =>
                  setRule({
                    ...rule,
                    branches: moveItem(rule.branches, from, hasElse ? Math.min(to, lastMovable) : to),
                  }),
              }
            : undefined;
        const branchRow: Row = {
          id: bid,
          path: bid,
          depth: depth + 1,
          guides: bGuides,
          ancestorIds: ids,
          childIds: [],
          kind: "branch",
          branch,
          set: setBranch,
          remove: removeBranch,
          order: branchOrder,
        };
        row.childIds.push(bid);
        out.push(branchRow);
        flatten(
          branch.then ?? [],
          `${bid}.then`,
          depth + 2,
          bGuides,
          [...ids, bid],
          (nextThen) => setBranch({ ...branch, then: nextThen }),
          out,
        );
        branchRow.childIds.push(...descendantsOf(out, bid));
      });
      return;
    }

    rule.cases.forEach((arm, j) => {
      const cid = `${id}.cases[${j}]`;
      const cGuides = [...rowGuides, j < rule.cases.length - 1];
      const setArm = (next: CaseArm) =>
        setRule({ ...rule, cases: rule.cases.map((c, k) => (k === j ? next : c)) });
      const removeArm = () => setRule({ ...rule, cases: rule.cases.filter((_, k) => k !== j) });
      const caseOrder =
        rule.cases.length > 1
          ? {
              group: `${id}|cases`,
              index: j,
              count: rule.cases.length,
              max: rule.cases.length - 1,
              reorder: (from: number, to: number) => setRule({ ...rule, cases: moveItem(rule.cases, from, to) }),
            }
          : undefined;
      const caseRow: Row = {
        id: cid,
        path: cid,
        depth: depth + 1,
        guides: cGuides,
        ancestorIds: ids,
        childIds: [],
        kind: "case",
        arm,
        set: setArm,
        remove: removeArm,
        order: caseOrder,
      };
      row.childIds.push(cid);
      out.push(caseRow);
      flatten(
        arm.then ?? [],
        `${cid}.then`,
        depth + 2,
        cGuides,
        [...ids, cid],
        (nextThen) => setArm({ ...arm, then: nextThen }),
        out,
      );
      caseRow.childIds.push(...descendantsOf(out, cid));
    });

    const did = `${id}.default`;
    const dGuides = [...rowGuides];
    const defaultRow: Row = {
      id: did,
      path: did,
      depth: depth + 1,
      guides: dGuides,
      ancestorIds: ids,
      childIds: [],
      kind: "default",
      block: rule.default ?? [],
      set: (next) => setRule({ ...rule, default: next }),
    };
    row.childIds.push(did);
    out.push(defaultRow);
    flatten(
      rule.default ?? [],
      `${did}`,
      depth + 2,
      dGuides,
      [...ids, did],
      defaultRow.set,
      out,
    );
    defaultRow.childIds.push(...descendantsOf(out, did));
  });
}

/** 已经写进 out 的、以 prefix 开头的行 id（递归行只取直接追加的那一串） */
function descendantsOf(rows: Row[], prefix: string): string[] {
  return rows.filter((r) => r.id.startsWith(`${prefix}.`) || r.id.startsWith(`${prefix}[`)).map((r) => r.id);
}

/* ------------------------------ 显示辅助 ------------------------------ */

/** 取一个块最终会给出的结论，仅用于徽标着色；不参与任何判定 */
function tailOutcome(block: Rule[]): { verdict: Verdict | null; code: string } {
  const last = block[block.length - 1];
  if (!last) return { verdict: null, code: "" };
  if (last.kind === "outcome") return { verdict: last.verdict, code: last.code ?? "" };
  if (last.kind === "if") return tailOutcome(last.branches[last.branches.length - 1]?.then ?? []);
  return tailOutcome(last.default ?? []);
}

/** 把条件摊到三列：状态码 / 字段取值 / 其余（分组等） */
function assertCells(conds: Condition[], fallback: Scope) {
  let status = "";
  let field = "";
  const rest: string[] = [];
  for (const c of conds) {
    if (!isAssert(c)) {
      rest.push(conditionText([c], fallback));
      continue;
    }
    const text = conditionText([c], fallback);
    if ((c.scope ?? fallback) === "status") status = text;
    else if ((c.field ?? "").trim()) field = `${c.field} ${operatorMeta(c.op).label} ${fmtValue(c.value)}`;
    else rest.push(text);
  }
  return { status, field, rest: rest.join(" 并且 ") };
}

function rowCells(row: Row) {
  switch (row.kind) {
    case "rule": {
      if (row.rule.kind === "outcome") {
        return {
          tag: "outcome",
          tagTone: "out" as const,
          label: "结论 · 无条件给出",
          status: "—",
          field: "—",
          extra: "无条件",
          verdict: row.rule.verdict,
          code: row.rule.code ?? "",
        };
      }
      if (row.rule.kind === "if") {
        const first = row.rule.branches[0];
        const cells = first ? assertCells(first.assert ?? [], first.scope ?? "body") : null;
        const tail = tailOutcome(row.rule.branches[row.rule.branches.length - 1]?.then ?? []);
        return {
          tag: "if",
          tagTone: "if" as const,
          label: `if · ${ruleSummary(row.rule)}`,
          status: cells?.status || "—",
          field: cells?.field || "—",
          extra: `${row.rule.branches.length} 个分支 · ${blockOutcomeText(row.rule.branches[row.rule.branches.length - 1]?.then ?? [])}`,
          verdict: tail.verdict,
          code: tail.code,
        };
      }
      const tail = tailOutcome(row.rule.default ?? []);
      const scope = row.rule.scope ?? "body";
      return {
        tag: "switch",
        tagTone: "sw" as const,
        label: `switch · 按 ${scope === "status" ? "状态码" : `${scopeLabel(scope)} ${row.rule.on}`} 分流`,
        status: "—",
        field: scope === "status" ? "状态码" : row.rule.on || "（未填字段）",
        extra: `${row.rule.cases.length} 个 case · default ${blockOutcomeText(row.rule.default ?? [])}`,
        verdict: tail.verdict,
        code: tail.code,
      };
    }
    case "branch": {
      const isElse = (row.branch.assert ?? []).length === 0;
      const cells = assertCells(row.branch.assert ?? [], row.branch.scope ?? "body");
      const tail = tailOutcome(row.branch.then ?? []);
      return {
        tag: isElse ? "else" : "分支",
        tagTone: "plain" as const,
        label: `${branchLabel(row.branch, row.ancestorIds.length)} · ${isElse ? "其余所有情况" : conditionText(row.branch.assert ?? [], row.branch.scope ?? "body")}`,
        status: cells.status || "—",
        field: cells.field || "—",
        extra: cells.rest || blockOutcomeText(row.branch.then ?? []),
        verdict: tail.verdict,
        code: tail.code,
      };
    }
    case "case": {
      const tail = tailOutcome(row.arm.then ?? []);
      return {
        tag: "case",
        tagTone: "plain" as const,
        label: `case ${formatCaseValues(row.arm.values) || "（未填取值）"}`,
        status: "—",
        field: formatCaseValues(row.arm.values) || "—",
        extra: blockOutcomeText(row.arm.then ?? []),
        verdict: tail.verdict,
        code: tail.code,
      };
    }
    case "default": {
      const tail = tailOutcome(row.block);
      return {
        tag: "default",
        tagTone: "plain" as const,
        label: "default · 没有任何 case 命中时",
        status: "—",
        field: "其余取值",
        extra: blockOutcomeText(row.block),
        verdict: tail.verdict,
        code: tail.code,
      };
    }
  }
}

/** 条件列：把状态码 / 字段 / 附加条件摊成可换行的结构化 chip，避免多列把表挤扁 */
function ConditionCell({ status, field, extra }: { status: string; field: string; extra: string }) {
  const chips: Array<{ text: string; tone: "status" | "field" | "extra" }> = [];
  if (status && status !== "—") chips.push({ text: status, tone: "status" });
  if (field && field !== "—") chips.push({ text: field, tone: "field" });
  if (extra && extra !== "—" && extra !== "无条件") chips.push({ text: extra, tone: "extra" });
  if (chips.length === 0) return <span className="text-[10.5px] text-muted">无条件</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {chips.map((chip, i) => (
        <span
          key={i}
          title={chip.text}
          className={cn(
            "min-w-0 max-w-[190px] truncate rounded px-1 py-px font-mono text-[10px] leading-[15px]",
            chip.tone === "status" && "bg-info-soft text-info",
            chip.tone === "field" && "bg-sunken text-ink-soft",
            chip.tone === "extra" && "text-muted",
          )}
        >
          {chip.text}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------ 组件 ------------------------------ */

export function DecisionTable({
  rules,
  onChange,
  issues,
  findings,
  hitId,
  collapsed,
  onToggle,
  onExpandAll,
  onCollapseAll,
}: {
  rules: Rule[];
  onChange: (next: Rule[]) => void;
  issues: Map<string, SpecIssue[]>;
  findings: Finding[];
  hitId: string | null;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  /** 打开中「往这个块里加语句」行内插入条的行 id */
  const [menu, setMenu] = useState<string | null>(null);
  /** 正在被拖的行（只有同 group 的兄弟行能接住它） */
  const [drag, setDrag] = useState<{ id: string; group: string; index: number } | null>(null);
  /** 拖拽源同时存一份 ref：drop 处理必须同步拿到它，不能等 React 下一次渲染 */
  const dragRef = useRef<{ id: string; group: string; index: number } | null>(null);
  /** 拖拽悬停的落点：落在这行的上沿还是下沿 */
  const [drop, setDrop] = useState<{ id: string; edge: "before" | "after" } | null>(null);
  const rows = useMemo(() => {
    const out: Row[] = [];
    flatten(rules, "rules", 0, [], [], (next) => next, out);
    return out;
  }, [rules]);

  const endDrag = () => {
    dragRef.current = null;
    setDrag(null);
    setDrop(null);
  };

  /** 把被拖行落到目标行的前/后 */
  const commitDrop = (row: Row, edge: "before" | "after") => {
    const from = dragRef.current;
    if (!from || !row.order || row.order.group !== from.group) return endDrag();
    const insertAt = edge === "after" ? row.order.index + 1 : row.order.index;
    const to = Math.min(Math.max(dropIndex(from.index, insertAt), 0), row.order.max);
    if (to !== from.index) {
      onChange(row.order.reorder(from.index, to));
      // 下标会随重排整体变化，正在展开的编辑器/菜单没有意义了
      setEditing(null);
      setMenu(null);
    }
    endDrag();
  };

  const isUnderHit = (id: string) =>
    !!hitId && (id === hitId || id.startsWith(`${hitId}.`) || id.startsWith(`${hitId}[`));

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted">
          自上而下 · 首个命中即停 · <span className="font-medium text-accent">行序 = 优先级</span>
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onCollapseAll}
            className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10.5px] text-ink-soft transition-colors hover:border-accent/40 hover:text-accent"
          >
            全部收起
          </button>
          <button
            type="button"
            onClick={onExpandAll}
            className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10.5px] text-ink-soft transition-colors hover:border-accent/40 hover:text-accent"
          >
            全部展开
          </button>
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[710px] border-collapse text-[11.5px]">
          <thead>
            <tr className="bg-sunken/70 text-left text-[10.5px] text-muted">
              <th className="w-[190px] whitespace-nowrap px-2 py-1.5 font-medium">层级 · 语句 / 分支</th>
              <th className="px-2 py-1.5 font-medium">条件（状态码 / 字段 / 附加）</th>
              <th className="w-[76px] whitespace-nowrap px-2 py-1.5 font-medium">结论</th>
              <th className="w-[80px] whitespace-nowrap px-2 py-1.5 font-medium">分类码</th>
              <th className="w-[104px] whitespace-nowrap px-2 py-1.5 font-medium">操作</th>
            </tr>
          </thead>
          <tbody id="verdict-table-body">
            {rows.map((row) => {
              if (row.ancestorIds.some((id) => collapsed.has(id))) return null;
              const c = rowCells(row);
              const rowIssues = issuesUnder(issues, row.path);
              const rowFindings = findingsUnder(findings, row.path);
              const hasError = rowIssues.length > 0;
              const canFold = row.childIds.length > 0;
              const isFolded = collapsed.has(row.id);
              const isHit = row.id === hitId;
              const isAncestor = isUnderHit(row.id) && !isHit;
              const indent = Math.min(row.depth, 2);
              const order = row.order;
              const canDrag = !!order;
              const isDragging = drag?.id === row.id;
              const dropEdge = drop?.id === row.id ? drop.edge : null;
              const canNest = row.depth + 2 <= MAX_RULE_DEPTH;
              // 分支 / case / default 自己就是一个语句块，可以直接往里加语句
              const isBody = row.kind === "branch" || row.kind === "case" || row.kind === "default";
              const addTo = (rule: Rule) => {
                if (row.kind === "branch") onChange(row.set({ ...row.branch, then: appendStatement(row.branch.then ?? [], rule) }));
                else if (row.kind === "case") onChange(row.set({ ...row.arm, then: appendStatement(row.arm.then ?? [], rule) }));
                else if (row.kind === "default") onChange(row.set(appendStatement(row.block ?? [], rule)));
              };
              const addMenuId = `add:${row.id}`;
              const nestHint = canNest ? undefined : `已经到 ${MAX_RULE_DEPTH} 层上限，再深就读不懂了`;

              return (
                <Fragment key={row.id}>
                  <tr
                    id={`rule-anchor-${row.path}`}
                    className={cn(
                      "border-t border-line/70 transition-[background-color,opacity] duration-150",
                      row.depth === 1 && "bg-sunken/40",
                      row.depth >= 2 && "bg-sunken/80 text-muted",
                      hasError && "!bg-danger-soft",
                      isAncestor && "!bg-accent-soft/40",
                      isHit && "!bg-accent-soft",
                      hitId && !isUnderHit(row.id) && "opacity-45",
                      isDragging && "opacity-40",
                    )}
                    style={
                      dropEdge === "before"
                        ? { boxShadow: "inset 0 2px 0 var(--color-accent)" }
                        : dropEdge === "after"
                          ? { boxShadow: "inset 0 -2px 0 var(--color-accent)" }
                          : undefined
                    }
                    onDragOver={(e) => {
                      const from = dragRef.current;
                      // 不是同块 → 不 preventDefault，浏览器会自己画「不允许」光标
                      if (!from || !order || from.group !== order.group) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      const box = e.currentTarget.getBoundingClientRect();
                      const edge = e.clientY < box.top + box.height / 2 ? "before" : "after";
                      if (drop?.id !== row.id || drop.edge !== edge) setDrop({ id: row.id, edge });
                    }}
                    onDragLeave={() => setDrop((d) => (d?.id === row.id ? null : d))}
                    onDrop={(e) => {
                      const from = dragRef.current;
                      if (!from || !order || from.group !== order.group) return endDrag();
                      e.preventDefault();
                      const box = e.currentTarget.getBoundingClientRect();
                      commitDrop(row, e.clientY < box.top + box.height / 2 ? "before" : "after");
                    }}
                  >
                    <td className="relative whitespace-nowrap px-2 py-1.5" style={{ paddingLeft: 6 + indent * 16 + 30 }}>
                      {row.guides.slice(0, Math.min(row.guides.length, 4)).map((on, k) =>
                        on ? (
                          <i
                            key={k}
                            aria-hidden
                            className={cn("pointer-events-none absolute top-0 bottom-0 w-px", isUnderHit(row.id) ? "bg-accent/50" : "bg-line-strong")}
                            style={{ left: 27 + k * 16 }}
                          />
                        ) : null,
                      )}
                      {canDrag && (
                        <span
                          draggable
                          role="button"
                          tabIndex={-1}
                          aria-label={`拖动调整顺序：${c.label}`}
                          title={`按住拖动调整顺序（同块内共 ${order.count} 行，行序 = 优先级）`}
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", row.id);
                            const from = { id: row.id, group: order.group, index: order.index };
                            dragRef.current = from;
                            setDrag(from);
                            setMenu(null);
                            setEditing(null);
                          }}
                          onDragEnd={endDrag}
                          className="absolute left-0 top-1/2 z-[2] grid h-6 w-4 -translate-y-1/2 cursor-grab place-items-center rounded text-line-strong hover:text-accent active:cursor-grabbing"
                        >
                          <GripVertical className="size-3" />
                        </span>
                      )}
                      <span className="relative z-[1] inline-flex items-center gap-1">
                        {canFold ? (
                          <button
                            type="button"
                            aria-label={isFolded ? "展开子树" : "收起子树"}
                            aria-expanded={!isFolded}
                            onClick={() => onToggle(row.id)}
                            className="absolute top-1/2 grid size-3.5 -translate-y-1/2 place-items-center rounded border border-line-strong bg-surface text-muted hover:border-accent hover:text-accent"
                            style={{ left: indent * 16 + 18 }}
                          >
                            {isFolded ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                          </button>
                        ) : (
                          <i
                            aria-hidden
                            className={cn("absolute top-1/2 size-1 -translate-y-1/2 rounded-full", isHit ? "bg-accent" : "bg-line-strong")}
                            style={{ left: indent * 16 + 22 }}
                          />
                        )}
                        <span
                          className={cn(
                            "rounded border px-1 py-px font-mono text-[9.5px] leading-[14px]",
                            c.tagTone === "if" && "border-violet/30 bg-violet-soft text-violet",
                            c.tagTone === "sw" && "border-info/30 bg-info-soft text-info",
                            c.tagTone === "out" && "border-success/30 bg-success-soft text-success",
                            c.tagTone === "plain" && "border-line-strong bg-surface text-ink-soft",
                          )}
                        >
                          {c.tag}
                        </span>
                        {row.depth >= 3 && <span className="font-mono text-[9.5px] text-muted">L{row.depth + 1}</span>}
                        <span className="max-w-[150px] truncate text-ink-soft" title={rowCells(row).label}>
                          {c.label}
                        </span>
                        {rowFindings.length > 0 && (
                          <span
                            title={rowFindings.map((f) => f.message).join("\n")}
                            className="inline-flex items-center gap-0.5 rounded bg-warn-soft px-1 text-[10px] text-warn"
                          >
                            <AlertTriangle className="size-3" />
                            {rowFindings.length}
                          </span>
                        )}
                        {c.tag === "outcome" && row.kind === "rule" && !isTotalRule(row.rule) && (
                          <span className="text-[10px] text-warn">可能缺兜底</span>
                        )}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      <ConditionCell status={c.status} field={c.field} extra={c.extra} />
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      {c.verdict ? <VerdictBadge verdict={c.verdict} /> : <span className="text-line-strong">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[10.5px]" title={c.code}>
                      {c.code || <span className="text-line-strong">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <div className="flex items-center gap-0.5">
                        {isBody && (
                          <IconButton
                            label="在这个块里加一条语句"
                            aria-expanded={menu === addMenuId}
                            onClick={() => setMenu((v) => (v === addMenuId ? null : addMenuId))}
                          >
                            <Plus className="size-3.5" />
                          </IconButton>
                        )}
                        <IconButton
                          label={editing === row.id ? "完成编辑" : "编辑这一行"}
                          onClick={() => setEditing((v) => (v === row.id ? null : row.id))}
                        >
                          {editing === row.id ? <Check className="size-3.5 text-accent" /> : <Pencil className="size-3.5" />}
                        </IconButton>
                        {"remove" in row && (
                          <IconButton
                            tone="danger"
                            label="删除这一行"
                            onClick={() => {
                              onChange(row.remove());
                              setEditing(null);
                              setMenu(null);
                            }}
                          >
                            <Trash2 className="size-3.5" />
                          </IconButton>
                        )}
                      </div>
                    </td>
                  </tr>
                  {menu === addMenuId && isBody && (
                    <tr className="border-t border-accent/25 bg-accent-soft/40">
                      <td colSpan={5} className="px-3 py-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[10.5px] text-ink-soft">往这个块里加，插在兜底语句之前：</span>
                          <Button
                            size="xs"
                            variant="secondary"
                            onClick={() => {
                              addTo(newOutcomeRule());
                              setMenu(null);
                            }}
                          >
                            结论
                          </Button>
                          <Button
                            size="xs"
                            variant="secondary"
                            disabled={!canNest}
                            title={nestHint}
                            onClick={() => {
                              addTo(newIfRule());
                              setMenu(null);
                            }}
                          >
                            如果 if
                          </Button>
                          <Button
                            size="xs"
                            variant="secondary"
                            disabled={!canNest}
                            title={nestHint}
                            onClick={() => {
                              addTo(newSwitchRule());
                              setMenu(null);
                            }}
                          >
                            分流 switch
                          </Button>
                          {!canNest && <span className="text-[10px] text-muted">已到 {MAX_RULE_DEPTH} 层上限，只能加结论</span>}
                          <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setMenu(null)}>
                            取消
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )}
                  {hasError && (
                    <tr>
                      <td colSpan={5} className="bg-danger-soft/60 px-2 py-1">
                        {rowIssues.map((issue, k) => (
                          <p key={k} className="text-[10.5px] leading-snug text-danger">
                            {issue.message}
                          </p>
                        ))}
                      </td>
                    </tr>
                  )}
                  {editing === row.id && (
                    <tr className="border-t border-line-strong bg-surface">
                      <td colSpan={5} className="px-3 py-2">
                        <RowEditor
                          row={row}
                          onChange={onChange}
                          canNest={row.depth + 2 <= MAX_RULE_DEPTH}
                          onDone={() => setEditing(null)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-[11.5px] text-muted">
                  还没有判定语句。空的判定段 = 所有响应都落到 UNCLASSIFIED 致命。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[10.5px] leading-snug text-muted">
        行首手柄可拖动调整顺序（只在同一个块内换位，行序 = 优先级）；「＋」往分支体 / case / default
        里加语句，会插在块末尾的兜底语句之前，所以不会变成永远轮不到的死配置。折叠只影响显示，不改判定。
      </p>
    </div>
  );
}

/** 父行的最后一条是否「必然给出结论」，仅用于界面提示 */
function isTotalRule(rule: Rule): boolean {
  if (rule.kind === "outcome") return true;
  if (rule.kind === "if") return (rule.branches[rule.branches.length - 1]?.assert ?? []).length === 0;
  return (rule.default ?? []).length > 0;
}

/* ------------------------------ 行内编辑 ------------------------------ */

function RowEditor({
  row,
  onChange,
  canNest,
  onDone,
}: {
  row: Row;
  onChange: (next: Rule[]) => void;
  canNest: boolean;
  onDone: () => void;
}) {
  const nestHint = canNest ? undefined : `已经到 ${MAX_RULE_DEPTH} 层上限，再深就读不懂了`;
  if (row.kind === "rule" && row.rule.kind === "outcome") {
    const rule = row.rule;
    return (
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <span className="mb-1 block text-[10.5px] text-muted">结论</span>
          <div className="flex gap-1">
            {VERDICTS.map((v) => (
              <button
                key={v.value}
                type="button"
                title={v.note}
                onClick={() => onChange(row.set({ ...rule, verdict: v.value }))}
                className={cn(
                  "h-7 rounded-md border px-2 text-[11px] transition-colors",
                  rule.verdict === v.value
                    ? v.tone === "success"
                      ? "border-success/30 bg-success-soft text-success"
                      : v.tone === "danger"
                        ? "border-danger/30 bg-danger-soft text-danger"
                        : v.tone === "warn"
                          ? "border-warn/30 bg-warn-soft text-warn"
                          : "border-line-strong bg-sunken text-ink-soft"
                    : "border-line bg-surface text-ink-soft hover:bg-sunken",
                )}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
        <div className="min-w-[220px] flex-1">
          <span className="mb-1 block text-[10.5px] text-muted">分类码 · 会进死信，也是能否改报文重投的依据</span>
          <Input
            value={rule.code ?? ""}
            spellCheck={false}
            className="h-8 font-mono text-[11.5px]"
            onChange={(e) => onChange(row.set({ ...rule, code: e.target.value }))}
          />
        </div>
        <Button size="xs" variant="secondary" onClick={onDone}>
          完成
        </Button>
      </div>
    );
  }

  if (row.kind === "rule" && row.rule.kind === "if") {
    const rule = row.rule;
    const hasElse = (rule.branches[rule.branches.length - 1]?.assert ?? []).length === 0;
    return (
      <div className="space-y-2">
        <p className="text-[10.5px] text-muted">if 的分支顺序就是命中顺序；「否则」只能在最后。</p>
        <div className="flex flex-wrap gap-1">
          <Button
            size="xs"
            variant="secondary"
            onClick={() => {
              const at = hasElse ? rule.branches.length - 1 : rule.branches.length;
              onChange(row.set({ ...rule, branches: [...rule.branches.slice(0, at), newBranch(), ...rule.branches.slice(at)] }));
            }}
          >
            + 否则如果
          </Button>
          {!hasElse && (
            <Button size="xs" variant="secondary" onClick={() => onChange(row.set({ ...rule, branches: [...rule.branches, { then: [newFallbackRule()] }] }))}>
              + 否则
            </Button>
          )}
        </div>
        {/* 分支体的入口集中在这里：不然「怎么嵌一层」只能靠点分支行的铅笔才发现 */}
        <div className="space-y-1 rounded-md border border-line bg-sunken/50 px-2 py-1.5">
          <p className="text-[10px] font-medium text-muted">分支体 · 也能往里放语句（放在该分支的兜底结论之前）</p>
          {rule.branches.map((b, j) => {
            const conds = b.assert ?? [];
            const nestInto = (next: Rule) =>
              onChange(
                row.set({
                  ...rule,
                  branches: rule.branches.map((x, k) => (k === j ? { ...x, then: appendStatement(x.then ?? [], next) } : x)),
                }),
              );
            return (
              <div key={j} className="flex flex-wrap items-center gap-1.5">
                <span className="w-3 shrink-0 text-right font-mono text-[10px] text-muted">{j + 1}</span>
                <span
                  className="max-w-[240px] truncate text-[10.5px] text-ink-soft"
                  title={conds.length === 0 ? "否则" : conditionText(conds, b.scope ?? "body")}
                >
                  {conds.length === 0 ? "否则 · 其余所有情况" : `${branchLabel(b, j)} ${conditionText(conds, b.scope ?? "body")}`}
                </span>
                <span className="shrink-0 text-[10px] text-muted">→ {blockOutcomeText(b.then ?? [])}</span>
                <span className="ml-auto flex shrink-0 items-center gap-0.5">
                  <Button size="xs" variant="ghost" onClick={() => nestInto(newOutcomeRule())}>
                    + 结论
                  </Button>
                  <Button size="xs" variant="ghost" disabled={!canNest} title={nestHint} onClick={() => nestInto(newIfRule())}>
                    + if
                  </Button>
                  <Button size="xs" variant="ghost" disabled={!canNest} title={nestHint} onClick={() => nestInto(newSwitchRule())}>
                    + switch
                  </Button>
                </span>
              </div>
            );
          })}
          {!canNest && <p className="text-[10px] text-muted">已经到 {MAX_RULE_DEPTH} 层上限，分支体里只能加结论。</p>}
        </div>
      </div>
    );
  }

  if (row.kind === "rule" && row.rule.kind === "switch") {
    const rule = row.rule;
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10.5px] text-muted">按</span>
          <Select
            value={rule.scope ?? "body"}
            aria-label="判别字段作用域"
            className="h-8 w-[104px] text-[11px]"
            onChange={(e) => onChange(row.set({ ...rule, scope: e.target.value as Scope }))}
          >
            {SCOPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
          {(rule.scope ?? "body") !== "status" && (
            <Input
              value={rule.on}
              placeholder="$.code"
              spellCheck={false}
              aria-label="判别字段"
              className="h-8 w-[200px] font-mono text-[11.5px]"
              onChange={(e) => onChange(row.set({ ...rule, on: e.target.value }))}
            />
          )}
          <span className="text-[10.5px] text-muted">的取值分流</span>
        </div>
        <Button size="xs" variant="secondary" onClick={() => onChange(row.set({ ...rule, cases: [...rule.cases, newCaseArm()] }))}>
          + 加一个 case
        </Button>
      </div>
    );
  }

  if (row.kind === "branch") {
    const branch = row.branch;
    const isElse = (branch.assert ?? []).length === 0;
    return (
      <div className="space-y-2">
        {!isElse ? (
          <AssertEditor
            conditions={branch.assert ?? []}
            onChange={(assert) => onChange(row.set({ ...branch, assert }))}
            pathPrefix={`${row.path}.assert`}
            issues={undefined}
            defaultScope={branch.scope ?? "body"}
            showScope
          />
        ) : (
          <p className="text-[11px] text-muted">最后一个分支省条件 = 否则：上面都没命中时走这里。</p>
        )}
        {canNest && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10.5px] text-muted">往这个分支体里加：</span>
            <Button size="xs" variant="ghost" onClick={() => onChange(row.set({ ...branch, then: appendStatement(branch.then ?? [], newIfRule()) }))}>
              + 嵌入 if
            </Button>
            <Button size="xs" variant="ghost" onClick={() => onChange(row.set({ ...branch, then: appendStatement(branch.then ?? [], newSwitchRule()) }))}>
              + 嵌入 switch
            </Button>
            <Button size="xs" variant="ghost" onClick={() => onChange(row.set({ ...branch, then: appendStatement(branch.then ?? [], newOutcomeRule()) }))}>
              + 结论
            </Button>
            <span className="self-center text-[10px] text-muted">插在兜底结论之前</span>
          </div>
        )}
        {!canNest && <p className="text-[10.5px] text-muted">已经到 {MAX_RULE_DEPTH} 层上限，这里只能加结论。</p>}
      </div>
    );
  }

  if (row.kind === "case") {
    const arm = row.arm;
    return (
      <div className="space-y-2">
        <p className="text-[10.5px] text-muted">
          取值按逗号分隔：<code className="font-mono">200</code> 是数字、<code className="font-mono">&quot;200&quot;</code> 是字符串，两者匹配不上。
        </p>
        <div className="flex items-center gap-2">
          <CaseValuesInput
            key={formatCaseValues(arm.values)}
            values={arm.values}
            onChange={(values) => onChange(row.set({ ...arm, values }))}
          />
          {canNest && (
            <Button size="xs" variant="ghost" onClick={() => onChange(row.set({ ...arm, then: appendStatement(arm.then ?? [], newOutcomeRule()) }))}>
              + 结论
            </Button>
          )}
          {canNest && (
            <Button size="xs" variant="ghost" onClick={() => onChange(row.set({ ...arm, then: appendStatement(arm.then ?? [], newIfRule()) }))}>
              + 嵌入 if
            </Button>
          )}
        </div>
      </div>
    );
  }

  // default：switch 必须有，只能改它的语句块
  if (row.kind === "default") {
    return (
      <div className="space-y-2">
        <p className="text-[10.5px] text-muted">没有任何 case 命中时走这里；switch 必须有 default。</p>
        <div className="flex flex-wrap gap-1">
          <Button size="xs" variant="ghost" onClick={() => onChange(row.set(appendStatement(row.block ?? [], newOutcomeRule())))}>
            + 结论
          </Button>
          {canNest && (
            <Button size="xs" variant="ghost" onClick={() => onChange(row.set(appendStatement(row.block ?? [], newIfRule())))}>
              + 嵌入 if
            </Button>
          )}
        </div>
      </div>
    );
  }
  return null;
}
