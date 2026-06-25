import { describe, it, expect } from "vitest";
import { extractEvaluations } from "./evaluation.js";

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
