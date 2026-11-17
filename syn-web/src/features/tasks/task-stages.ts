/**
 * 任务编辑窗体的六段元数据。
 *
 * 顺序就是配置顺序：匹配 → 映射 → 校验 → 投递 → 动作 → 判定。
 * 投递排在动作之前，因为动作的形状依附于出口：`action.path` 相对 `target.base`，
 * 而 `kind=db` 时动作段根本不存在（op 由记录自带，写库形状看 `on_conflict`）。
 * 判定排在最后，因为它看的就是投递的响应。控制面板卡片、属性栏、画布段落
 * 都引用同一组 key（`TaskStage` / `TaskTab`），改顺序时三处必须一起看。
 *
 * 这里只放纯逻辑（顺序、概要、问题归段），方便单测；渲染在 `TaskStageRail`。
 */
import type { TaskSpec } from "@/lib/api/types";
import { countRules, verdictRules } from "@/lib/spec/rules";

/** 控制面板点卡片上的某一段时，按这个值直接打开对应段；`json` 是额外的高级入口 */
export type TaskTab =
  | "match"
  | "mapping"
  | "actions"
  | "guards"
  | "outcomes"
  | "target"
  | "json";

export interface StageDef {
  key: TaskTab;
  label: string;
  /** 轨道上的圈号；JSON 段没有圈号，db 任务的「动作」也不占号 */
  stage: string;
}

export const STAGES: StageDef[] = [
  { key: "match", label: "匹配", stage: "1" },
  { key: "mapping", label: "映射", stage: "2" },
  { key: "guards", label: "校验", stage: "3" },
  // 先定出口，再定形状：路径前缀与「有没有动作段」都由投递段决定
  { key: "target", label: "投递", stage: "4" },
  { key: "actions", label: "动作", stage: "5" },
  // 判定在最后：它看的就是投递的响应，先有投递才有结论
  { key: "outcomes", label: "判定", stage: "6" },
  { key: "json", label: "JSON", stage: "—" },
];

/**
 * 这份 spec 实际要显示的段。
 *
 * db 直写没有动作段 —— 执行器不读 actions，保存期也要求它为空（后端校验同一口径），
 * 所以轨道与页签都不该出现它；圈号顺延，不能留一个空缺号。
 */
export function stagesFor(spec: TaskSpec): StageDef[] {
  const db = spec.target.kind === "db";
  const live = STAGES.filter((s) => !(db && s.key === "actions"));
  return live.map((s, i) =>
    s.stage === "—" ? s : { ...s, stage: String(i + 1) },
  );
}

/** 当前 spec 下，这一段到底存不存在（供页签渲染与 `tabOfPath` 兜底用） */
export function stageExists(spec: TaskSpec, key: TaskTab): boolean {
  return stagesFor(spec).some((s) => s.key === key);
}

/** 问题路径 → 归属的段：保存失败时要能把人直接送到出错的那一段 */
export function tabOfPath(path: string): TaskTab {
  if (path.startsWith("mapping")) return "mapping";
  if (path.startsWith("match")) return "match";
  if (path.startsWith("actions")) return "actions";
  if (path.startsWith("guards")) return "guards";
  if (path.startsWith("outcomes")) return "outcomes";
  if (path.startsWith("rules")) return "outcomes";
  if (path.startsWith("target")) return "target";
  // id / topic 在顶部身份证区直接标红，其余未知路径落到第一段
  return "match";
}

/**
 * 轨道上每段下面的一行概要。只写「条数 / 名字」这类一眼能核对的信息，
 * 完整内容仍在右侧改 —— 左侧塞下整份条件会变成第二份编辑器。
 */
export function stageSummary(spec: TaskSpec, key: TaskTab): string {
  switch (key) {
    case "match": {
      const n = spec.match?.length ?? 0;
      return n === 0 ? "全收 · 无条件" : `${n} 条条件`;
    }
    case "mapping": {
      const rows = spec.mapping?.rows ?? [];
      const keepNull = rows.filter((row) => row.on_null === "keep").length;
      const fallback = rows.filter((row) => row.on_null === "fallback").length;
      const parts: string[] = [];
      if (keepNull > 0) parts.push(`${keepNull} 行 null 保留`);
      if (fallback > 0) parts.push(`${fallback} 行兜底默认值`);
      return `${rows.length} 行 · ${parts.length > 0 ? parts.join("，") : "null 省略"}`;
    }
    case "guards":
      return `${spec.guards?.length ?? 0} 条守卫`;
    case "actions": {
      const ops = (spec.actions ?? []).map((a) => a.op);
      return ops.length > 0 ? `${ops.join(" / ")} 已配` : "未配置动作";
    }
    case "target":
      return spec.target.kind === "db"
        ? `db · ${spec.target.datasource?.trim() || "未选数据源"}`
        : `http · ${spec.target.service?.trim() || "未填服务名"}`;
    case "outcomes": {
      const n = countRules(verdictRules(spec));
      return n === 0 ? "未配置判定" : `${n} 条语句`;
    }
    case "json":
      return "整份 spec 原文";
  }
}

/**
 * 「已填」只用于轨道顶部那个进度数字，不参与校验：
 * 匹配留空是合法的「全收」、守卫留空也是合法的「不设闸」，不能当成错误。
 */
export function stageFilled(spec: TaskSpec, key: TaskTab): boolean {
  switch (key) {
    case "match":
      return (spec.match?.length ?? 0) > 0;
    case "mapping":
      return (spec.mapping?.rows?.length ?? 0) > 0;
    case "guards":
      return (spec.guards?.length ?? 0) > 0;
    case "actions":
      return (spec.actions?.length ?? 0) > 0;
    case "target":
      return spec.target.kind === "db"
        ? Boolean(spec.target.datasource?.trim() && spec.target.table?.trim())
        : Boolean(spec.target.service?.trim() && spec.target.base?.trim());
    case "outcomes":
      // 判定段两套形状：新任务与升级过的任务写 rules，老任务仍是扁平 outcomes
      return countRules(verdictRules(spec)) > 0;
    case "json":
      return false;
  }
}
