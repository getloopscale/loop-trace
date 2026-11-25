import { describe, it, expect } from "vitest";
import { RateLimiter, type EvaluatorRecord } from "@looptrace/core";

import { createApp } from "./app.js";
import type { EvaluatorApiDeps } from "./handlers/evaluators.js";

/**
 * M118 (T3.1) — zod-at-the-boundary regression. Each advanced success response is `.parse()`-ed against
 * a server schema before `c.json`, so a handler returning an object with an EXTRA/leaked field is caught
 * at the boundary (→ 500 via onError), NOT silently shipped. A correct record passes and yields the same
 * JSON as before (behavior-preserving). Mirrors how `traceListResponseSchema.parse` guards the reads.
 */

const VALID_EVAL: EvaluatorRecord = {
  id: "e1", name: "has-good", kind: "rule", config: { predicate: "" }, target: "", enabled: true, createdAt: "2026-07-07T00:00:00Z",
} as unknown as EvaluatorRecord;

function appWith(created: unknown): ReturnType<typeof createApp> {
  const repo = {
    createEvaluator: async () => created,
    writeVerdict: async () => {},
  } as unknown as EvaluatorApiDeps["repo"];
  const deps: EvaluatorApiDeps = { repo, engine: {} as never, limiter: new RateLimiter(1000), now: () => 1 };
  return createApp({} as never, undefined, {}, deps);
}

function post(app: ReturnType<typeof createApp>): Promise<Response> {
  return app.request("/v1/evaluators", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "has-good", kind: "rule", config: { predicate: "" } }),
  });
}

describe("M118 boundary parse of advanced responses", () => {
  it("test_boundary_parse_accepts_valid_shape", async () => {
    const res = await post(appWith(VALID_EVAL));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The happy JSON is byte-identical to the validated record (no drift).
    expect(body).toEqual({ id: "e1", name: "has-good", kind: "rule", config: { predicate: "" }, target: "", enabled: true, createdAt: "2026-07-07T00:00:00Z" });
  });

  it("test_boundary_parse_rejects_extra_field", async () => {
    // A leaked persistence column (workspace_id) must be caught at the response boundary → 500.
    const leaky = { ...VALID_EVAL, workspace_id: "ws-secret" };
    const res = await post(appWith(leaky));
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
