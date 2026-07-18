import { describe, expect, test } from "vitest";

import { createProviderClients } from "./provider-clients.js";
import { OpenAICompatibleJudge } from "./llm-judge.js";
import { OpenAICompatibleChat, OpenAICompatibleReplay } from "./chat.js";
import type { JudgeConfig } from "./llm-judge.js";

describe("createProviderClients", () => {
  test("test_create_provider_clients_fail_closed_when_config_null", () => {
    // Fail-closed policy: an unconfigured provider yields three null clients (routes 503 rather than
    // fabricating an answer) — identical to bootstrap()'s pre-extraction behavior.
    expect(createProviderClients(null)).toEqual({
      judge: null,
      chat: null,
      replay: null,
    });
  });

  test("test_create_provider_clients_builds_all_three_when_configured", () => {
    const config: JudgeConfig = {
      baseUrl: "https://example.test/v1",
      apiKey: undefined,
      model: "gpt-test",
    };
    const { judge, chat, replay } = createProviderClients(config);
    // Same wiring bootstrap did: one instance of each provider class per configured provider.
    expect(judge).toBeInstanceOf(OpenAICompatibleJudge);
    expect(chat).toBeInstanceOf(OpenAICompatibleChat);
    expect(replay).toBeInstanceOf(OpenAICompatibleReplay);
  });
});
