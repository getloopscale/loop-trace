/**
 * Span-query DSL (M30) — the first query language in Theo Lens. A space-separated
 * list of `field:value` clauses (implicit AND), e.g. `kind:llm status:error
 * model:gpt-4o name:"Chat Open AI"`. Pure + TOTAL: it never throws — any token it
 * cannot turn into a valid clause is collected in `ignored` (mirroring the M24
 * `websearch_to_tsquery` totality so a half-typed filter bar never 500s the list).
 *
 * The repository (`listTraces`) turns each clause into a predicate on a span and a
 * trace matches iff ONE span satisfies EVERY clause (span-scoped AND). `kind:` is
 * filtered by replicating the UI's `deriveKindFromSignals` in SQL — the stored
 * `spans.kind` column is the OTLP numeric kind, not the semantic one.
 */

/** Whitelisted query fields. */
export type SpanField = "kind" | "name" | "status" | "model";

export interface SpanClause {
  field: SpanField;
  value: string;
}

export interface SpanQuery {
  clauses: SpanClause[];
  /** Tokens that did not parse to a valid clause (kept for honesty/UX, never fatal). */
  ignored: string[];
}

/** Canonical semantic span-kinds the DSL accepts (mirrors the UI taxonomy). */
export const SPAN_QUERY_KIND_VALUES = [
  "llm",
  "tool",
  "retriever",
  "embedding",
  "chain",
  "unknown",
] as const;

const STATUS_VALUES = ["ok", "error"] as const;

// A token is either a quoted clause (`field:"a b c"`) or a bare run of non-space.
// The quoted alternative is tried first so spaces inside quotes don't split a token.
const TOKEN_RE = /\w+:"[^"]*"|\S+/g;
const CLAUSE_RE = /^([A-Za-z]+):(.*)$/;

function stripQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function isValidClause(field: string, value: string): field is SpanField {
  if (value.length === 0) return false;
  switch (field) {
    case "kind":
      return (SPAN_QUERY_KIND_VALUES as readonly string[]).includes(value);
    case "status":
      return (STATUS_VALUES as readonly string[]).includes(value);
    case "name":
    case "model":
      return true;
    default:
      return false;
  }
}

/** Parse a span-query string into clauses + ignored tokens. Never throws (EC: total). */
export function parseSpanQuery(input: string): SpanQuery {
  const clauses: SpanClause[] = [];
  const ignored: string[] = [];
  const tokens = input.match(TOKEN_RE) ?? [];
  for (const token of tokens) {
    const m = CLAUSE_RE.exec(token);
    if (m == null) {
      ignored.push(token);
      continue;
    }
    const field = m[1]!;
    const value = stripQuotes(m[2]!);
    if (isValidClause(field, value)) {
      clauses.push({ field, value });
    } else {
      ignored.push(token);
    }
  }
  return { clauses, ignored };
}
