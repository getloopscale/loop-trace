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

/** Whitelisted typed query fields. */
export type SpanField = "kind" | "name" | "status" | "model";

/**
 * A span-query clause. Typed fields (`kind|name|status|model`) carry a value; the
 * M92 `attr` clause carries an arbitrary attribute KEY plus a value — matching a span
 * whose `attributes ->> key` equals `value`. The key is a jsonb path bound as data at
 * compile time (never SQL); it is additionally shape-validated here (defense-in-depth).
 */
export type SpanClause =
  | { field: SpanField; value: string }
  | { field: "attr"; key: string; value: string };

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

// M92 — a valid attribute key: starts alphanumeric, then alphanumerics + dot/underscore/hyphen,
// ≤ 128 chars. Instrumentation keys are dotted (gen_ai.request.temperature). This bounds abuse/DoS;
// it is NOT the injection guard (the key is bound as a jsonb path — see spanClauseSql).
const ATTR_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
    if (field === "attr") {
      // M92 — `attr:<key>=<value>`: the FIRST '=' splits key/value (the value may itself
      // contain '='). The key is shape-validated; a malformed key/value drops the whole token.
      const eq = value.indexOf("=");
      const key = eq > 0 ? value.slice(0, eq) : "";
      const attrValue = eq > 0 ? value.slice(eq + 1) : "";
      if (ATTR_KEY_RE.test(key) && attrValue.length > 0) {
        clauses.push({ field: "attr", key, value: attrValue });
      } else {
        ignored.push(token);
      }
    } else if (isValidClause(field, value)) {
      clauses.push({ field, value });
    } else {
      ignored.push(token);
    }
  }
  return { clauses, ignored };
}
