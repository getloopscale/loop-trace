import { afterEach, describe, expect, it, vi } from "vitest";

import { LensReadClient } from "./client.js";
import { LensApiError } from "./errors.js";

const BASE = "https://lens.example.com";
const KEY = "theo_live_abc123";

/** A mock `fetch` that records the last call and returns a canned JSON 200 (override per test). */
function mockFetch(body: unknown, init?: { status?: number; text?: string }) {
  const status = init?.status ?? 200;
  const payload = init?.text !== undefined ? init.text : JSON.stringify(body);
  // 204/205/304 forbid a body — the Response constructor throws on a non-null body for those.
  const noBody = status === 204 || status === 205 || status === 304;
  const fn = vi.fn(async () => new Response(noBody ? null : payload, { status }));
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

  // #49 — reach the capability through the unified edge by swapping the /v1 root for a basePath.
  it("basePath /v1/lens routes a read through the edge prefix", async () => {
    const fetchFn = mockFetch({ traces: [], total: 0, limit: 0, offset: 0 });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, basePath: "/v1/lens", fetch: fetchFn });
    await client.listTraces();
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/lens/traces");
  });

  it("basePath /v1/lens routes a nested path + a write correctly (no double /v1)", async () => {
    const fetchFn = mockFetch({ id: "d1", name: "s" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, basePath: "/v1/lens", fetch: fetchFn });
    await client.createDataset({ name: "s" });
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/lens/datasets");
  });

  it("basePath /v1/lens maps the discovery root /v1 → /v1/lens", async () => {
    const fetchFn = mockFetch({ service: "theo-lens", version: "x", capability: "observability", openapi: "/openapi.json", docs: "/openapi.json" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, basePath: "/v1/lens", fetch: fetchFn });
    await client.capabilities();
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/lens");
  });

  it("default basePath is /v1 (direct-to-engine, unchanged behavior)", async () => {
    const fetchFn = mockFetch({ tools: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.toolStats();
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/analytics/tools");
  });

  it("rejects a basePath that does not start with /", () => {
    expect(() => new LensReadClient({ baseUrl: BASE, apiKey: KEY, basePath: "v1/lens" })).toThrow(/basePath/);
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

  it("listDatasets hits /v1/datasets and returns the { datasets } wrapper", async () => {
    const fetchFn = mockFetch({ datasets: [{ id: "d1", name: "set" }] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const res = await client.listDatasets();
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/datasets");
    expect(Array.isArray(res.datasets)).toBe(true);
    expect(res.datasets[0]?.id).toBe("d1");
  });

  it("capabilities hits /v1 and returns service + version + openapi pointer", async () => {
    const fetchFn = mockFetch({
      service: "theo-lens",
      version: "1.2.3",
      capability: "observability",
      openapi: "/openapi.json",
      docs: "/openapi.json",
    });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const res = await client.capabilities();
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1");
    expect(res.service).toBe("theo-lens");
    expect(res.version).toBe("1.2.3");
    expect(res.openapi).toBe("/openapi.json");
  });
});

/** A fetch returning queued responses/rejects in order (last item repeats if calls exceed the queue). */
function seqFetch(items: Array<Response | Error>) {
  let i = 0;
  const fn = vi.fn(async () => {
    const item = items[Math.min(i, items.length - 1)];
    i += 1;
    if (item instanceof Error) throw item;
    return item as Response;
  });
  return fn as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number, headers?: Record<string, string>) =>
  new Response("", { status: code, ...(headers ? { headers } : {}) });
/** Fixed jitter → 0.8 + 0.5·0.4 = 1.0 (no jitter) so exp-backoff delays are exact. */
const NO_JITTER = () => 0.5;

describe("LensReadClient — resilient transport (M104)", () => {
  afterEach(() => vi.useRealTimers());

  it("retries a 503 once then resolves (2 calls, one backoff of base·2^0)", async () => {
    const fetchFn = seqFetch([status(503), ok({ tools: [] })]);
    const delays: number[] = [];
    const client = new LensReadClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: fetchFn,
      sleep: async (ms) => void delays.push(ms),
      random: NO_JITTER,
    });
    await client.toolStats();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([500]);
  });

  it("fails fast on a fatal 400 — single call, no backoff, typed error", async () => {
    const fetchFn = seqFetch([status(400)]);
    const delays: number[] = [];
    const client = new LensReadClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: fetchFn,
      sleep: async (ms) => void delays.push(ms),
    });
    await expect(client.toolStats()).rejects.toBeInstanceOf(LensApiError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("honors Retry-After seconds on a 429", async () => {
    const fetchFn = seqFetch([status(429, { "retry-after": "2" }), ok({ tools: [] })]);
    const delays: number[] = [];
    const client = new LensReadClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: fetchFn,
      sleep: async (ms) => void delays.push(ms),
    });
    await client.toolStats();
    expect(delays).toEqual([2000]);
  });

  it("falls back to exp-backoff for a 429 WITHOUT a Retry-After header", async () => {
    const fetchFn = seqFetch([status(429), ok({ tools: [] })]);
    const delays: number[] = [];
    const client = new LensReadClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: fetchFn,
      sleep: async (ms) => void delays.push(ms),
      random: NO_JITTER,
    });
    await client.toolStats();
    expect(delays).toEqual([500]);
  });

  it("retries a timeout abort then succeeds (timeout is in the retryable set)", async () => {
    const fetchFn = seqFetch([new DOMException("aborted", "AbortError"), ok({ tools: [] })]);
    const client = new LensReadClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: fetchFn,
      maxRetries: 1,
      sleep: async () => {},
    });
    await client.toolStats();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("caps retries at maxRetries then throws the typed error (maxRetries+1 calls)", async () => {
    const fetchFn = seqFetch([status(503), status(503), status(503), status(503)]);
    const client = new LensReadClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: fetchFn,
      maxRetries: 2,
      sleep: async () => {},
      random: NO_JITTER,
    });
    await expect(client.toolStats()).rejects.toMatchObject({
      code: "UNEXPECTED_RESPONSE",
      status: 503,
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("retries a network reject then throws NETWORK_ERROR", async () => {
    const fetchFn = seqFetch([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")]);
    const client = new LensReadClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: fetchFn,
      maxRetries: 2,
      sleep: async () => {},
    });
    await expect(client.toolStats()).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("aborts a hung request at timeoutMs and throws TIMEOUT", async () => {
    vi.useFakeTimers();
    const hanging = vi.fn(
      (_url: unknown, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;
    const client = new LensReadClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: hanging,
      maxRetries: 0,
      timeoutMs: 100,
    });
    const p = client.toolStats();
    const assertion = expect(p).rejects.toMatchObject({ code: "TIMEOUT", status: 0 });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it("keeps exp-backoff jitter within ±20% and under the cap", async () => {
    for (const rnd of [() => 0, () => 0.999999]) {
      const fetchFn = seqFetch([status(503), ok({ tools: [] })]);
      const delays: number[] = [];
      const client = new LensReadClient({
        baseUrl: BASE,
        apiKey: KEY,
        fetch: fetchFn,
        sleep: async (ms) => void delays.push(ms),
        random: rnd,
      });
      await client.toolStats();
      // base = 500 at attempt 0; jitter multiplier ∈ [0.8, 1.2] → delay ∈ [400, 600] (rounded)
      expect(delays[0]).toBeGreaterThanOrEqual(400);
      expect(delays[0]).toBeLessThanOrEqual(600);
    }
  });
});

function methodOf(fn: ReturnType<typeof vi.fn>): string {
  return (calledInit(fn).method ?? "GET") as string;
}
function bodyOf(fn: ReturnType<typeof vi.fn>): unknown {
  const raw = calledInit(fn).body;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

describe("LensReadClient — write surface (M107)", () => {
  it("createDataset POSTs {name} to /v1/datasets with content-type json", async () => {
    const fetchFn = mockFetch({ id: "d1", name: "eval-set" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const res = await client.createDataset({ name: "eval-set" });
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/datasets");
    expect(methodOf(fetchFn)).toBe("POST");
    expect(bodyOf(fetchFn)).toEqual({ name: "eval-set" });
    expect(header(calledInit(fetchFn), "content-type")).toBe("application/json");
    expect(res.id).toBe("d1");
  });

  it("updateDataset PUTs {name} to /v1/datasets/{id}", async () => {
    const fetchFn = mockFetch({ id: "d1", name: "renamed" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.updateDataset("d1", { name: "renamed" });
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/datasets/d1");
    expect(methodOf(fetchFn)).toBe("PUT");
    expect(bodyOf(fetchFn)).toEqual({ name: "renamed" });
  });

  it("deleteDataset DELETEs /v1/datasets/{id} and resolves void on a 204", async () => {
    const fetchFn = mockFetch(undefined, { status: 204, text: "" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const res = await client.deleteDataset("d1");
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/datasets/d1");
    expect(methodOf(fetchFn)).toBe("DELETE");
    expect(res).toBeUndefined();
  });

  it("addDatasetItem POSTs the body to /v1/datasets/{id}/items", async () => {
    const fetchFn = mockFetch({ id: "d1", name: "s", items: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.addDatasetItem("d1", { traceId: "t1" });
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/datasets/d1/items");
    expect(methodOf(fetchFn)).toBe("POST");
    expect(bodyOf(fetchFn)).toEqual({ traceId: "t1" });
  });

  it("removeDatasetItem DELETEs /v1/datasets/{id}/items/{traceId}", async () => {
    const fetchFn = mockFetch({ id: "d1", name: "s", items: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.removeDatasetItem("d1", "t/1");
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/datasets/d1/items/t%2F1");
    expect(methodOf(fetchFn)).toBe("DELETE");
  });

  it("annotateTrace POSTs the annotation to /v1/traces/{id}/annotations", async () => {
    const fetchFn = mockFetch({ annotations: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.annotateTrace("tr1", { label: "good", note: "n" });
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/traces/tr1/annotations");
    expect(methodOf(fetchFn)).toBe("POST");
    expect(bodyOf(fetchFn)).toEqual({ label: "good", note: "n" });
  });

  it("deleteAnnotations DELETEs /v1/traces/{id}/annotations", async () => {
    const fetchFn = mockFetch({ annotations: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const res = await client.deleteAnnotations("tr1");
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/traces/tr1/annotations");
    expect(methodOf(fetchFn)).toBe("DELETE");
    expect(Array.isArray(res.annotations)).toBe(true);
  });

  it("tagTrace POSTs {tag} to /v1/traces/{id}/tags", async () => {
    const fetchFn = mockFetch({ tags: ["urgent"] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const res = await client.tagTrace("tr1", { tag: "urgent" });
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/traces/tr1/tags");
    expect(methodOf(fetchFn)).toBe("POST");
    expect(bodyOf(fetchFn)).toEqual({ tag: "urgent" });
    expect(res.tags).toContain("urgent");
  });

  it("untagTrace DELETEs /v1/traces/{id}/tags with the tag as a query param", async () => {
    const fetchFn = mockFetch({ tags: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.untagTrace("tr1", "urgent");
    const url = new URL(calledUrl(fetchFn));
    expect(url.pathname).toBe("/v1/traces/tr1/tags");
    expect(url.searchParams.get("tag")).toBe("urgent");
    expect(methodOf(fetchFn)).toBe("DELETE");
  });

  it("retries an idempotent write on BOTH a 503 and a network reject (M108 — idempotency-justified)", async () => {
    // 503 (server-signaled) → retried then succeeds.
    const f503 = seqFetch([status(503), ok({ id: "d1", name: "s" })]);
    const c1 = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: f503, sleep: async () => {} });
    await c1.createDataset({ name: "s" });
    expect(f503).toHaveBeenCalledTimes(2);

    // network reject on an idempotent write → RETRIED then succeeds (safe — the engine de-dups).
    const fNet = seqFetch([new TypeError("boom"), ok({ id: "d1", name: "s" })]);
    const c2 = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fNet, sleep: async () => {} });
    await c2.createDataset({ name: "s" });
    expect(fNet).toHaveBeenCalledTimes(2);
  });

  it("addDatasetItem retries a network reject for a traceId item (idempotent path)", async () => {
    const fNet = seqFetch([new TypeError("boom"), ok({ id: "d1", name: "s", items: [] })]);
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fNet, sleep: async () => {} });
    await client.addDatasetItem("d1", { traceId: "t1" });
    expect(fNet).toHaveBeenCalledTimes(2);
  });

  it("addDatasetItem does NOT retry a network reject for a synthetic item (not idempotent — no double-insert)", async () => {
    const fNet = seqFetch([new TypeError("boom"), ok({ id: "d1", name: "s", items: [] })]);
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fNet, sleep: async () => {} });
    await expect(client.addDatasetItem("d1", { input: "prompt", output: "resp" })).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    expect(fNet).toHaveBeenCalledTimes(1);
  });

  it("caps an idempotent write's network retries then throws NETWORK_ERROR (M108)", async () => {
    const fNet = seqFetch([new TypeError("x"), new TypeError("x"), new TypeError("x")]);
    const client = new LensReadClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch: fNet,
      maxRetries: 2,
      sleep: async () => {},
    });
    await expect(client.deleteDataset("d1")).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
    expect(fNet).toHaveBeenCalledTimes(3);
  });

  // Typed mutation-error matrix (M108) — every write failure class → a LensApiError to switch on.
  it("maps a 409 NAME_CONFLICT to a typed LensApiError", async () => {
    const fetchFn = mockFetch(undefined, { status: 409, text: '{"code":"NAME_CONFLICT","message":"taken"}' });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await expect(client.updateDataset("d1", { name: "dup" })).rejects.toMatchObject({
      status: 409,
      code: "NAME_CONFLICT",
    });
  });

  it("maps a 400 INVALID_BODY on a write to a typed LensApiError (bare message, no details)", async () => {
    const fetchFn = mockFetch(undefined, {
      status: 400,
      text: '{"code":"INVALID_BODY","message":"annotation requires a label or a note"}',
    });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const err = await client.annotateTrace("tr1", {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LensApiError);
    expect((err as LensApiError).status).toBe(400);
    expect((err as LensApiError).code).toBe("INVALID_BODY");
    expect((err as LensApiError).details).toBeUndefined();
  });

  it("maps a 404 NOT_FOUND on a write (missing target) to a typed LensApiError", async () => {
    const fetchFn = mockFetch(undefined, { status: 404, text: '{"code":"NOT_FOUND","message":"not found"}' });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await expect(client.addDatasetItem("missing", { traceId: "t1" })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });
});

describe("LensReadClient — evaluators + guards (M111)", () => {
  it("createEvaluator POSTs the union body to /v1/evaluators", async () => {
    const fetchFn = mockFetch({ id: "ev1", name: "quality", kind: "rule", config: { predicate: "status:error" }, createdAt: "t" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const rec = await client.createEvaluator({ name: "quality", kind: "rule", config: { predicate: "status:error" } });
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/evaluators");
    expect(methodOf(fetchFn)).toBe("POST");
    expect(bodyOf(fetchFn)).toEqual({ name: "quality", kind: "rule", config: { predicate: "status:error" } });
    expect(rec.id).toBe("ev1");
  });

  it("updateEvaluator PUTs to /v1/evaluators/{id}", async () => {
    const fetchFn = mockFetch({ id: "ev1", name: "quality", kind: "rule", config: { predicate: "x" }, createdAt: "t", enabled: false });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.updateEvaluator("ev1", { enabled: false });
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/evaluators/ev1");
    expect(methodOf(fetchFn)).toBe("PUT");
    expect(bodyOf(fetchFn)).toEqual({ enabled: false });
  });

  it("deleteEvaluator DELETEs /v1/evaluators/{id} (204 → void)", async () => {
    const fetchFn = mockFetch(undefined, { status: 204, text: "" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.deleteEvaluator("ev1");
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/evaluators/ev1");
    expect(methodOf(fetchFn)).toBe("DELETE");
  });

  it("runEvaluator POSTs to /v1/evaluators/{id}/run and returns a RunResult", async () => {
    // M133 made the endpoint async (202 + poll). `runEvaluator` keeps its
    // synchronous signature by polling internally — a consumer asked for a
    // result, not a job handle — so the mock serves both halves.
    const fetchFn = seqFetch([
      ok({ id: "job1", evaluatorId: "ev1", evaluatorName: "quality", status: "queued", total: 5, scored: 0, skipped: 0, errors: 0, errorDetails: [], truncated: false, createdAt: "t", updatedAt: "t" }),
      ok({ id: "job1", evaluatorId: "ev1", evaluatorName: "quality", status: "completed", total: 5, scored: 5, skipped: 0, errors: 0, errorDetails: [], truncated: false, createdAt: "t", updatedAt: "t" }),
    ]);
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const res = await client.runEvaluator("ev1", { limit: 10 });
    expect(new URL(String(fetchFn.mock.calls[0]![0])).pathname).toBe("/v1/evaluators/ev1/run");
    expect(res.evaluator).toBe("quality");
    expect(res.written).toBe(5);
  });

  it("runEvaluator does NOT retry a network reject (non-idempotent — no double-scoring)", async () => {
    const fNet = seqFetch([new TypeError("boom"), ok({ evaluator: "q", written: 1, skipped: 0, truncated: false, errors: [] })]);
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fNet, sleep: async () => {} });
    await expect(client.runEvaluator("ev1")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fNet).toHaveBeenCalledTimes(1);
  });

  it("createMonitor POSTs to /v1/guards and returns a MonitorRecord", async () => {
    const fetchFn = mockFetch({ id: "g1", evaluatorId: "ev1", operator: "gte", threshold: 0.8, createdAt: "t" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const g = await client.createMonitor({ evaluatorId: "ev1", operator: "gte", threshold: 0.8 });
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/guards");
    expect(methodOf(fetchFn)).toBe("POST");
    expect(g.id).toBe("g1");
  });

  it("deleteMonitor DELETEs /v1/guards/{id} (204 → void)", async () => {
    const fetchFn = mockFetch(undefined, { status: 204, text: "" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.deleteMonitor("g1");
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/guards/g1");
    expect(methodOf(fetchFn)).toBe("DELETE");
  });

  it("maps a 400 INVALID_EVALUATOR (with details) to a typed LensApiError", async () => {
    const fetchFn = mockFetch(undefined, {
      status: 400,
      text: '{"code":"INVALID_EVALUATOR","message":"invalid evaluator","details":[{"field":"config.predicate","issue":"required"}]}',
    });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const err = await client
      .createEvaluator({ name: "x", kind: "rule", config: { predicate: "" } })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LensApiError);
    expect((err as LensApiError).code).toBe("INVALID_EVALUATOR");
    expect((err as LensApiError).details?.[0]?.field).toBe("config.predicate");
  });
});

describe("LensReadClient — labeling queue + ask-feedback (M112)", () => {
  it("enqueueForLabeling POSTs {spanId} to the enqueue route", async () => {
    const fetchFn = mockFetch({ id: "lq1", traceId: "tr1", spanId: "sp1", status: "pending", createdBy: "u", createdAt: "t" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const item = await client.enqueueForLabeling("tr1", { spanId: "sp1" });
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/traces/tr1/enqueue-for-labeling");
    expect(methodOf(fetchFn)).toBe("POST");
    expect(bodyOf(fetchFn)).toEqual({ spanId: "sp1" });
    expect(item.status).toBe("pending");
  });

  it("resolveLabelingItem POSTs the label and does NOT retry a network reject (conservative)", async () => {
    const fNet = seqFetch([new TypeError("boom"), ok({ id: "lq1", traceId: "tr1", spanId: "sp1", status: "resolved", createdBy: "u", createdAt: "t" })]);
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fNet, sleep: async () => {} });
    await expect(client.resolveLabelingItem("lq1", { label: "good" })).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fNet).toHaveBeenCalledTimes(1);
    expect(new URL(calledUrl(fNet)).pathname).toBe("/v1/labeling-queue/lq1/resolve");
  });

  it("exportLabelingAsDataset POSTs {name} and does NOT retry a network reject (conservative)", async () => {
    const fNet = seqFetch([new TypeError("boom"), ok({ id: "d1", name: "golden" })]);
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fNet, sleep: async () => {} });
    await expect(client.exportLabelingAsDataset({ name: "golden" })).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fNet).toHaveBeenCalledTimes(1);
    expect(new URL(calledUrl(fNet)).pathname).toBe("/v1/labeling-queue/export-as-dataset");
  });

  it("submitAskFeedback POSTs {turnId,label} (upsert → network-retryable)", async () => {
    const fetchFn = mockFetch({ id: "fb1", traceId: "tr1", turnId: "turn-1", label: "up", updatedAt: "t" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const rec = await client.submitAskFeedback("tr1", { turnId: "turn-1", label: "up" });
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/traces/tr1/ask/feedback");
    expect(methodOf(fetchFn)).toBe("POST");
    expect(bodyOf(fetchFn)).toEqual({ turnId: "turn-1", label: "up" });
    expect(rec.label).toBe("up");
  });

  it("deleteAskFeedback DELETEs with turnId as a query param (204 → void)", async () => {
    const fetchFn = mockFetch(undefined, { status: 204, text: "" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.deleteAskFeedback("tr1", "turn-1");
    const url = new URL(calledUrl(fetchFn));
    expect(url.pathname).toBe("/v1/traces/tr1/ask/feedback");
    expect(url.searchParams.get("turnId")).toBe("turn-1");
    expect(methodOf(fetchFn)).toBe("DELETE");
  });
});

describe("LensReadClient — experiment runs + replay (M113, billable non-idempotent)", () => {
  it("createExperimentRun POSTs to /v1/experiment-runs and returns an ExperimentRun", async () => {
    const fetchFn = mockFetch({ id: "run1", datasetId: "d1", name: "exp", variant: { model: "gpt-4" }, status: "completed", truncated: false, itemCount: 3, passCount: 2, totalCostUsd: 0.01, createdBy: "u", createdAt: "t" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const run = await client.createExperimentRun({ datasetId: "d1", name: "exp", variant: { model: "gpt-4" } });
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/experiment-runs");
    expect(methodOf(fetchFn)).toBe("POST");
    expect(run.id).toBe("run1");
    expect(run.passCount).toBe(2);
  });

  it("createExperimentRun does NOT retry a network reject (billable — no double-run)", async () => {
    const fNet = seqFetch([new TypeError("boom"), ok({ id: "run1", datasetId: "d1", name: "e", variant: {}, status: "completed", truncated: false, itemCount: 0, passCount: 0, totalCostUsd: 0, createdBy: "u", createdAt: "t" })]);
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fNet, sleep: async () => {} });
    await expect(client.createExperimentRun({ datasetId: "d1", name: "e", variant: {} })).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fNet).toHaveBeenCalledTimes(1);
  });

  it("replaySpan POSTs the messages and does NOT retry a network reject (billable)", async () => {
    const fNet = seqFetch([new TypeError("boom"), ok({ output: "hi", promptTokens: 1, completionTokens: 1, totalTokens: 2, latencyMs: 12, model: "gpt-4" })]);
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fNet, sleep: async () => {} });
    await expect(client.replaySpan("tr1", { messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fNet).toHaveBeenCalledTimes(1);
    expect(new URL(calledUrl(fNet)).pathname).toBe("/v1/traces/tr1/replay");
  });

  it("createReplaySession POSTs {traceId} and returns the ack (not retried)", async () => {
    const fetchFn = mockFetch({ recorded: true });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const ack = await client.createReplaySession({ traceId: "tr1" });
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/replay-sessions");
    expect(methodOf(fetchFn)).toBe("POST");
    expect(bodyOf(fetchFn)).toEqual({ traceId: "tr1" });
    expect(ack.recorded).toBe(true);
  });
});

describe("LensReadClient — M117 read parity: GENERATED (zod-backed) reads (T1.2)", () => {
  it("getTraceCost builds /v1/traces/{id}/cost (test_getTraceCost_builds_v1_traces_cost_url)", async () => {
    const fetchFn = mockFetch({ traceId: "t1", totalCostUsd: 0, spanCount: 0 });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.getTraceCost("t1");
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/traces/t1/cost");
    expect(methodOf(fetchFn)).toBe("GET");
  });

  it("getNorthStar composes /v1/lens/metrics/north-star when basePath is set (test_getNorthStar_composes_v1_lens_when_basePath_set)", async () => {
    const fetchFn = mockFetch({});
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, basePath: "/v1/lens", fetch: fetchFn });
    await client.getNorthStar();
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/lens/metrics/north-star");
  });

  it("listTraceTags builds /v1/traces/{id}/tags (GET)", async () => {
    const fetchFn = mockFetch({ tags: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.listTraceTags("t1");
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/traces/t1/tags");
    expect(methodOf(fetchFn)).toBe("GET");
  });

  it("listTraceAnnotations builds /v1/traces/{id}/annotations (GET)", async () => {
    const fetchFn = mockFetch({ annotations: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.listTraceAnnotations("t1");
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/traces/t1/annotations");
    expect(methodOf(fetchFn)).toBe("GET");
  });

  it("getAgents builds /v1/agents", async () => {
    const fetchFn = mockFetch({ agents: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.getAgents();
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/agents");
  });

  it("getToolTraces path-escapes the tool name and builds /v1/analytics/tools/{tool}/traces", async () => {
    const fetchFn = mockFetch({ traces: [], total: 0, limit: 0, offset: 0 });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.getToolTraces("Read/File");
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/analytics/tools/Read%2FFile/traces");
  });

  it("getEvaluatorMetrics builds /v1/metrics/evaluators", async () => {
    const fetchFn = mockFetch({ evaluators: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.getEvaluatorMetrics();
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/metrics/evaluators");
  });

  it("getScores builds /v1/metrics/scores", async () => {
    const fetchFn = mockFetch({ range: "24h", scores: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.getScores();
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/metrics/scores");
  });

  it("getSpanAttributes builds /v1/metrics/span-attributes and forwards ?key", async () => {
    const fetchFn = mockFetch({ mode: "values", key: "k", values: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.getSpanAttributes({ key: "gen_ai.request.model" });
    const url = new URL(calledUrl(fetchFn));
    expect(url.pathname).toBe("/v1/metrics/span-attributes");
    expect(url.searchParams.get("key")).toBe("gen_ai.request.model");
  });

  it("getSession builds /v1/sessions/{id}", async () => {
    const fetchFn = mockFetch({ sessionId: "s1", traces: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.getSession("s1");
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/sessions/s1");
  });

  it("getDataset builds /v1/datasets/{id}", async () => {
    const fetchFn = mockFetch({ id: "d1", name: "s", items: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.getDataset("d1");
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/datasets/d1");
  });

  it("listLabelingQueue builds /v1/labeling-queue and forwards page/pageSize/status", async () => {
    const fetchFn = mockFetch({ items: [], total: 0, page: 1, pageSize: 50 });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.listLabelingQueue({ page: 2, pageSize: 25, status: "pending" });
    const url = new URL(calledUrl(fetchFn));
    expect(url.pathname).toBe("/v1/labeling-queue");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("pageSize")).toBe("25");
    expect(url.searchParams.get("status")).toBe("pending");
  });

  it("getLabelingItem builds /v1/labeling-queue/{id}", async () => {
    const fetchFn = mockFetch({ id: "lq1", traceId: "t", spanId: "s", status: "pending", createdBy: "u", createdAt: "t" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.getLabelingItem("lq1");
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/labeling-queue/lq1");
  });
});

describe("LensReadClient — M117 read parity: HAND (bare c.json) reads (T2.2)", () => {
  it("getTrace path-escapes the traceId and builds /v1/traces/{id} (GET)", async () => {
    const fetchFn = mockFetch({ spanId: "a1", traceId: "t/1", name: "x", children: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.getTrace("t/1");
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/traces/t%2F1");
    expect(methodOf(fetchFn)).toBe("GET");
  });

  it("listEvaluators builds /v1/evaluators and returns the { evaluators } wrapper", async () => {
    const fetchFn = mockFetch({ evaluators: [{ id: "ev1", name: "q", kind: "rule", config: { predicate: "status:ok" }, createdAt: "t", target: "span", enabled: true }] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const res = await client.listEvaluators();
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/evaluators");
    expect(res.evaluators[0]?.id).toBe("ev1");
  });

  it("getEvaluator builds /v1/evaluators/{id}", async () => {
    const fetchFn = mockFetch({ id: "ev1", name: "q", kind: "rule", config: { predicate: "status:ok" }, createdAt: "t", target: "span", enabled: true });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.getEvaluator("ev1");
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/evaluators/ev1");
    expect(methodOf(fetchFn)).toBe("GET");
  });

  it("listMonitors builds /v1/guards and returns the { guards } wrapper", async () => {
    const fetchFn = mockFetch({ guards: [{ id: "g1", evaluatorId: "ev1", operator: "gte", threshold: 0.8, createdAt: "t", enabled: true }] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const res = await client.listMonitors();
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/guards");
    expect(res.guards[0]?.id).toBe("g1");
  });

  it("getMonitorBreaches builds /v1/guards/{id}/breaches and returns { traceIds }", async () => {
    const fetchFn = mockFetch({ traceIds: ["tr1", "tr2"] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const res = await client.getMonitorBreaches("g1");
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/guards/g1/breaches");
    expect(res.traceIds).toEqual(["tr1", "tr2"]);
  });

  it("listExperimentRuns builds /v1/experiment-runs and forwards ?datasetId", async () => {
    const fetchFn = mockFetch({ runs: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.listExperimentRuns({ datasetId: "d1" });
    const url = new URL(calledUrl(fetchFn));
    expect(url.pathname).toBe("/v1/experiment-runs");
    expect(url.searchParams.get("datasetId")).toBe("d1");
  });

  it("listExperimentRuns omits datasetId when not supplied", async () => {
    const fetchFn = mockFetch({ runs: [] });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.listExperimentRuns();
    const url = new URL(calledUrl(fetchFn));
    expect(url.pathname).toBe("/v1/experiment-runs");
    expect(url.searchParams.has("datasetId")).toBe(false);
  });

  it("getExperimentRun builds /v1/experiment-runs/{runId}", async () => {
    const fetchFn = mockFetch({ id: "run1", datasetId: "d1", name: "e", variant: {}, status: "completed", truncated: false, itemCount: 0, passCount: 0, totalCostUsd: 0, createdBy: "u", createdAt: "t" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.getExperimentRun("run1");
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/experiment-runs/run1");
  });

  it("test_compareExperimentRuns_sends_run_ids_as_query", async () => {
    const fetchFn = mockFetch({ runs: [], deltas: null });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await client.compareExperimentRuns(["a", "b"]);
    const url = new URL(calledUrl(fetchFn));
    // The id list lands in the QUERY string (?ids=a,b), NOT the path segment.
    expect(url.pathname).toBe("/v1/experiment-runs/compare");
    expect(url.searchParams.get("ids")).toBe("a,b");
  });

  it("askCopilot POSTs { question } to /v1/traces/{id}/ask and returns { answer }", async () => {
    const fetchFn = mockFetch({ answer: "it retried once" });
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const res = await client.askCopilot("tr1", { question: "why did it fail?" });
    expect(new URL(calledUrl(fetchFn)).pathname).toBe("/v1/traces/tr1/ask");
    expect(methodOf(fetchFn)).toBe("POST");
    expect(bodyOf(fetchFn)).toEqual({ question: "why did it fail?" });
    expect(res.answer).toBe("it retried once");
  });

  it("test_askCopilot_does_not_network_retry", async () => {
    // A billable POST → a network reject must NOT be retried (retryNetwork:false), mirroring runEvaluator.
    const fNet = seqFetch([new TypeError("boom"), ok({ answer: "never reached" })]);
    const client = new LensReadClient({ baseUrl: BASE, apiKey: KEY, fetch: fNet, sleep: async () => {} });
    await expect(client.askCopilot("tr1", { question: "q" })).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fNet).toHaveBeenCalledTimes(1);
    expect(new URL(calledUrl(fNet)).pathname).toBe("/v1/traces/tr1/ask");
  });
});
