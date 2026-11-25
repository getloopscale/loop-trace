import { describe, it, expect } from "vitest";

const BASE = process.env["LOOPTRACE_E2E_BASE"] ?? "http://localhost:44318";

describe("OTLP span round-trip (e2e)", () => {
  it("span_roundtrip_from_clean_compose", async () => {
    const span = {
      spanId: "e2e-span-1",
      traceId: "e2e-trace-1",
      name: "checkout",
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000000250000000",
    };
    const envelope = {
      resourceSpans: [{ scopeSpans: [{ spans: [span] }] }],
    };

    const post = await fetch(`${BASE}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    expect(post.status).toBe(200);

    const get = await fetch(`${BASE}/v1/spans/e2e-span-1`);
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject(span);
  });
});
