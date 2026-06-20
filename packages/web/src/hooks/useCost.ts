import { useQuery } from "@tanstack/react-query";
import { ApiError, getCostByPeriod, getTraceCost } from "../api/client.js";

/** Don't retry deterministic 4xx (e.g. 404); retry transient errors up to twice. */
function retry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return false;
  }
  return failureCount < 2;
}

/** Per-trace cost (M5). Supplementary — callers tolerate error/loading. */
export function useTraceCost(traceId: string) {
  return useQuery({
    queryKey: ["trace-cost", traceId],
    queryFn: () => getTraceCost(traceId),
    enabled: traceId.length > 0,
    retry,
  });
}

/** Day/week cost aggregation (M5). */
export function useCostByPeriod(period: "day" | "week") {
  return useQuery({
    queryKey: ["cost", period],
    queryFn: () => getCostByPeriod(period),
    retry,
  });
}
