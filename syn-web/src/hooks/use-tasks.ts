import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tasks, type Page, type SyncTask, type TaskQuery, type TaskToggleResult } from "@/lib/api";
import {
  PAGE_PREFIX,
  forgetToggleSeq,
  isLatestToggle,
  nextToggleSeq,
  patchTaskEnabled,
  restoreTaskCaches,
  snapshotTaskCaches,
  type CacheSnapshot,
} from "./task-cache";

export const taskKeys = {
  all: ["tasks"] as const,
  page: (query: TaskQuery) => [...PAGE_PREFIX, query] as const,
  list: () => ["tasks", "list"] as const,
  detail: (id: string) => ["tasks", "detail", id] as const,
};

export function useTasksPage(query: TaskQuery) {
  return useQuery<Page<SyncTask>>({
    queryKey: taskKeys.page(query),
    queryFn: () => tasks.page(query),
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });
}

/** 试跑页要按 topic 列出候选任务，直接拿全量：一个部署里任务通常不到一百个 */
export function useAllTasks() {
  return useQuery<SyncTask[]>({
    queryKey: taskKeys.list(),
    queryFn: () => tasks.list(),
    staleTime: 5_000,
  });
}

interface ToggleContext {
  snapshot: CacheSnapshot;
  id: string;
  seq: number;
}

export function useTaskMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: taskKeys.all });

  /**
   * 启停是「点了就该立刻看到」的开关。
   *
   * 之前这里有三处会让开关看起来点不动／弹回去：
   * - `onMutate` 先 `await cancelQueries` 才改缓存，慢一拍；且 cancel 默认 revert，
   *    会把在途 fetch 开始时的旧值恢复回来，正好抹掉乐观值；
   * - `onSuccess` 立刻 `invalidate()` 触发 refetch，在途的旧 list 响应把值盖回去；
   * - 只补 `enabled` 不补 `spec.enabled`，随后编辑保存任务时用旧 spec 反推列，
   *   把刚打开的开关又关掉（实时模式才有，演示模式 `mock.toggle` 两边都写）。
   *
   * 现在：同步落地乐观值（含 spec）→ 请求 → 只有最后一次点击能用服务端值收尾，
   * 并只把缓存标脏、不立刻重拉。具体规则见 `task-cache.ts`。
   */
  const toggle = useMutation<TaskToggleResult, Error, TaskToggleResult, ToggleContext>({
    mutationFn: ({ id, enabled }) => tasks.toggle(id, enabled),
    onMutate: async ({ id, enabled }) => {
      const snapshot = snapshotTaskCaches(queryClient);
      const seq = nextToggleSeq(id);
      // 1) 同步落地乐观值：点击当场就能看到，不等任何 await
      patchTaskEnabled(queryClient, id, enabled);
      // 2) 取消在途 refetch。cancelQueries 默认 `revert: true`，会把 query state 恢复到
      //    那次 fetch 开始时的旧值 —— 正好可能把刚写进去的乐观值抹掉，所以取消后
      //    无条件再补一次。界面不等这个 await，请求晚一个微任务发出无感。
      await queryClient.cancelQueries({ queryKey: taskKeys.all });
      if (isLatestToggle(id, seq)) patchTaskEnabled(queryClient, id, enabled);
      return { snapshot, id, seq };
    },
    onError: (_error, { id }, context) => {
      if (!context || !isLatestToggle(id, context.seq)) return;
      restoreTaskCaches(queryClient, context.snapshot);
    },
    onSuccess: (server, { id, enabled }, context) => {
      if (!context || !isLatestToggle(id, context.seq)) return;
      // 服务端值优先；响应形状不完整时退回本次请求值（乐观值已经是它）
      patchTaskEnabled(queryClient, id, typeof server?.enabled === "boolean" ? server.enabled : enabled);
      void queryClient.invalidateQueries({ queryKey: taskKeys.all, refetchType: "none" });
    },
    onSettled: (_data, _error, { id }, context) => {
      if (context) forgetToggleSeq(id, context.seq);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => tasks.remove(id),
    onSuccess: () => void invalidate(),
  });

  const save = useMutation({
    mutationFn: (input: { id?: string; name: string; spec: SyncTask["spec"] }) =>
      input.id ? tasks.update(input.id, { name: input.name, spec: input.spec }) : tasks.create({ name: input.name, spec: input.spec }),
    onSuccess: () => void invalidate(),
  });

  return { toggle, remove, save };
}
