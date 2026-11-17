/**
 * 任务编辑窗体的六段元数据。
 *
 * 顺序就是执行顺序：匹配 → 映射 → 校验 → 动作 → 投递 → 判定。
 * 判定放在投递之后，因为它看的就是投递的响应；控制面板卡片、属性栏、画布段落
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
  /** 轨道上的圈号；JSON 段没有圈号 */
  stage: string;
}

export const STAGES: StageDef[] = [
  { key: "match", label: "匹配", stage: "1" },
  { key: "mapping", label: "映射", stage: "2" },
  { key: "guards", label: "校验", stage: "3" },
  { key: "actions", label: "动作", stage: "4" },
  // 投递在判定之前：判定段看的就是投递的响应，先有投递才有结论
  { key: "target", label: "投递", stage: "5" },
  { key: "outcomes", label: "判定", stage: "6" },
  { key: "json", label: "JSON", stage: "—" },
];

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
      return `${rows.length} 行 · ${keepNull > 0 ? `${keepNull} 行 null 保留` : "null 省略"}`;
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
