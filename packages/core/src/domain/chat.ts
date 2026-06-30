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
 * Call an OpenAI-compatible `/chat/completions` and return the assistant's text.
 * Pins temperature 0. Throws {@link ChatError} on any failure (fail-closed).
 */
export async function openaiChatCompletion(
  config: ChatConfig,
  messages: ChatMessage[],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
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
        body: JSON.stringify({ model: config.model, temperature: 0, messages }),
      },
    );
  } catch (err) {
    throw new ChatError(`chat request failed: ${String(err)}`);
  }
  if (!resp.ok) {
    throw new ChatError(`chat endpoint returned ${resp.status}`);
  }
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new ChatError("chat response was not JSON");
  }
  const content = (body as { choices?: { message?: { content?: unknown } }[] })
    ?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new ChatError("chat response missing choices[0].message.content");
  }
  return content;
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
