import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ApiError, getSession, getSessions } from "../api/client.js";
import { useAutoRefreshInterval } from "./useAutoRefresh.js";

/** Don't retry deterministic 4xx (e.g. 404); retry transient errors up to twice. */
function retry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return false;
  }
  return failureCount < 2;
}

/** Sessions list, newest-first (M13). */
export function useSessions() {
  return useQuery({
    queryKey: ["sessions"],
    queryFn: getSessions,
    placeholderData: keepPreviousData,
    retry,
    refetchInterval: useAutoRefreshInterval(),
    refetchIntervalInBackground: false,
  });
}

/** One session's detail, keyed by id (M13). */
export function useSessionDetail(sessionId: string) {
  return useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => getSession(sessionId),
    enabled: sessionId.length > 0,
    retry,
  });
}
