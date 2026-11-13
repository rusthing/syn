import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { idem, type IdemRecord, type Page } from "@/lib/api";

export function useIdem(query: { keyword?: string; pageNum?: number; pageSize?: number }) {
  return useQuery<Page<IdemRecord>>({
    queryKey: ["idem", query],
    queryFn: () => idem.page(query),
    placeholderData: keepPreviousData,
  });
}
