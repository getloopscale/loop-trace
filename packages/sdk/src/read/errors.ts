/**
 * The single typed error every `LensReadClient` method can throw (M104, ADR-1).
 *
 * A caller catches ONE type and switches on `code` — no string-matching, no mixed `Error`/`TypeError`.
 * `code` is the engine's stable UPPER_SNAKE key from the `{code,message,details?}` envelope
 * (`packages/core/src/domain/api-error.ts`), or a synthetic client-side code for a non-envelope
 * failure (network / timeout / opaque body). `FieldIssue` mirrors the envelope's `details[]` — declared
 * here (not imported from core) to keep the SDK runtime-standalone.
 */

/** One field-level validation problem from the engine's error envelope. */
export interface FieldIssue {
  field: string;
  issue: string;
}

export interface LensApiErrorArgs {
  status: number;
  code: string;
  message: string;
  details?: FieldIssue[];
}

export class LensApiError extends Error {
  /** HTTP status (0 for a network reject / timeout — no response was received). */
  readonly status: number;
  /** Stable machine key: the engine's envelope `code`, or a synthetic client code. */
  readonly code: string;
  /** Field-level problems, present only for a boundary-validation failure. */
  readonly details?: FieldIssue[];

  constructor(args: LensApiErrorArgs) {
    super(args.message);
    this.name = "LensApiError";
    this.status = args.status;
    this.code = args.code;
    if (args.details && args.details.length > 0) this.details = args.details;
    // Restore the prototype chain so `instanceof LensApiError` holds across transpile targets.
    Object.setPrototypeOf(this, LensApiError.prototype);
  }
}

/** True when `value` looks like the engine's `{code,message}` envelope. */
function isEnvelope(value: unknown): value is { code: string; message?: string; details?: unknown } {
  return typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string";
}

function detailsOf(value: { details?: unknown }): FieldIssue[] | undefined {
  const raw = value.details;
  if (!Array.isArray(raw)) return undefined;
  const parsed = raw.filter(
    (d): d is FieldIssue =>
      typeof d === "object" &&
      d !== null &&
      typeof (d as FieldIssue).field === "string" &&
      typeof (d as FieldIssue).issue === "string",
  );
  return parsed.length > 0 ? parsed : undefined;
}

/**
 * Map a non-2xx `Response` to a `LensApiError`. Parses the `{code,message,details?}` envelope when
 * present; an opaque / non-JSON body falls back to a synthetic `UNEXPECTED_RESPONSE` (status kept).
 */
export async function errorFromResponse(
  res: Response,
  method: string,
  path: string,
): Promise<LensApiError> {
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = undefined;
  }
  const code = isEnvelope(body) ? body.code : "UNEXPECTED_RESPONSE";
  const serverMessage = isEnvelope(body) && typeof body.message === "string" ? body.message : undefined;
  const details = isEnvelope(body) ? detailsOf(body) : undefined;
  const message = `${method} ${path} failed: ${res.status} ${code}${serverMessage ? ` — ${serverMessage}` : ""}`;
  return new LensApiError({ status: res.status, code, message, ...(details ? { details } : {}) });
}

/** Map a `fetch` reject (or an abort) to a typed network/timeout error (no response received). */
export function errorFromReject(err: unknown, method: string, path: string): LensApiError {
  const aborted = err instanceof Error && err.name === "AbortError";
  const code = aborted ? "TIMEOUT" : "NETWORK_ERROR";
  const reason = err instanceof Error ? err.message : String(err);
  return new LensApiError({
    status: 0,
    code,
    message: `${method} ${path} failed: ${code}${reason ? ` — ${reason}` : ""}`,
  });
}

/** Map a malformed 2xx body (valid HTTP, unparseable JSON) to a typed client error. */
export function invalidBodyError(status: number, method: string, path: string): LensApiError {
  return new LensApiError({
    status,
    code: "INVALID_RESPONSE_BODY",
    message: `${method} ${path}: invalid JSON response body`,
  });
}
