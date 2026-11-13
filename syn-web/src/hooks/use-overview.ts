import { useQuery } from "@tanstack/react-query";
import { overview } from "@/lib/api";

export function useOverview(window = "24h") {
  return useQuery({
    queryKey: ["overview", window],
    queryFn: () => overview.get(window),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}
