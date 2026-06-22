import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ApiError, getTraceTree, listTraces } from "../api/client.js";
import type { ListTracesQuery } from "../api/types.js";

/** Don't retry deterministic 4xx (e.g. 404); retry transient errors up to twice. */
function retry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return false;
  }
  return failureCount < 2;
}

/**
 * Executions list query keyed by the filter/sort query (M9 — refetches on change).
 * keepPreviousData holds the prior list visible while a new filter loads, so the
 * list does not flash empty/Loading on every filter change (review F-fe-6).
 */
export function useTraceList(query: ListTracesQuery = {}) {
  return useQuery({
    queryKey: ["traces", query],
    queryFn: () => listTraces(query),
    placeholderData: keepPreviousData,
    retry,
  });
}

/** Single-trace tree query, keyed by traceId. */
export function useTraceTree(traceId: string) {
  return useQuery({
    queryKey: ["trace", traceId],
    queryFn: () => getTraceTree(traceId),
    enabled: traceId.length > 0,
    retry,
  });
}
