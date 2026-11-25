import { describe, expect, it } from "vitest";

import type { Span } from "../observability/span.js";
import {
  KNOWN_FILTER_COLUMNS,
  UnknownFilterColumnError,
  matchesFilter,
  type FilterClause,
} from "./trace-filter.js";

/**
 * M134 T2.2 — which TRACES trigger an evaluator.
 *
 * Distinct from the evaluator's existing `target`, which selects which SPANS
 * INSIDE a trace get scored. Conflating the two is the likeliest implementation
 * error in this milestone, so the two concepts never share a code path.
 *
 * looptrace has an advantage the references do not: the spans are in hand at
 * ingest, so the common case costs no query at all.
 */
function span(overrides: Partial<Span> = {}): Span {
  return {
    spanId: "s1",
    traceId: "t1",
    name: "chat",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    ...overrides,
  } as Span;
}

const clause = (
  column: string,
  op: FilterClause["op"],
  value: string | string[],
): FilterClause => ({ column, op, value }) as FilterClause;

describe("matchesFilter (M134 T2.2)", () => {
  describe("empty filter — the zero-cost path", () => {
    it("test_empty_filter_matches_every_trace", () => {
      expect(matchesFilter([span()], [])).toBe(true);
    });

    it("test_empty_filter_matches_even_an_empty_span_set", () => {
      expect(matchesFilter([], [])).toBe(true);
    });
  });

  describe("positive operators", () => {
    it.each([
      ["eq", "chat", true],
      ["eq", "other", false],
      ["contains", "ha", true],
      ["contains", "zz", false],
      ["startsWith", "ch", true],
      ["startsWith", "ha", false],
      ["endsWith", "at", true],
      ["endsWith", "ch", false],
    ] as const)(
      "test_operator_%s_with_%s_yields_%s",
      (op, value, expected) => {
        expect(
          matchesFilter([span({ name: "chat" })], [clause("name", op, value)]),
        ).toBe(expected);
      },
    );

    it("test_anyOf_matches_when_value_is_in_the_set", () => {
      const f = [clause("model", "anyOf", ["gpt-4", "claude"])];
      expect(matchesFilter([span({ model: "claude" })], f)).toBe(true);
      expect(matchesFilter([span({ model: "llama" })], f)).toBe(false);
    });
  });

  describe("negative operators — the subtle half", () => {
    // A negative clause must hold for EVERY span. Evaluating it as "some span
    // does not contain X" would make it trivially true on any multi-span trace,
    // which is the opposite of what the user asked for.
    it("test_notContains_is_false_when_ANY_span_contains_the_value", () => {
      const spans = [span({ name: "chat" }), span({ spanId: "s2", name: "tool.search" })];
      expect(matchesFilter(spans, [clause("name", "notContains", "tool")])).toBe(
        false,
      );
    });

    it("test_notContains_is_true_only_when_NO_span_contains_the_value", () => {
      const spans = [span({ name: "chat" }), span({ spanId: "s2", name: "reply" })];
      expect(matchesFilter(spans, [clause("name", "notContains", "tool")])).toBe(
        true,
      );
    });

    it("test_noneOf_is_false_when_ANY_span_is_in_the_set", () => {
      const spans = [span({ model: "claude" }), span({ spanId: "s2", model: "gpt-4" })];
      expect(
        matchesFilter(spans, [clause("model", "noneOf", ["gpt-4"])]),
      ).toBe(false);
    });
  });

  describe("null / absent values", () => {
    it("test_absent_column_does_not_satisfy_a_positive_clause", () => {
      // `model` is optional; a span without it must not match "model eq X".
      expect(
        matchesFilter([span({ model: undefined })], [clause("model", "eq", "gpt-4")]),
      ).toBe(false);
    });

    it("test_absent_column_satisfies_a_negative_clause", () => {
      // A trace with no model genuinely does not use gpt-4.
      expect(
        matchesFilter([span({ model: undefined })], [clause("model", "noneOf", ["gpt-4"])]),
      ).toBe(true);
    });
  });

  describe("multiple clauses", () => {
    it("test_clauses_are_ANDed", () => {
      const spans = [span({ name: "chat", model: "claude" })];
      expect(
        matchesFilter(spans, [
          clause("name", "eq", "chat"),
          clause("model", "eq", "claude"),
        ]),
      ).toBe(true);
      expect(
        matchesFilter(spans, [
          clause("name", "eq", "chat"),
          clause("model", "eq", "gpt-4"),
        ]),
      ).toBe(false);
    });

    it("test_a_clause_may_match_a_different_span_than_its_sibling", () => {
      // Trace-level semantics: "this trace used a tool AND ran on claude" is
      // satisfied by two different spans.
      const spans = [
        span({ name: "chat", model: "claude" }),
        span({ spanId: "s2", name: "tool.search" }),
      ];
      expect(
        matchesFilter(spans, [
          clause("name", "contains", "tool"),
          clause("model", "eq", "claude"),
        ]),
      ).toBe(true);
    });
  });

  describe("unknown column — fails LOUD, never silently false", () => {
    it("test_unknown_column_raises_a_typed_error_naming_the_column", () => {
      // Blueprint AP-5: the reference evaluated filters fail-CLOSED, and its
      // false branch had a side effect (it cancelled a pending job). Returning
      // `false` here would silently skip evaluation on a typo. The error names
      // the column so the operator can fix it.
      expect(() =>
        matchesFilter([span()], [clause("nope", "eq", "x")]),
      ).toThrow(UnknownFilterColumnError);
      expect(() => matchesFilter([span()], [clause("nope", "eq", "x")])).toThrow(
        /nope/,
      );
    });

    it("test_every_known_column_is_accepted", () => {
      // Pins the registry that T2.3 shares, so write-time and read-time views
      // of "a valid column" cannot drift apart.
      for (const column of KNOWN_FILTER_COLUMNS) {
        expect(() =>
          matchesFilter([span()], [clause(column, "eq", "whatever")]),
        ).not.toThrow();
      }
    });
  });
});
