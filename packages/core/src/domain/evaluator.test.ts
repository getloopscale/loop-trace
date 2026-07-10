import { describe, it, expect } from "vitest";

import {
  evaluatorSchema,
  guardSchema,
  evaluateRule,
  evaluateGuard,
  validatePredicate,
  deriveKind,
  type Evaluator,
} from "./evaluator.js";
import type { Span } from "./span.js";

function span(over: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
  return {
    name: "op",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    ...over,
  };
}

const ruleEv = (predicate: string, over: Partial<Evaluator> = {}): Evaluator =>
  evaluatorSchema.parse({
    name: "quality",
    kind: "rule",
    config: { predicate },
    ...over,
  });

describe("M36 evaluator schema (T1.2)", () => {
  it("test_evaluator_schema_accepts_rule_and_judge", () => {
    expect(() =>
      evaluatorSchema.parse({ name: "r", kind: "rule", config: { predicate: "status:error" } }),
    ).not.toThrow();
    expect(() =>
      evaluatorSchema.parse({
        name: "j",
        kind: "llm_judge",
        config: { prompt: "Is this good?", model: "gpt-4o" },
      }),
    ).not.toThrow();
  });

  it("test_evaluator_schema_rejects_unknown_kind_and_bad_name", () => {
    expect(() =>
      evaluatorSchema.parse({ name: "ok", kind: "bogus", config: {} }),
    ).toThrow();
    expect(() =>
      evaluatorSchema.parse({ name: "Bad Name!", kind: "rule", config: { predicate: "" } }),
    ).toThrow();
  });

  it("test_evaluator_name_boundary", () => {
    const parse = (name: string) =>
      evaluatorSchema.safeParse({ name, kind: "rule", config: { predicate: "" } });
    expect(parse("a").success).toBe(true); // 1 char
    expect(parse("a".repeat(64)).success).toBe(true); // 64 chars
    // F6: assert the TYPED failure is the name-regex issue, not a bare throw.
    for (const bad of ["", "a".repeat(65), "Bad Name"]) {
      const res = parse(bad);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues.some((i) => i.path.includes("name"))).toBe(true);
      }
    }
  });

  it("test_guard_schema_accepts_operators", () => {
    expect(() =>
      guardSchema.parse({ evaluatorId: "e1", operator: "lt", threshold: 0.5 }),
    ).not.toThrow();
    expect(() =>
      guardSchema.parse({ evaluatorId: "e1", operator: "label_eq", labelValue: "fail" }),
    ).not.toThrow();
    expect(() =>
      guardSchema.parse({ evaluatorId: "e1", operator: "bogus" }),
    ).toThrow();
  });
});

