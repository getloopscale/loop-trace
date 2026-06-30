/**
 * M36 — env parse for the LLM-judge + the evaluator sweep + the backfill cap.
 * Mirrors the M23 `parseRetentionConfig` shape (default-OFF, fail-soft on bad input).
 */
import type { JudgeConfig } from "./llm-judge.js";

/** Default per-backfill trace cap (ADR D7); override with THEOLENS_EVAL_BACKFILL_MAX. */
export const DEFAULT_EVAL_BACKFILL_MAX = 500;

/**
 * Judge config from env. Returns null (judge DISABLED) when no base URL is set —
 * `llm_judge` evaluators then fail closed with a typed error (EC of grill Q3).
 */
export function parseJudgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): JudgeConfig | null {
  const baseUrl = env["THEOLENS_JUDGE_BASE_URL"]?.trim();
  const model = env["THEOLENS_JUDGE_MODEL"]?.trim();
  if (!baseUrl || !model) return null;
  return {
    baseUrl,
    model,
    apiKey: env["THEOLENS_JUDGE_API_KEY"]?.trim() || undefined,
  };
}

/** Opt-in periodic evaluator sweep interval (hours). 0 / unset / invalid = OFF (D5). */
export function parseEvalSweepHours(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env["THEOLENS_EVAL_SWEEP_HOURS"];
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Per-backfill trace cap (D7). Invalid/unset → default 500; never ≤ 0. */
export function parseBackfillMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["THEOLENS_EVAL_BACKFILL_MAX"];
  if (raw === undefined) return DEFAULT_EVAL_BACKFILL_MAX;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_EVAL_BACKFILL_MAX;
}
