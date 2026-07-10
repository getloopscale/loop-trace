/**
 * Typed domain errors (M82). The repository throws these; the API boundary maps them to HTTP status
 * codes (fail-clear, Unbreakable Rule 8) instead of letting a raw Postgres error surface as a 500.
 */

/** A write violated a `(workspace_id, name)` unique constraint (rename/create to an already-used name). */
export class NameConflictError extends Error {
  constructor(message = "a resource with that name already exists") {
    super(message);
    this.name = "NameConflictError";
  }
}

/** True when a caught error is a Postgres unique-violation (SQLSTATE 23505). Drizzle wraps the pg error,
 *  so check both the error itself and its `.cause` (the underlying `pg` error carrying the SQLSTATE code). */
export function isUniqueViolation(err: unknown): boolean {
  return isSqlState(err, "23505");
}

/** True when a caught error is a Postgres foreign-key violation (SQLSTATE 23503) — e.g. an insert that
 *  races a concurrent parent delete (M101 / ADR 0003). Same wrap-aware check as {@link isUniqueViolation}. */
export function isForeignKeyViolation(err: unknown): boolean {
  return isSqlState(err, "23503");
}

/** Drizzle wraps the pg error, so check both the error itself and its `.cause` for the SQLSTATE. */
function isSqlState(err: unknown, state: string): boolean {
  const code = (e: unknown): string | undefined =>
    typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
  if (code(err) === state) return true;
  const cause = typeof err === "object" && err !== null ? (err as { cause?: unknown }).cause : undefined;
  return code(cause) === state;
}
