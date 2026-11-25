import { describe, it, expect } from "vitest";

const BASE = process.env["LOOPTRACE_E2E_BASE"] ?? "http://localhost:44318";

/**
 * Served-UI smoke (M7, T3.1 — DoD #1 mechanical proof): against the composed
 * stack from a clean `docker compose up`, the API serves the Trace Explorer UI
 * same-origin, falls back to index.html for client-side routes, and still
 * ingests + reads spans — proving the one-command stack is ready to use with no
 * second service and no manual migration.
 */
describe("Served UI from the composed stack (e2e)", () => {
  it("test_served_ui_root_returns_html", async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('id="root"');
  });

  it("test_served_ui_spa_route_falls_back_to_index", async () => {
    // A client-side route (no such file) must serve index.html, not 404.
    const res = await fetch(`${BASE}/traces/does-not-exist`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('id="root"');
  });

  it("test_span_roundtrips_through_served_stack", async () => {
    const envelope = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  spanId: "served-ui-span-1",
                  traceId: "served-ui-trace-1",
                  name: "checkout",
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000000250000000",
                },
              ],
            },
          ],
        },
      ],
    };
    const post = await fetch(`${BASE}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    expect(post.status).toBe(200);

    const get = await fetch(`${BASE}/v1/spans/served-ui-span-1`);
    expect(get.status).toBe(200);
    expect((await get.json()).spanId).toBe("served-ui-span-1");
  });
});
