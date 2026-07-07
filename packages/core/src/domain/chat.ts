/**
 * M33 — shared OpenAI-compatible chat-completions path (extracted from the M36
 * `OpenAICompatibleJudge`, D1). One HTTP path + one env (`THEOLENS_JUDGE_*` via
 * `parseJudgeConfig`) for ALL LLM calls: the M36 judge parses a verdict on top of it,
 * the M33 copilot returns the raw free-text answer. Native `fetch`, no SDK (Rule 9).
 * FAIL-CLOSED (`error-handling.md`): any non-2xx / network error / non-JSON / missing
 * content throws {@link ChatError} — never a fabricated answer.
 */

/** Typed error for any chat failure — fail-closed, never a silent answer. */
export class ChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatError";
  }
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
): Promise<unknown> {
  let resp: Response;
  try {
    resp = await fetchImpl(
      `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          messages,
          // M62: optional structured output — forwarded as an OpenAI-compatible `response_format`
          // json_schema (the provider enforces it). Absent schema → no field (identical to today).
          ...(responseSchema
            ? { response_format: { type: "json_schema", json_schema: { name: "variant_schema", schema: responseSchema } } }
            : {}),
        }),
        // A stalled provider aborts at the timeout → fetch rejects → ChatError (never a silent hang).
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      },
    );
  } catch (err) {
    throw new ChatError(`chat request failed: ${String(err)}`);
  }
  if (!resp.ok) {
    throw new ChatError(`chat endpoint returned ${resp.status}`);
  }
  try {
    return await resp.json();
  } catch {
    throw new ChatError("chat response was not JSON");
  }
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
): Promise<string> {
  return extractContent(await requestChatCompletion(config, messages, fetchImpl));
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
): Promise<ChatCompletionWithUsage> {
  const body = await requestChatCompletion(config, messages, fetchImpl, responseSchema);
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

/** OpenAI-compatible {@link ChatClient} over {@link openaiChatCompletion}. */
export class OpenAICompatibleChat implements ChatClient {
  constructor(
    private readonly config: ChatConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  ask(messages: ChatMessage[]): Promise<string> {
    return openaiChatCompletion(this.config, messages, this.fetchImpl);
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

/** OpenAI-compatible {@link ReplayClient} over {@link openaiChatCompletionWithUsage}. */
export class OpenAICompatibleReplay implements ReplayClient {
  constructor(
    private readonly config: ChatConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async run(messages: ChatMessage[], modelOverride?: string, responseSchema?: object): Promise<ReplayResult> {
    // base_url/apiKey are ALWAYS the server config — only the model may be overridden (no SSRF: the
    // client can never redirect the call to a different endpoint). M62: an optional response schema is
    // forwarded as structured output (the provider enforces it).
    const model = modelOverride && modelOverride.trim() ? modelOverride.trim() : this.config.model;
    const usage = await openaiChatCompletionWithUsage({ ...this.config, model }, messages, this.fetchImpl, responseSchema);
    return { ...usage, model };
  }
}
