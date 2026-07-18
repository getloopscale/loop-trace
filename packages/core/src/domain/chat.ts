/**
 * M33 — shared OpenAI-compatible chat-completions path (extracted from the M36
 * `OpenAICompatibleJudge`, D1). One HTTP path + one env (`THEOLENS_JUDGE_*` via
 * `parseJudgeConfig`) for ALL LLM calls: the M36 judge parses a verdict on top of it,
 * the M33 copilot returns the raw free-text answer. Native `fetch`, no SDK (Rule 9).
 * FAIL-CLOSED (`error-handling.md`): any non-2xx / network error / non-JSON / missing
 * content throws {@link ChatError} — never a fabricated answer.
 */

import { parseProviderRetry, parseProviderBreaker, type ProviderRetryConfig } from "./provider-config.js";
import { ProviderBreaker, ProviderBreakerOpenError } from "./provider-breaker.js";

/** Internal sentinel — a 5xx response is thrown inside the breaker so it counts as an outage, then
 *  unwrapped outside to preserve the existing retry/fatal handling. Never leaves this module. */
class ProviderOutage extends Error {
  constructor(readonly response: Response) {
    super(`provider ${response.status}`);
    this.name = "ProviderOutage";
  }
}

/** Typed error for any chat failure — fail-closed, never a silent answer. */
export class ChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatError";
  }
}

