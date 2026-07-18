/**
 * M55 — span-replay handler (`POST /v1/traces/:traceId/replay`). Re-runs an EDITED message list
 * against the real provider server-side and returns output + tokens + latency. Reads the workspace
 * from the Principal (never the body); `observability:read` scope is enforced at the route (D3 —
 * mirrors the M33 copilot: an ephemeral provider call, never a store write). Fail-closed: no provider
 * → 503; provider error → 502; rate-limited → 429; invalid body → 400 (error-handling.md). The trace
 * is read ONLY to authorize (a foreign/missing trace → 404, no billable call); it is NEVER mutated
 * (the M44 read-only-body invariant — the only persist path is save-as-dataset). The browser never
 * holds a provider key; base_url/apiKey stay server config (no SSRF surface).
 */
import type { Context } from "hono";

import {
  ChatError,
  replayResponseSchema,
  ProviderBreakerOpenError,
  errorBody,
  apiError,
  type ChatMessage,
  type RateLimiter,
  type ReplayClient,
  type SpanRepository,
} from "@usetheo/lens-core";

import { getPrincipal } from "../auth/middleware.js";
import { replayRuns, replayRateLimited, replayUnavailable } from "../metrics.js";

/** Deps the replay route needs (wired by the composition root — reuses the copilot provider config). */
export interface ReplayApiDeps {
  /** Read-only: authorizes the trace belongs to the caller's workspace (404 otherwise). Never written. */
  spanRepo: SpanRepository;
  /** null = no provider configured → the endpoint fails closed (503). */
  chat: ReplayClient | null;
  /** Per-workspace billable-abuse guard (429). */
  limiter: RateLimiter;
  /** Injected clock (ms) for the limiter + latency — defaults to Date.now. */
  now?: () => number;
}

const ROLES = new Set(["system", "user", "assistant"]);
const MAX_MESSAGES = 100;
const MAX_TOTAL_BYTES = 256 * 1024; // 256 KiB across all message content
const MAX_MODEL_LEN = 256;
const MAX_SCHEMA_BYTES = 32 * 1024; // 32 KiB for the optional structured-output schema (M62)

/** True for a plain JSON object (a valid structured-output schema shape) — not array/null/primitive. */
function isPlainObject(v: unknown): v is object {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate + normalize the edited messages + optional model + optional responseSchema. Throws a code
 *  string on any violation (fail-fast at the boundary — never forwards a malformed schema). */
function parseReplayBody(body: unknown): {
  messages: ChatMessage[];
  model: string | undefined;
  responseSchema: object | undefined;
} {
  const b = body as { messages?: unknown; model?: unknown; responseSchema?: unknown };
  if (!Array.isArray(b.messages) || b.messages.length === 0 || b.messages.length > MAX_MESSAGES) {
    throw "INVALID_BODY";
  }
  let totalBytes = 0;
  const messages: ChatMessage[] = [];
  for (const m of b.messages) {
    const mm = m as { role?: unknown; content?: unknown };
    if (typeof mm.role !== "string" || !ROLES.has(mm.role) || typeof mm.content !== "string") {
      throw "INVALID_BODY";
    }
    totalBytes += Buffer.byteLength(mm.content, "utf8");
    if (totalBytes > MAX_TOTAL_BYTES) throw "INVALID_BODY";
    messages.push({ role: mm.role as ChatMessage["role"], content: mm.content });
  }
  let model: string | undefined;
  if (b.model !== undefined) {
    if (typeof b.model !== "string" || b.model.length > MAX_MODEL_LEN) throw "INVALID_BODY";
    const trimmed = b.model.trim();
    model = trimmed === "" ? undefined : trimmed;
  }
  // M62: optional structured output — must be a plain JSON object (an OpenAI json_schema). A non-object
  // (string/array/number/null) is a client mistake → 400 before any billable call (error-handling.md).
  // Bounded to MAX_SCHEMA_BYTES so a huge/deep schema cannot inflate the billable provider request.
  let responseSchema: object | undefined;
  if (b.responseSchema !== undefined) {
    if (!isPlainObject(b.responseSchema)) throw "INVALID_SCHEMA";
    if (Buffer.byteLength(JSON.stringify(b.responseSchema), "utf8") > MAX_SCHEMA_BYTES) throw "INVALID_SCHEMA";
    responseSchema = b.responseSchema;
  }
  return { messages, model, responseSchema };
}

export async function replayHandler(c: Context, deps: ReplayApiDeps): Promise<Response> {
  const ws = getPrincipal(c).workspaceId;
  const clock = deps.now ?? Date.now;

  // Rate-limit first (protects the billable endpoint before any work, D3).
  const rlNow = clock();
  if (!deps.limiter.tryAcquire(ws, rlNow)) {
    replayRateLimited.add(1); // observable: an abuse/spike is visible at runtime (pillar c)
    c.header("Retry-After", String(deps.limiter.retryAfterSeconds(ws, rlNow))); // M94
    return c.json(errorBody("RATE_LIMITED", "replay rate limit exceeded"), 429);
  }
  // Fail-closed: no provider configured → disabled.
  if (deps.chat === null) {
    return c.json(errorBody("REPLAY_DISABLED", "replay is not configured"), 503);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(errorBody("INVALID_BODY", "invalid json body"), 400);
  }

  let parsed: { messages: ChatMessage[]; model: string | undefined; responseSchema: object | undefined };
  try {
    parsed = parseReplayBody(body);
  } catch (code) {
    // `code` is a domain-thrown code string (INVALID_BODY / INVALID_SCHEMA) — surfaced via apiError
    // (accepts an arbitrary string; the parser's codes are stable).
    return c.json(apiError(typeof code === "string" ? code : "INVALID_BODY", "invalid replay body"), 400);
  }

  // Authorize: the trace must belong to the caller's workspace. A foreign/missing trace → 404 and NO
  // billable provider call. Read-only (never mutates the trace — M44 read-only body).
  const traceId = c.req.param("traceId") ?? "";
  const tree = await deps.spanRepo.getTraceTree(traceId, ws);
  if (tree === null) {
    return c.json(errorBody("TRACE_NOT_FOUND", "trace not found"), 404);
  }

  const t0 = clock();
  try {
    const result = await deps.chat.run(parsed.messages, parsed.model, parsed.responseSchema);
    const latencyMs = Math.max(0, clock() - t0);
    replayRuns.add(1); // observable: healthy replay volume (pillar c)
    return c.json(
      // M118 (D4) — parse at the boundary so the OpenAPI stays the single source of truth (no drift).
      replayResponseSchema.parse({
        output: result.content,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        totalTokens: result.totalTokens,
        latencyMs,
        model: result.model,
        // M62: real provider cost when reported (undefined → omitted → the UI renders an em-dash).
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      }),
      200,
    );
  } catch (err) {
    // Fail-closed: surface the provider failure, never a fabricated/empty result.
    replayUnavailable.add(1); // observable: a provider-outage spike is visible (pillar c)
    // M118 — an OPEN provider circuit breaker fast-fails with 503 (provider down) vs 502 (per-call error).
    if (err instanceof ProviderBreakerOpenError) {
      return c.json(errorBody("REPLAY_UNAVAILABLE", "provider circuit open — temporarily unavailable"), 503);
    }
    const reason = err instanceof ChatError ? err.message : String(err);
    return c.json(errorBody("REPLAY_UNAVAILABLE", reason), 502);
  }
}
