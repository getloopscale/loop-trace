import { describe, it, expect } from "vitest";

import {
  openaiChatCompletion,
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
