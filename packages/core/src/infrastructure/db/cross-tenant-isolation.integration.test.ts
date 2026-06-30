import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../domain/span.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("./migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

const WS_A = "ws-alice";
const WS_B = "ws-bob";

/** A minimal span in a given trace/session. */
function span(over: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
  return {
    name: "op",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    ...over,
  };
}

/**
 * M22 — the load-bearing isolation proof: a read in workspace A NEVER returns
 * workspace B's rows, across EVERY read method. A missed `WHERE workspace_id`
 * filter on any method is a silent cross-tenant leak; this suite is the gate.
 */
suite("M22 cross-tenant isolation (integration)", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;
  let repo: DrizzleSpanRepository;

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    repo = new DrizzleSpanRepository(db);
  });
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE spans, traces, sessions, replay_sessions, trace_tags, span_evaluations, annotations, dataset_items, datasets",
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  it("test_ingest_binds_caller_workspace_and_reads_isolate", async () => {
    // Bob ingests a trace; Alice must not see it, Bob must.
    await repo.save(
      [
        span({
          spanId: "b-span",
          traceId: "b-trace",
          sessionId: "b-sess",
          model: "gpt-4o",
          inputTokens: 10,
          outputTokens: 5,
          inputValue: "bob secret prompt",
          toolName: "Bash",
        }),
      ],
      WS_B,
    );

    // getBySpanId
    expect(await repo.getBySpanId("b-span", WS_A)).toBeNull();
    expect((await repo.getBySpanId("b-span", WS_B))?.spanId).toBe("b-span");
    // getTraceTree
    expect(await repo.getTraceTree("b-trace", WS_A)).toBeNull();
    expect((await repo.getTraceTree("b-trace", WS_B))?.traceId).toBe("b-trace");
    // listTraces
    expect((await repo.listTraces({}, WS_A)).traces).toHaveLength(0);
    expect((await repo.listTraces({}, WS_B)).traces).toHaveLength(1);
    // getTraceCost
    expect(await repo.getTraceCost("b-trace", WS_A)).toBeNull();
    expect(await repo.getTraceCost("b-trace", WS_B)).not.toBeNull();
    // listSessions / getSessionDetail
    expect((await repo.listSessions(WS_A)).sessions).toHaveLength(0);
    expect((await repo.listSessions(WS_B)).sessions).toHaveLength(1);
    expect(await repo.getSessionDetail("b-sess", WS_A)).toBeNull();
    expect(await repo.getSessionDetail("b-sess", WS_B)).not.toBeNull();
    // aggregateToolStats (Bash only in B)
    expect((await repo.aggregateToolStats(WS_A)).tools).toHaveLength(0);
    expect((await repo.aggregateToolStats(WS_B)).tools.map((t) => t.toolName)).toContain("Bash");
    // listTracesForTool
    expect((await repo.listTracesForTool("Bash", 50, WS_A)).traces).toHaveLength(0);
    expect((await repo.listTracesForTool("Bash", 50, WS_B)).traces).toHaveLength(1);
    // aggregateAgents — seed an agent span in B
  });

  it("test_two_workspaces_same_trace_id_do_not_collide", async () => {
    // The SAME trace_id ingested by two workspaces stays isolated (span_id is the
    // PK, so use distinct span ids; the trace aggregate is keyed by trace_id but
    // bound to its workspace via the recompute).
    await repo.save([span({ spanId: "a1", traceId: "shared", inputValue: "A" })], WS_A);
    await repo.save([span({ spanId: "b1", traceId: "shared", inputValue: "B" })], WS_B);
    const aTree = await repo.getTraceTree("shared", WS_A);
    const bTree = await repo.getTraceTree("shared", WS_B);
    // Each workspace sees only its own span under that trace id.
    expect(aTree?.spanId).toBe("a1");
    expect(bTree?.spanId).toBe("b1");
  });

  it("test_identical_ids_full_collision_isolate", async () => {
    // The hostile case the review's BLOCKERs (F-sec-1/2/3) turn on: an attacker in
    // workspace B replays the EXACT span_id + trace_id + session_id of workspace A.
    // Pre-composite-PK this aliased rows (shared single-column keys) and leaked A's
    // aggregates/content into B's reads (and flipped trace ownership on the upsert).
    // With composite (workspace_id, *) keys + workspace-scoped queries, every read
    // is per-tenant and the second ingest is NOT dropped (onConflict is per-pair).
    const ID = { spanId: "x", traceId: "t" };
    await repo.save(
      [
        span({
          ...ID,
          sessionId: "s",
          model: "gpt-4o",
          inputTokens: 100,
          outputTokens: 100,
          inputValue: "ALICE PRIVATE",
          evaluations: [{ name: "quality", score: 0.9, label: "good" }],
        }),
      ],
      WS_A,
    );
    await repo.save(
      [
        span({
          ...ID,
          sessionId: "s",
          model: "gpt-4o",
          inputTokens: 1,
          outputTokens: 1,
          inputValue: "BOB PRIVATE",
          evaluations: [{ name: "quality", score: 0.1, label: "bad" }],
        }),
      ],
      WS_B,
    );

    // Both ingests survived (the second was NOT silently dropped by onConflict).
    expect((await repo.getBySpanId("x", WS_A))?.inputValue).toBe("ALICE PRIVATE");
    expect((await repo.getBySpanId("x", WS_B))?.inputValue).toBe("BOB PRIVATE");

    // getTraceTree: each tenant sees ONLY its own span content under the shared id.
    expect((await repo.getTraceTree("t", WS_A))?.inputValue).toBe("ALICE PRIVATE");
    expect((await repo.getTraceTree("t", WS_B))?.inputValue).toBe("BOB PRIVATE");

    // getTraceCost: distinct token counts → distinct, non-summed costs (F-sec-3:
    // the recompute reads only the caller's spans, never the other tenant's).
    const costA = await repo.getTraceCost("t", WS_A);
    const costB = await repo.getTraceCost("t", WS_B);
    expect(costA?.totalTokens).toBe(200);
    expect(costB?.totalTokens).toBe(2);

    // getSessionDetail (F-sec-1): aggregates are per-tenant — traceCount 1 each,
    // tokens NOT summed across the shared session_id.
    const sdA = await repo.getSessionDetail("s", WS_A);
    const sdB = await repo.getSessionDetail("s", WS_B);
    expect(sdA?.traceCount).toBe(1);
    expect(sdA?.totalTokens).toBe(200);
    expect(sdB?.traceCount).toBe(1);
    expect(sdB?.totalTokens).toBe(2);

    // listSessions (F-sec-2): one session per tenant, tokens scoped, no cross-bleed.
    const lsA = (await repo.listSessions(WS_A)).sessions;
    const lsB = (await repo.listSessions(WS_B)).sessions;
    expect(lsA).toHaveLength(1);
    expect(lsA[0]?.totalTokens).toBe(200);
    expect(lsB[0]?.totalTokens).toBe(2);

    // aggregateEvaluators (the JOIN-scope fix): each tenant's "quality" eval is its
    // own — A's avg is 0.9, B's is 0.1, never averaged together across the shared id.
    const evA = await repo.aggregateEvaluators("30d", WS_A);
    const evB = await repo.aggregateEvaluators("30d", WS_B);
    expect(evA.find((e) => e.name === "quality")?.avgScore).toBeCloseTo(0.9);
    expect(evB.find((e) => e.name === "quality")?.avgScore).toBeCloseTo(0.1);
  });

  it("test_tags_annotations_datasets_isolate", async () => {
    await repo.save([span({ spanId: "a1", traceId: "ta", inputValue: "in", outputValue: "out" })], WS_A);
    await repo.save([span({ spanId: "b1", traceId: "tb", inputValue: "in", outputValue: "out" })], WS_B);

    // Tag a trace in A — B cannot tag A's trace (advisory existence check fails).
    expect(await repo.addTag("ta", "prod", WS_A)).toBe(true);
    expect(await repo.addTag("ta", "prod", WS_B)).toBe(false); // not B's trace
    expect(await repo.listTags("ta", WS_A)).toEqual(["prod"]);
    expect(await repo.listTags("ta", WS_B)).toEqual([]);

    // Annotation isolation.
    expect(
      await repo.upsertAnnotation("ta", { name: "fb", annotatorKind: "HUMAN", spanId: undefined }, WS_A),
    ).toBe(true);
    expect(
      await repo.upsertAnnotation("ta", { name: "fb", annotatorKind: "HUMAN", spanId: undefined }, WS_B),
    ).toBe(false);
    expect(await repo.listAnnotations("ta", WS_A)).toHaveLength(1);
    expect(await repo.listAnnotations("ta", WS_B)).toHaveLength(0);

    // Datasets: same name in A and B do not collide; each sees only its own.
    const dsA = await repo.createDataset("golden", WS_A);
    const dsB = await repo.createDataset("golden", WS_B);
    expect(dsA.id).not.toBe(dsB.id);
    expect((await repo.listDatasets(WS_A)).map((d) => d.id)).toEqual([dsA.id]);
    expect((await repo.listDatasets(WS_B)).map((d) => d.id)).toEqual([dsB.id]);
    // A's dataset is invisible to B (getDataset).
    expect(await repo.getDataset(dsA.id, WS_B)).toBeNull();
    expect(await repo.getDataset(dsA.id, WS_A)).not.toBeNull();
    // Adding A's trace to A's dataset works; B cannot add to A's dataset.
    expect(await repo.addDatasetItem(dsA.id, "ta", WS_A)).toBe(true);
    expect(await repo.addDatasetItem(dsA.id, "ta", WS_B)).toBe(false);
  });

  it("test_metrics_aggregates_isolate", async () => {
    await repo.save(
      [span({ spanId: "a1", traceId: "ta", model: "gpt-4o", inputTokens: 100, outputTokens: 50 })],
      WS_A,
    );
    // A sees its cost/observability/north-star; B sees nothing.
    expect((await repo.aggregateCostByPeriod("day", WS_A)).buckets.length).toBeGreaterThan(0);
    expect((await repo.aggregateCostByPeriod("day", WS_B)).buckets).toHaveLength(0);
    const obsA = await repo.aggregateObservability("7d", WS_A);
    const obsB = await repo.aggregateObservability("7d", WS_B);
    expect(obsA.tokensByModel.length).toBeGreaterThan(0);
    expect(obsB.tokensByModel).toHaveLength(0);
    await repo.recordReplaySession("ta", WS_A);
    const nsA = await repo.aggregateNorthStar(WS_A);
    const nsB = await repo.aggregateNorthStar(WS_B);
    expect(nsA.tracesPerDay.reduce((s, b) => s + b.count, 0)).toBeGreaterThan(0);
    expect(nsB.tracesPerDay.reduce((s, b) => s + b.count, 0)).toBe(0);
  });

  it("test_single_tenant_default_behaves_as_pre_m22", async () => {
    // No workspace passed → the `default` workspace; reads see default-ingested data.
    await repo.save([span({ spanId: "d1", traceId: "td", inputValue: "x" })]);
    expect((await repo.getBySpanId("d1"))?.spanId).toBe("d1");
    expect((await repo.listTraces({})).traces).toHaveLength(1);
  });
});
