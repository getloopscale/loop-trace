import { beforeEach, describe, expect, it } from "vitest";
import type {
  CostByPeriodResponse,
  CostPeriod,
  ListTracesOptions,
  NorthStarResponse,
  ObservabilityResponse,
  SessionListResponse,
  SessionDetailResponse,
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

  lastListOpts: ListTracesOptions | undefined;

  async listTraces(opts?: ListTracesOptions): Promise<TraceListResponse> {
    this.lastListOpts = opts; // capture so route param→opts mapping is assertable
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

  replayCalls: string[] = [];
  northStar: NorthStarResponse = { tracesPerDay: [], replaySessionsPerWeek: [] };
  failOnNorthStar = false;

  async recordReplaySession(traceId: string): Promise<void> {
    if (this.failOnNorthStar) throw new Error("simulated postgres unavailable");
    this.replayCalls.push(traceId);
  }

  async aggregateNorthStar(): Promise<NorthStarResponse> {
    if (this.failOnNorthStar) throw new Error("simulated postgres unavailable");
    return this.northStar;
  }

  observability: ObservabilityResponse = {
    range: "24h",
    traffic: [],
    latency: [],
    tokensByModel: [],
  };
  lastObservabilityRange: string | undefined;
  failOnObservability = false;

  async aggregateObservability(
    range: ObservabilityResponse["range"],
  ): Promise<ObservabilityResponse> {
    if (this.failOnObservability) throw new Error("simulated postgres unavailable");
    this.lastObservabilityRange = range;
    return { ...this.observability, range };
  }

  sessionList: SessionListResponse = { sessions: [] };
  sessionDetail: SessionDetailResponse | null = null;
  failOnSessions = false;

  async listSessions(): Promise<SessionListResponse> {
    if (this.failOnSessions) throw new Error("simulated postgres unavailable");
    return this.sessionList;
  }

  async getSessionDetail(sessionId: string): Promise<SessionDetailResponse | null> {
    if (this.failOnSessions) throw new Error("simulated postgres unavailable");
    if (!this.sessionDetail) return null;
    return { ...this.sessionDetail, sessionId };
  }

  // M14 tags: in-memory map traceId → Set<tag>; tagTraceExists gates the 404.
  readonly tags = new Map<string, Set<string>>();
  tagTraceExists = true;

  async addTag(traceId: string, tag: string): Promise<boolean> {
    if (!this.tagTraceExists) return false;
    const set = this.tags.get(traceId) ?? new Set<string>();
    set.add(tag);
    this.tags.set(traceId, set);
    return true;
  }

  async removeTag(traceId: string, tag: string): Promise<void> {
    this.tags.get(traceId)?.delete(tag);
  }

  async listTags(traceId: string): Promise<string[]> {
    return [...(this.tags.get(traceId) ?? [])].sort();
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

  it("test_get_trace_tree_returns_input_output_events", async () => {
    await post(
      tracesEnvelope({
        spanId: "rich",
        traceId: "rt",
        name: "agent",
        startTimeUnixNano: "1700000000000000000",
        endTimeUnixNano: "1700000000100000000",
        attributes: [
          { key: "input.value", value: { stringValue: "ask" } },
          { key: "output.value", value: { stringValue: "answer" } },
        ],
        events: [{ name: "chunk", timeUnixNano: "1700000000050000000" }],
      }),
    );
    const tree = (await (await app.request("/v1/traces/rt")).json()) as {
      inputValue?: string;
      outputValue?: string;
      events?: { name: string }[];
    };
    expect(tree.inputValue).toBe("ask");
    expect(tree.outputValue).toBe("answer");
    expect(tree.events?.[0]?.name).toBe("chunk");
  });

  it("test_span_without_new_fields_omits_them", async () => {
    await post(tracesEnvelope(rawSpan));
    const tree = (await (await app.request("/v1/traces/c-t1")).json()) as Record<string, unknown>;
    expect(tree.inputValue).toBeUndefined();
    expect(tree.outputValue).toBeUndefined();
    expect(tree.events).toBeUndefined();
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

  it("test_get_traces_rejects_bad_param_with_400", async () => {
    expect((await app.request("/v1/traces?order_by=banana")).status).toBe(400);
    expect((await app.request("/v1/traces?status=maybe")).status).toBe(400);
    expect((await app.request("/v1/traces?limit=999999")).status).toBe(400);
  });

  it("test_get_traces_passes_validated_opts_to_repo", async () => {
    const res = await app.request("/v1/traces?status=error&order_by=latency&dir=asc");
    expect(res.status).toBe(200);
    expect(repo.lastListOpts).toMatchObject({
      status: "error",
      orderBy: "latency",
      dir: "asc",
    });
  });

  it("get_traces_forwards_q_param", async () => {
    const res = await app.request("/v1/traces?q=lisbon");
    expect(res.status).toBe(200);
    expect(repo.lastListOpts?.q).toBe("lisbon");
  });

  it("get_traces_empty_q_is_omitted", async () => {
    // EC: a cleared search box (`?q=`) is "no filter", NOT a 400 on min(1).
    const res = await app.request("/v1/traces?q=");
    expect(res.status).toBe(200);
    expect(repo.lastListOpts?.q).toBeUndefined();
  });

  it("get_traces_csv_export_honors_q", async () => {
    // EC-1: the CSV export reuses the SAME filtered query — q must reach the repo.
    const res = await app.request("/v1/traces?q=lisbon&format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(repo.lastListOpts).toMatchObject({ q: "lisbon", format: "csv" });
  });

  it("test_get_traces_csv_export_has_header_and_rows", async () => {
    await repo.save([{ spanId: "csv1", traceId: "csv-t1", name: "checkout", startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000100000000" }]);
    const res = await app.request("/v1/traces?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const body = await res.text();
    const lines = body.trim().split("\r\n");
    expect(lines[0]).toBe("traceId,name,statusCode,durationMs,totalTokens");
    expect(lines.some((l) => l.includes("csv-t1"))).toBe(true);
  });

  it("test_get_traces_csv_escapes_formula_injection", async () => {
    await repo.save([{ spanId: "inj1", traceId: "inj-t1", name: "=cmd()", startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000100000000" }]);
    const body = await (await app.request("/v1/traces?format=csv")).text();
    // The formula char is neutralized with a leading quote inside the quoted field.
    expect(body).toContain(`"'=cmd()"`);
    expect(body).not.toContain(`,=cmd()`); // never a bare live formula
  });

  it("test_get_traces_csv_escapes_delimiters_and_quotes", async () => {
    await repo.save([{ spanId: "rfc1", traceId: "rfc-t1", name: 'a,b"c', startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000100000000" }]);
    const body = await (await app.request("/v1/traces?format=csv")).text();
    // RFC-4180: comma stays inside quotes; internal quote is doubled.
    expect(body).toContain(`"a,b""c"`);
  });

  it("test_post_replay_session_records_and_returns_200", async () => {
    const res = await app.request("/v1/replay-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ traceId: "t1" }),
    });
    expect(res.status).toBe(200);
    expect(repo.replayCalls).toEqual(["t1"]);
  });

  it("test_post_replay_session_rejects_missing_traceId_with_400", async () => {
    const res = await app.request("/v1/replay-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(repo.replayCalls).toEqual([]);
  });

  it("test_get_north_star_returns_aggregation_dto", async () => {
    repo.northStar = {
      tracesPerDay: [{ period: "2026-06-22", count: 3 }],
      replaySessionsPerWeek: [{ period: "2026-06-15", count: 2 }],
    };
    const res = await app.request("/v1/metrics/north-star");
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof repo.northStar;
    expect(body.tracesPerDay[0]).toEqual({ period: "2026-06-22", count: 3 });
    expect(body.replaySessionsPerWeek[0]).toEqual({ period: "2026-06-15", count: 2 });
  });

  it("test_north_star_route_returns_5xx_on_repo_failure", async () => {
    repo.failOnNorthStar = true;
    expect((await app.request("/v1/metrics/north-star")).status).toBeGreaterThanOrEqual(500);
    const post = await app.request("/v1/replay-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ traceId: "t1" }),
    });
    expect(post.status).toBeGreaterThanOrEqual(500);
  });

  it("test_north_star_route_rejects_leaked_column_at_boundary_with_5xx", async () => {
    const leaky: SpanRepository = {
      ...repo,
      save: repo.save.bind(repo),
      getBySpanId: repo.getBySpanId.bind(repo),
      getTraceTree: repo.getTraceTree.bind(repo),
      listTraces: repo.listTraces.bind(repo),
      recordReplaySession: repo.recordReplaySession.bind(repo),
      aggregateNorthStar: async () =>
        ({ tracesPerDay: [{ period: "2026-06-22", count: 1, leak: 9 }], replaySessionsPerWeek: [] }) as never,
    };
    expect((await createApp(leaky).request("/v1/metrics/north-star")).status).toBeGreaterThanOrEqual(500);
  });

  it("test_get_observability_returns_dto", async () => {
    repo.observability = {
      range: "24h",
      traffic: [{ periodStart: "2026-06-22T00:00:00Z", traceCount: 4, errorCount: 1, errorRate: 0.25 }],
      latency: [{ periodStart: "2026-06-22T00:00:00Z", p50Ms: 10, p75Ms: 20, p95Ms: 40, p99Ms: 99 }],
      tokensByModel: [{ periodStart: "2026-06-22T00:00:00Z", model: "gpt-4o", totalTokens: 150, costUsd: 0.01 }],
    };
    const res = await app.request("/v1/metrics/observability?range=7d");
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof repo.observability;
    expect(body.range).toBe("7d"); // route passes the validated range
    expect(body.traffic[0]?.errorRate).toBe(0.25);
    expect(repo.lastObservabilityRange).toBe("7d");
  });

  it("test_get_observability_rejects_bad_range_with_400", async () => {
    expect((await app.request("/v1/metrics/observability?range=banana")).status).toBe(400);
  });

  it("test_get_observability_returns_5xx_on_repo_failure", async () => {
    repo.failOnObservability = true;
    expect((await app.request("/v1/metrics/observability")).status).toBeGreaterThanOrEqual(500);
  });

  it("test_observability_route_rejects_leaked_column_at_boundary_with_5xx", async () => {
    const leaky: SpanRepository = {
      ...repo,
      save: repo.save.bind(repo),
      getBySpanId: repo.getBySpanId.bind(repo),
      getTraceTree: repo.getTraceTree.bind(repo),
      listTraces: repo.listTraces.bind(repo),
      aggregateObservability: async () =>
        ({ range: "24h", traffic: [{ periodStart: "x", traceCount: 1, errorCount: 0, errorRate: 0, leak: 9 }], latency: [], tokensByModel: [] }) as never,
    };
    expect((await createApp(leaky).request("/v1/metrics/observability")).status).toBeGreaterThanOrEqual(500);
  });

  it("test_get_sessions_returns_list_dto", async () => {
    repo.sessionList = {
      sessions: [
        { sessionId: "S1", firstSeenAt: "2026-06-22T00:00:00.000Z", lastSeenAt: "2026-06-22T01:00:00.000Z", traceCount: 3, costUsd: 0.012, totalTokens: 1500, errorRate: 0.333 },
      ],
    };
    const res = await app.request("/v1/sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof repo.sessionList;
    expect(body.sessions[0]?.sessionId).toBe("S1");
    expect(body.sessions[0]?.traceCount).toBe(3);
  });

  it("test_get_session_returns_detail_dto", async () => {
    repo.sessionDetail = {
      sessionId: "ignored",
      firstSeenAt: "2026-06-22T00:00:00.000Z",
      lastSeenAt: "2026-06-22T01:00:00.000Z",
      traceCount: 2,
      costUsd: 0.02,
      totalTokens: 300,
      errorRate: 0.5,
      latencyP50Ms: 12,
      latencyP95Ms: 88,
      traces: [{ traceId: "ta", durationMs: 12, statusCode: "ok" }],
    };
    const res = await app.request("/v1/sessions/S1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof repo.sessionDetail & { sessionId: string };
    expect(body.sessionId).toBe("S1"); // route passes the path id
    expect(body.traceCount).toBe(2);
    expect(body.traces[0]?.traceId).toBe("ta");
  });

  it("test_get_session_absent_returns_404", async () => {
    repo.sessionDetail = null;
    expect((await app.request("/v1/sessions/nope")).status).toBe(404);
  });

  it("test_session_route_rejects_leaked_column_at_boundary_with_5xx", async () => {
    const leaky: SpanRepository = {
      ...repo,
      save: repo.save.bind(repo),
      getBySpanId: repo.getBySpanId.bind(repo),
      getTraceTree: repo.getTraceTree.bind(repo),
      listTraces: repo.listTraces.bind(repo),
      listSessions: async () =>
        ({ sessions: [{ sessionId: "S1", firstSeenAt: "x", lastSeenAt: "y", traceCount: 1, costUsd: 0, totalTokens: 0, errorRate: 0, leak: 9 }] }) as never,
    };
    expect((await createApp(leaky).request("/v1/sessions")).status).toBeGreaterThanOrEqual(500);
  });

  it("test_post_tag_adds_and_returns_tags", async () => {
    repo.tagTraceExists = true;
    const res = await app.request("/v1/traces/t1/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "prod" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: string[] };
    expect(body.tags).toContain("prod");
  });

  it("test_post_tag_invalid_returns_400", async () => {
    repo.tagTraceExists = true;
    const empty = await app.request("/v1/traces/t1/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "   " }),
    });
    expect(empty.status).toBe(400);
    const big = await app.request("/v1/traces/t1/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "a".repeat(65) }),
    });
    expect(big.status).toBe(400);
  });

  it("test_post_tag_absent_trace_returns_404", async () => {
    repo.tagTraceExists = false; // addTag returns false → 404
    const res = await app.request("/v1/traces/nope/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("test_delete_tag_is_idempotent_200", async () => {
    repo.tagTraceExists = true;
    // a slash-bearing tag via query param (EC-1) — removing an absent tag is 200.
    const res = await app.request("/v1/traces/t1/tags?tag=" + encodeURIComponent("area/auth"), {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).tags).toEqual([]); // returns the (now-empty) tag set
  });

  it("test_get_traces_tag_filter_passes_through", async () => {
    await post(tracesEnvelope(rawSpan));
    const res = await app.request("/v1/traces?tag=prod");
    expect(res.status).toBe(200);
    expect(repo.lastListOpts?.tag).toBe("prod"); // route param → opts mapping
  });
});

describe("createApp serves the UI when a web-dist dir is provided (M7)", () => {
  // CWD-relative fixture (serveStatic rejects absolute roots — EC-1).
  const FIXTURE_ROOT = "packages/api/src/server/__fixtures__/web-dist";

  it("test_createApp_serves_ui_when_dist_provided", async () => {
    const app = createApp(new StubSpanRepository(), FIXTURE_ROOT);
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
  });

  it("test_createApp_does_not_shadow_v1_routes", async () => {
    // Static is mounted AFTER /v1/*; the API must still return JSON, not index.html.
    const app = createApp(new StubSpanRepository(), FIXTURE_ROOT);
    const res = await app.request("/v1/traces");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { traces: unknown[] };
    expect(Array.isArray(body.traces)).toBe(true);
  });

  it("test_createApp_api_only_when_no_dist", async () => {
    // Backward compatible: no web-dist arg → API-only, GET / unhandled (404).
    const app = createApp(new StubSpanRepository());
    const res = await app.request("/");
    expect(res.status).toBe(404);
  });
});
