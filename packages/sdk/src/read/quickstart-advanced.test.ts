import { describe, expect, it, vi } from "vitest";

import { LensReadClient } from "../index.js";

/** A mock engine for the README "Advanced" quickstart (create evaluator → run). */
function mockEngine(): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    if (method === "POST" && url.pathname === "/v1/evaluators") {
      return new Response(
        JSON.stringify({ id: "ev1", name: "errors", kind: "rule", config: { predicate: "status:error" }, target: "", enabled: true, createdAt: "t" }),
        { status: 200 },
      );
    }
    // M133: run is asynchronous — 202 + a job the client polls. The SDK keeps a
    // synchronous `runEvaluator` by polling internally, so the doc-smoke must
    // serve BOTH halves or it would prove nothing about the real flow.
    if (method === "POST" && url.pathname === "/v1/evaluators/ev1/run") {
      return new Response(
        JSON.stringify({ id: "job1", evaluatorId: "ev1", evaluatorName: "errors", status: "queued", total: 12, scored: 0, skipped: 0, errors: 0, errorDetails: [], truncated: false, createdAt: "t", updatedAt: "t" }),
        { status: 202 },
      );
    }
    if (method === "GET" && url.pathname === "/v1/evaluator-run-jobs/job1") {
      return new Response(
        JSON.stringify({ id: "job1", evaluatorId: "ev1", evaluatorName: "errors", status: "completed", total: 12, scored: 12, skipped: 0, errors: 0, errorDetails: [], truncated: false, createdAt: "t", updatedAt: "t" }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("README advanced quickstart — doc-smoke (M114)", () => {
  it("runs the documented flow: createEvaluator → runEvaluator", async () => {
    // ─── BEGIN advanced quickstart (mirrored in README.md § Advanced — keep in sync) ───
    const client = new LensReadClient({
      baseUrl: "https://api.usetheo.dev",
      apiKey: process.env["LENS_API_KEY"] ?? "theo_live_demo",
      fetch: mockEngine(), // in real code: omit `fetch`
    });

    const evaluator = await client.createEvaluator({
      name: "errors",
      kind: "rule",
      config: { predicate: "status:error" },
    });
    const result = await client.runEvaluator(evaluator.id, { limit: 100 });
    // ─── END advanced quickstart ───

    expect(evaluator.id).toBe("ev1");
    expect(result.written).toBe(12);
  });
});
