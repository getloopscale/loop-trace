import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type SpanRepository } from "@usetheo/lens-core";
import { createSpanRepository, migrateLatest } from "@usetheo/lens-core/infra";
import { createApp } from "@usetheo/lens-api";
import type pg from "pg";

import { LensReadClient } from "./client.js";

/**
 * M117 (T1.3) — the per-method runtime-path proof for the 13 GENERATED (zod-backed) read methods.
 * The two-layer drift gate pins these 13 shapes STATICALLY (snapshot ↔ live doc ↔ generated types);
 * this contract test proves the RUNTIME path each method walks — engine-relative URL, query mapping,
 * the shared transport, and the real handler → repo → DB → envelope round-trip. Drives the SDK against
 * the REAL engine (`createApp(repo)` over Testcontainers Postgres, `app.fetch` injected). Gated on
 * THEOLENS_PG_URI (Testcontainers globalSetup provides it).
 *
 * The paired `listLabelingQueue`/`getLabelingItem` reads feed `enqueueForLabeling`'s returned id back
 * into the read (Corner 1 write→read round-trip #2), proving the asymmetry is closed at runtime.
 */
const PG_URI = process.env["THEOLENS_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

suite("LensReadClient ↔ engine — M117 GENERATED read parity (T1.3)", () => {
  let app: ReturnType<typeof createApp>;
  let repo: SpanRepository;
  let pool: pg.Pool;
  let client: LensReadClient;

  beforeAll(async () => {
    const created = createSpanRepository(PG_URI as string);
    repo = created.repo;
    pool = created.pool;
    await migrateLatest(pool);
    app = createApp(repo);
    const engineFetch: typeof fetch = (input, init) =>
      app.fetch(new Request(typeof input === "string" ? input : input.toString(), init));
    client = new LensReadClient({
      baseUrl: "http://engine.local",
      apiKey: "theo_live_contract_test",
      fetch: engineFetch,
    });
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE spans, traces, sessions, replay_sessions, labeling_queue_items");
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Ingest a trace through the real OTLP `/v1/traces` path (the cost/agents/facets reads). */
  async function seedTrace(): Promise<void> {
    const span = {
      spanId: "sdk-a1",
      traceId: "sdk-t1",
      name: "chat",
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000000500000000",
      attributes: {
        "gen_ai.request.model": "gpt-4",
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 5,
      },
    };
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] }),
    });
    expect(res.status).toBe(200);
  }

  /**
   * Seed the typed `toolName` / `sessionId` columns directly via the repo — the OTLP `/v1/traces`
   * ingest does NOT map the `gen_ai.tool.name` / `session.id` attributes into those typed columns
   * (Claude Code's own `tool_name` / a session rollup do), and `getToolTraces` / `getSession` filter
   * on the columns. Seeding via the same repo the app is wired with keeps the contract honest — the
   * read still walks the real handler → repo → DB → envelope path (mirrors the core session/tool tests).
   */
  function repoSpan(sessionId: string, toolName: string) {
    return {
      spanId: "repo-a1",
      traceId: "repo-t1",
      name: toolName,
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000000100000000",
      model: "gpt-4",
      inputTokens: 3,
      outputTokens: 2,
      sessionId,
      toolName,
    };
  }

  it("getTraceCost round-trips the trace's cost rollup shape", async () => {
    await seedTrace();
    const cost = await client.getTraceCost("sdk-t1");
    expect(cost.traceId).toBe("sdk-t1");
    expect(typeof cost.costUsd).toBe("number");
    expect(typeof cost.inputTokens).toBe("number");
    expect(typeof cost.outputTokens).toBe("number");
    expect(typeof cost.totalTokens).toBe("number");
  });

  it("listTraceTags returns the { tags } wrapper", async () => {
    await seedTrace();
    const res = await client.listTraceTags("sdk-t1");
    expect(Array.isArray(res.tags)).toBe(true);
  });

  it("listTraceAnnotations returns the { annotations } wrapper", async () => {
    await seedTrace();
    const res = await client.listTraceAnnotations("sdk-t1");
    expect(Array.isArray(res.annotations)).toBe(true);
  });

  it("getAgents returns the { agents } catalog with the seeded agent", async () => {
    await repo.save([
      {
        spanId: "agent-a1",
        traceId: "agent-t1",
        name: "agent.run",
        startTimeUnixNano: "1700000000000000000",
        endTimeUnixNano: "1700000000100000000",
        attributes: { "agent.name": "agent-x" },
      },
    ]);
    const res = await client.getAgents();
    expect(Array.isArray(res.agents)).toBe(true);
    expect(res.agents.some((a) => a.name === "agent-x")).toBe(true);
  });

  it("getToolTraces returns the trace list for a seeded tool", async () => {
    await repo.save([repoSpan("sess-1", "search")]);
    const res = await client.getToolTraces("search");
    expect(Array.isArray(res.traces)).toBe(true);
    expect(res.traces.some((t) => t.traceId === "repo-t1")).toBe(true);
  });

  it("getNorthStar returns the two aggregate series", async () => {
    await seedTrace();
    const res = await client.getNorthStar();
    expect(Array.isArray(res.tracesPerDay)).toBe(true);
    expect(Array.isArray(res.replaySessionsPerWeek)).toBe(true);
  });

  it("getEvaluatorMetrics returns the { evaluators } aggregate", async () => {
    await seedTrace();
    const res = await client.getEvaluatorMetrics();
    expect(Array.isArray(res.evaluators)).toBe(true);
  });

  it("getScores returns the ranged { range, scores } shape", async () => {
    await seedTrace();
    const res = await client.getScores();
    expect(res.range).toBeDefined();
    expect(Array.isArray(res.scores)).toBe(true);
  });

  it("getSpanAttributes returns the facet-keys mode with no key", async () => {
    await seedTrace();
    const res = await client.getSpanAttributes();
    expect(res.mode).toBe("keys");
    if (res.mode === "keys") expect(Array.isArray(res.keys)).toBe(true);
  });

  it("getSpanAttributes returns the values mode for a given key", async () => {
    await seedTrace();
    const res = await client.getSpanAttributes({ key: "gen_ai.request.model" });
    expect(res.mode).toBe("values");
    if (res.mode === "values") {
      expect(res.key).toBe("gen_ai.request.model");
      expect(Array.isArray(res.values)).toBe(true);
    }
  });

  it("getSession returns the session detail with member traces", async () => {
    await repo.save([repoSpan("sess-1", "search")]);
    const res = await client.getSession("sess-1");
    expect(res.sessionId).toBe("sess-1");
    expect(Array.isArray(res.traces)).toBe(true);
    expect(typeof res.traceCount).toBe("number");
    expect(res.traceCount).toBeGreaterThan(0);
  });

  it("getDataset returns the dataset detail (create → getDataset round-trip)", async () => {
    const created = await client.createDataset({ name: "read-parity-set" });
    const detail = await client.getDataset(created.id);
    expect(detail.id).toBe(created.id);
    expect(detail.name).toBe("read-parity-set");
    expect(Array.isArray(detail.items)).toBe(true);
  });

  it("test_listLabelingQueue_returns_enqueued_item (write→read round-trip)", async () => {
    await seedTrace();
    const item = await client.enqueueForLabeling("sdk-t1", { spanId: "sdk-a1" });
    const page = await client.listLabelingQueue();
    expect(page.items.some((i) => i.id === item.id)).toBe(true);
    expect(typeof page.total).toBe("number");
    expect(typeof page.page).toBe("number");
    expect(typeof page.pageSize).toBe("number");
  });

  it("getLabelingItem returns the enqueued item by id (enqueue→getLabelingItem round-trip)", async () => {
    await seedTrace();
    const item = await client.enqueueForLabeling("sdk-t1", { spanId: "sdk-a1" });
    const read = await client.getLabelingItem(item.id);
    expect(read.id).toBe(item.id);
    expect(read.traceId).toBe("sdk-t1");
    expect(read.spanId).toBe("sdk-a1");
    expect(read.status).toBe("pending");
  });
});
