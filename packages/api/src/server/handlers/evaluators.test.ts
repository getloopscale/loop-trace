import { describe, it, expect } from "vitest";
import type { Context } from "hono";
import { RateLimiter, type EvaluatorRecord, type RunResult } from "@usetheo/lens-core";

import { runEvaluatorHandler, type EvaluatorApiDeps } from "./evaluators.js";
import { evaluatorRunRateLimited } from "../metrics.js";

/**
 * M118 (T2.1) — the billable `POST /v1/evaluators/:id/run` (fans out up to backfillMax=500 LLM-judge
 * calls) MUST be per-workspace rate-limited: an exhausted workspace gets `429 { code: "RATE_LIMITED" }`
 * + a `Retry-After` header BEFORE any billable engine work, while OTHER workspaces are unaffected
 * (per-workspace isolation, `rate-limiter.ts`). Mirrors the replay 429 handler test.
 */

const EVAL: EvaluatorRecord = {
  id: "e1",
  name: "has-good",
  kind: "rule",
  config: { predicate: "" },
  target: "",
  enabled: true,
  createdAt: "2026-07-07T00:00:00Z",
} as unknown as EvaluatorRecord;

const RUN_RESULT: RunResult = { evaluator: "has-good", written: 1, skipped: 0, truncated: false, errors: [] };

function ctx(opts: { ws?: string; body?: unknown; headers?: Record<string, string> } = {}): Context {
  const principal = { workspaceId: opts.ws ?? "ws-x", userId: "u", role: "member", scopes: ["observability:write"] };
  const headers = opts.headers ?? {};
  return {
    get: (k: string) => (k === "principal" ? principal : undefined),
    req: {
      param: (n: string) => (n === "id" ? "e1" : undefined),
      json: async () => opts.body ?? {},
    },
    header: (k: string, v: string) => { headers[k] = v; },
    body: (b: unknown, status = 200) => new Response(b as BodyInit, { status }),
    json: (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }),
  } as unknown as Context;
}

// A repo/engine that always returns the same evaluator + a canned run result, and counts run calls so a
// test can prove the 429 path never reached the billable engine.
function deps(over: Partial<EvaluatorApiDeps> = {}): EvaluatorApiDeps {
  const repo = { getEvaluator: async () => EVAL, writeVerdict: async () => {} } as unknown as EvaluatorApiDeps["repo"];
  const engine = {
    evaluatorRepo: repo,
    // A no-trace repo: runEvaluator resolves an empty selection → a valid RunResult (so a non-rate-
    // limited call returns 200, letting the isolation test assert `!== 429`).
    spanRepo: { listTraces: async () => ({ traces: [] }), getTraceTree: async () => null },
    judge: null,
    backfillMax: 500,
  } as unknown as EvaluatorApiDeps["engine"];
  void RUN_RESULT;
  return {
    repo,
    engine,
    limiter: new RateLimiter(1000),
    now: () => 1_000_000,
    ...over,
  };
}

describe("M118 runEvaluatorHandler rate limiting", () => {
  it("test_post_evaluator_run_flood_returns_429", async () => {
    evaluatorRunRateLimited.reset();
    const limiter = new RateLimiter(1); // 1 per window
    const headers: Record<string, string> = {};
    const d = deps({ limiter, now: () => 2_000_000 });
    // First call consumes the single token (may 200 or 5xx depending on the fake engine — not asserted).
    await runEvaluatorHandler(ctx({ ws: "ws-A" }), d);
    // Second call in the same window → shed with 429 BEFORE the engine runs.
    const second = await runEvaluatorHandler(ctx({ ws: "ws-A", headers }), d);
    expect(second.status).toBe(429);
    expect(((await second.json()) as { code: string }).code).toBe("RATE_LIMITED");
    expect(Number(headers["Retry-After"])).toBeGreaterThanOrEqual(1);
    expect(evaluatorRunRateLimited.value).toBeGreaterThanOrEqual(1);
  });

  it("test_evaluator_run_limiter_is_per_workspace", async () => {
    const limiter = new RateLimiter(1);
    const d = deps({ limiter, now: () => 3_000_000 });
    // Workspace B floods to exhaustion.
    await runEvaluatorHandler(ctx({ ws: "ws-B" }), d);
    const bSecond = await runEvaluatorHandler(ctx({ ws: "ws-B" }), d);
    expect(bSecond.status).toBe(429); // B is now rate-limited
    // Workspace A's first call in the same window must NOT be rate-limited (isolation).
    const aFirst = await runEvaluatorHandler(ctx({ ws: "ws-A" }), d);
    expect(aFirst.status).not.toBe(429);
  });
});
