/**
 * M118 (D2) — a minimal hand-rolled circuit breaker (closed/open/half-open) wrapping the provider call
 * in `chat.ts`. Clock-injected like the existing retry (`parseProviderRetry`), env-tunable via
 * `parseProviderBreaker`. When the provider is sustainedly failing the breaker OPENs and fast-fails
 * (`ProviderBreakerOpenError`) WITHOUT calling the provider — so a call no longer pays
 * `CHAT_TIMEOUT_MS`×retry when the provider is down, which compounds badly with the 500-call evaluator
 * fan-out. Per-provider, process-wide (KISS/YAGNI — UQ2). ~30 LoC, no library (Rule 9 — the state
 * machine is a tiny counter + timestamp).
 *
 * Node's event loop is single-threaded, so the state mutations below are atomic per call (no true
 * parallelism); the admission budget (`failures + inFlight < threshold`) bounds the number of provider
 * calls admitted while CLOSED under a burst of concurrent failures, so the transition to OPEN happens
 * exactly once and excess concurrent calls fast-fail instead of all hammering a down provider.
 */

/** Fast-fail error thrown when the breaker is OPEN (the provider is NOT called). Extends {@link Error}
 *  with a distinct name so a handler can map it to 503 (circuit open) vs a 502 (provider returned error). */
export class ProviderBreakerOpenError extends Error {
  constructor(message = "provider circuit breaker is open") {
    super(message);
    this.name = "ProviderBreakerOpenError";
  }
}

/** Breaker policy. `failureThreshold` consecutive failures ⇒ OPEN; after `cooldownMs` one HALF-OPEN probe. */
export interface ProviderBreakerConfig {
  failureThreshold: number;
  cooldownMs: number;
}

/** Conservative defaults (D2 — avoid false-trips): 5 consecutive failures, 30s cool-down. */
export const DEFAULT_PROVIDER_BREAKER: ProviderBreakerConfig = { failureThreshold: 5, cooldownMs: 30_000 };

type State = "closed" | "open" | "half_open";

export class ProviderBreaker {
  private state: State = "closed";
  private failures = 0;
  private openedAt = 0;
  private inFlight = 0;
  private probeInFlight = false;
  /** Number of CLOSED→OPEN transitions — asserted "exactly once" by the concurrent test. */
  openTransitions = 0;

  constructor(
    private readonly config: ProviderBreakerConfig = DEFAULT_PROVIDER_BREAKER,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Run `fn` through the breaker. CLOSED: admit while the budget (`failures + inFlight < threshold`)
   * holds, else fast-fail. OPEN: fast-fail until the cool-down elapses, then admit exactly ONE probe
   * (HALF-OPEN). A success closes the breaker; a failure (re-)opens it.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const nowMs = this.now();

    if (this.state === "open") {
      if (nowMs - this.openedAt < this.config.cooldownMs) {
        throw new ProviderBreakerOpenError();
      }
      // Cool-down elapsed → allow a single HALF-OPEN probe; concurrent callers past the first fast-fail.
      if (this.probeInFlight) throw new ProviderBreakerOpenError();
      this.state = "half_open";
      this.probeInFlight = true;
      return this.attempt(fn, true);
    }

    if (this.state === "half_open") {
      // A probe is already in flight — shed the rest.
      throw new ProviderBreakerOpenError();
    }

    // CLOSED — admission budget bounds how many concurrent calls reach a failing provider.
    if (this.failures + this.inFlight >= this.config.failureThreshold) {
      this.trip(nowMs);
      throw new ProviderBreakerOpenError();
    }
    return this.attempt(fn, false);
  }

  private async attempt<T>(fn: () => Promise<T>, isProbe: boolean): Promise<T> {
    this.inFlight += 1;
    try {
      const out = await fn();
      // Success → close + reset.
      this.state = "closed";
      this.failures = 0;
      this.probeInFlight = false;
      return out;
    } catch (err) {
      this.failures += 1;
      if (isProbe || this.failures >= this.config.failureThreshold) {
        this.trip(this.now());
      }
      throw err;
    } finally {
      this.inFlight -= 1;
      if (isProbe) this.probeInFlight = false;
    }
  }

  /** Transition to OPEN exactly once per open episode (record the timestamp + count the transition). */
  private trip(nowMs: number): void {
    if (this.state !== "open") {
      this.openTransitions += 1;
    }
    this.state = "open";
    this.openedAt = nowMs;
    this.probeInFlight = false;
  }
}
