/**
 * M36 — env parse for the LLM-judge + the evaluator sweep + the backfill cap.
 * Mirrors the M23 `parseRetentionConfig` shape (default-OFF, fail-soft on bad input).
 */
import type { JudgeConfig } from "./llm-judge.js";
import { type ProviderBreakerConfig, DEFAULT_PROVIDER_BREAKER } from "./provider-breaker.js";
import { positiveIntEnv } from "./env.js";

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

/** M33: copilot per-workspace requests/minute (D3). Invalid/unset → default 20; never ≤ 0. */
export const DEFAULT_COPILOT_RPM = 20;
export function parseCopilotRpm(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["THEOLENS_COPILOT_RPM"];
  if (raw === undefined) return DEFAULT_COPILOT_RPM;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_COPILOT_RPM;
}

/** M118: evaluator-run per-workspace requests/minute (billable fan-out guard, its own knob — UQ3, so
 *  the run limit is decoupled from copilot's). `POST /v1/evaluators/:id/run` fans out up to
 *  backfillMax=500 judge calls per request, so its RPM is deliberately low. Invalid/unset → 10; never ≤ 0. */
export const DEFAULT_EVALUATOR_RPM = 10;
export function parseEvaluatorRpm(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["THEOLENS_EVALUATOR_RPM"];
  if (raw === undefined) return DEFAULT_EVALUATOR_RPM;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_EVALUATOR_RPM;
}

/** M93: OTLP ingest per-workspace requests/minute (backpressure). Far higher than copilot — ingest
 *  is the high-volume write path; a runaway producer sheds with 429 before pool exhaustion.
 *  Invalid/unset → default 600; never ≤ 0. */
export const DEFAULT_INGEST_RPM = 600;
export function parseIngestRpm(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["THEOLENS_INGEST_RPM"];
  if (raw === undefined) return DEFAULT_INGEST_RPM;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_INGEST_RPM;
}

/** M93: cap on the RAW ingest body (bytes) — bodyLimit 413s past this before buffering. Default 4 MiB. */
export const DEFAULT_MAX_INGEST_BYTES = 4 * 1024 * 1024;
export function parseMaxIngestBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["THEOLENS_MAX_INGEST_BYTES"];
  if (raw === undefined) return DEFAULT_MAX_INGEST_BYTES;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_INGEST_BYTES;
}

/** M93: cap on the DECOMPRESSED ingest body (bytes) — a gzip-bomb past this 413s. Default 16 MiB
 *  (above the raw cap since gzip legitimately inflates). */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024;
export function parseMaxDecompressedBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["THEOLENS_MAX_DECOMPRESSED_BYTES"];
  if (raw === undefined) return DEFAULT_MAX_DECOMPRESSED_BYTES;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_DECOMPRESSED_BYTES;
}

/** M94: node-pg Pool resilience config. A stuck query aborts at `statement_timeout` (freeing the
 *  connection); `max` bounds the pool; connect/idle timeouts prevent hangs. All env-tunable. */
export interface PoolConfig {
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  statement_timeout: number;
  query_timeout: number;
}
export const DEFAULT_POOL_CONFIG: PoolConfig = {
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 30_000,
  query_timeout: 30_000,
};
export function parsePoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  return {
    max: positiveIntEnv(env, "THEOLENS_PG_POOL_MAX", DEFAULT_POOL_CONFIG.max),
    connectionTimeoutMillis: positiveIntEnv(env, "THEOLENS_PG_CONNECT_TIMEOUT_MS", DEFAULT_POOL_CONFIG.connectionTimeoutMillis),
    idleTimeoutMillis: positiveIntEnv(env, "THEOLENS_PG_IDLE_TIMEOUT_MS", DEFAULT_POOL_CONFIG.idleTimeoutMillis),
    statement_timeout: positiveIntEnv(env, "THEOLENS_PG_STATEMENT_TIMEOUT_MS", DEFAULT_POOL_CONFIG.statement_timeout),
    query_timeout: positiveIntEnv(env, "THEOLENS_PG_QUERY_TIMEOUT_MS", DEFAULT_POOL_CONFIG.query_timeout),
  };
}

/** M94: server-level HTTP request timeout (ms). A DB-blocked route 503s at this ceiling instead of
 *  hanging a socket. Default 30s. */
export const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30_000;
export function parseHttpRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntEnv(env, "THEOLENS_HTTP_REQUEST_TIMEOUT_MS", DEFAULT_HTTP_REQUEST_TIMEOUT_MS);
}

/** M94: graceful-shutdown drain deadline (ms) — how long SIGTERM awaits in-flight requests before a
 *  forced close. Default 10s. */
export const DEFAULT_SHUTDOWN_DRAIN_MS = 10_000;
export function parseShutdownDrainMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntEnv(env, "THEOLENS_SHUTDOWN_DRAIN_MS", DEFAULT_SHUTDOWN_DRAIN_MS);
}

/** M118: provider circuit-breaker policy (env-tunable, sibling of `parseProviderRetry`). `failureThreshold`
 *  consecutive failures ⇒ OPEN (fast-fail 503 without calling the provider); after `cooldownMs` one
 *  HALF-OPEN probe. Conservative defaults (5 failures / 30s) so a transient blip does not trip it. The
 *  config shape + defaults are the canonical ones in `provider-breaker.ts` (DRY). */
export function parseProviderBreaker(env: NodeJS.ProcessEnv = process.env): ProviderBreakerConfig {
  return {
    failureThreshold: positiveIntEnv(env, "THEOLENS_PROVIDER_BREAKER_THRESHOLD", DEFAULT_PROVIDER_BREAKER.failureThreshold),
    cooldownMs: positiveIntEnv(env, "THEOLENS_PROVIDER_BREAKER_COOLDOWN_MS", DEFAULT_PROVIDER_BREAKER.cooldownMs),
  };
}

/** M94: provider-call retry policy. A transient failure (429/5xx/timeout) is retried up to
 *  `maxAttempts` (total, incl. the first) with exponential backoff from `baseDelayMs`; a fatal 4xx is
 *  never retried. Default 2 attempts / 250ms base. */
export interface ProviderRetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  /** Ceiling on a single backoff wait (ms) — caps a hostile/misconfigured provider `Retry-After`
   *  (e.g. `999999`) so it cannot pin the request for hours. Default 60s. */
  maxBackoffMs: number;
}
export const DEFAULT_PROVIDER_RETRY: ProviderRetryConfig = { maxAttempts: 2, baseDelayMs: 250, maxBackoffMs: 60_000 };
export function parseProviderRetry(env: NodeJS.ProcessEnv = process.env): ProviderRetryConfig {
  return {
    maxAttempts: positiveIntEnv(env, "THEOLENS_PROVIDER_MAX_ATTEMPTS", DEFAULT_PROVIDER_RETRY.maxAttempts),
    baseDelayMs: positiveIntEnv(env, "THEOLENS_PROVIDER_RETRY_BASE_MS", DEFAULT_PROVIDER_RETRY.baseDelayMs),
    maxBackoffMs: positiveIntEnv(env, "THEOLENS_PROVIDER_MAX_BACKOFF_MS", DEFAULT_PROVIDER_RETRY.maxBackoffMs),
  };
}
