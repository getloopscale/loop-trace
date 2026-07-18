import { describe, it, expect } from "vitest";
import { RateLimiter, ERROR_CODES, type ChatClient } from "@usetheo/lens-core";

import { createApp } from "./app.js";
import type { CopilotApiDeps } from "./handlers/copilot.js";

/**
 * M118 (T5.1 / D3) — the error-envelope migration is behavior-preserving at the wire: a representative
 * formerly-inline route still returns its exact code string (R5), and every returned code is a member of
 * the stable `ERROR_CODES` union. Proven end-to-end through a real route (copilot 429/503).
 */

function buildApp(over: { chat?: ChatClient | null; limiter?: RateLimiter } = {}): ReturnType<typeof createApp> {
  const repo = new Proxy({}, { get: () => async () => null }) as never;
  const copilot: CopilotApiDeps = {
    spanRepo: repo,
    chat: over.chat === undefined ? { ask: async () => "ok" } : over.chat,
    limiter: over.limiter ?? new RateLimiter(1000),
    now: () => 1,
  };
  return createApp(repo, undefined, {}, undefined, copilot);
}

function ask(app: ReturnType<typeof createApp>): Promise<Response> {
  return app.request("/v1/traces/t1/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "why?" }),
  });
}

describe("M118 error envelope through a real route", () => {
  it("test_migration_preserves_exact_code_string (429 RATE_LIMITED)", async () => {
    const app = buildApp({ limiter: new RateLimiter(1) });
    await ask(app); // consume the single token
    const res = await ask(app); // shed → 429
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("RATE_LIMITED"); // exact string preserved (R5)
    expect((ERROR_CODES as readonly string[]).includes(body.code)).toBe(true);
  });

  it("copilot_disabled_returns_typed_503_envelope", async () => {
    const app = buildApp({ chat: null });
    const res = await ask(app);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("COPILOT_DISABLED");
    expect((ERROR_CODES as readonly string[]).includes(body.code)).toBe(true);
    // The envelope shape is exactly { code, message } (no extra keys).
    expect(Object.keys(body).sort()).toEqual(["code", "message"]);
  });
});
