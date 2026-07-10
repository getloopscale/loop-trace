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
 * M102 (M96 F4) — a SANITIZED, category-based issue message. The default Zod message embeds the
 * attacker-controlled `received '<value>'` (e.g. `invalid_enum_value`), which would reflect raw input
 * into the API response. This derives the message from the SCHEMA's own structured fields (the type
 * it expected, the allowed enum `options`, the min/max bound — all server-defined, safe to expose and
 * useful to the client) and NEVER echoes the received value.
 */
function sanitizedIssue(i: ZodError["issues"][number]): string {
  switch (i.code) {
    case "invalid_type":
      return `expected ${i.expected}`;
    case "invalid_enum_value":
      return `expected one of: ${i.options.map(String).join(", ")}`;
    case "too_small":
      return `value is too small (min ${i.minimum})`;
    case "too_big":
      return `value is too large (max ${i.maximum})`;
    case "invalid_string":
      return `invalid ${typeof i.validation === "string" ? i.validation : "string"} format`;
    case "unrecognized_keys":
      return "unrecognized field(s)";
    default:
      // A bare category token — never the raw `i.message` (which may echo the received value).
      return i.code;
  }
}

/**
 * Flatten a ZodError into `{ field, issue }[]` — the offending field path (dot-joined, `<root>` when
 * the error is at the top level) + a sanitized category message. Empty array when there are no issues.
 */
export function zodFieldErrors(error: ZodError): FieldIssue[] {
  return error.issues.map((i) => ({
    field: i.path.length > 0 ? i.path.join(".") : "<root>",
    issue: sanitizedIssue(i),
  }));
}
