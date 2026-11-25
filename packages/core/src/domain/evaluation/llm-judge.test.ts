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
  parsePoolConfig,
  parseHttpRequestTimeoutMs,
  parseShutdownDrainMs,
  parseProviderRetry,
  DEFAULT_POOL_CONFIG,
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
    expect(parseJudgeConfig({ LOOPTRACE_JUDGE_BASE_URL: "http://x" })).toBeNull(); // model missing
    expect(
      parseJudgeConfig({ LOOPTRACE_JUDGE_BASE_URL: "http://x", LOOPTRACE_JUDGE_MODEL: "m" }),
    ).toEqual({ baseUrl: "http://x", model: "m", apiKey: undefined });
  });

  it("test_parse_eval_sweep_hours_default_off", () => {
    expect(parseEvalSweepHours({})).toBe(0);
    expect(parseEvalSweepHours({ LOOPTRACE_EVAL_SWEEP_HOURS: "0" })).toBe(0);
    expect(parseEvalSweepHours({ LOOPTRACE_EVAL_SWEEP_HOURS: "bad" })).toBe(0);
    expect(parseEvalSweepHours({ LOOPTRACE_EVAL_SWEEP_HOURS: "6" })).toBe(6);
  });

  it("test_parse_backfill_max_default_500", () => {
    expect(parseBackfillMax({})).toBe(500);
    expect(parseBackfillMax({ LOOPTRACE_EVAL_BACKFILL_MAX: "0" })).toBe(500);
    expect(parseBackfillMax({ LOOPTRACE_EVAL_BACKFILL_MAX: "100" })).toBe(100);
  });
});

describe("M94 resilience config", () => {
  it("parsePoolConfig defaults + env override + invalid fallback", () => {
    expect(parsePoolConfig({})).toEqual(DEFAULT_POOL_CONFIG);
    expect(parsePoolConfig({ LOOPTRACE_PG_POOL_MAX: "25" }).max).toBe(25);
    expect(parsePoolConfig({ LOOPTRACE_PG_STATEMENT_TIMEOUT_MS: "5000" }).statement_timeout).toBe(5000);
    // invalid (0/negative/NaN) → default, never breaks the pool
    expect(parsePoolConfig({ LOOPTRACE_PG_POOL_MAX: "0" }).max).toBe(DEFAULT_POOL_CONFIG.max);
    expect(parsePoolConfig({ LOOPTRACE_PG_POOL_MAX: "-1" }).max).toBe(DEFAULT_POOL_CONFIG.max);
    expect(parsePoolConfig({ LOOPTRACE_PG_CONNECT_TIMEOUT_MS: "bad" }).connectionTimeoutMillis).toBe(
      DEFAULT_POOL_CONFIG.connectionTimeoutMillis,
    );
  });

  it("parseHttpRequestTimeoutMs + parseShutdownDrainMs default + override", () => {
    expect(parseHttpRequestTimeoutMs({})).toBe(30_000);
    expect(parseHttpRequestTimeoutMs({ LOOPTRACE_HTTP_REQUEST_TIMEOUT_MS: "10000" })).toBe(10_000);
    expect(parseHttpRequestTimeoutMs({ LOOPTRACE_HTTP_REQUEST_TIMEOUT_MS: "0" })).toBe(30_000);
    expect(parseShutdownDrainMs({})).toBe(10_000);
    expect(parseShutdownDrainMs({ LOOPTRACE_SHUTDOWN_DRAIN_MS: "3000" })).toBe(3_000);
  });

  it("parseProviderRetry default (2 attempts, 60s backoff cap) + override + invalid fallback", () => {
    expect(parseProviderRetry({})).toEqual({ maxAttempts: 2, baseDelayMs: 250, maxBackoffMs: 60_000 });
    expect(parseProviderRetry({ LOOPTRACE_PROVIDER_MAX_ATTEMPTS: "3" }).maxAttempts).toBe(3);
    expect(parseProviderRetry({ LOOPTRACE_PROVIDER_MAX_BACKOFF_MS: "5000" }).maxBackoffMs).toBe(5000);
    // never < 1 attempt (an invalid value keeps the default; the call always runs once)
    expect(parseProviderRetry({ LOOPTRACE_PROVIDER_MAX_ATTEMPTS: "0" }).maxAttempts).toBe(2);
  });
});
