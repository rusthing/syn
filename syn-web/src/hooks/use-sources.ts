import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  datasources,
  registry,
  sources,
  type DatasourceInfo,
  type DatasourceSaveInput,
  type ServiceOption,
  type SyncSource,
} from "@/lib/api";

export const sourceKeys = {
  all: ["sources"] as const,
  datasources: ["datasources"] as const,
  /** 注册中心候选：与数据源分开缓存，刷新频率低、失败也不该拖累数据源列表 */
  services: ["services"] as const,
};

export function useSources() {
  return useQuery<SyncSource[]>({
    queryKey: sourceKeys.all,
    queryFn: () => sources.list(),
    refetchInterval: 30_000,
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

/**
 * 数据源候选清单。连接串在数据源页维护，这里只拿脱敏后的实体给下拉用
 * （`TaskEditorDrawer` 取 `id / code / name / target`）。
 */
export function useDatasources() {
  return useQuery<DatasourceInfo[]>({
    queryKey: sourceKeys.datasources,
    queryFn: () => datasources.list(),
    staleTime: 60_000,
  });
}

/** 数据源的写操作：成功后统一失效 `datasources` 缓存，列表与下拉一起刷新 */
export function useDatasourceMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: sourceKeys.datasources });

  const create = useMutation({
    mutationFn: (input: DatasourceSaveInput) => datasources.create(input),
    onSuccess: () => void invalidate(),
  });

  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: DatasourceSaveInput }) =>
      datasources.update(id, input),
    onSuccess: () => void invalidate(),
  });

  const setEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      datasources.setEnabled(id, enabled),
    onSuccess: () => void invalidate(),
  });

  const remove = useMutation({
    mutationFn: (id: string) => datasources.remove(id),
    onSuccess: () => void invalidate(),
  });

  return { create, update, setEnabled, remove };
}

/**
 * 注册中心里已登记的服务名候选，给「投递」页签的目标服务输入框做辅助。
 *
 * 这个接口允许「还没实现 / 注册中心不可达」：queryFn 把失败吞成空数组，
 * 不把错误抛到页面（配置要能先于下游上线）。候选项变化不频繁，staleTime 放长。
 */
export function useServices() {
  return useQuery<ServiceOption[]>({
    queryKey: sourceKeys.services,
    queryFn: async () => {
      try {
        return await registry.services();
      } catch {
        return [];
      }
    },
    staleTime: 10 * 60_000,
  });
}
