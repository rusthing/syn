/**
 * 任务编辑窗体左侧的六段轨道（变体 1「极简轨道」）。
 *
 * 一次只显示一段的内容在右侧，左侧是常驻的步骤索引：竖线串起六个圈号，
 * 图标一律靠右。选中态整块铺淡琥珀底，圈号 / 段名 / 概要 / 图标统一取同一个
 * 琥珀色 —— 整块只有一个色相，不会和右侧表单里的各种状态色打架。
 * 未选中的图标已经是彩色的（只是略降不透明度），选中是「变实」而不是「换色」。
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { TaskSpec } from "@/lib/api/types";
import { stagesFor, stageFilled, stageSummary, type StageDef, type TaskTab } from "./task-stages";

const ICONS: Record<TaskTab, { paths: string[]; cap?: boolean; join?: boolean }> = {
  // 漏斗：从一堆记录里筛出归本任务管的
  match: { paths: ["M2 3h12l-4.5 5v4l-3 1.5V8z"], join: true },
  mapping: { paths: ["M2 5h10M10 3l2 2-2 2M14 11H4M4 9l-2 2 2 2"], cap: true, join: true },
  guards: { paths: ["M8 2l5 2v4c0 3-2 5-5 6-3-1-5-3-5-6V4z", "M6 8l1.5 1.5L10 7"], cap: true, join: true },
  actions: { paths: ["M9 1.5 4 9h4l-1 5.5L12 7H8z"], join: true },
  target: { paths: ["M2 7.5 14 3l-4 10-2.5-4z", "M7.5 9 14 3"], cap: true, join: true },
  outcomes: { paths: ["M8 2v5m0 0-4 4m4-4 4 4"], cap: true },
  json: {
    paths: [
      "M6 2c-2 0-2 2-2 3s0 2-2 2c2 0 2 1 2 2s0 3 2 3M10 2c2 0 2 2 2 3s0 2 2 2c-2 0-2 1-2 2s0 3-2 3",
    ],
    cap: true,
  },
};

function StageIcon({ stage }: { stage: TaskTab }): ReactNode {
  const { paths, cap, join } = ICONS[stage];
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap={cap ? "round" : undefined}
      strokeLinejoin={join ? "round" : undefined}
      aria-hidden
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

function StageRow({
  def,
  active,
  summary,
  issues,
  onSelect,
}: {
  def: StageDef;
  active: boolean;
  summary: string;
  issues: number;
  onSelect: (key: TaskTab) => void;
}): ReactNode {
  const json = def.key === "json";
  return (
    <button
      type="button"
      onClick={() => onSelect(def.key)}
      aria-current={active ? "step" : undefined}
      aria-label={`${def.label}，${summary}${issues > 0 ? `，${issues} 处待修` : ""}`}
      className={cn(
        "relative flex min-h-12 w-full items-center gap-2 rounded-md py-1 pl-0.5 pr-2 text-left transition-colors",
        active ? "bg-stage-soft" : "hover:bg-ink/[0.045]",
      )}
    >
      {/* 选中行的竖条落在轨道左边缘，与圈号同色 */}
      <span
        className={cn(
          "absolute -left-2 bottom-1.5 top-1.5 w-[3px] rounded-sm bg-stage",
          !active && "hidden",
        )}
        aria-hidden
      />
      <span
        className={cn(
          "relative z-[1] flex size-5 shrink-0 items-center justify-center rounded-full border bg-surface font-mono text-[11px]",
          active
            ? "border-[1.5px] border-stage font-medium text-stage"
            : "border-line-strong text-muted",
          json && "invisible",
        )}
        aria-hidden
      >
        {def.stage}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate",
            json ? "text-[12px]" : "text-[13px]",
            active ? "font-medium text-stage" : "text-ink",
          )}
        >
          {def.label}
        </span>
        <span className={cn("block truncate text-[11px]", active ? "text-stage/80" : "text-muted")}>
          {summary}
        </span>
      </span>
      {issues > 0 && (
        <span
          className="flex size-4 shrink-0 items-center justify-center rounded-full bg-danger text-[9.5px] font-semibold text-on-danger"
          title={`${issues} 处待修`}
        >
          {issues}
        </span>
      )}
      <span
        className={cn(
          "flex shrink-0 items-center justify-center text-stage",
          active ? "opacity-100" : "opacity-[.85]",
        )}
      >
        <StageIcon stage={def.key} />
      </span>
    </button>
  );
}

export function TaskStageRail({
  tab,
  spec,
  issueCount,
  onSelect,
}: {
  tab: TaskTab;
  spec: TaskSpec;
  /** 每段的结构校验问题数，> 0 时在行尾标红点计数 */
  issueCount: (key: TaskTab) => number;
  onSelect: (key: TaskTab) => void;
}): ReactNode {
  // db 直写没有动作段：段列表与圈号都由 `stagesFor` 算，不要在这里判断 kind
  const stages = stagesFor(spec);
  const steps = stages.filter((s) => s.key !== "json");
  const json = stages.find((s) => s.key === "json")!;
  const filled = steps.filter((s) => stageFilled(spec, s.key)).length;

  return (
    <aside className="border-r border-line bg-sunken" aria-label="配置步骤">
      {/*
        内层 sticky 而外层拉伸：右侧内容变长时整列都还有底色，滚到下面步骤仍看得见。
        外层不能自己 sticky —— 它一旦和表格一样高就贴不住了。
      */}
      <div className="sticky top-0 flex min-h-[380px] flex-col px-2 pb-2.5 pt-3">
        <div className="flex items-center justify-between px-1 pb-2 text-[11px] text-muted">
          <span>{steps.length} 段配置</span>
          <span className="tnum">{filled} 已填</span>
        </div>
        <div className="relative">
          <span
            className="pointer-events-none absolute bottom-3.5 left-3 top-3.5 w-px bg-line"
            aria-hidden
          />
          {steps.map((def) => (
            <StageRow
              key={def.key}
              def={def}
              active={tab === def.key}
              summary={stageSummary(spec, def.key)}
              issues={issueCount(def.key)}
              onSelect={onSelect}
            />
          ))}
        </div>
        <div className="mt-auto border-t border-line pt-1">
          <StageRow
            def={json}
            active={tab === json.key}
            summary={stageSummary(spec, json.key)}
            issues={0}
            onSelect={onSelect}
          />
        </div>
      </div>
    </aside>
  );
}
