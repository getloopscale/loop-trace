import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../../domain/observability/span.js";
import { createPool, DrizzleSpanRepository } from "../observability/drizzle-span-repository.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("./migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

function span(overrides: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
  return {
    name: "op",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    ...overrides,
  };
}

suite("span_evaluations + evaluators aggregate (integration, M26)", () => {
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
      "TRUNCATE spans, traces, sessions, replay_sessions, span_evaluations",
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("test_ingest_writes_span_evaluations_idempotent", async () => {
    const s = span({
      spanId: "e1",
      traceId: "t-eval",
      evaluations: [
        { name: "hallucination", score: 0.2, label: "factual", explanation: "ok" },
      ],
    });
    await repo.save([s]);
    await repo.save([s]); // re-ingest → must NOT duplicate (idempotent on span_id+name)
    const { rows } = await pool.query(
      "SELECT name, score, label, explanation FROM span_evaluations WHERE span_id = 'e1'",
    );
    expect(rows).toEqual([
      { name: "hallucination", score: 0.2, label: "factual", explanation: "ok" },
    ]);
  });

  it("test_trace_tree_attaches_span_evals", async () => {
    await repo.save([
      span({
        spanId: "root",
        traceId: "t-tree",
        evaluations: [{ name: "relevance", score: 0.9 }],
      }),
    ]);
    const tree = await repo.getTraceTree("t-tree");
    expect(tree?.evaluations).toEqual([{ name: "relevance", score: 0.9 }]);
  });

  it("test_evaluator_summary_groups_by_name_with_avg_and_labels", async () => {
    await repo.save([
      span({ spanId: "a1", traceId: "t1", evaluations: [{ name: "hallucination", score: 0.2, label: "factual" }] }),
      span({ spanId: "a2", traceId: "t1", evaluations: [{ name: "hallucination", score: 0.4, label: "factual" }] }),
      span({ spanId: "b1", traceId: "t1", evaluations: [{ name: "relevance", label: "relevant" }] }),
    ]);
    const summary = await repo.aggregateEvaluators("7d");
    const byName = Object.fromEntries(summary.map((s) => [s.name, s]));
    expect(byName["hallucination"]).toEqual({
      name: "hallucination",
      count: 2,
      avgScore: expect.closeTo(0.3, 5),
      labels: { factual: 2 },
    });
    expect(byName["relevance"]).toEqual({
      name: "relevance",
      count: 1,
      labels: { relevant: 1 }, // no avgScore — relevance had no numeric score
    });
  });

  it("test_evaluator_summary_excludes_out_of_window", async () => {
    // a trace updated 40 days ago is outside the 30d window
    await repo.save([span({ spanId: "old", traceId: "t-old", evaluations: [{ name: "x", score: 1 }] })]);
    await pool.query("UPDATE traces SET updated_at = now() - interval '40 days' WHERE trace_id = 't-old'");
    expect(await repo.aggregateEvaluators("30d")).toEqual([]);
  });

  // M90 — score aggregation over time
  it("test_scores_over_time_buckets_by_period_with_mean_and_labels", async () => {
    // Two evals in the current hour-bucket + one eval 2 hours back (a distinct hour
    // bucket, still within 24h). The 2h gap never collides with the current hour.
    await repo.save([
      span({ spanId: "n1", traceId: "t-now", evaluations: [{ name: "hallucination", score: 0.2, label: "factual" }] }),
      span({ spanId: "n2", traceId: "t-now", evaluations: [{ name: "hallucination", score: 0.4, label: "factual" }] }),
    ]);
    await repo.save([
      span({ spanId: "o1", traceId: "t-2h", evaluations: [{ name: "hallucination", score: 0.8, label: "hallucinated" }] }),
    ]);
    await pool.query("UPDATE traces SET updated_at = now() - interval '2 hours' WHERE trace_id = 't-2h'");

    const buckets = (await repo.aggregateScoresOverTime("24h")).filter((b) => b.name === "hallucination");
    // Two distinct hourly buckets, sorted ascending (older first).
    expect(buckets).toHaveLength(2);
    expect(buckets[0]!.periodStart < buckets[1]!.periodStart).toBe(true);
    // Older bucket: the 2h-back single sample.
    expect(buckets[0]).toEqual({
      periodStart: buckets[0]!.periodStart,
      name: "hallucination",
      sampleCount: 1,
      avgScore: 0.8,
      labels: { hallucinated: 1 },
    });
    // Current bucket: mean of {0.2, 0.4} = 0.3, both labelled factual.
    expect(buckets[1]).toEqual({
      periodStart: buckets[1]!.periodStart,
      name: "hallucination",
      sampleCount: 2,
      avgScore: expect.closeTo(0.3, 5),
      labels: { factual: 2 },
    });
  });

  it("test_scores_over_time_categorical_only_omits_avg", async () => {
    // an evaluator that only wrote a label (no numeric score) → no avgScore, labels present.
    await repo.save([
      span({ spanId: "c1", traceId: "t-cat", evaluations: [{ name: "tone", label: "warm" }] }),
      span({ spanId: "c2", traceId: "t-cat", evaluations: [{ name: "tone", label: "warm" }] }),
    ]);
    const buckets = (await repo.aggregateScoresOverTime("24h")).filter((b) => b.name === "tone");
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.avgScore).toBeUndefined();
    expect(buckets[0]!.sampleCount).toBe(2);
    expect(buckets[0]!.labels).toEqual({ warm: 2 });
  });

  it("test_scores_over_time_empty_range_is_empty_not_zero_filled", async () => {
    // an eval 40 days ago is out of the 24h window → no buckets at all. An empty
    // period is an ABSENCE, never a fabricated zero-sample bucket (M89 honesty).
    await repo.save([span({ spanId: "z", traceId: "t-z", evaluations: [{ name: "x", score: 0.5 }] })]);
    await pool.query("UPDATE traces SET updated_at = now() - interval '40 days' WHERE trace_id = 't-z'");
    expect(await repo.aggregateScoresOverTime("24h")).toEqual([]);
  });
});
