import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tasks, type Page, type SyncTask, type TaskQuery } from "@/lib/api";

export const taskKeys = {
  all: ["tasks"] as const,
  page: (query: TaskQuery) => ["tasks", "page", query] as const,
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

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => tasks.toggle(id, enabled),
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