describe("M36 rule engine (T3.1)", () => {
  it("test_rule_match_returns_pass_verdict", () => {
    const v = evaluateRule(ruleEv("status:error"), span({ spanId: "s", traceId: "t", statusCode: "ERROR" }));
    expect(v).toEqual({ score: 1, label: "pass" });
  });

  it("test_rule_nomatch_returns_fail_verdict", () => {
    const v = evaluateRule(ruleEv("status:error"), span({ spanId: "s", traceId: "t", statusCode: "OK" }));
    expect(v).toEqual({ score: 0, label: "fail" });
  });

  it("test_rule_empty_predicate_is_total_no_throw", () => {
    // empty predicate = match-all → pass; never throws
    const v = evaluateRule(ruleEv(""), span({ spanId: "s", traceId: "t" }));
    expect(v.score).toBe(1);
  });

  it("test_rule_kind_clause_matches_ui_derived_kind", () => {
    const llm = span({ spanId: "s", traceId: "t", model: "gpt-4o" });
    expect(evaluateRule(ruleEv("kind:llm"), llm).score).toBe(1);
    expect(evaluateRule(ruleEv("kind:tool"), llm).score).toBe(0);
    // chain needs children context
    const parent = span({ spanId: "p", traceId: "t" });
    expect(evaluateRule(ruleEv("kind:chain"), parent, true).score).toBe(1);
    expect(evaluateRule(ruleEv("kind:chain"), parent, false).score).toBe(0);
  });

  it("M92 — an attr:key=value clause matches a span's arbitrary attribute (text equality)", () => {
    const s = span({ spanId: "s", traceId: "t", attributes: { "gen_ai.request.temperature": 0.7, tier: "gold" } });
    // present key + matching (text-coerced) value → match
    expect(evaluateRule(ruleEv("attr:gen_ai.request.temperature=0.7"), s).score).toBe(1);
    expect(evaluateRule(ruleEv("attr:tier=gold"), s).score).toBe(1);
    // present key, different value → no match
    expect(evaluateRule(ruleEv("attr:tier=silver"), s).score).toBe(0);
    // absent key → no match (not a fabricated match)
    expect(evaluateRule(ruleEv("attr:missing=x"), s).score).toBe(0);
    // a span with no attributes at all → no match, never throws
    expect(evaluateRule(ruleEv("attr:tier=gold"), span({ spanId: "s2", traceId: "t" })).score).toBe(0);
  });

  it("test_custom_pass_fail_labels", () => {
    const ev = ruleEv("status:error", { passLabel: "errored", failLabel: "clean" });
    expect(evaluateRule(ev, span({ spanId: "s", traceId: "t", statusCode: "ERROR" })).label).toBe("errored");
    expect(evaluateRule(ev, span({ spanId: "s", traceId: "t" })).label).toBe("clean");
  });

  it("test_deriveKind_tool_retriever_embedding", () => {
    expect(deriveKind(span({ spanId: "s", traceId: "t", toolName: "Bash" }))).toBe("tool");
    expect(deriveKind(span({ spanId: "s", traceId: "t", attributes: { "gen_ai.operation.name": "retrieve" } }))).toBe("retriever");
    expect(deriveKind(span({ spanId: "s", traceId: "t", attributes: { "gen_ai.operation.name": "embeddings" } }))).toBe("embedding");
    expect(deriveKind(span({ spanId: "s", traceId: "t" }))).toBe("unknown");
  });

  it("test_create_rule_rejects_zero_clause_predicate", () => {
    // EC-1: a non-empty predicate that parses to 0 clauses is rejected
    expect(validatePredicate("statuss:eror")).not.toBeNull();
    expect(validatePredicate("garbage tokens here")).not.toBeNull();
    // explicit empty = match-all is allowed
    expect(validatePredicate("")).toBeNull();
    expect(validatePredicate("status:error")).toBeNull();
  });
});

describe("M36 guards (T6.1)", () => {
  const g = (operator: string, over: Record<string, unknown> = {}) =>
    guardSchema.parse({ evaluatorId: "e1", operator, ...over });

  it("test_guard_operator_matrix", () => {
    expect(evaluateGuard(g("lt", { threshold: 0.5 }), { score: 0.4 })).toBe(true);
    expect(evaluateGuard(g("lt", { threshold: 0.5 }), { score: 0.6 })).toBe(false);
    expect(evaluateGuard(g("gte", { threshold: 0.5 }), { score: 0.5 })).toBe(true);
    expect(evaluateGuard(g("gt", { threshold: 0.5 }), { score: 0.5 })).toBe(false);
    expect(evaluateGuard(g("lte", { threshold: 0.5 }), { score: 0.5 })).toBe(true);
    expect(evaluateGuard(g("eq", { threshold: 1 }), { score: 1 })).toBe(true);
    expect(evaluateGuard(g("label_eq", { labelValue: "fail" }), { label: "fail" })).toBe(true);
    expect(evaluateGuard(g("label_eq", { labelValue: "fail" }), { label: "pass" })).toBe(false);
  });

  it("test_guard_null_score_is_no_breach", () => {
    // a score operator over a label-only verdict → no breach (null-safe)
    expect(evaluateGuard(g("lt", { threshold: 0.5 }), { label: "x" })).toBe(false);
    expect(evaluateGuard(g("label_eq", { labelValue: "fail" }), { score: 0 })).toBe(false);
  });
});
