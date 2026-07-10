/**
 * Shared UUID-shape guard for repository path params. A uuid-typed Postgres column rejects a
 * non-uuid string with SQLSTATE 22P02 (a 500 at the boundary); guarding here turns a garbage path
 * param into an honest "absent" (null/false) instead — the M22/M82 convention: non-uuid id →
 * absent, never a 500 (fail-clear, Unbreakable Rule 8). Single authority so the span and evaluator
 * repos share ONE definition (DRY).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
