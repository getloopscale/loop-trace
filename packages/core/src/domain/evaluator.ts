/**
 * M36 — Online evaluators (compute/write path). An evaluator produces a {@link Verdict}
 * for a span and the engine writes it into the existing `span_evaluations` store
 * (M26 read-path lights up automatically). Two kinds behind a seam:
 *  - `rule` — a deterministic predicate reusing the M30 span-query DSL (no new DSL, D3).
 *  - `llm_judge` — a configurable OpenAI-compatible judge (see `llm-judge.ts`, D4).
 *
 * This module owns the PURE pieces (types, schemas, `evaluateRule`, `evaluateGuard`,
 * `validatePredicate`); the run engine (`evaluator-engine.ts`) and the judge client
 * (`llm-judge.ts`) compose them. Per `rules/architecture.md`, the domain depends on
 * nothing outward.
 */
import { z } from "zod";

import { parseSpanQuery, type SpanClause } from "./span-query.js";
import type { Span } from "./span.js";

/** The evaluator seam (grill Q1). */
export const EVALUATOR_KINDS = ["rule", "llm_judge"] as const;
export type EvaluatorKind = (typeof EVALUATOR_KINDS)[number];

/** Guard threshold operators (grill Q4). */
export const GUARD_OPERATORS = [
  "lt",
  "lte",
  "gt",
  "gte",
  "eq",
  "label_eq",
] as const;
export type GuardOperator = (typeof GUARD_OPERATORS)[number];

const NAME_RE = /^[a-z0-9_-]{1,64}$/;

/** A verdict — exactly the shape `span_evaluations` stores (minus `name`). */
export interface Verdict {
  score?: number;
  label?: string;
  explanation?: string;
}

/** rule config = a span-query predicate (empty string = match-all, see EC-1). */
export const ruleConfigSchema = z
  .object({ predicate: z.string() })
  .strict();

/** llm_judge config = a judge prompt + the pinned model name. */
export const judgeConfigSchema = z
  .object({ prompt: z.string().min(1), model: z.string().min(1) })
  .strict();

/** An evaluator definition (discriminated on `kind`). */
export const evaluatorSchema = z
  .object({
    name: z.string().regex(NAME_RE, "name must match ^[a-z0-9_-]{1,64}$"),
    target: z.string().default(""),
    passLabel: z.string().optional(),
    failLabel: z.string().optional(),
    enabled: z.boolean().default(true),
  })
  .and(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("rule"), config: ruleConfigSchema }),
      z.object({ kind: z.literal("llm_judge"), config: judgeConfigSchema }),
    ]),
  );

export type Evaluator = z.infer<typeof evaluatorSchema>;

/** A flag-only guard over an evaluator's verdict. */
export const guardSchema = z
  .object({
    evaluatorId: z.string().min(1),
    operator: z.enum(GUARD_OPERATORS),
    threshold: z.number().optional(),
    labelValue: z.string().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

export type Guard = z.infer<typeof guardSchema>;

/** Result of running an evaluator over a selection of spans. */
export interface RunResult {
  evaluator: string;
  written: number;
  skipped: number;
  truncated: boolean;
  errors: { spanId: string; reason: string }[];
}

/**
 * Derive the semantic span-kind, mirroring the repository's `DERIVED_SPAN_KIND_SQL`
 * (drizzle-span-repository.ts) so a `kind:` rule agrees with what the operator sees
 * in the list. `chain` needs the trace context (does any span have this as parent),
 * supplied via `hasChildren` — absent context → never `chain` (a lone span is not a
 * chain), the same conservative default the single-span view would show.
 */
export function deriveKind(span: Span, hasChildren = false): string {
  const attrs = span.attributes ?? {};
  const op = attrs["gen_ai.operation.name"];
  const toolAttr = attrs["gen_ai.tool.name"];
  if (toolAttr != null || span.toolName != null || op === "execute_tool") {
    return "tool";
  }
  if (op === "retrieve" || op === "search") return "retriever";
  if (op === "embeddings" || op === "embedding") return "embedding";
  if (op === "chat" || op === "text_completion" || span.model != null) {
    return "llm";
  }
  if (hasChildren) return "chain";
  return "unknown";
}

/** Whether a span satisfies one clause (mirrors the SQL clause semantics, D3). */
function spanSatisfies(
  clause: SpanClause,
  span: Span,
  hasChildren: boolean,
): boolean {
  switch (clause.field) {
    case "name":
      return span.name === clause.value;
    case "model":
      return span.model === clause.value;
    case "status": {
      const isError = span.statusCode != null && /error/i.test(span.statusCode);
      return clause.value === "error" ? isError : !isError;
    }
    case "kind":
      return deriveKind(span, hasChildren) === clause.value;
  }
}

/**
 * Validate a rule predicate at the create boundary (EC-1). A NON-empty predicate
 * MUST parse to ≥ 1 clause — otherwise a typo silently matches every span (pass-all
 * footgun). An explicitly empty predicate (`""`) is allowed and means match-all.
 * Returns null when valid, or a reason string when invalid.
 */
export function validatePredicate(predicate: string): string | null {
  if (predicate.trim() === "") return null; // explicit match-all
  const { clauses } = parseSpanQuery(predicate);
  if (clauses.length === 0) {
    return "predicate parses to zero valid clauses (would match every span)";
  }
  return null;
}

/**
 * Evaluate a rule evaluator against one span. Match (every clause satisfied, or an
 * empty predicate) → pass verdict; otherwise fail. Total — never throws.
 */
export function evaluateRule(
  ev: Extract<Evaluator, { kind: "rule" }>,
  span: Span,
  hasChildren = false,
): Verdict {
  const { clauses } = parseSpanQuery(ev.config.predicate);
  const matched = clauses.every((c) => spanSatisfies(c, span, hasChildren));
  return matched
    ? { score: 1, label: ev.passLabel ?? "pass" }
    : { score: 0, label: ev.failLabel ?? "fail" };
}

/**
 * Evaluate a guard against a verdict. Returns true when the verdict BREACHES the
 * guard. Null-safe: a score operator over a verdict with no score is NOT a breach.
 */
export function evaluateGuard(guard: Guard, verdict: Verdict): boolean {
  if (guard.operator === "label_eq") {
    return verdict.label != null && verdict.label === guard.labelValue;
  }
  const s = verdict.score;
  const t = guard.threshold;
  if (s == null || t == null) return false;
  switch (guard.operator) {
    case "lt":
      return s < t;
    case "lte":
      return s <= t;
    case "gt":
      return s > t;
    case "gte":
      return s >= t;
    case "eq":
      return s === t;
  }
}
