import { beforeEach, describe, expect, it } from "vitest";
import type {
  CostByPeriodResponse,
  CostPeriod,
  Span,
  SpanRepository,
  ToolStatsResponse,
  TraceCost,
  TraceListResponse,
  TraceTreeNode,
} from "@usetheo/lens-core";

import { createApp } from "./app.js";
import { spansIngested, tracesIngested } from "./metrics.js";
import { encodeOtlpProtobuf } from "../otlp/__fixtures__/otlp-protobuf.js";

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

  costByTrace = new Map<string, TraceCost>();
  buckets: CostByPeriodResponse["buckets"] = [];
  failOnCost = false;
  failOnAggregate = false;

  async getTraceCost(traceId: string): Promise<TraceCost | null> {
    if (this.failOnCost) throw new Error("simulated postgres unavailable");
    return this.costByTrace.get(traceId) ?? null;
  }

  async aggregateCostByPeriod(period: CostPeriod): Promise<CostByPeriodResponse> {
    if (this.failOnAggregate) throw new Error("simulated postgres unavailable");
    return { period, buckets: this.buckets };
  }

  toolStats: ToolStatsResponse["tools"] = [];
  tracesForTool = new Map<string, TraceListResponse["traces"]>();
  failOnTools = false;

  async aggregateToolStats(): Promise<ToolStatsResponse> {
    if (this.failOnTools) throw new Error("simulated postgres unavailable");
    return { tools: this.toolStats };
  }

  async listTracesForTool(toolName: string): Promise<TraceListResponse> {
    if (this.failOnTools) throw new Error("simulated postgres unavailable");
    return { traces: this.tracesForTool.get(toolName) ?? [] };
  }

  async listTraces(): Promise<TraceListResponse> {
    const byTrace = new Map<string, Span>();
    for (const s of this.store.values()) {
      if (!byTrace.has(s.traceId)) byTrace.set(s.traceId, s);
    }
    return {
      traces: [...byTrace.values()].map((s) => ({
        traceId: s.traceId,
        name: s.name,
      })),
    };
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

  it("post_malformed_protobuf_400_no_save_no_metric", async () => {
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: Buffer.from([0xff, 0xff, 0xff, 0xff]),
    });
    expect(res.status).toBe(400);
    expect(repo.saveCalls).toHaveLength(0);
    expect(spansIngested.value).toBe(0);
  });

  it("post_corrupt_gzip_400_no_save", async () => {
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: Buffer.from("not gzip at all"),
    });
    expect(res.status).toBe(400);
    expect(repo.saveCalls).toHaveLength(0);
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

  it("get_v1_traces_returns_list_dto", async () => {
    await post(tracesEnvelope(rawSpan));
    const res = await app.request("/v1/traces");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { traces: { traceId: string }[] };
    expect(body.traces.map((t) => t.traceId)).toContain("c-t1");
  });

  it("get_v1_traces_empty_returns_empty_list", async () => {
    const res = await app.request("/v1/traces");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ traces: [] });
  });

  it("get_v1_traces_rejects_leaked_column_at_boundary_with_5xx", async () => {
    // The route parses through the strict DTO so a future adapter regression that
    // leaks a persistence column is caught at runtime, not shipped (review F-arch-1).
    const leaky: SpanRepository = {
      ...repo,
      save: repo.save.bind(repo),
      getBySpanId: repo.getBySpanId.bind(repo),
      getTraceTree: repo.getTraceTree.bind(repo),
      listTraces: async () =>
        ({ traces: [{ traceId: "x", cost_usd: 0.01 }] }) as never,
    };
    const leakyApp = createApp(leaky);
    const res = await leakyApp.request("/v1/traces");
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("get_v1_traces_preserves_repo_order", async () => {
    const ordered: SpanRepository = {
      ...repo,
      save: repo.save.bind(repo),
      getBySpanId: repo.getBySpanId.bind(repo),
      getTraceTree: repo.getTraceTree.bind(repo),
      listTraces: async () => ({
        traces: [{ traceId: "newest" }, { traceId: "oldest" }],
      }),
    };
    const res = await createApp(ordered).request("/v1/traces");
    const body = (await res.json()) as { traces: { traceId: string }[] };
    expect(body.traces.map((t) => t.traceId)).toEqual(["newest", "oldest"]);
  });

  it("get_trace_cost_returns_dto_and_404_when_absent", async () => {
    repo.costByTrace.set("t1", {
      traceId: "t1",
      costUsd: 0.0125,
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
    });
    const ok = await app.request("/v1/traces/t1/cost");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ traceId: "t1", costUsd: 0.0125 });
    const missing = await app.request("/v1/traces/nope/cost");
    expect(missing.status).toBe(404);
  });

  it("get_analytics_cost_buckets_by_period_and_rejects_invalid_period", async () => {
    repo.buckets = [
      { periodStart: "2026-06-20T00:00:00.000Z", costUsd: 0.5, totalTokens: 100, traceCount: 3 },
    ];
    const day = await app.request("/v1/analytics/cost");
    expect(day.status).toBe(200);
    expect(await day.json()).toMatchObject({ period: "day", buckets: [{ traceCount: 3 }] });
    const week = await app.request("/v1/analytics/cost?period=week");
    expect((await week.json()).period).toBe("week");
    const bad = await app.request("/v1/analytics/cost?period=month");
    expect(bad.status).toBe(400);
  });

  it("cost_routes_return_5xx_on_repo_failure", async () => {
    // DB error mid-query → structured 500 via onError (Rule 8) for both new read routes.
    repo.costByTrace.set("t1", {
      traceId: "t1", costUsd: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    });
    repo.failOnCost = true;
    expect((await app.request("/v1/traces/t1/cost")).status).toBeGreaterThanOrEqual(500);
    repo.failOnAggregate = true;
    expect((await app.request("/v1/analytics/cost")).status).toBeGreaterThanOrEqual(500);
  });

  it("get_analytics_tools_returns_ranked_stats", async () => {
    repo.toolStats = [
      { toolName: "search", callCount: 9, errorCount: 1, errorRate: 0.111, p50Ms: 12, p95Ms: 40 },
      { toolName: "fetch", callCount: 3, errorCount: 0, errorRate: 0, p50Ms: 5, p95Ms: 8 },
    ];
    const res = await app.request("/v1/analytics/tools");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: { toolName: string }[] };
    expect(body.tools.map((t) => t.toolName)).toEqual(["search", "fetch"]);
  });

  it("get_tool_traces_returns_list_dto_and_empty", async () => {
    repo.tracesForTool.set("search", [{ traceId: "t1", name: "checkout" }]);
    const ok = await app.request("/v1/analytics/tools/search/traces");
    expect(ok.status).toBe(200);
    expect((await ok.json()).traces[0].traceId).toBe("t1");
    const empty = await app.request("/v1/analytics/tools/unknown/traces");
    expect(await empty.json()).toEqual({ traces: [] });
  });

  it("tool_routes_return_5xx_on_repo_failure", async () => {
    repo.failOnTools = true;
    expect((await app.request("/v1/analytics/tools")).status).toBeGreaterThanOrEqual(500);
    expect(
      (await app.request("/v1/analytics/tools/search/traces")).status,
    ).toBeGreaterThanOrEqual(500);
  });

  it("tool_routes_reject_leaked_column_at_boundary_with_5xx", async () => {
    const leaky: SpanRepository = {
      ...repo,
      save: repo.save.bind(repo),
      getBySpanId: repo.getBySpanId.bind(repo),
      getTraceTree: repo.getTraceTree.bind(repo),
      listTraces: repo.listTraces.bind(repo),
      aggregateToolStats: async () =>
        ({ tools: [{ toolName: "x", callCount: 1, errorCount: 0, errorRate: 0, p50Ms: 1, p95Ms: 1, leak: 9 }] }) as never,
    };
    const res = await createApp(leaky).request("/v1/analytics/tools");
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("cost_routes_reject_leaked_column_at_boundary_with_5xx", async () => {
    // The strict DTO parse at the boundary rejects a leaked persistence column (M3 F-arch-1).
    const leaky: SpanRepository = {
      ...repo,
      save: repo.save.bind(repo),
      getBySpanId: repo.getBySpanId.bind(repo),
      getTraceTree: repo.getTraceTree.bind(repo),
      listTraces: repo.listTraces.bind(repo),
      getTraceCost: async () =>
        ({ traceId: "t1", costUsd: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, secret: 1 }) as never,
      aggregateCostByPeriod: async (period) =>
        ({ period, buckets: [{ periodStart: "x", costUsd: 0, totalTokens: 0, traceCount: 0, leak: 1 }] }) as never,
    };
    const leakyApp = createApp(leaky);
    expect((await leakyApp.request("/v1/traces/t1/cost")).status).toBeGreaterThanOrEqual(500);
    expect((await leakyApp.request("/v1/analytics/cost")).status).toBeGreaterThanOrEqual(500);
  });
});
