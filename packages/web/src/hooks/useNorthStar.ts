import { useQuery } from "@tanstack/react-query";
import { ApiError, getNorthStar } from "../api/client.js";

/** Don't retry deterministic 4xx; retry transient errors up to twice. */
function retry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return false;
  }
  return failureCount < 2;
}

/** North-star metrics: traces/day + replay-sessions/week (M8 DoD #3). */
export function useNorthStar() {
  return useQuery({
    queryKey: ["north-star"],
    queryFn: getNorthStar,
    retry,
  });
}
