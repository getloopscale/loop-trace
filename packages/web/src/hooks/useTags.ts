import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, addTraceTag, getTraceTags, removeTraceTag } from "../api/client.js";

/** Don't retry deterministic 4xx; retry transient errors up to twice. */
function retry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return false;
  }
  return failureCount < 2;
}

/**
 * A trace's tags + add/remove mutations (M14). Mutations write through to the API
 * and invalidate the query so the chip list reflects the server state (no optimistic
 * drift). Keyed by traceId.
 */
export function useTraceTags(traceId: string) {
  const qc = useQueryClient();
  const key = ["trace-tags", traceId];

  const query = useQuery({
    queryKey: key,
    queryFn: () => getTraceTags(traceId),
    enabled: traceId.length > 0,
    retry,
  });

  const add = useMutation({
    mutationFn: (tag: string) => addTraceTag(traceId, tag),
    onSuccess: (data) => qc.setQueryData(key, data),
  });

  const remove = useMutation({
    mutationFn: (tag: string) => removeTraceTag(traceId, tag),
    onSuccess: (data) => qc.setQueryData(key, data),
  });

  return { query, add, remove };
}
