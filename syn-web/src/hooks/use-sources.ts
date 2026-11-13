import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { datasources, sources, type DatasourceInfo, type SyncSource } from "@/lib/api";

export const sourceKeys = {
  all: ["sources"] as const,
  datasources: ["datasources"] as const,
};

export function useSources() {
  return useQuery<SyncSource[]>({
    queryKey: sourceKeys.all,
    queryFn: () => sources.list(),
    refetchInterval: 30_000,
  });
}

/**
 * 可选的数据源连接名。连接串改在 toml / consul，改完要等 syn-svr 热更新，
 * 这里不设自动刷新：手动重开编辑器就会重新拉一次。
 */
export function useDatasources() {
  return useQuery<DatasourceInfo[]>({
    queryKey: sourceKeys.datasources,
    queryFn: () => datasources.list(),
    staleTime: 60_000,
  });
}

export function useSourceMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: sourceKeys.all });

  const pull = useMutation({
    // 允许传 `{ id, reset }`：http 全量源「翻到底」之后靠 reset 从头再拉
    mutationFn: (arg: string | { id: string; reset?: boolean }) =>
      typeof arg === "string" ? sources.pull(arg) : sources.pull(arg.id, arg.reset),
    onSuccess: () => void invalidate(),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => sources.toggle(id, enabled),
    onSuccess: () => void invalidate(),
  });

  const save = useMutation({
    mutationFn: (input: Parameters<typeof sources.save>[0]) => sources.save(input),
    onSuccess: () => void invalidate(),
  });

  const remove = useMutation({
    mutationFn: (id: string) => sources.remove(id),
    onSuccess: () => void invalidate(),
  });

  return { pull, toggle, save, remove };
}