/** M94 — retry/backoff injection point (test-injectable clock; env-configured policy in production). */
export interface RequestOpts {
  retry?: ProviderRetryConfig;
  sleep?: (ms: number) => Promise<void>;
  /**
   * M118 — the circuit breaker guarding the provider fetch (D2). Passed by the production clients
   * (`OpenAICompatibleChat`/`OpenAICompatibleReplay`), each holding one process-wide-per-provider
   * breaker so a sustained outage trips once and every subsequent call fast-fails (503) without paying
   * CHAT_TIMEOUT_MS×retry — which compounds badly with the 500-call evaluator fan-out. Absent (a raw
   * `openaiChatCompletion` call with no breaker) → no breaker, so the pure request path carries no
   * shared global state (testability + DIP).
   */
  breaker?: ProviderBreaker;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse a `Retry-After` header (integer seconds) to ms; a missing/invalid value → 0. */
function retryAfterMs(header: string | null | undefined): number {
  if (header == null) return 0;
  const s = Number(header);
  return Number.isFinite(s) && s > 0 ? s * 1000 : 0;
}

/** Exponential backoff with jitter (ms) for attempt N (1-based): base·2^(N-1) + [0,base). */
function backoffMs(attempt: number, baseMs: number): number {
  return baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * baseMs);
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Provider config (shared with the M36 judge — `parseJudgeConfig` produces it). */
export interface ChatConfig {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
}

/**
 * The shared OpenAI-compatible `/chat/completions` request path (D1 — one HTTP path for the copilot's
 * text answer AND the M55 replay's usage-capturing call). Pins temperature 0. Returns the parsed JSON
 * body or THROWS {@link ChatError} on any failure (fail-closed: network / non-2xx / non-JSON).
 */
/** Bound every provider call so a stalled upstream cannot hang the request (billable-path safety). */
const CHAT_TIMEOUT_MS = 30_000;

async function requestChatCompletion(
  config: ChatConfig,
  messages: ChatMessage[],
  fetchImpl: typeof fetch,
  responseSchema?: object,
  opts?: RequestOpts,
): Promise<unknown> {
  // M94 — a transient failure (network / timeout / 429 / 5xx) is retried with bounded backoff
  // (honoring Retry-After); a fatal 4xx≠429 fails fast (error-handling.md §2). Policy is env-tunable
  // (parseProviderRetry); the sleep is injectable for deterministic tests.
  const retry = opts?.retry ?? parseProviderRetry();
  const sleep = opts?.sleep ?? realSleep;
  const breaker = opts?.breaker;
  const maxAttempts = Math.max(1, retry.maxAttempts);
  const body = JSON.stringify({
    model: config.model,
    temperature: 0,
    messages,
    // M62: optional structured output — forwarded as an OpenAI-compatible `response_format`
    // json_schema (the provider enforces it). Absent schema → no field (identical to today).
    ...(responseSchema
      ? { response_format: { type: "json_schema", json_schema: { name: "variant_schema", schema: responseSchema } } }
      : {}),
  });

  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const doFetch = (): Promise<Response> =>
    fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body,
      // A stalled provider aborts at the timeout → fetch rejects → retry/breaker (never a silent hang).
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });

  let lastError = new ChatError("chat request exhausted retries");
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let resp: Response;
    try {
      // M118 — when a breaker is provided (production clients), the raw fetch runs THROUGH it. An
      // "outage" (network/timeout or a 5xx) is signalled by throwing inside `run` so the breaker counts
      // it; a 4xx (incl. 429) resolves the response normally (not an outage — the retry/fatal logic
      // below handles it). When the breaker is OPEN it throws ProviderBreakerOpenError WITHOUT calling
      // the provider → fast-fail (propagated). No breaker → a plain fetch (behavior unchanged).
      resp = breaker
        ? await breaker.run(async () => {
            const r = await doFetch();
            if (r.status >= 500) throw new ProviderOutage(r);
            return r;
          })
        : await doFetch();
    } catch (err) {
      // OPEN breaker → fast-fail immediately (do NOT retry; the provider is down, retrying is pointless).
      if (err instanceof ProviderBreakerOpenError) throw err;
      // A 5xx outage sentinel unwraps to the underlying response → fall through to the non-2xx logic.
      if (err instanceof ProviderOutage) {
        resp = err.response;
      } else {
        // Network / timeout (AbortError) — retryable.
        lastError = new ChatError(`chat request failed: ${String(err)}`);
        if (attempt < maxAttempts) {
          await sleep(Math.min(backoffMs(attempt, retry.baseDelayMs), retry.maxBackoffMs));
          continue;
        }
        throw lastError;
      }
    }
    if (resp.ok) {
      try {
        return await resp.json();
      } catch {
        throw new ChatError("chat response was not JSON");
      }
    }
    // Non-2xx: 429 + 5xx are recoverable (retry with backoff, honoring Retry-After); 4xx≠429 is fatal.
    // NOTE (accepted trade-off): retrying a 5xx/timeout re-issues a non-idempotent chat completion,
    // so an ambiguous failure MAY double-bill. This matches the provider SDKs' own behavior; ≤2
    // attempts by default bounds the exposure. A stricter idempotency-key path is a future option.
    const recoverable = resp.status === 429 || resp.status >= 500;
    if (!recoverable || attempt >= maxAttempts) {
      throw new ChatError(`chat endpoint returned ${resp.status}`);
    }
    lastError = new ChatError(`chat endpoint returned ${resp.status}`);
    // Honor Retry-After but CAP it (a hostile `Retry-After: 999999` must not pin the request for hours).
    const advised = Math.min(retryAfterMs(resp.headers?.get?.("retry-after")), retry.maxBackoffMs);
    await sleep(Math.min(Math.max(advised, backoffMs(attempt, retry.baseDelayMs)), retry.maxBackoffMs));
  }
  throw lastError;
}

/** Extract the required assistant text or THROW (content is mandatory for both callers). */
function extractContent(body: unknown): string {
  const content = (body as { choices?: { message?: { content?: unknown } }[] })
    ?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new ChatError("chat response missing choices[0].message.content");
  }
  return content;
}

/**
 * Call an OpenAI-compatible `/chat/completions` and return the assistant's text.
 * Pins temperature 0. Throws {@link ChatError} on any failure (fail-closed).
 */
export async function openaiChatCompletion(
  config: ChatConfig,
  messages: ChatMessage[],
  fetchImpl: typeof fetch = fetch,
  opts?: RequestOpts,
): Promise<string> {
  return extractContent(await requestChatCompletion(config, messages, fetchImpl, undefined, opts));
}

