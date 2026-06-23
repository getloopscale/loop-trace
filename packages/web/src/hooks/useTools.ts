import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ApiError, getToolStats, getTracesForTool } from "../api/client.js";
import { useAutoRefreshInterval } from "./useAutoRefresh.js";

function retry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return false;
  }
  return failureCount < 2;
}

/** Per-tool operational stats ranking (M6). */
export function useToolStats() {
  return useQuery({
    queryKey: ["tools"],
    queryFn: getToolStats,
    placeholderData: keepPreviousData,
    retry,
    refetchInterval: useAutoRefreshInterval(),
    refetchIntervalInBackground: false,
  });
}

/** Executions that called a given tool (M6 drill-down). */
export function useTracesForTool(toolName: string) {
  return useQuery({
    queryKey: ["tool-traces", toolName],
    queryFn: () => getTracesForTool(toolName),
    enabled: toolName.length > 0,
    retry,
  });
}
