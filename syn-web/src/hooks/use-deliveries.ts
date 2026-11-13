import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { deliveries, type DeliveryQuery, type Page, type Delivery } from "@/lib/api";

export function useDeliveries(query: DeliveryQuery) {
  return useQuery<Page<Delivery>>({
    queryKey: ["deliveries", query],
    queryFn: () => deliveries.page(query),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
}
