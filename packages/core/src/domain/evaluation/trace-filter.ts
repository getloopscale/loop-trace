import type { Span } from "../observability/span.js";

/**
 * M134 T2.2 — the predicate that decides WHICH TRACES trigger an evaluator.
 *
 * Not to be confused with an evaluator's `target`, which selects WHICH SPANS
 * INSIDE a trace get scored. They are orthogonal and deliberately share no code
 * path: `target` narrows work within a trace the evaluator already owns;
 * `filter` decides whether the evaluator owns the trace at all.
 *
 * theo-lens evaluates this in memory against the spans it just saved. The
 * references had to re-fetch the entity and, for anything outside a small
 * column allowlist, fall back to an analytical query per config per trace —
 * the dominant cost of job creation there. Here the common case costs nothing.
 */

/** Columns a filter may reference. Shared with the write-time validator (EC-7). */
export const KNOWN_FILTER_COLUMNS = [
  "name",
  "model",
  "provider",
  "sessionId",
  "statusCode",
  "toolName",
] as const;

export type FilterColumn = (typeof KNOWN_FILTER_COLUMNS)[number];

export type FilterOperator =
  | "eq"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "anyOf"
  | "noneOf";

export interface FilterClause {
  column: FilterColumn;
  op: FilterOperator;
  value: string | string[];
}

/**
 * Raised when a filter references a column that cannot be evaluated.
 *
 * This fails LOUD by design. Blueprint AP-5 recorded the reference's mistake:
 * its in-memory evaluator caught errors and returned `false`, and the false
 * branch had a side effect — it cancelled a pending job. Fail-closed is the
 * wrong polarity whenever "no match" is not a no-op. A typo must surface, not
 * silently disable evaluation.
 *
 * The write-time validator (T2.3) is what keeps this from ever being thrown by
 * a job in production; this is the read-side backstop.
 */
export class UnknownFilterColumnError extends Error {
  constructor(public readonly column: string) {
    super(
      `Unknown filter column "${column}". Known columns: ${KNOWN_FILTER_COLUMNS.join(", ")}`,
    );
    this.name = "UnknownFilterColumnError";
  }
}

/** True when `column` is evaluable. Exported so T2.3 validates against one list. */
export function isKnownFilterColumn(column: string): column is FilterColumn {
  return (KNOWN_FILTER_COLUMNS as readonly string[]).includes(column);
}

/** Operators asserting absence — they must hold for EVERY span, not merely one. */
const NEGATIVE_OPS: ReadonlySet<FilterOperator> = new Set([
  "notContains",
  "noneOf",
]);

function readColumn(span: Span, column: FilterColumn): string | undefined {
  const raw = (span as unknown as Record<string, unknown>)[column];
  return typeof raw === "string" ? raw : undefined;
}

/** Does ONE span satisfy the positive form of this clause? */
function spanSatisfies(span: Span, clause: FilterClause): boolean {
  const actual = readColumn(span, clause.column);
  if (actual === undefined) return false;

  switch (clause.op) {
    case "eq":
      return actual === clause.value;
    case "contains":
    case "notContains":
      return actual.includes(String(clause.value));
    case "startsWith":
      return actual.startsWith(String(clause.value));
    case "endsWith":
      return actual.endsWith(String(clause.value));
    case "anyOf":
    case "noneOf":
      return (
        Array.isArray(clause.value) && clause.value.includes(actual)
      );
  }
}

/**
 * Trace-level semantics: a positive clause holds when SOME span satisfies it
 * (so "this trace used a tool AND ran on claude" can be satisfied by two
 * different spans), and a negative clause holds only when NO span does.
 *
 * The asymmetry is load-bearing. Evaluating a negative clause as "some span
 * does not contain X" would make it trivially true on any multi-span trace —
 * the opposite of what the operator asked for.
 */
export function matchesFilter(
  spans: readonly Span[],
  filter: readonly FilterClause[],
): boolean {
  for (const clause of filter) {
    if (!isKnownFilterColumn(clause.column)) {
      throw new UnknownFilterColumnError(clause.column);
    }
    const someSpanSatisfies = spans.some((s) => spanSatisfies(s, clause));
    const holds = NEGATIVE_OPS.has(clause.op)
      ? !someSpanSatisfies
      : someSpanSatisfies;
    if (!holds) return false;
  }
  return true;
}
