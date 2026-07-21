import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import { createPool, DrizzleSpanRepository } from "../observability/drizzle-span-repository.js";
import { DrizzleEvaluatorRepository } from "./drizzle-evaluator-repository.js";
import { runEvaluator, runSweep, type EngineDeps } from "../../../domain/evaluation/evaluator-engine.js";
import { evaluatorSchema } from "../../../domain/evaluation/evaluator.js";
import type { Span } from "../../../domain/observability/span.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

const WS_A = "ws-alice";
const WS_B = "ws-bob";

function span(over: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
  return { name: "op", startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000100000000", ...over };
}

suite("M36 evaluator engine (integration)", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;
  let spanRepo: DrizzleSpanRepository;
  let evalRepo: DrizzleEvaluatorRepository;
  let deps: EngineDeps;

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    spanRepo = new DrizzleSpanRepository(db);
    evalRepo = new DrizzleEvaluatorRepository(db);
    deps = { evaluatorRepo: evalRepo, spanRepo, judge: null, backfillMax: 500 };
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE spans, traces, sessions, evaluators, monitors, span_evaluations");
  });
  afterAll(async () => {
    await pool.end();
  });

  async function verdictCount(ws: string, name: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM span_evaluations WHERE workspace_id=$1 AND name=$2",
      [ws, name],
    );
    return Number(rows[0]!.n);
  }

  it("test_run_rule_evaluator_writes_verdicts_visible_via_store", async () => {
    // one root span (error status) → rule status:error → pass verdict written
    await spanRepo.save([span({ spanId: "s1", traceId: "t1", statusCode: "ERROR" })], WS_A);
    const ev = await evalRepo.createEvaluator(
      evaluatorSchema.parse({ name: "is_error", kind: "rule", config: { predicate: "status:error" } }),
      WS_A,
    );
    const r = await runEvaluator(ev, {}, WS_A, deps);
    expect(r.written).toBe(1);
    expect(await verdictCount(WS_A, "is_error")).toBe(1);
  });

  it("test_rerun_is_idempotent_no_duplicate_rows", async () => {
    await spanRepo.save([span({ spanId: "s1", traceId: "t1" })], WS_A);
    const ev = await evalRepo.createEvaluator(
      evaluatorSchema.parse({ name: "q", kind: "rule", config: { predicate: "" } }),
      WS_A,
    );
    await runEvaluator(ev, {}, WS_A, deps);
    await runEvaluator(ev, {}, WS_A, deps); // re-run
    expect(await verdictCount(WS_A, "q")).toBe(1); // idempotent
  });

  it("test_run_scoped_to_workspace", async () => {
    await spanRepo.save([span({ spanId: "a1", traceId: "ta" })], WS_A);
    await spanRepo.save([span({ spanId: "b1", traceId: "tb" })], WS_B);
    const evA = await evalRepo.createEvaluator(
      evaluatorSchema.parse({ name: "q", kind: "rule", config: { predicate: "" } }),
      WS_A,
    );
    const r = await runEvaluator(evA, {}, WS_A, deps);
    expect(r.written).toBe(1); // only A's trace
    expect(await verdictCount(WS_A, "q")).toBe(1);
    expect(await verdictCount(WS_B, "q")).toBe(0); // B untouched
  });

  it("test_sweep_runs_enabled_evaluators_over_recent_traces", async () => {
    await spanRepo.save([span({ spanId: "s1", traceId: "t1" })], WS_A);
    await evalRepo.createEvaluator(
      evaluatorSchema.parse({ name: "swept", kind: "rule", config: { predicate: "" } }),
      WS_A,
    );
    const results = await runSweep(WS_A, deps);
    expect(results).toHaveLength(1);
    expect(results[0]!.written).toBe(1);
    expect(await verdictCount(WS_A, "swept")).toBe(1);
  });

  it("test_concurrent_runs_same_span_leave_one_row", async () => {
    // F4/CV-1: two concurrent runs on the SAME (evaluator, span) must leave exactly
    // one span_evaluations row (workspace-leading unique + onConflict — no Lost Update).
    await spanRepo.save([span({ spanId: "s1", traceId: "t1" })], WS_A);
    const ev = await evalRepo.createEvaluator(
      evaluatorSchema.parse({ name: "q", kind: "rule", config: { predicate: "" } }),
      WS_A,
    );
    await Promise.all([
      runEvaluator(ev, {}, WS_A, deps),
      runEvaluator(ev, {}, WS_A, deps),
    ]);
    expect(await verdictCount(WS_A, "q")).toBe(1);
  });

  it("test_backfill_zero_matches_writes_nothing", async () => {
    // no spans → nothing to evaluate
    const ev = await evalRepo.createEvaluator(
      evaluatorSchema.parse({ name: "q", kind: "rule", config: { predicate: "" } }),
      WS_A,
    );
    const r = await runEvaluator(ev, {}, WS_A, deps);
    expect(r.written).toBe(0);
    expect(r.errors).toHaveLength(0);
  });
});
