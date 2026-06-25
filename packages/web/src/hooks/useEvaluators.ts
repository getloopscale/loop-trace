import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ApiError, getEvaluators } from "../api/client.js";
import type { ObservabilityRange } from "../api/types.js";
import { useAutoRefreshInterval } from "./useAutoRefresh.js";

/** Don't retry deterministic 4xx; retry transient errors up to twice. */
function retry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return false;
  }
  return failureCount < 2;
}

/**
 * Per-evaluator aggregate query keyed by the range (M26 — refetches on change).
 * keepPreviousData holds the prior cards visible while the new range loads, so
 * the page does not flash empty/Loading on every range toggle (mirrors M11).
 */
export function useEvaluators(range: ObservabilityRange) {
  return useQuery({
    queryKey: ["evaluators", range],
    queryFn: () => getEvaluators(range),
    placeholderData: keepPreviousData,
    retry,
    refetchInterval: useAutoRefreshInterval(),
    refetchIntervalInBackground: false,
  });
}
