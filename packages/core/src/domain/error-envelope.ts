/**
 * M118 (D3) — the single typed error envelope. `apiError` (api-error.ts) already produces the canonical
 * `{ code, message, details? }` shape; this module adds a STABLE code union (`ERROR_CODES`) and a
 * `errorBody(code, message)` helper whose `code` is constrained to that union — so a typo'd code is a
 * compile error and every error code is greppable/auditable in one place. The handlers that hand-wrote
 * inline `{ code, message }` literals now route through `errorBody`; the dynamic-code paths (a
 * `CopilotError.code` / `InvalidFeedbackError.code` surfaced verbatim) keep using `apiError` (which
 * accepts an arbitrary string). The wire shape and the exact code strings are UNCHANGED (R5).
 */
import { apiError, type ApiErrorBody, type FieldIssue } from "./api-error.js";

/** Every stable error code the engine surface returns. New codes are added here (single source). */
export const ERROR_CODES = [
  // shared / boundary
  "INTERNAL",
  "NOT_FOUND",
  "INVALID_BODY",
  "INVALID_QUERY",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "RATE_LIMITED",
  // ingest
  "INVALID_OTLP",
  // copilot
  "COPILOT_DISABLED",
  "COPILOT_UNAVAILABLE",
  "TRACE_NOT_FOUND",
  "SPAN_NOT_FOUND",
  "INVALID_QUESTION",
  "INVALID_FEEDBACK",
  // replay
  "REPLAY_DISABLED",
  "REPLAY_UNAVAILABLE",
  "INVALID_SCHEMA",
  // experiment
  "RUN_DISABLED",
  "RUN_UNAVAILABLE",
  "RUN_NOT_FOUND",
  "DATASET_NOT_FOUND",
  "EMPTY_DATASET",
  // evaluators / guards
  "EVALUATOR_NOT_FOUND",
  "INVALID_EVALUATOR",
  "INVALID_PREDICATE",
  "INVALID_RUN_OPTS",
  "INVALID_GUARD",
  "NAME_CONFLICT",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Runtime guard — true when `code` is a known stable error code. */
export function isErrorCode(code: string): code is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Build the canonical error envelope with a TYPED code (the D3 single error path). Identical wire shape
 * to `apiError` — this just constrains `code` to {@link ERROR_CODES} so typos are caught at compile time.
 */
export function errorBody(code: ErrorCode, message: string, details?: FieldIssue[]): ApiErrorBody {
  return apiError(code, message, details);
}
