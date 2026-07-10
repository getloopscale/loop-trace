import { describe, it, expect } from "vitest";
import { extractEvaluations, scoresResponseSchema } from "./evaluation.js";

describe("scoresResponseSchema (M90)", () => {
  it("round-trips a well-formed time-bucketed score payload", () => {
    const payload = {
      range: "7d",
      scores: [
        { periodStart: "2026-07-08T00:00:00.000Z", name: "hallucination", sampleCount: 3, avgScore: 0.21, labels: {} },
        { periodStart: "2026-07-08T00:00:00.000Z", name: "tone", sampleCount: 2, labels: { friendly: 2 } },
      ],
    };
    expect(scoresResponseSchema.parse(payload)).toEqual(payload);
  });

  it("rejects an unknown column (strict, no-leak invariant)", () => {
    expect(() =>
      scoresResponseSchema.parse({
        range: "24h",
        scores: [{ periodStart: "x", name: "n", sampleCount: 1, labels: {}, leaked: "col" }],
      }),
    ).toThrow();
  });

  it("rejects a negative sampleCount and a bad range", () => {
    expect(() =>
      scoresResponseSchema.parse({ range: "24h", scores: [{ periodStart: "x", name: "n", sampleCount: -1, labels: {} }] }),
    ).toThrow();
    expect(() => scoresResponseSchema.parse({ range: "bogus", scores: [] })).toThrow();
  });

  it("avgScore is optional — a categorical-only bucket omits it", () => {
    const parsed = scoresResponseSchema.parse({
      range: "1h",
      scores: [{ periodStart: "x", name: "tone", sampleCount: 2, labels: { warm: 2 } }],
    });
    expect(parsed.scores[0].avgScore).toBeUndefined();
  });
});

describe("extractEvaluations (M26)", () => {
  it("test_extract_single_eval", () => {
    const { evaluations, strippedKeys } = extractEvaluations({
      "eval.hallucination.score": 0.2,
      "eval.hallucination.label": "factual",
      "eval.hallucination.explanation": "no fabricated claims",
      "gen_ai.request.model": "gpt-4o", // unrelated — untouched
    });
    expect(evaluations).toEqual([
      {
        name: "hallucination",
        score: 0.2,
        label: "factual",
        explanation: "no fabricated claims",
      },
    ]);
    expect(strippedKeys.sort()).toEqual(
      [
        "eval.hallucination.explanation",
        "eval.hallucination.label",
        "eval.hallucination.score",
      ].sort(),
    );
  });

  it("test_extract_multiple_evaluators", () => {
    const { evaluations } = extractEvaluations({
      "eval.hallucination.score": 0.1,
      "eval.relevance.label": "relevant",
    });
    const byName = Object.fromEntries(evaluations.map((e) => [e.name, e]));
    expect(byName["hallucination"]).toMatchObject({ name: "hallucination", score: 0.1 });
    expect(byName["relevance"]).toMatchObject({ name: "relevance", label: "relevant" });
    expect(evaluations).toHaveLength(2);
  });

  it("test_extract_ignores_malformed", () => {
    const { evaluations } = extractEvaluations({
      "eval.x.score": "not-a-number", // non-number score ignored
      "eval..score": 0.5, // empty name ignored
      "eval.": 1, // no name/field ignored
      "evalx.score": 0.5, // not the eval. prefix
    });
    expect(evaluations).toEqual([]);
  });

  it("test_extract_explanation_only_not_an_eval", () => {
    // explanation alone (no score/label) is not a scored evaluation
    const { evaluations } = extractEvaluations({
      "eval.x.explanation": "some text",
    });
    expect(evaluations).toEqual([]);
  });

  it("test_extract_score_or_label_alone_counts", () => {
    expect(extractEvaluations({ "eval.a.score": 0 }).evaluations).toEqual([
      { name: "a", score: 0 },
    ]);
    expect(extractEvaluations({ "eval.b.label": "ok" }).evaluations).toEqual([
      { name: "b", label: "ok" },
    ]);
  });

  it("test_extract_total_never_throws", () => {
    for (const attrs of [
      undefined,
      {},
      { "eval.a.score": null },
      { "eval.a.score": {} },
      { "eval.🙂.score": 1 },
    ] as (Record<string, unknown> | undefined)[]) {
      expect(() => extractEvaluations(attrs)).not.toThrow();
    }
  });
});
