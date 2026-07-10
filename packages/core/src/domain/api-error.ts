/**
 * M96 — the one API error envelope every engine route speaks: `{ code, message, details? }`.
 * `code` is the stable machine key (a UPPER_SNAKE identifier a client switches on); `message` is the
 * human string (kept back-compatible with the pre-M96 bare-`{error}` text); `details` names the
 * offending fields for a boundary-validation failure. A single constructor makes the shape
 * un-driftable (DRY) — routes never hand-write the object literal.
 */
import type { ZodError } from "zod";

/** One field-level validation problem: which input field, and what was wrong with it. */
export interface FieldIssue {
  field: string;
  issue: string;
}

/** The canonical error body. `details` is present only when there is field-level information. */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: FieldIssue[];
}

/** Build the canonical envelope. `details` is omitted entirely when empty (never `details: []`). */
export function apiError(code: string, message: string, details?: FieldIssue[]): ApiErrorBody {
  const body: ApiErrorBody = { code, message };
  if (details && details.length > 0) body.details = details;
  return body;
}

/**
 * Flatten a ZodError into `{ field, issue }[]` — the offending field path (dot-joined, `<root>` when
 * the error is at the top level) + the Zod message. Empty array when the error carries no issues.
 */
export function zodFieldErrors(error: ZodError): FieldIssue[] {
  return error.issues.map((i) => ({
    field: i.path.length > 0 ? i.path.join(".") : "<root>",
    issue: i.message,
  }));
}