/** Result of a usage-capturing chat call (M55 replay). Tokens come from the provider, never computed. */
export interface ChatCompletionWithUsage {
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** M62: real provider cost (USD) when the provider reports `usage.cost` (e.g. OpenRouter). Additive —
   *  a provider that omits it → undefined (the UI renders an em-dash; cost is NEVER computed/fabricated). */
  costUsd?: number;
}

/**
 * M55 — same request path as {@link openaiChatCompletion}, additionally returning the provider's
 * `usage` token counts (the replay needs tokens). `usage` is optional in the OpenAI-compatible
 * response — a missing block defaults to zeros (never a throw); `content` stays mandatory (fail-closed).
 * The copilot's string-only path is unchanged.
 */
export async function openaiChatCompletionWithUsage(
  config: ChatConfig,
  messages: ChatMessage[],
  fetchImpl: typeof fetch = fetch,
  responseSchema?: object,
  opts?: RequestOpts,
): Promise<ChatCompletionWithUsage> {
  const body = await requestChatCompletion(config, messages, fetchImpl, responseSchema, opts);
  const content = extractContent(body);
  const usage = (body as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown; cost?: unknown } })?.usage;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  // M62: cost is an ADDITIVE read — present only when the provider reports it (undefined otherwise,
  // never 0/NaN). No request change was needed (probed: OpenRouter returns `usage.cost` by default).
  const costUsd = typeof usage?.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : undefined;
  return {
    content,
    promptTokens: num(usage?.prompt_tokens),
    completionTokens: num(usage?.completion_tokens),
    totalTokens: num(usage?.total_tokens),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/** The free-text chat seam (DIP — real impl or a deterministic test stub). */
export interface ChatClient {
  /** Returns the assistant's answer or THROWS ChatError. */
  ask(messages: ChatMessage[]): Promise<string>;
}

/** OpenAI-compatible {@link ChatClient} over {@link openaiChatCompletion}. Holds one process-wide-per-
 *  provider breaker (M118 D2) so a sustained outage fast-fails without paying CHAT_TIMEOUT_MS×retry. */
export class OpenAICompatibleChat implements ChatClient {
  private readonly breaker = new ProviderBreaker(parseProviderBreaker());

  constructor(
    private readonly config: ChatConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  ask(messages: ChatMessage[]): Promise<string> {
    return openaiChatCompletion(this.config, messages, this.fetchImpl, { breaker: this.breaker });
  }
}

/** A replay result — the usage-capturing call plus the model actually used (M55). */
export interface ReplayResult extends ChatCompletionWithUsage {
  model: string;
}

/**
 * M55 — the span-replay seam (DIP — real impl or a deterministic test stub). `run` re-executes an
 * edited message list against the real provider, optionally overriding the model, and returns the
 * output + usage. THROWS {@link ChatError} on any provider failure (fail-closed).
 */
export interface ReplayClient {
  run(messages: ChatMessage[], modelOverride?: string, responseSchema?: object): Promise<ReplayResult>;
}

/** OpenAI-compatible {@link ReplayClient} over {@link openaiChatCompletionWithUsage}. Holds one
 *  process-wide-per-provider breaker (M118 D2). */
export class OpenAICompatibleReplay implements ReplayClient {
  private readonly breaker = new ProviderBreaker(parseProviderBreaker());

  constructor(
    private readonly config: ChatConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async run(messages: ChatMessage[], modelOverride?: string, responseSchema?: object): Promise<ReplayResult> {
    // base_url/apiKey are ALWAYS the server config — only the model may be overridden (no SSRF: the
    // client can never redirect the call to a different endpoint). M62: an optional response schema is
    // forwarded as structured output (the provider enforces it).
    const model = modelOverride && modelOverride.trim() ? modelOverride.trim() : this.config.model;
    const usage = await openaiChatCompletionWithUsage({ ...this.config, model }, messages, this.fetchImpl, responseSchema, { breaker: this.breaker });
    return { ...usage, model };
  }
}
