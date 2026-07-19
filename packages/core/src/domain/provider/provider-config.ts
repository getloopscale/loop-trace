/**
 * Provider-parse leaf (M120 D1). Owns the provider retry/breaker env parsers — hoisted out of
 * `evaluator-config.ts` into a leaf that imports ONLY `./env.js` (`positiveIntEnv`) and the already-leaf
 * `./provider-breaker.js`. This severs the `chat → evaluator-config` edge (chat.ts re-points here), so the
 * `chat → evaluator-config → llm-judge → chat` runtime cycle is broken while behavior is preserved.
 * Mirrors the M23 `parseRetentionConfig` shape (default-safe, fail-soft on bad input).
 */
import { type ProviderBreakerConfig, DEFAULT_PROVIDER_BREAKER } from "./provider-breaker.js";
import { positiveIntEnv } from "./env.js";

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
