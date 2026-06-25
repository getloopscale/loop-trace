import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  addAnnotation,
  getAnnotations,
  removeAnnotation,
  type AnnotationInput,
} from "../api/client.js";

/** Don't retry deterministic 4xx; retry transient errors up to twice. */
function retry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return false;
  }
  return failureCount < 2;
}

/**
 * A trace's annotations + add/remove mutations (M26b). Mutations write through to
 * the API and replace the cached list with the server response (no optimistic drift,
 * mirrors useTags). Keyed by traceId; covers trace-level + every span's annotations.
 */
export function useAnnotations(traceId: string) {
  const qc = useQueryClient();
  const key = ["annotations", traceId];

  const query = useQuery({
    queryKey: key,
    queryFn: () => getAnnotations(traceId),
    enabled: traceId.length > 0,
    retry,
  });

  const add = useMutation({
    mutationFn: (input: AnnotationInput) => addAnnotation(traceId, input),
    onSuccess: (data) => qc.setQueryData(key, data),
  });

  const remove = useMutation({
    mutationFn: (k: { spanId?: string; name?: string }) =>
      removeAnnotation(traceId, k),
    onSuccess: (data) => qc.setQueryData(key, data),
  });

  return { query, add, remove };
}
