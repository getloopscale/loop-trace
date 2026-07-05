/**
 * M33 — "Ask about this step" copilot handler (`POST /v1/traces/:traceId/ask`). Reads
 * the workspace from the Principal (never the body, M22 inv-3); `observability:read` scope is
 * enforced at the route. Fail-closed (D2): no chat client → 503; chat error → 502;
 * never a fabricated answer. Per-workspace rate-limited (D3 → 429). Stateless (D4).
 */
import type { Context } from "hono";

import {
  buildCopilotPrompt,
  validateQuestion,
  capAnswer,
  CopilotError,
  ChatError,
  type ChatClient,
  type SpanRepository,
  type RateLimiter,
} from "@usetheo/lens-core";

import { getPrincipal } from "../auth/middleware.js";
import {
  copilotAsksAnswered,
  copilotAsksRateLimited,
  copilotAsksUnavailable,
} from "../metrics.js";

/** Deps the copilot route needs (wired by the composition root). */
export interface CopilotApiDeps {
  spanRepo: SpanRepository;
  /** null = no LLM provider configured → the endpoint fails closed (503). */
  chat: ChatClient | null;
  limiter: RateLimiter;
  /** Injected clock (ms) for the rate limiter — defaults to Date.now. */
  now?: () => number;
}

export async function askHandler(c: Context, deps: CopilotApiDeps): Promise<Response> {
  const ws = getPrincipal(c).workspaceId;
  const nowMs = (deps.now ?? Date.now)();

  // Rate-limit first (protects the whole endpoint, D3).
  if (!deps.limiter.tryAcquire(ws, nowMs)) {
    copilotAsksRateLimited.add(1); // observable: an abuse/spike is visible at runtime (pillar c)
    return c.json({ code: "RATE_LIMITED", message: "copilot rate limit exceeded" }, 429);
  }
  // Fail-closed: no provider configured → disabled (D2).
  if (deps.chat === null) {
    return c.json({ code: "COPILOT_DISABLED", message: "copilot is not configured" }, 503);
  }

  let body: { spanId?: unknown; question?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ code: "INVALID_BODY", message: "invalid json body" }, 400);
  }

  let question: string;
  try {
    question = validateQuestion(body.question); // EC-1
  } catch (err) {
    const code = err instanceof CopilotError ? err.code : "INVALID_QUESTION";
    return c.json({ code, message: (err as Error).message }, 400);
  }

  const traceId = c.req.param("traceId") ?? "";
  const tree = await deps.spanRepo.getTraceTree(traceId, ws);
  if (tree === null) {
    return c.json({ code: "TRACE_NOT_FOUND", message: "trace not found" }, 404);
  }

  const spanId = typeof body.spanId === "string" ? body.spanId : undefined;
  let messages;
  try {
    messages = buildCopilotPrompt(tree, spanId, question); // throws SPAN_NOT_FOUND (EC-2)
  } catch (err) {
    if (err instanceof CopilotError && err.code === "SPAN_NOT_FOUND") {
      return c.json({ code: "SPAN_NOT_FOUND", message: err.message }, 404);
    }
    throw err;
  }

  try {
    const answer = await deps.chat.ask(messages);
    copilotAsksAnswered.add(1); // observable: healthy answered-ask volume (pillar c)
    return c.json({ answer: capAnswer(answer) }, 200); // EC-6 cap
  } catch (err) {
    // Fail-closed: surface the LLM failure, never a fabricated/empty answer (D2).
    copilotAsksUnavailable.add(1); // observable: a provider-outage spike is visible (pillar c)
    const reason = err instanceof ChatError ? err.message : String(err);
    return c.json({ code: "COPILOT_UNAVAILABLE", message: reason }, 502);
  }
}
