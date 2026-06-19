import { beforeEach, describe, expect, it } from "vitest";
import type { Span, SpanRepository } from "@usetheo/lens-core";

import { createApp } from "./app.js";
import { spansIngested } from "./metrics.js";

/**
 * Contract-level tests for the route logic using an in-memory stub repository —
 * no Postgres required, so these always run (not env-gated). They pin the error
 * path (repo failure → 5xx, Rule 8) and the "no side-effect on rejection"
 * invariants that the real-DB integration suite cannot cheaply assert.
 */
class StubSpanRepository implements SpanRepository {
  readonly saveCalls: Span[][] = [];
  private readonly store = new Map<string, Span>();
  failOnSave = false;

  async save(spans: Span[]): Promise<void> {
    if (this.failOnSave) throw new Error("simulated postgres unavailable");
    this.saveCalls.push(spans);
    for (const s of spans) this.store.set(s.spanId, s);
  }

  async getBySpanId(spanId: string): Promise<Span | null> {
    return this.store.get(spanId) ?? null;
  }
}

function tracesEnvelope(span: Record<string, unknown>): string {
  return JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] });
}

const rawSpan = {
  spanId: "c-a1",
  traceId: "c-t1",
  name: "op",
  startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: "1700000000100000000",
};

describe("createApp (contract, stub repo)", () => {
  let repo: StubSpanRepository;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    repo = new StubSpanRepository();
    app = createApp(repo);
    spansIngested.reset();
  });

  function post(body: BodyInit, contentType = "application/json"): Promise<Response> {
    return app.request("/v1/traces", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
  }

  it("post_traces_persists_and_increments_metric", async () => {
    const res = await post(tracesEnvelope(rawSpan));
    expect(res.status).toBe(200);
    expect(repo.saveCalls).toHaveLength(1);
    expect(spansIngested.value).toBe(1);
  });

  it("post_traces_non_json_415_no_save_no_metric", async () => {
    const res = await post(tracesEnvelope(rawSpan), "application/x-protobuf");
    expect(res.status).toBe(415);
    expect(repo.saveCalls).toHaveLength(0);
    expect(spansIngested.value).toBe(0);
  });

  it("post_traces_malformed_json_400_no_save_no_metric", async () => {
    const res = await post("{ not json");
    expect(res.status).toBe(400);
    expect(repo.saveCalls).toHaveLength(0);
    expect(spansIngested.value).toBe(0);
  });

  it("post_traces_empty_envelope_200_no_save_no_metric", async () => {
    const res = await post(JSON.stringify({ resourceSpans: [] }));
    expect(res.status).toBe(200);
    expect(repo.saveCalls).toHaveLength(0);
    expect(spansIngested.value).toBe(0);
  });

  it("post_traces_repo_failure_returns_5xx_and_does_not_increment_metric", async () => {
    // Simulates Postgres unavailable at request time (plan § Failure scenarios row 4).
    repo.failOnSave = true;
    const res = await post(tracesEnvelope(rawSpan));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(spansIngested.value).toBe(0); // no partial silent success
  });

  it("get_unknown_span_returns_404", async () => {
    const res = await app.request("/v1/spans/missing");
    expect(res.status).toBe(404);
  });

  it("get_returns_persisted_span", async () => {
    await post(tracesEnvelope(rawSpan));
    const res = await app.request("/v1/spans/c-a1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ spanId: "c-a1" });
  });
});
