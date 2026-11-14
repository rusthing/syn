import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { canvas, type CanvasNodePos } from "@/lib/api";

export const canvasKeys = {
  layout: ["canvas", "layout"] as const,
};

const keyOf = (pos: CanvasNodePos) => `${pos.kind}:${pos.key}`;

/**
 * 画布坐标。节点本身不在这里 —— 页面从数据源 / 来源 / 任务三个列表现拼，
 * 所以这三个列表变了，图自动跟着变，坐标只多不少也无所谓（多出来的会被 `mergePositions` 忽略）。
 */
export function useCanvasLayout() {
  return useQuery<CanvasNodePos[]>({
    queryKey: canvasKeys.layout,
    queryFn: () => canvas.layout(),
    staleTime: 60_000,
  });
}

export function useCanvasMutations() {
  const queryClient = useQueryClient();

  /**
   * 拖动松手时提交。成功后就地合并进缓存，**不重新拉列表**：
   * 一次拖动重拉整张图会让画布闪一下，而且拿回来的还是同一批坐标。
   */
  const save = useMutation({
    mutationFn: (nodes: CanvasNodePos[]) => canvas.save(nodes),
    onSuccess: (saved) => {
      queryClient.setQueryData<CanvasNodePos[]>(canvasKeys.layout, (old) => {
        const map = new Map((old ?? []).map((p) => [keyOf(p), p]));
        for (const pos of saved) map.set(keyOf(pos), pos);
        return [...map.values()];
      });
    },
  });

  return { save };
}
