import { useQuery } from "@tanstack/react-query";
import { getTraceTree, listTraces } from "../api/client.js";

/** Executions list query (M3 D3 — react-query keying + caching). */
export function useTraceList() {
  return useQuery({ queryKey: ["traces"], queryFn: listTraces });
}

/** Single-trace tree query, keyed by traceId. */
export function useTraceTree(traceId: string) {
  return useQuery({
    queryKey: ["trace", traceId],
    queryFn: () => getTraceTree(traceId),
    enabled: traceId.length > 0,
  });
}
