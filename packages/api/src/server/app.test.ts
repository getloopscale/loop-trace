import { beforeEach, describe, expect, it } from "vitest";
import type { Span, SpanRepository, TraceTreeNode } from "@usetheo/lens-core";

import { createApp } from "./app.js";
import { spansIngested, tracesIngested } from "./metrics.js";
import { encodeOtlpProtobuf } from "../otlp/decode-protobuf.js";

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

  async getTraceTree(traceId: string): Promise<TraceTreeNode | null> {
    const rows = [...this.store.values()].filter((s) => s.traceId === traceId);
    if (rows.length === 0) return null;
    const nodes = new Map<string, TraceTreeNode>(
      rows.map((s) => [s.spanId, { ...s, children: [] }]),
    );
    const all = [...nodes.values()];
    const root = all.find((n) => n.parentSpanId == null) ?? all[0]!;
    for (const node of all) {
      if (node === root) continue;
      const parent = node.parentSpanId ? nodes.get(node.parentSpanId) : undefined;
      (parent ?? root).children.push(node);
    }
    return root;
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
    tracesIngested.reset();
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

  it("post_traces_unsupported_content_type_415_no_save_no_metric", async () => {
    // M1 accepts json + protobuf; an unsupported type (csv) is 415 with no side-effect.
    const res = await post(tracesEnvelope(rawSpan), "text/csv");
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

  it("post_protobuf_persists_and_returns_200", async () => {
    const bytes = encodeOtlpProtobuf({
      resourceSpans: [
        { scopeSpans: [{ spans: [{ name: "op", traceId: Buffer.from([1, 2]), spanId: Buffer.from([3, 4]), startTimeUnixNano: "1", endTimeUnixNano: "2" }] }] },
      ],
    });
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: bytes,
    });
    expect(res.status).toBe(200);
    expect(repo.saveCalls).toHaveLength(1);
    expect(tracesIngested.value).toBe(1);
    // ids normalized to hex
    expect(await repo.getBySpanId("0304")).not.toBeNull();
  });

  it("post_unsupported_content_type_415", async () => {
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: "a,b",
    });
    expect(res.status).toBe(415);
  });

  it("get_trace_tree_returns_reconstructed_tree", async () => {
    await post(
      JSON.stringify({
        resourceSpans: [
          { scopeSpans: [{ spans: [
            { spanId: "root", traceId: "tt", name: "r", startTimeUnixNano: "1", endTimeUnixNano: "2" },
            { spanId: "child", traceId: "tt", parentSpanId: "root", name: "c", startTimeUnixNano: "1", endTimeUnixNano: "2" },
          ] }] },
        ],
      }),
    );
    const res = await app.request("/v1/traces/tt");
    expect(res.status).toBe(200);
    const tree = (await res.json()) as { spanId: string; children: { spanId: string }[] };
    expect(tree.spanId).toBe("root");
    expect(tree.children.map((c) => c.spanId)).toEqual(["child"]);
  });

  it("get_unknown_trace_returns_404", async () => {
    const res = await app.request("/v1/traces/missing");
    expect(res.status).toBe(404);
  });
});
