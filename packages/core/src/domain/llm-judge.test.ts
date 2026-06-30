import { describe, it, expect } from "vitest";

import {
  parseJudgeVerdict,
  OpenAICompatibleJudge,
  JudgeError,
  type JudgeConfig,
} from "./llm-judge.js";
import {
  parseJudgeConfig,
  parseEvalSweepHours,
  parseBackfillMax,
} from "./evaluator-config.js";

const cfg: JudgeConfig = { baseUrl: "http://judge", apiKey: "k", model: "m" };

function fetchReturning(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

function fetchContent(content: string): typeof fetch {
  return fetchReturning(200, { choices: [{ message: { content } }] });
}

describe("M36 parseJudgeVerdict (T4.1)", () => {
  it("test_judge_parses_structured_verdict", () => {
    expect(parseJudgeVerdict('{"score":0.9,"label":"good"}')).toEqual({
      score: 0.9,
      label: "good",
    });
  });

  it("test_judge_throws_on_unparseable_json", () => {
    expect(() => parseJudgeVerdict("not json")).toThrow(JudgeError);
  });

  it("test_judge_rejects_out_of_range_score", () => {
    // EC-2: out of [0,1] → JudgeError (no silent clamp)
    expect(() => parseJudgeVerdict('{"score":5}')).toThrow(JudgeError);
    expect(() => parseJudgeVerdict('{"score":-1}')).toThrow(JudgeError);
  });

  it("test_judge_rejects_verdict_without_score_or_label", () => {
    // EC-3: explanation alone is not a verdict
    expect(() => parseJudgeVerdict('{"explanation":"meh"}')).toThrow(JudgeError);
  });

  it("test_judge_accepts_label_only", () => {
    expect(parseJudgeVerdict('{"label":"pass"}')).toEqual({ label: "pass" });
  });
});

describe("M36 OpenAICompatibleJudge (T4.1)", () => {
  it("test_judge_returns_verdict_on_2xx", async () => {
    const j = new OpenAICompatibleJudge(cfg, fetchContent('{"score":0.7}'));
    expect(await j.judge("rate this", "hello")).toEqual({ score: 0.7 });
  });

  it("test_judge_throws_on_non_2xx", async () => {
    const j = new OpenAICompatibleJudge(cfg, fetchReturning(503, {}));
    await expect(j.judge("p", "io")).rejects.toBeInstanceOf(JudgeError);
  });

  it("test_judge_throws_on_network_error", async () => {
    const failing = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const j = new OpenAICompatibleJudge(cfg, failing);
    await expect(j.judge("p", "io")).rejects.toBeInstanceOf(JudgeError);
  });

  it("test_judge_throws_on_missing_content", async () => {
    const j = new OpenAICompatibleJudge(cfg, fetchReturning(200, { choices: [] }));
    await expect(j.judge("p", "io")).rejects.toBeInstanceOf(JudgeError);
  });
});

describe("M36 evaluator-config (T4.1)", () => {
  it("test_parse_judge_config_missing_disables_judge", () => {
    expect(parseJudgeConfig({})).toBeNull();
    expect(parseJudgeConfig({ THEOLENS_JUDGE_BASE_URL: "http://x" })).toBeNull(); // model missing
    expect(
      parseJudgeConfig({ THEOLENS_JUDGE_BASE_URL: "http://x", THEOLENS_JUDGE_MODEL: "m" }),
    ).toEqual({ baseUrl: "http://x", model: "m", apiKey: undefined });
  });

  it("test_parse_eval_sweep_hours_default_off", () => {
    expect(parseEvalSweepHours({})).toBe(0);
    expect(parseEvalSweepHours({ THEOLENS_EVAL_SWEEP_HOURS: "0" })).toBe(0);
    expect(parseEvalSweepHours({ THEOLENS_EVAL_SWEEP_HOURS: "bad" })).toBe(0);
    expect(parseEvalSweepHours({ THEOLENS_EVAL_SWEEP_HOURS: "6" })).toBe(6);
  });

  it("test_parse_backfill_max_default_500", () => {
    expect(parseBackfillMax({})).toBe(500);
    expect(parseBackfillMax({ THEOLENS_EVAL_BACKFILL_MAX: "0" })).toBe(500);
    expect(parseBackfillMax({ THEOLENS_EVAL_BACKFILL_MAX: "100" })).toBe(100);
  });
});
