/**
 * M36 — env parse for the LLM-judge + the evaluator sweep + the backfill cap.
 * Mirrors the M23 `parseRetentionConfig` shape (default-OFF, fail-soft on bad input).
 */
import type { JudgeConfig } from "./llm-judge.js";
import { positiveIntEnv } from "../provider/env.js";

/** Default per-backfill trace cap (ADR D7); override with LOOPTRACE_EVAL_BACKFILL_MAX. */
export const DEFAULT_EVAL_BACKFILL_MAX = 500;

/**
 * Judge config from env. Returns null (judge DISABLED) when no base URL is set —
 * `llm_judge` evaluators then fail closed with a typed error (EC of grill Q3).
 */
export function parseJudgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): JudgeConfig | null {
  const baseUrl = env["LOOPTRACE_JUDGE_BASE_URL"]?.trim();
  const model = env["LOOPTRACE_JUDGE_MODEL"]?.trim();
  if (!baseUrl || !model) return null;
  return {
    baseUrl,
    model,
    apiKey: env["LOOPTRACE_JUDGE_API_KEY"]?.trim() || undefined,
  };
}

/** Opt-in periodic evaluator sweep interval (hours). 0 / unset / invalid = OFF (D5). */
export function parseEvalSweepHours(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env["LOOPTRACE_EVAL_SWEEP_HOURS"];
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Per-backfill trace cap (D7). Invalid/unset → default 500; never ≤ 0. */
export function parseBackfillMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["LOOPTRACE_EVAL_BACKFILL_MAX"];
  if (raw === undefined) return DEFAULT_EVAL_BACKFILL_MAX;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_EVAL_BACKFILL_MAX;
}

/** M33: copilot per-workspace requests/minute (D3). Invalid/unset → default 20; never ≤ 0. */
export const DEFAULT_COPILOT_RPM = 20;
export function parseCopilotRpm(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["LOOPTRACE_COPILOT_RPM"];
  if (raw === undefined) return DEFAULT_COPILOT_RPM;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_COPILOT_RPM;
}

/** M118: evaluator-run per-workspace requests/minute (billable fan-out guard, its own knob — UQ3, so
 *  the run limit is decoupled from copilot's). `POST /v1/evaluators/:id/run` fans out up to
 *  backfillMax=500 judge calls per request, so its RPM is deliberately low. Invalid/unset → 10; never ≤ 0. */
export const DEFAULT_EVALUATOR_RPM = 10;
export function parseEvaluatorRpm(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["LOOPTRACE_EVALUATOR_RPM"];
  if (raw === undefined) return DEFAULT_EVALUATOR_RPM;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_EVALUATOR_RPM;
}

/** M93: OTLP ingest per-workspace requests/minute (backpressure). Far higher than copilot — ingest
 *  is the high-volume write path; a runaway producer sheds with 429 before pool exhaustion.
 *  Invalid/unset → default 600; never ≤ 0. */
export const DEFAULT_INGEST_RPM = 600;
export function parseIngestRpm(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["LOOPTRACE_INGEST_RPM"];
  if (raw === undefined) return DEFAULT_INGEST_RPM;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_INGEST_RPM;
}

/** M93: cap on the RAW ingest body (bytes) — bodyLimit 413s past this before buffering. Default 4 MiB. */
export const DEFAULT_MAX_INGEST_BYTES = 4 * 1024 * 1024;
export function parseMaxIngestBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["LOOPTRACE_MAX_INGEST_BYTES"];
  if (raw === undefined) return DEFAULT_MAX_INGEST_BYTES;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_INGEST_BYTES;
}

/** M93: cap on the DECOMPRESSED ingest body (bytes) — a gzip-bomb past this 413s. Default 16 MiB
 *  (above the raw cap since gzip legitimately inflates). */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024;
export function parseMaxDecompressedBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["LOOPTRACE_MAX_DECOMPRESSED_BYTES"];
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
  /**
   * Idade máxima de uma conexão, em segundos. `idleTimeoutMillis` só aposenta a
   * conexão OCIOSA; uma conexão em uso constante ficava viva indefinidamente. Depois
   * de um failover do Postgres gerenciado, ou de um proxy reciclando conexões por
   * baixo, o pool segue entregando clientes que apontam para um servidor que já não
   * está lá — e o sintoma é um gotejar de queries com erro, não uma queda que alguém
   * perceba. Aposentar por tempo troca isso por reconexão previsível.
   */
  maxLifetimeSeconds: number;
}
export const DEFAULT_POOL_CONFIG: PoolConfig = {
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 30_000,
  query_timeout: 30_000,
  maxLifetimeSeconds: 3_600,
};
export function parsePoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  return {
    max: positiveIntEnv(env, "LOOPTRACE_PG_POOL_MAX", DEFAULT_POOL_CONFIG.max),
    connectionTimeoutMillis: positiveIntEnv(env, "LOOPTRACE_PG_CONNECT_TIMEOUT_MS", DEFAULT_POOL_CONFIG.connectionTimeoutMillis),
    idleTimeoutMillis: positiveIntEnv(env, "LOOPTRACE_PG_IDLE_TIMEOUT_MS", DEFAULT_POOL_CONFIG.idleTimeoutMillis),
    statement_timeout: positiveIntEnv(env, "LOOPTRACE_PG_STATEMENT_TIMEOUT_MS", DEFAULT_POOL_CONFIG.statement_timeout),
    query_timeout: positiveIntEnv(env, "LOOPTRACE_PG_QUERY_TIMEOUT_MS", DEFAULT_POOL_CONFIG.query_timeout),
    maxLifetimeSeconds: positiveIntEnv(env, "LOOPTRACE_PG_MAX_LIFETIME_S", DEFAULT_POOL_CONFIG.maxLifetimeSeconds),
  };
}

/** M94: server-level HTTP request timeout (ms). A DB-blocked route 503s at this ceiling instead of
 *  hanging a socket. Default 30s. */
export const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30_000;
export function parseHttpRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntEnv(env, "LOOPTRACE_HTTP_REQUEST_TIMEOUT_MS", DEFAULT_HTTP_REQUEST_TIMEOUT_MS);
}

/** M94: graceful-shutdown drain deadline (ms) — how long SIGTERM awaits in-flight requests before a
 *  forced close. Default 10s. */
export const DEFAULT_SHUTDOWN_DRAIN_MS = 10_000;
export function parseShutdownDrainMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntEnv(env, "LOOPTRACE_SHUTDOWN_DRAIN_MS", DEFAULT_SHUTDOWN_DRAIN_MS);
}

/**
 * M120: the provider retry/breaker parsers moved to the `provider-config.ts` leaf to sever the
 * `chat → evaluator-config → llm-judge → chat` runtime cycle. Re-exported here so every existing
 * caller (the core barrel, tests) keeps resolving these names from `evaluator-config.js` unchanged
 * (D2 — zero caller churn); only `chat.ts` imports them from the leaf directly.
 */
export {
  parseProviderRetry,
  parseProviderBreaker,
  DEFAULT_PROVIDER_RETRY,
  type ProviderRetryConfig,
} from "../provider/provider-config.js";
