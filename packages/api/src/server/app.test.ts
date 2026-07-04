import { beforeEach, describe, expect, it } from "vitest";
import type {
  Annotation,
  NormalizedAnnotation,
  Dataset,
  DatasetDetail,
  Agent,
  CostByPeriodResponse,
  CostPeriod,
  EvaluatorSummary,
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
import { spansIngested, tracesIngested, evaluationsExtracted, annotationsWritten, datasetItemsAdded } from "./metrics.js";
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

  // M26: per-evaluator aggregate stub.
  lastEvaluatorsRange: ObservabilityResponse["range"] | null = null;
  evaluators: EvaluatorSummary[] = [
    { name: "hallucination", count: 3, avgScore: 0.3, labels: { factual: 3 } },
  ];
  async aggregateEvaluators(
    range: ObservabilityResponse["range"],
  ): Promise<EvaluatorSummary[]> {
    this.lastEvaluatorsRange = range;
    return this.evaluators;
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

  // M26b annotations: in-memory list keyed by traceId; annTraceExists gates the 404.
  readonly anns = new Map<string, Annotation[]>();
  annTraceExists = true;
  annWriteCount = 0;

  async upsertAnnotation(traceId: string, ann: NormalizedAnnotation): Promise<boolean> {
    if (!this.annTraceExists) return false;
    const list = this.anns.get(traceId) ?? [];
    const sameKey = (a: Annotation): boolean =>
      (a.spanId ?? undefined) === ann.spanId &&
      a.name === ann.name &&
      a.annotatorKind === ann.annotatorKind;
    const next = list.filter((a) => !sameKey(a)); // upsert: drop the prior, prepend the new
    next.unshift({
      ...(ann.spanId !== undefined ? { spanId: ann.spanId } : {}),
      name: ann.name,
      ...(ann.label !== undefined ? { label: ann.label } : {}),
      ...(ann.note !== undefined ? { note: ann.note } : {}),
      annotatorKind: ann.annotatorKind,
      updatedAt: "2026-06-25T00:00:00.000Z",
    });
    this.anns.set(traceId, next);
    this.annWriteCount += 1;
    return true;
  }

  async listAnnotations(traceId: string): Promise<Annotation[]> {
    return [...(this.anns.get(traceId) ?? [])];
  }

  async removeAnnotation(
    traceId: string,
    key: { spanId?: string; name: string; annotatorKind?: string },
  ): Promise<void> {
    const kind = key.annotatorKind ?? "HUMAN";
    const list = this.anns.get(traceId) ?? [];
    this.anns.set(
      traceId,
      list.filter(
        (a) =>
          !(
            (a.spanId ?? undefined) === key.spanId &&
            a.name === key.name &&
            a.annotatorKind === kind
          ),
      ),
    );
  }

  // M26d datasets: in-memory by id; name→id for create-or-get; items per dataset.
  readonly dsByName = new Map<string, string>();
  readonly dsDetail = new Map<string, DatasetDetail>();
  dsItemTraceExists = true;
  dsItemAddCount = 0;
  private dsSeq = 0;

  async createDataset(name: string): Promise<Dataset> {
    let id = this.dsByName.get(name);
    if (id === undefined) {
      id = `ds-${++this.dsSeq}`;
      this.dsByName.set(name, id);
      this.dsDetail.set(id, { id, name, createdAt: "2026-06-25T00:00:00.000Z", items: [] });
    }
    const d = this.dsDetail.get(id)!;
    return { id, name: d.name, createdAt: d.createdAt, itemCount: d.items.length };
  }

  async listDatasets(): Promise<Dataset[]> {
    return [...this.dsDetail.values()].map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.createdAt,
      itemCount: d.items.length,
    }));
  }

  async getDataset(datasetId: string): Promise<DatasetDetail | null> {
    return this.dsDetail.get(datasetId) ?? null;
  }

  async addDatasetItem(datasetId: string, traceId: string): Promise<boolean> {
    const d = this.dsDetail.get(datasetId);
    if (d === undefined || !this.dsItemTraceExists) return false;
    if (!d.items.some((i) => i.traceId === traceId)) {
      d.items.unshift({ traceId, inputSnapshot: "snap-in", createdAt: "2026-06-25T00:00:00.000Z" });
    }
    this.dsItemAddCount += 1;
    return true;
  }

  async removeDatasetItem(datasetId: string, traceId: string): Promise<void> {
    const d = this.dsDetail.get(datasetId);
    if (d) d.items = d.items.filter((i) => i.traceId !== traceId);
  }

  // M32 agents catalog stub.
  agents: Agent[] = [];
  async aggregateAgents(): Promise<Agent[]> {
    return this.agents;
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
    evaluationsExtracted.reset();
    annotationsWritten.reset();
    datasetItemsAdded.reset();
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

  it("post_traces_increments_evaluations_extracted_metric", async () => {
    // M26 wiring-triad pillar (c): eval attributes ingested → evaluationsExtracted bumps.
    await post(
      tracesEnvelope({
        ...rawSpan,
        attributes: [
          { key: "eval.hallucination.score", value: { doubleValue: 0.2 } },
          { key: "eval.relevance.label", value: { stringValue: "relevant" } },
        ],
      }),
    );
    expect(evaluationsExtracted.value).toBe(2);
  });

  it("post_traces_no_evals_leaves_evaluations_metric_at_zero", async () => {
    await post(tracesEnvelope(rawSpan));
    expect(spansIngested.value).toBe(1);
    expect(evaluationsExtracted.value).toBe(0);
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

  it("test_get_traces_forwards_advanced_filters_and_rejects_bad (M52)", async () => {
    const res = await app.request(
      "/v1/traces?min_cost_usd=0.1&max_cost_usd=5&min_tokens=100&max_tokens=9000&session_id=sess-x",
    );
    expect(res.status).toBe(200);
    expect(repo.lastListOpts).toMatchObject({
      minCostUsd: 0.1,
      maxCostUsd: 5,
      minTokens: 100,
      maxTokens: 9000,
      sessionId: "sess-x",
    });
    // a non-numeric range value fails at the boundary (fail-fast 400)
    expect((await app.request("/v1/traces?min_cost_usd=abc")).status).toBe(400);
    // an EMPTY numeric value is "no filter" (undefined), NOT a spurious `>= 0` bound (M52 review LOW)
    const res2 = await app.request("/v1/traces?min_cost_usd=&max_tokens=");
    expect(res2.status).toBe(200);
    expect(repo.lastListOpts?.minCostUsd).toBeUndefined();
    expect(repo.lastListOpts?.maxTokens).toBeUndefined();
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

  it("get_traces_forwards_span_query", async () => {
    // M30: the raw span-query DSL string reaches the repo (parsed server-side there).
    const res = await app.request("/v1/traces?span_query=kind%3Allm");
    expect(res.status).toBe(200);
    expect(repo.lastListOpts?.spanQuery).toBe("kind:llm");
  });

  it("get_traces_empty_span_query_is_omitted", async () => {
    // EC: a cleared "Filter spans" bar (`?span_query=`) is "no filter", NOT a 400.
    const res = await app.request("/v1/traces?span_query=");
    expect(res.status).toBe(200);
    expect(repo.lastListOpts?.spanQuery).toBeUndefined();
  });

  it("get_traces_csv_export_honors_span_query", async () => {
    const res = await app.request("/v1/traces?span_query=kind%3Atool&format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(repo.lastListOpts).toMatchObject({ spanQuery: "kind:tool", format: "csv" });
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

  it("test_get_evaluators_returns_summary", async () => {
    repo.evaluators = [
      { name: "hallucination", count: 3, avgScore: 0.3, labels: { factual: 2, hallucinated: 1 } },
      { name: "relevance", count: 1, labels: { relevant: 1 } },
    ];
    const res = await app.request("/v1/metrics/evaluators?range=7d");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { evaluators: EvaluatorSummary[] };
    expect(body.evaluators).toHaveLength(2);
    expect(body.evaluators[0]?.name).toBe("hallucination");
    expect(body.evaluators[0]?.avgScore).toBe(0.3);
    expect(repo.lastEvaluatorsRange).toBe("7d"); // validated range passed through
  });

  it("test_get_evaluators_rejects_bad_range_with_400", async () => {
    expect((await app.request("/v1/metrics/evaluators?range=banana")).status).toBe(400);
  });

  it("test_get_evaluators_defaults_range_to_24h", async () => {
    await app.request("/v1/metrics/evaluators");
    expect(repo.lastEvaluatorsRange).toBe("24h");
  });

  it("test_evaluators_route_rejects_leaked_column_at_boundary_with_5xx", async () => {
    const leaky: SpanRepository = {
      ...repo,
      save: repo.save.bind(repo),
      getBySpanId: repo.getBySpanId.bind(repo),
      getTraceTree: repo.getTraceTree.bind(repo),
      listTraces: repo.listTraces.bind(repo),
      aggregateEvaluators: async () =>
        [{ name: "x", count: 1, labels: {}, span_id: "leak" }] as never,
    };
    expect(
      (await createApp(leaky).request("/v1/metrics/evaluators")).status,
    ).toBeGreaterThanOrEqual(500);
  });

  it("test_get_trace_tree_carries_span_evaluations", async () => {
    // Round-trip: eval.* span attributes ingested via OTLP surface as typed
    // evaluations on the trace tree node (the route returns the tree verbatim).
    await post(
      tracesEnvelope({
        spanId: "ev",
        traceId: "t-eval",
        name: "agent",
        startTimeUnixNano: "1700000000000000000",
        endTimeUnixNano: "1700000000100000000",
        attributes: [
          { key: "eval.relevance.score", value: { doubleValue: 0.9 } },
          { key: "eval.relevance.label", value: { stringValue: "relevant" } },
        ],
      }),
    );
    const tree = (await (await app.request("/v1/traces/t-eval")).json()) as TraceTreeNode;
    expect(tree.evaluations).toEqual([{ name: "relevance", score: 0.9, label: "relevant" }]);
  });

  function postAnnotation(traceId: string, body: unknown): Promise<Response> {
    return app.request(`/v1/traces/${traceId}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("test_post_annotation_creates_and_returns_list", async () => {
    const res = await postAnnotation("t1", { label: "thumbs_up", note: "great" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { annotations: Annotation[] };
    expect(body.annotations).toHaveLength(1);
    expect(body.annotations[0]).toMatchObject({ name: "feedback", label: "thumbs_up", note: "great" });
    expect(body.annotations[0]).not.toHaveProperty("spanId"); // trace-level
    expect(annotationsWritten.value).toBe(1);
  });

  it("test_post_annotation_span_level", async () => {
    const res = await postAnnotation("t1", { spanId: "s9", label: "thumbs_down" });
    const body = (await res.json()) as { annotations: Annotation[] };
    expect(body.annotations[0]?.spanId).toBe("s9");
  });

  it("test_post_annotation_empty_400_no_write", async () => {
    const res = await postAnnotation("t1", { note: "   " });
    expect(res.status).toBe(400);
    expect(annotationsWritten.value).toBe(0);
  });

  it("test_post_annotation_absent_trace_404", async () => {
    repo.annTraceExists = false;
    expect((await postAnnotation("ghost", { label: "thumbs_up" })).status).toBe(404);
    expect(annotationsWritten.value).toBe(0);
  });

  it("test_post_annotation_upsert_replaces", async () => {
    await postAnnotation("t1", { label: "thumbs_up" });
    await postAnnotation("t1", { label: "thumbs_down", note: "changed my mind" });
    const list = await repo.listAnnotations("t1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ label: "thumbs_down", note: "changed my mind" });
  });

  it("test_get_annotations_returns_list", async () => {
    await postAnnotation("t1", { label: "thumbs_up" });
    const res = await app.request("/v1/traces/t1/annotations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { annotations: Annotation[] };
    expect(body.annotations).toHaveLength(1);
  });

  it("test_delete_annotation_idempotent", async () => {
    await postAnnotation("t1", { label: "thumbs_up" });
    const res = await app.request("/v1/traces/t1/annotations?name=feedback", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.json() as { annotations: Annotation[] }).annotations).toHaveLength(0);
    // deleting again → still 200, still empty (idempotent)
    const again = await app.request("/v1/traces/t1/annotations?name=feedback", { method: "DELETE" });
    expect(again.status).toBe(200);
  });

  it("test_annotations_route_rejects_leaked_column_at_boundary_with_5xx", async () => {
    const leaky: SpanRepository = {
      ...repo,
      save: repo.save.bind(repo),
      getBySpanId: repo.getBySpanId.bind(repo),
      getTraceTree: repo.getTraceTree.bind(repo),
      listTraces: repo.listTraces.bind(repo),
      upsertAnnotation: async () => true,
      listAnnotations: async () =>
        [{ name: "feedback", annotatorKind: "HUMAN", updatedAt: "x", trace_id: "leak" }] as never,
    };
    expect(
      (await createApp(leaky).request("/v1/traces/t1/annotations")).status,
    ).toBeGreaterThanOrEqual(500);
  });

  function postJson(path: string, body: unknown): Promise<Response> {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("test_post_dataset_creates_and_is_idempotent", async () => {
    const a = (await (await postJson("/v1/datasets", { name: "travel" })).json()) as Dataset;
    expect(a.name).toBe("travel");
    const b = (await (await postJson("/v1/datasets", { name: "travel" })).json()) as Dataset;
    expect(b.id).toBe(a.id); // create-or-get
  });

  it("test_post_dataset_blank_400", async () => {
    expect((await postJson("/v1/datasets", { name: "   " })).status).toBe(400);
  });

  it("test_get_datasets_lists_with_counts", async () => {
    const ds = (await (await postJson("/v1/datasets", { name: "travel" })).json()) as Dataset;
    await postJson(`/v1/datasets/${ds.id}/items`, { traceId: "t1" });
    const body = (await (await app.request("/v1/datasets")).json()) as { datasets: Dataset[] };
    const travel = body.datasets.find((d) => d.name === "travel");
    expect(travel?.itemCount).toBe(1);
  });

  it("test_post_dataset_item_adds_and_returns_detail", async () => {
    const ds = (await (await postJson("/v1/datasets", { name: "travel" })).json()) as Dataset;
    const res = await postJson(`/v1/datasets/${ds.id}/items`, { traceId: "t1" });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as DatasetDetail;
    expect(detail.items.map((i) => i.traceId)).toContain("t1");
    expect(datasetItemsAdded.value).toBe(1);
  });

  it("test_post_dataset_item_missing_traceId_400", async () => {
    const ds = (await (await postJson("/v1/datasets", { name: "travel" })).json()) as Dataset;
    expect((await postJson(`/v1/datasets/${ds.id}/items`, {})).status).toBe(400);
    expect(datasetItemsAdded.value).toBe(0); // no write on a 400
  });

  it("test_post_dataset_item_absent_dataset_404", async () => {
    expect((await postJson("/v1/datasets/ds-ghost/items", { traceId: "t1" })).status).toBe(404);
    expect(datasetItemsAdded.value).toBe(0); // no write on a 404
  });

  it("test_post_dataset_item_absent_trace_404", async () => {
    repo.dsItemTraceExists = false;
    const ds = (await (await postJson("/v1/datasets", { name: "travel" })).json()) as Dataset;
    expect((await postJson(`/v1/datasets/${ds.id}/items`, { traceId: "ghost" })).status).toBe(404);
    expect(datasetItemsAdded.value).toBe(0); // no write on a 404
  });

  it("test_get_dataset_detail_404_when_absent", async () => {
    expect((await app.request("/v1/datasets/ds-ghost")).status).toBe(404);
  });

  it("test_delete_dataset_item_removes_and_idempotent", async () => {
    const ds = (await (await postJson("/v1/datasets", { name: "travel" })).json()) as Dataset;
    await postJson(`/v1/datasets/${ds.id}/items`, { traceId: "t1" });
    const res = await app.request(`/v1/datasets/${ds.id}/items/t1`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as DatasetDetail).items).toHaveLength(0);
    // deleting again → still 200 (idempotent)
    expect((await app.request(`/v1/datasets/${ds.id}/items/t1`, { method: "DELETE" })).status).toBe(200);
  });

  it("test_delete_dataset_item_absent_dataset_404", async () => {
    expect(
      (await app.request("/v1/datasets/ds-ghost/items/t1", { method: "DELETE" })).status,
    ).toBe(404);
  });

  it("test_datasets_route_rejects_leaked_column_at_boundary_with_5xx", async () => {
    const leaky: SpanRepository = {
      ...repo,
      save: repo.save.bind(repo),
      getBySpanId: repo.getBySpanId.bind(repo),
      getTraceTree: repo.getTraceTree.bind(repo),
      listTraces: repo.listTraces.bind(repo),
      listDatasets: async () =>
        [{ id: "d1", name: "x", createdAt: "x", itemCount: 0, secret: "leak" }] as never,
    };
    expect((await createApp(leaky).request("/v1/datasets")).status).toBeGreaterThanOrEqual(500);
  });

  it("test_get_agents_returns_catalog", async () => {
    repo.agents = [
      {
        name: "research_agent",
        firstSeenAt: "2026-06-20T00:00:00.000Z",
        latestSeenAt: "2026-06-24T00:00:00.000Z",
        runCount: 8,
        versions: ["1.0.0", "1.1.0", "1.2.0"],
        versionCount: 3,
        tools: ["essential_info"],
        systemPrompt: "You are a travel researcher.",
        stale: false,
        highChurn: true,
        anonymous: false,
      },
    ];
    const res = await app.request("/v1/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Agent[] };
    expect(body.agents[0]?.name).toBe("research_agent");
    expect(body.agents[0]?.highChurn).toBe(true);
    expect(body.agents[0]?.versionCount).toBe(3);
  });

  it("test_get_agents_empty_ok", async () => {
    repo.agents = [];
    const res = await app.request("/v1/agents");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agents: Agent[] }).agents).toEqual([]);
  });

  it("test_agents_route_rejects_leaked_column_at_boundary_with_5xx", async () => {
    const leaky: SpanRepository = {
      ...repo,
      save: repo.save.bind(repo),
      getBySpanId: repo.getBySpanId.bind(repo),
      getTraceTree: repo.getTraceTree.bind(repo),
      listTraces: repo.listTraces.bind(repo),
      aggregateAgents: async () =>
        [{ name: "x", firstSeenAt: "a", latestSeenAt: "b", runCount: 1, versions: [], versionCount: 0, tools: [], stale: false, highChurn: false, anonymous: false, secret: "leak" }] as never,
    };
    expect((await createApp(leaky).request("/v1/agents")).status).toBeGreaterThanOrEqual(500);
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
