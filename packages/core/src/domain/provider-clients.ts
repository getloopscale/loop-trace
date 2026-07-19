/**
 * M120 (D3) — the provider-client factory. Centralizes the fail-closed construction policy that
 * `bootstrap()` repeated 3× verbatim (`judgeConfig !== null ? new OpenAICompatible* : null`): a null
 * config yields a null client so the route 503s rather than fabricating an answer. Lives in the core
 * domain because every input (`JudgeConfig`) and output (`JudgeClient`/`ChatClient`/`ReplayClient`) is
 * core and the fail-closed rule is a core business policy (DIP — the domain defines it, the composition
 * root only wires it). `behavior_change: none` — same construction, one home.
 */
import { OpenAICompatibleJudge, type JudgeClient, type JudgeConfig } from "./evaluation/llm-judge.js";
import {
  OpenAICompatibleChat,
  OpenAICompatibleReplay,
  type ChatClient,
  type ReplayClient,
} from "./chat.js";

/** The three provider seams built from one config — each null when the provider is unconfigured. */
export interface ProviderClients {
  judge: JudgeClient | null;
  chat: ChatClient | null;
  replay: ReplayClient | null;
}

/**
 * Build the judge / chat / replay clients from a single provider config, applying the fail-closed
 * policy: a `null` config produces `{ judge: null, chat: null, replay: null }` (every provider route
 * then 503s); a real config produces one instance of each OpenAI-compatible client.
 */
export function createProviderClients(judgeConfig: JudgeConfig | null): ProviderClients {
  return {
    judge: judgeConfig !== null ? new OpenAICompatibleJudge(judgeConfig) : null,
    chat: judgeConfig !== null ? new OpenAICompatibleChat(judgeConfig) : null,
    replay: judgeConfig !== null ? new OpenAICompatibleReplay(judgeConfig) : null,
  };
}
