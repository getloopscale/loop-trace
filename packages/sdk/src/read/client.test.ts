import { describe, expect, it, vi } from "vitest";

import { LensReadClient } from "./client.js";

const BASE = "https://lens.example.com";
const KEY = "theo_live_abc123";

/** A mock `fetch` that records the last call and returns a canned JSON 200 (override per test). */
function mockFetch(body: unknown, init?: { status?: number; text?: string }) {
  const status = init?.status ?? 200;
  const payload = init?.text !== undefined ? init.text : JSON.stringify(body);
  const fn = vi.fn(async () => new Response(payload, { status }));
  return fn as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

/** Extract the URL string the client fetched (input may be a URL, string, or Request). */
function calledUrl(fn: ReturnType<typeof vi.fn>): string {
  const input = fn.mock.calls[0]?.[0] as string | URL | Request;
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}
function calledInit(fn: ReturnType<typeof vi.fn>): RequestInit {
  return (fn.mock.calls[0]?.[1] ?? {}) as RequestInit;
}
function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe("LensReadClient — transport (T2.1)", () => {
  it("sets Bearer auth and builds the URL from baseUrl + path", async () => {
    const fetchFn = mockFetch({ traces: [], total: 0, limit: 0, offset: 0 });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.listTraces();
    expect(calledUrl(fetchFn)).toBe(`${BASE}/v1/traces`);
    expect(header(calledInit(fetchFn), "authorization")).toBe(`Bearer ${KEY}`);
  });

  it("omits undefined query params and sends no query string when opts are empty", async () => {
    const fetchFn = mockFetch({ traces: [], total: 0, limit: 0, offset: 0 });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.listTraces({ status: "error", limit: 10 });
    const url = new URL(calledUrl(fetchFn));
    expect(url.searchParams.get("status")).toBe("error");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.has("model")).toBe(false);
    expect(url.searchParams.has("offset")).toBe(false);
  });

  it("never sends a workspace param (invariant 2/3 — the key resolves it)", async () => {
    const fetchFn = mockFetch({ traces: [], total: 0, limit: 0, offset: 0 });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.listTraces({ status: "ok" });
    const url = new URL(calledUrl(fetchFn));
    expect(url.searchParams.has("workspace_id")).toBe(false);
    expect(url.searchParams.has("workspace")).toBe(false);
  });

  it("throws on a non-2xx naming the status and path (M103 minimal error)", async () => {
    const fetchFn = mockFetch(undefined, { status: 404, text: '{"code":"NOT_FOUND"}' });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await expect(client.getSpan("s1")).rejects.toThrow(/404/);
    await expect(client.getSpan("s1")).rejects.toThrow(/\/v1\/spans\/s1/);
  });

  it("throws a clear error on a malformed 200 body (never returns undefined)", async () => {
    const fetchFn = mockFetch(undefined, { status: 200, text: "not-json" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await expect(client.toolStats()).rejects.toThrow(/JSON/i);
  });

  it("sends a 0-valued query param (0 is not undefined — must not be dropped)", async () => {
    const fetchFn = mockFetch({ traces: [], total: 0, limit: 0, offset: 0 });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.listTraces({ offset: 0, limit: 0 });
    const url = new URL(calledUrl(fetchFn));
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("limit")).toBe("0");
  });

  it("fails fast at construction on a relative baseUrl (fail-clear, not a raw TypeError later)", () => {
    expect(() => new LensReadClient({ baseUrl: "lens.example.com", apiKey: KEY })).toThrow(
      /absolute URL/i,
    );
  });

  it("preserves a base path in baseUrl when appending the route", async () => {
    const fetchFn = mockFetch({ tools: [] });
    const client = new LensReadClient({ baseUrl: `${BASE}/api/`, apiKey: KEY, fetch: fetchFn });
    await client.toolStats();
    expect(calledUrl(fetchFn)).toBe(`${BASE}/api/v1/analytics/tools`);
  });
});

describe("LensReadClient — the 7 typed read methods (T2.2)", () => {
  it("listTraces maps sessionId → session_id and hits /v1/traces", async () => {
    const fetchFn = mockFetch({ traces: [{ traceId: "t1" }], total: 1, limit: 50, offset: 0 });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const res = await client.listTraces({ sessionId: "sess-1", model: "gpt-4" });
    const url = new URL(calledUrl(fetchFn));
    expect(url.pathname).toBe("/v1/traces");
    expect(url.searchParams.get("session_id")).toBe("sess-1");
    expect(url.searchParams.get("model")).toBe("gpt-4");
    expect(res.traces[0]?.traceId).toBe("t1");
  });

  it("getSpan path-escapes the spanId and hits /v1/spans/{id}", async () => {
    const fetchFn = mockFetch({ spanId: "a/b", traceId: "t", name: "x" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.getSpan("a/b");
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/spans/a%2Fb");
  });

  it("observability sends range and hits /v1/metrics/observability", async () => {
    const fetchFn = mockFetch({ range: "7d", traffic: [], latency: [], tokensByModel: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const res = await client.observability({ range: "7d" });
    const url = new URL(calledUrl(fetchFn));
    expect(url.pathname).toBe("/v1/metrics/observability");
    expect(url.searchParams.get("range")).toBe("7d");
    expect(res.range).toBe("7d");
  });

  it("listSessions sends limit/offset and hits /v1/sessions", async () => {
    const fetchFn = mockFetch({ sessions: [], total: 0, limit: 20, offset: 0 });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.listSessions({ limit: 20, offset: 40 });
    const url = new URL(calledUrl(fetchFn));
    expect(url.pathname).toBe("/v1/sessions");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("offset")).toBe("40");
  });

  it("costByPeriod sends period and hits /v1/analytics/cost", async () => {
    const fetchFn = mockFetch({ period: "day", buckets: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const res = await client.costByPeriod({ period: "day" });
    const url = new URL(calledUrl(fetchFn));
    expect(url.pathname).toBe("/v1/analytics/cost");
    expect(url.searchParams.get("period")).toBe("day");
    expect(res.period).toBe("day");
  });

  it("toolStats hits /v1/analytics/tools with no query", async () => {
    const fetchFn = mockFetch({ tools: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.toolStats();
    const url = new URL(calledUrl(fetchFn));
    expect(url.pathname).toBe("/v1/analytics/tools");
    expect(url.search).toBe("");
  });

  it("listDatasets hits /v1/datasets and returns an array", async () => {
    const fetchFn = mockFetch([{ id: "d1", name: "set" }]);
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const res = await client.listDatasets();
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/datasets");
    expect(Array.isArray(res)).toBe(true);
    expect(res[0]?.id).toBe("d1");
  });
});
