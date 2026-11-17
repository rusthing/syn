/**
 * 判定表里对「语句块」做插入与重排的纯操作。
 *
 * 单独成文件是因为：往块里加语句**不能直接 push 到末尾**。每个块的最后一条
 * 必须是「必然给出结论」的语句（结论 / 带否则的 if / 带 default 的 switch），
 * 而判定是「自上而下、首个命中即停」—— 追加在它后面的语句永远轮不到。
 * 这条约束在 analyze.ts 里被报成 `unreachable`，所以插入点必须自己算对。
 */
import type { Rule } from "@/lib/api/types";
import { blockConcludes } from "@/lib/spec/rules";

/**
 * # 在语句块末尾追加一条语句
 *
 * ## 参数
 * - `block` 目标语句块（不会被修改）
 * - `rule` 要插入的语句
 *
 * ## 返回值
 * 新的语句块。若原块末尾已经是「必然给出结论」的语句，新语句插在**它之前**，
 * 保证既能让新语句生效、又保住块末尾的兜底。
 *
 * ## 示例
 * ```ts
 * appendStatement([ifRule, fallback], newIfRule()) // => [ifRule, newIfRule(), fallback]
 * appendStatement([], newIfRule())                 // => [newIfRule()]
 * ```
 */
export function appendStatement(block: Rule[], rule: Rule): Rule[] {
  if (!blockConcludes(block)) return [...block, rule];
  const last = block[block.length - 1];
  return [...block.slice(0, -1), rule, last];
}

/**
 * # 把 from 位置的元素挪到 to 位置
 *
 * `to` 是**移除来源元素之后**的落点下标（`dropIndex` 负责从拖拽意图换算）。
 */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= arr.length) return arr;
  const next = [...arr];
  const [item] = next.splice(from, 1);
  const at = Math.max(0, Math.min(to, next.length));
  next.splice(at, 0, item);
  return next;
}

/**
 * # 拖拽落点换算
 *
 * `insertAt` 是「插到原数组的第几个位置之前」，返回值可直接喂给 `moveItem`。
 * 向下拖时来源被移除会让后续下标前移一位，所以要减 1。
 */
export function dropIndex(from: number, insertAt: number): number {
  return insertAt > from ? insertAt - 1 : insertAt;
}
