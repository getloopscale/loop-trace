import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import { createPool } from "../../infrastructure/db/observability/drizzle-span-repository.js";
import {
  MAX_ATTEMPTS,
  claimNextJobs,
  completeJob,
  failJob,
  heartbeat,
  reclaimStale,
} from "./eval-job-claim.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const MIGRATIONS = fileURLToPath(
  new URL("../../infrastructure/db/migrations", import.meta.url),
);
const suite = PG_URI ? describe : describe.skip;

const EV = "11111111-1111-1111-1111-111111111111";
const STALE_MS = 120_000;

/**
 * M134 T3.1 — the claim protocol (ADR D1).
 *
 * This is the substrate decision made executable. The conditional
 * `UPDATE … RETURNING` is what lets several workers share one table with no
 * broker; the reclaim path is the mechanism the reference LACKED — blueprint
 * AP-4 recorded that every occurrence of its PENDING status is a write and
 * nothing ever re-drives a stranded row.
 *
 * These are integration tests by necessity. The guarantee lives in Postgres'
 * READ COMMITTED re-evaluation of the outer WHERE under a row lock; a test
 * against a fake would assert only that the code calls a function.
 */
suite("eval job claim protocol (integration, M134 T3.1)", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS });
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE eval_jobs");
  });

  afterAll(async () => {
    await pool.end();
  });

  async function enqueue(
    traceId: string,
    opts: { workspaceId?: string; runAfterSeconds?: number } = {},
  ): Promise<void> {
    await pool.query(
      `INSERT INTO eval_jobs (workspace_id, evaluator_id, trace_id, run_after)
       VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
      [opts.workspaceId ?? "default", EV, traceId, String(opts.runAfterSeconds ?? 0)],
    );
  }

  const statusOf = async (traceId: string): Promise<string> =>
    (await pool.query("SELECT status FROM eval_jobs WHERE trace_id = $1", [traceId]))
      .rows[0].status;

  it("test_claim_marks_row_and_returns_it", async () => {
    await enqueue("t-1");

    const claimed = await claimNextJobs(pool, "w1", 10, STALE_MS);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.traceId).toBe("t-1");
    expect(claimed[0]!.workspaceId).toBe("default");
    expect(claimed[0]!.attempts).toBe(1);
    expect(await statusOf("t-1")).toBe("running");
  });

  it("test_claim_carries_the_workspace_from_the_row", async () => {
    // EC-5: the loop spans workspaces. If the claim did not return the tenant,
    // the daemon would have to guess one — and both existing daemon precedents
    // in this repo guess `default`.
    await enqueue("t-ws", { workspaceId: "ws-b" });

    const claimed = await claimNextJobs(pool, "w1", 10, STALE_MS);

    expect(claimed[0]!.workspaceId).toBe("ws-b");
  });

  it("test_second_worker_does_not_claim_a_fresh_claim", async () => {
    await enqueue("t-2");

    const first = await claimNextJobs(pool, "w1", 10, STALE_MS);
    const second = await claimNextJobs(pool, "w2", 10, STALE_MS);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("test_two_workers_racing_claim_same_row_yields_one_winner", async () => {
    await enqueue("t-race");

    const [a, b] = await Promise.all([
      claimNextJobs(pool, "w1", 10, STALE_MS),
      claimNextJobs(pool, "w2", 10, STALE_MS),
    ]);

    expect(a.length + b.length).toBe(1);
    const { rows } = await pool.query(
      "SELECT attempts FROM eval_jobs WHERE trace_id = 't-race'",
    );
    expect(rows[0].attempts).toBe(1);
  });

  it("test_claim_is_exclusive_under_high_contention", async () => {
    // The two-worker case is too weak to be evidence: it passes even against a
    // naive implementation. This raises contention to 16 workers over 25 rounds
    // and asserts the invariant every round — exactly one winner AND exactly one
    // attempt increment. A double claim means one trace is scored twice (double
    // judge spend, duplicate verdicts skewing every aggregate) and the attempt
    // budget is consumed at twice the rate.
    const WORKERS = 16;
    const ROUNDS = 25;

    for (let round = 0; round < ROUNDS; round += 1) {
      await pool.query("TRUNCATE eval_jobs");
      await enqueue(`t-hot-${round}`);

      const results = await Promise.all(
        Array.from({ length: WORKERS }, (_, i) =>
          claimNextJobs(pool, `w${i}`, 1, STALE_MS),
        ),
      );

      const winners = results.reduce((n, r) => n + r.length, 0);
      expect(winners).toBe(1);

      const { rows } = await pool.query("SELECT attempts FROM eval_jobs");
      expect(Number(rows[0].attempts)).toBe(1);
    }
  });

  it("test_job_with_future_run_after_is_not_claimed", async () => {
    // EC-6: a trace still arriving across OTLP batches keeps pushing run_after
    // out; claiming it early would score it on partial spans.
    await enqueue("t-later", { runAfterSeconds: 60 });

    expect(await claimNextJobs(pool, "w1", 10, STALE_MS)).toHaveLength(0);
  });

  it("test_stale_claim_is_reclaimable_after_window", async () => {
    // The mechanism the reference lacked (AP-4). A worker that dies mid-job
    // must not strand the row forever.
    await enqueue("t-stale");
    await claimNextJobs(pool, "w1", 10, STALE_MS);
    // Simulate a worker that died: backdate its claim past the stale window.
    await pool.query(
      "UPDATE eval_jobs SET claimed_at = now() - interval '10 minutes' WHERE trace_id = 't-stale'",
    );

    const reclaimed = await claimNextJobs(pool, "w2", 10, STALE_MS);

    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.attempts).toBe(2);
  });

  it("test_heartbeat_extends_claim_so_a_live_worker_is_never_stolen_from", async () => {
    await enqueue("t-beat");
    await claimNextJobs(pool, "w1", 10, STALE_MS);
    await pool.query(
      "UPDATE eval_jobs SET claimed_at = now() - interval '10 minutes' WHERE trace_id = 't-beat'",
    );

    const ok = await heartbeat(pool, "t-beat", "w1");
    expect(ok).toBe(true);

    // With the claim refreshed, another worker must not take it.
    expect(await claimNextJobs(pool, "w2", 10, STALE_MS)).toHaveLength(0);
  });

  it("test_heartbeat_from_a_foreign_worker_is_rejected", async () => {
    // A worker that lost its claim to the reclaim path must not be able to
    // silently take it back.
    await enqueue("t-foreign");
    await claimNextJobs(pool, "w1", 10, STALE_MS);

    expect(await heartbeat(pool, "t-foreign", "w2")).toBe(false);
  });

  it("test_completed_job_is_terminal", async () => {
    await enqueue("t-done");
    const [job] = await claimNextJobs(pool, "w1", 10, STALE_MS);

    await completeJob(pool, job!.id);

    expect(await statusOf("t-done")).toBe("done");
    expect(await claimNextJobs(pool, "w2", 10, STALE_MS)).toHaveLength(0);
  });

  it("test_failed_job_is_retried_while_under_the_attempt_budget", async () => {
    await enqueue("t-retry");
    const [job] = await claimNextJobs(pool, "w1", 10, STALE_MS);

    await failJob(pool, job!.id, "provider timeout");

    // Back to queued, with the reason recorded — the Failure-scenarios table
    // promised a reason and v1.0 of the plan had nowhere to put it.
    expect(await statusOf("t-retry")).toBe("queued");
    const { rows } = await pool.query(
      "SELECT last_error FROM eval_jobs WHERE trace_id = 't-retry'",
    );
    expect(rows[0].last_error).toBe("provider timeout");
    expect(await claimNextJobs(pool, "w2", 10, STALE_MS)).toHaveLength(1);
  });

  it("test_job_reaching_max_attempts_moves_to_failed_and_is_not_reclaimed", async () => {
    // EC-8. Without an attempt budget, a deterministically failing job — bad
    // judge config, permanent 401, a filter typo — is claimed, fails, goes
    // stale, and is reclaimed every sweep forever, competing with every other
    // tenant's work. This is AP-4 inverted into a livelock.
    await enqueue("t-doomed");

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      const [job] = await claimNextJobs(pool, `w${i}`, 10, STALE_MS);
      expect(job).toBeDefined();
      await failJob(pool, job!.id, `attempt ${i + 1} failed`);
    }

    expect(await statusOf("t-doomed")).toBe("failed");
    // Terminal: no sweep ever picks it up again.
    expect(await claimNextJobs(pool, "w-later", 10, STALE_MS)).toHaveLength(0);
  });

  it("test_reclaimStale_reports_how_many_rows_it_freed", async () => {
    await enqueue("t-a");
    await enqueue("t-b");
    await claimNextJobs(pool, "w1", 10, STALE_MS);
    await pool.query("UPDATE eval_jobs SET claimed_at = now() - interval '10 minutes'");

    expect(await reclaimStale(pool, STALE_MS)).toBe(2);
    expect(await statusOf("t-a")).toBe("queued");
  });

  it("test_claim_respects_the_limit", async () => {
    for (const t of ["t-1", "t-2", "t-3", "t-4"]) await enqueue(t);

    expect(await claimNextJobs(pool, "w1", 2, STALE_MS)).toHaveLength(2);
  });
});
