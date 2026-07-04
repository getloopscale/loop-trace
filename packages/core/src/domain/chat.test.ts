import { describe, it, expect } from "vitest";

import {
  openaiChatCompletion,
  openaiChatCompletionWithUsage,
  OpenAICompatibleChat,
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
});
