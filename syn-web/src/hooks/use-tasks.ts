import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tasks, type Page, type SyncTask, type TaskQuery } from "@/lib/api";

/** 分页缓存的固定前缀：乐观更新要靠它一次命中所有筛选条件下的分页数据 */
const PAGE_PREFIX = ["tasks", "page"] as const;

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

export function useTaskMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: taskKeys.all });

  /**
   * 启停是「点了就该立刻看到」的开关：先改缓存、再发请求，失败回滚。
   * 只等接口往返的话，网络稍慢就会被当成「点了没反应」再去点第二下（又切回去）。
   */
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => tasks.toggle(id, enabled),
    onMutate: async ({ id, enabled }) => {
      await queryClient.cancelQueries({ queryKey: taskKeys.all });
      const snapshot = queryClient.getQueriesData({ queryKey: taskKeys.all });
      const patch = (t: SyncTask) => (t.id === id ? { ...t, enabled } : t);
      queryClient.setQueriesData<SyncTask[]>({ queryKey: taskKeys.list() }, (rows) => rows?.map(patch));
      queryClient.setQueriesData<Page<SyncTask>>({ queryKey: PAGE_PREFIX }, (page) =>
        page ? { ...page, list: page.list.map(patch) } : page,
      );
      return { snapshot };
    },
    onError: (_error, _vars, context) => {
      for (const [key, data] of context?.snapshot ?? []) queryClient.setQueryData(key, data);
    },
    onSuccess: () => void invalidate(),
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
