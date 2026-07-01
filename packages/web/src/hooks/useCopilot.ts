import { useMutation } from "@tanstack/react-query";
import { ApiError, askCopilot } from "../api/client.js";
import type { CopilotAskResponse } from "../api/types.js";

/** Don't retry deterministic 4xx (400 bad question / 403 / 404 / 429); retry transient 5xx once. */
function retry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return false;
  }
  return failureCount < 1;
}

/**
 * The "Ask about this step" copilot mutation (M33). Stateless (D4): each ask is a
 * fresh POST scoped to `traceId` (+ optional `spanId`). The mutation exposes
 * `data.answer` on success and `error` (an {@link ApiError} carrying the HTTP
 * status) on failure so the panel can render disabled/unavailable/rate-limited.
 */
export function useCopilot(traceId: string) {
  return useMutation<CopilotAskResponse, unknown, { spanId?: string; question: string }>({
    mutationFn: (input) => askCopilot(traceId, input),
    retry,
  });
}
