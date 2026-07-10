import { describe, expect, it, vi } from "vitest";

// Import from the PUBLIC package entry so this doubles as an export check for the write surface.
import { LensReadClient } from "../index.js";

/** A mock engine routing the write quickstart's calls by verb+path. */
function mockEngine(): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    if (method === "POST" && url.pathname === "/v1/datasets") {
      return new Response(JSON.stringify({ id: "d1", name: "regressions", createdAt: "t", itemCount: 0 }), {
        status: 200,
      });
    }
    if (method === "POST" && url.pathname === "/v1/datasets/d1/items") {
      return new Response(
        JSON.stringify({ id: "d1", name: "regressions", createdAt: "t", items: [{ traceId: "trace-123", createdAt: "t" }] }),
        { status: 200 },
      );
    }
    if (method === "POST" && url.pathname === "/v1/traces/trace-123/annotations") {
      // Faithful to the engine's AnnotationsResponse shape (name/annotatorKind/updatedAt all required).
      return new Response(
        JSON.stringify({
          annotations: [{ name: "feedback", label: "regression", annotatorKind: "HUMAN", updatedAt: "t" }],
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("README write quickstart — doc-smoke (M110)", () => {
  it("runs the documented curate flow: createDataset → addDatasetItem → annotateTrace", async () => {
    // ─── BEGIN write quickstart (mirrored verbatim in README.md § Write — keep in sync) ───
    const client = new LensReadClient({
      baseUrl: "https://api.usetheo.dev",
      apiKey: process.env["LENS_API_KEY"] ?? "theo_live_demo",
      fetch: mockEngine(), // in real code: omit `fetch`
    });

    const dataset = await client.createDataset({ name: "regressions" });
    const detail = await client.addDatasetItem(dataset.id, { traceId: "trace-123" });
    const annotated = await client.annotateTrace("trace-123", { label: "regression", note: "wrong tool call" });
    // ─── END write quickstart ───

    expect(dataset.id).toBe("d1");
    expect(detail.items.some((i) => i.traceId === "trace-123")).toBe(true);
    expect(annotated.annotations[0]?.label).toBe("regression");
  });
});
