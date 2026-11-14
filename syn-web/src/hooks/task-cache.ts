/**
 * # 任务缓存的启停补丁（纯函数，便于单测）
 *
 * 从 `useTaskMutations` 里拆出来，是因为这段逻辑既要「一次命中所有筛选条件下的
 * 分页数据」，又要能被单独断言：形状漂移不报错，只会安静地显示错开关状态。
 *
 * 三条约定：
 *
 * 1. **`spec.enabled` 必须一起改**。后端 `set_enabled` 同时写列和 `spec.enabled`，
 *    而保存任务的 `build_model` 又是从 `spec` 反推列的。只改 `t.enabled` 的话，
 *    用户随后编辑并保存一次任务，就会拿旧 spec 把刚打开的开关悄悄关回去 ——
 *    实时模式才复现、演示模式（`mock.toggle` 两边都写）看不出来，非常隐蔽。
 * 2. **乐观补丁必须同步落地，且取消之后再补一次**。`onMutate` 里先
 *    `await cancelQueries` 再改缓存，会多出一个微任务；更隐蔽的是 v5 的
 *    `cancelQueries` 默认 `revert: true`，会把在途 fetch 开始时的旧 state 恢复回来，
 *    正好抹掉刚写进去的乐观值 —— 界面表现就是「翻一下又弹回去」。
 * 3. **只有最后一次点击能收尾**。连点时旧请求的响应不能把新值盖回去，所以
 *    每个任务带一个自增序号，回滚/落地前都先过 `isLatestToggle`。
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { Page, SyncTask } from "@/lib/api/types";

/** 分页缓存的固定前缀：乐观更新要靠它一次命中所有筛选条件下的分页数据 */
export const PAGE_PREFIX = ["tasks", "page"] as const;
const LIST_KEY = ["tasks", "list"] as const;
const DETAIL_PREFIX = ["tasks", "detail"] as const;
const ALL_KEY = ["tasks"] as const;

export type CacheSnapshot = Array<[QueryKey, unknown]>;

export function snapshotTaskCaches(client: QueryClient): CacheSnapshot {
  return client.getQueriesData({ queryKey: ALL_KEY });
}

export function restoreTaskCaches(client: QueryClient, snapshot: CacheSnapshot) {
  for (const [key, data] of snapshot) client.setQueryData(key, data);
}

export function patchTaskEnabled(client: QueryClient, id: string, enabled: boolean) {
  const patch = (task: SyncTask): SyncTask =>
    task.id === id ? { ...task, enabled, spec: { ...task.spec, enabled } } : task;

  client.setQueriesData<SyncTask[]>({ queryKey: LIST_KEY }, (rows) => rows?.map(patch));
  client.setQueriesData<Page<SyncTask>>({ queryKey: PAGE_PREFIX }, (page) =>
    page ? { ...page, list: page.list.map(patch) } : page,
  );
  client.setQueriesData<SyncTask>({ queryKey: DETAIL_PREFIX }, (task) =>
    task ? patch(task) : task,
  );
}

/* ------------------------------ 连点序号 ------------------------------ */

const seqByTask = new Map<string, number>();

/** 每次点击取一个新序号；同一任务的旧请求在收尾时会被 `isLatestToggle` 挡掉 */
export function nextToggleSeq(id: string): number {
  const seq = (seqByTask.get(id) ?? 0) + 1;
  seqByTask.set(id, seq);
  return seq;
}

export function isLatestToggle(id: string, seq: number): boolean {
  return seqByTask.get(id) === seq;
}

export function forgetToggleSeq(id: string, seq: number) {
  if (isLatestToggle(id, seq)) seqByTask.delete(id);
}
