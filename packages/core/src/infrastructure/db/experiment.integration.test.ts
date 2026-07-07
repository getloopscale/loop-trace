import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { ExperimentRunItem } from "../../domain/experiment.js";
import { compareRuns, aggregateRun } from "../../domain/experiment.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("./migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

const WS_A = "ws-a";
const WS_B = "ws-b";

function item(over: Partial<ExperimentRunItem>): ExperimentRunItem {
  return {
    datasetItemTraceId: "t1",
    output: "out",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    costUsd: 0.001,
    latencyMs: 100,
    model: "m",
    scores: [{ name: "acc", score: 1, label: "pass" }],
    ...over,
  };
}

function runInput(over: Record<string, unknown> = {}) {
  return {
    datasetId: "11111111-1111-1111-1111-111111111111",
    name: "run-1",
    variant: { model: "gpt-x" },
    status: "completed" as const,
    truncated: false,
    createdBy: "reviewer-a",
    items: [item({ datasetItemTraceId: "t1" }), item({ datasetItemTraceId: "t2", scores: [{ name: "acc", score: 0, label: "fail" }] })],
    ...over,
  };
}

suite("experiment runs write-path (integration, M64)", () => {
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
    await pool.query("TRUNCATE experiment_runs, experiment_run_items");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("test_create_run_then_list_is_workspace_scoped (cross-tenant isolation)", async () => {
    const run = await repo.createExperimentRun(runInput(), WS_A);
    expect(run.itemCount).toBe(2);
    expect(run.passCount).toBe(1); // one pass, one fail
    // ws-A sees its run; ws-B sees NOTHING (invariant 2)
    expect((await repo.listExperimentRuns(undefined, WS_A))).toHaveLength(1);
    expect((await repo.listExperimentRuns(undefined, WS_B))).toHaveLength(0);
    // and ws-B cannot fetch ws-A's run by id
    expect(await repo.getExperimentRun(run.id, WS_B)).toBeNull();
    expect(await repo.getExperimentRun(run.id, WS_A)).not.toBeNull();
  });

  it("test_get_run_returns_items_with_scores", async () => {
    const run = await repo.createExperimentRun(runInput(), WS_A);
    const detail = await repo.getExperimentRun(run.id, WS_A);
    expect(detail?.items).toHaveLength(2);
    expect(detail?.items?.[0].output).toBe("out");
    expect(detail?.items?.[0].scores).toEqual([{ name: "acc", score: 1, label: "pass" }]);
    expect(detail?.totalCostUsd).toBeCloseTo(0.002, 6);
  });

  it("test_list_filtered_by_dataset_is_workspace_scoped", async () => {
    await repo.createExperimentRun(runInput({ datasetId: "11111111-1111-1111-1111-111111111111" }), WS_A);
    await repo.createExperimentRun(runInput({ datasetId: "22222222-2222-2222-2222-222222222222" }), WS_A);
    expect(await repo.listExperimentRuns("11111111-1111-1111-1111-111111111111", WS_A)).toHaveLength(1);
    expect(await repo.listExperimentRuns("22222222-2222-2222-2222-222222222222", WS_A)).toHaveLength(1);
    expect(await repo.listExperimentRuns("11111111-1111-1111-1111-111111111111", WS_B)).toHaveLength(0);
  });

  it("test_compare_aligns_rows_by_trace_id (provenance)", async () => {
    // two runs over the same dataset; compare aligns rows by the source trace id (provenance linkage).
    const runA = await repo.createExperimentRun(runInput({ name: "A" }), WS_A);
    const runB = await repo.createExperimentRun(
      runInput({ name: "B", items: [item({ datasetItemTraceId: "t1", scores: [{ name: "acc", score: 0, label: "fail" }] }), item({ datasetItemTraceId: "t2" })] }),
      WS_A,
    );
    const a = await repo.getExperimentRun(runA.id, WS_A);
    const b = await repo.getExperimentRun(runB.id, WS_A);
    const byTrace = (r: typeof a) => new Map((r?.items ?? []).map((it) => [it.datasetItemTraceId, it]));
    const mapA = byTrace(a);
    const mapB = byTrace(b);
    // both runs cover the same source traces (aligned by trace id)
    expect([...mapA.keys()].sort()).toEqual([...mapB.keys()].sort());
    // aggregate compare: A passed 1, B passed 1 (swapped which row) → passCountDelta 0
    const deltas = compareRuns(aggregateRun(a!.items!), aggregateRun(b!.items!));
    expect(deltas.passCountDelta).toBe(0);
  });

  it("test_concurrent_create_yields_two_distinct_runs", async () => {
    await Promise.all([repo.createExperimentRun(runInput({ name: "A" }), WS_A), repo.createExperimentRun(runInput({ name: "B" }), WS_A)]);
    expect(await repo.listExperimentRuns(undefined, WS_A)).toHaveLength(2); // distinct UUIDs, no dedup collision
  });
});
