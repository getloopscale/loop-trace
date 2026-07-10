/**
 * M97 (audit B-L1) — the typed SQL→DTO boundary. Raw `db.execute(sql`…`)` results are `unknown`
 * rows; the repository historically cast them with `as unknown as Row[]`, so a renamed SELECT alias
 * (drift between the SQL and the TS shape) surfaced as a silent `undefined` at runtime instead of a
 * loud failure. `rowsAs` validates the rows against a Zod schema at the boundary (zod is already a
 * domain dep), so a shape mismatch throws a clear, contextful error where it happens.
 */
import type { z } from "zod";

/** Postgres result shape from Drizzle's `db.execute` (only `.rows` is consumed here). */
export interface SqlResult {
  rows: unknown[];
}

/**
 * Validate `res.rows` against `schema` (applied per row) and return the typed array. On mismatch,
 * throws with `context` (the query name) + the first Zod issue so a renamed column fails loudly at
 * the boundary rather than silently downstream.
 */
export function rowsAs<T>(res: SqlResult, schema: z.ZodType<T>, context: string): T[] {
  return res.rows.map((row, i) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? issue.path.join(".") : "<row>";
      throw new Error(
        `rowsAs(${context}): row ${i} failed SQL→DTO validation at "${where}": ${issue?.message ?? "unknown"}`,
      );
    }
    return parsed.data;
  });
}
