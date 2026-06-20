import { useQuery } from "@tanstack/react-query";
import { ApiError, getTraceTree, listTraces } from "../api/client.js";

/** Don't retry deterministic 4xx (e.g. 404); retry transient errors up to twice. */
function retry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return false;
  }
  return failureCount < 2;
}

/** Executions list query (M3 D3 — react-query keying + caching). */
export function useTraceList() {
  return useQuery({ queryKey: ["traces"], queryFn: listTraces, retry });
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
