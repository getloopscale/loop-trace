import { describe, it, expect } from "vitest";

import {
  openaiChatCompletion,
  openaiChatCompletionWithUsage,
  OpenAICompatibleChat,
  OpenAICompatibleReplay,
  ChatError,
  type ChatConfig,
} from "./chat.js";

const cfg: ChatConfig = { baseUrl: "http://llm", apiKey: "k", model: "m" };

function fetchReturning(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response) as unknown as typeof fetch;
}
const content = (s: string) => fetchReturning(200, { choices: [{ message: { content: s } }] });

describe("M33 openaiChatCompletion (T1.1)", () => {
  it("test_chat_returns_content_on_2xx", async () => {
    expect(await openaiChatCompletion(cfg, [{ role: "user", content: "hi" }], content("hello"))).toBe("hello");
  });
  it("test_chat_throws_on_non_2xx", async () => {
    await expect(openaiChatCompletion(cfg, [], fetchReturning(503, {}))).rejects.toBeInstanceOf(ChatError);
  });
  it("test_chat_throws_on_network_error", async () => {
    const failing = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    await expect(openaiChatCompletion(cfg, [], failing)).rejects.toBeInstanceOf(ChatError);
  });
  it("test_chat_throws_on_missing_content", async () => {
    await expect(openaiChatCompletion(cfg, [], fetchReturning(200, { choices: [] }))).rejects.toBeInstanceOf(ChatError);
  });
  it("test_chat_client_ask_delegates", async () => {
    const c = new OpenAICompatibleChat(cfg, content("answer"));
    expect(await c.ask([{ role: "user", content: "q" }])).toBe("answer");
  });
});

describe("M55 openaiChatCompletionWithUsage (T1.1) — captures the provider usage block", () => {
  const withUsage = fetchReturning(200, {
    choices: [{ message: { content: "hi" } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

  it("test_chat_completion_with_usage_returns_content_and_tokens", async () => {
    const r = await openaiChatCompletionWithUsage(cfg, [{ role: "user", content: "q" }], withUsage);
    expect(r).toEqual({ content: "hi", promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it("test_chat_completion_with_usage_defaults_missing_usage_to_zero (content required, usage optional)", async () => {
    // usage is optional in the OpenAI-compatible response — a missing block is 0s, never a throw.
    const r = await openaiChatCompletionWithUsage(cfg, [], content("only text"));
    expect(r).toEqual({ content: "only text", promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it("test_chat_completion_with_usage_fail_closed (same as the sibling)", async () => {
    await expect(openaiChatCompletionWithUsage(cfg, [], fetchReturning(503, {}))).rejects.toBeInstanceOf(ChatError);
    await expect(openaiChatCompletionWithUsage(cfg, [], fetchReturning(200, { choices: [] }))).rejects.toBeInstanceOf(ChatError);
  });

  it("test_chat_completion_times_out (a stalled provider → ChatError, never a hang)", async () => {
    // A fetch that rejects like an aborted request (the AbortSignal.timeout path) → ChatError.
    const aborting = (async () => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    }) as unknown as typeof fetch;
    await expect(openaiChatCompletionWithUsage(cfg, [], aborting)).rejects.toBeInstanceOf(ChatError);
  });
});

// A fetch that records the request body it was called with (to assert response_format forwarding).
function recordingFetch(): { impl: typeof fetch; body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  const impl = (async (_url: string, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 2 } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, body: () => captured };
}

describe("M62 replay cost + structured output", () => {
  it("test_usage_extraction_reads_cost_when_present", async () => {
    const withCost = fetchReturning(200, {
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12, cost: 3.15e-6 },
    });
    const r = await openaiChatCompletionWithUsage(cfg, [{ role: "user", content: "q" }], withCost);
    expect(r.costUsd).toBe(3.15e-6);
  });

  it("test_usage_extraction_costUsd_undefined_when_absent", async () => {
    // usage present but without `cost` (a strict OpenAI provider) → undefined, never 0 / NaN.
    const noCost = fetchReturning(200, {
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const r = await openaiChatCompletionWithUsage(cfg, [], noCost);
    expect(r.costUsd).toBeUndefined();
  });

  it("test_chat_forwards_responseSchema_as_response_format", async () => {
    const rec = recordingFetch();
    const schema = { type: "object", properties: { answer: { type: "string" } } };
    await openaiChatCompletionWithUsage(cfg, [{ role: "user", content: "q" }], rec.impl, schema);
    const rf = rec.body()["response_format"] as { type?: string; json_schema?: { schema?: unknown } };
    expect(rf?.type).toBe("json_schema");
    expect(rf?.json_schema?.schema).toEqual(schema);
  });

  it("test_chat_omits_response_format_when_no_schema", async () => {
    const rec = recordingFetch();
    await openaiChatCompletionWithUsage(cfg, [{ role: "user", content: "q" }], rec.impl);
    expect(rec.body()["response_format"]).toBeUndefined();
  });

  it("test_replay_run_threads_schema_and_returns_cost", async () => {
    const rec = recordingFetch();
    const replay = new OpenAICompatibleReplay(cfg, rec.impl);
    const schema = { type: "object" };
    const r = await replay.run([{ role: "user", content: "q" }], undefined, schema);
    expect((rec.body()["response_format"] as { type?: string })?.type).toBe("json_schema");
    expect(r.model).toBe("m");
  });
});
