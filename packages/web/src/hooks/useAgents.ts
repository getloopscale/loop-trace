import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ApiError, getAgents } from "../api/client.js";
import { useAutoRefreshInterval } from "./useAutoRefresh.js";

/** Don't retry deterministic 4xx; retry transient errors up to twice. */
function retry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return false;
  }
  return failureCount < 2;
}

/** The agents catalog (M32), auto-refresh aware (mirrors useSessions). */
export function useAgents() {
  return useQuery({
    queryKey: ["agents"],
    queryFn: getAgents,
    placeholderData: keepPreviousData,
    retry,
    refetchInterval: useAutoRefreshInterval(),
    refetchIntervalInBackground: false,
  });
}
