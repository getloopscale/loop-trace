import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ApiError, getObservability } from "../api/client.js";
import type { ObservabilityRange } from "../api/types.js";

/** Don't retry deterministic 4xx; retry transient errors up to twice. */
function retry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return false;
  }
  return failureCount < 2;
}

/**
 * Time-series observability query keyed by the range (M11 — refetches on change).
 * keepPreviousData holds the prior series visible while the new range loads, so
 * the dashboard does not flash empty/Loading on every range toggle (mirrors M9).
 */
export function useObservability(range: ObservabilityRange) {
  return useQuery({
    queryKey: ["observability", range],
    queryFn: () => getObservability(range),
    placeholderData: keepPreviousData,
    retry,
  });
}
