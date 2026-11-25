import { describe, expect, it, vi } from "vitest";

// Import from the PUBLIC package entry (not the internal module) so this doubles as an export check.
import { LensApiError, LensReadClient } from "../index.js";

/** A mock engine routing by path — the responses the README quickstart relies on. */
function mockEngine(): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/v1/traces") {
      return new Response(
        JSON.stringify({ traces: [{ traceId: "t1", name: "chat" }], total: 1, limit: 50, offset: 0 }),
        { status: 200 },
      );
    }
    if (url.pathname === "/v1/metrics/observability") {
      return new Response(
        JSON.stringify({ range: "24h", traffic: [], latency: [], tokensByModel: [] }),
        { status: 200 },
      );
    }
    if (url.pathname.startsWith("/v1/spans/")) {
      return new Response(JSON.stringify({ code: "NOT_FOUND", message: "not found" }), {
        status: 404,
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("README quickstart — doc-smoke (M106)", () => {
  it("runs the documented flow: construct → listTraces → observability → typed error", async () => {
    // ─── BEGIN quickstart (this block is mirrored verbatim in README.md — keep in sync) ───
    const client = new LensReadClient({
      baseUrl: "https://api.getloopscale.com",
      apiKey: process.env["LENS_API_KEY"] ?? "looptrace_live_demo",
      // In real code, omit `fetch` to use the platform-native fetch; injected here for the doc-smoke.
      fetch: mockEngine(),
    });

    const { traces } = await client.listTraces({ limit: 50 });
    const metrics = await client.observability({ range: "24h" });

    let missing: LensApiError | undefined;
    try {
      await client.getSpan("missing-span");
    } catch (err) {
      if (err instanceof LensApiError && err.code === "NOT_FOUND") missing = err;
    }
    // ─── END quickstart ───

    expect(traces[0]?.name).toBe("chat");
    expect(metrics.range).toBe("24h");
    expect(missing?.status).toBe(404);
  });
});
