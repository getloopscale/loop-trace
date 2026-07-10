#!/usr/bin/env node
/**
 * M95 query-layer benchmark — proves the migration-0025 composite/covering indexes help the
 * read hot-paths with NUMBERS (not reasoning), and measures how the gain scales at N / 2N / 4N.
 *
 * Method (honest, no fabricated figures):
 *   - Seed a real Postgres with N traces spread across WORKSPACES tenants (each with an evaluation
 *     → exercises the listTraces per-row eval-count subquery, the B-H3 de-N+1 path). Querying one
 *     tenant is the realistic shape where the composite (workspace_id, time) prefix earns its keep.
 *   - For each scale, measure the hot-path queries WITHOUT the 4 M95 indexes (DROP), then WITH
 *     them (CREATE) — same seeded data, ANALYZEd both times. Report mean ± std over RUNS runs
 *     and the EXPLAIN plan, so the before/after delta is the index effect and nothing else.
 *   - Requires THEOLENS_PG_URI. Missing → skip with a clear message (never fabricate numbers).
 *
 *   THEOLENS_PG_URI=… node benchmarks/query-layer.mjs
 */
import { createSpanRepository, migrateLatest } from "../packages/core/dist/index.js";
import { performance } from "node:perf_hooks";

const URI = process.env.THEOLENS_PG_URI;
if (!URI) {
  console.error("THEOLENS_PG_URI required — skipping (no fabricated numbers).");
  process.exit(0); // skip, not fail: mirrors the integration-suite gate
}

const SCALES = [5000, 10000, 20000]; // N, 2N, 4N total rows, spread across WORKSPACES tenants
const RUNS = 5;
const WORKSPACES = 10; // MULTI-tenant: the composite (workspace_id, time) prefix only earns its keep
const WS = "ws-0"; //    when the workspace filter is selective (query 1 of WORKSPACES). Single-tenant
//                       benchmarks pick the narrower single-column time index and hide the real win.
const M95_INDEXES = [
  "traces_workspace_updated_idx",
  "spans_workspace_ingested_idx",
  "sessions_workspace_last_seen_idx",
  "span_evaluations_workspace_trace_idx",
];

function stats(xs) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { mean, std };
}

async function seed(pool, spanRepo, n) {
  await pool.query("TRUNCATE spans, traces, sessions, evaluators, guards, span_evaluations");
  // Bulk-seed via raw SQL so the seed cost does not dominate wall-clock. Rows are spread across
  // WORKSPACES tenants ('ws-'||(g % WORKSPACES)) and updatedAt over 30 days — the realistic
  // production shape. The queried workspace holds ~1/WORKSPACES of the rows, so the composite's
  // workspace_id prefix is the difference between seeking one tenant vs scanning all tenants' rows.
  await pool.query(
    `INSERT INTO traces (workspace_id, trace_id, name, updated_at, status_code, total_tokens, cost_usd)
     SELECT 'ws-'||(g % $2), 't'||g, 'op', now() - (g % 2592000) * interval '1 second',
            CASE WHEN g % 2 = 0 THEN 'ok' ELSE 'error' END, g % 1000, (g % 100)::numeric / 100
     FROM generate_series(1, $1) g`,
    [n, WORKSPACES],
  );
  await pool.query(
    `INSERT INTO spans (workspace_id, span_id, trace_id, name, start_time_unix_nano, end_time_unix_nano, ingested_at)
     SELECT 'ws-'||(g % $2), 's'||g, 't'||g, 'op', '1700000000000000000', '1700000000100000000', now() - (g % 2592000) * interval '1 second'
     FROM generate_series(1, $1) g`,
    [n, WORKSPACES],
  );
  await pool.query(
    `INSERT INTO span_evaluations (workspace_id, span_id, trace_id, name)
     SELECT 'ws-'||(g % $2), 's'||g, 't'||g, 'q' FROM generate_series(1, $1) g`,
    [n, WORKSPACES],
  );
  await pool.query("ANALYZE traces, spans, span_evaluations");
}

async function dropIndexes(pool) {
  for (const idx of M95_INDEXES) await pool.query(`DROP INDEX IF EXISTS ${idx}`);
}
async function createIndexes(pool) {
  await pool.query(`CREATE INDEX IF NOT EXISTS traces_workspace_updated_idx ON traces (workspace_id, updated_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS spans_workspace_ingested_idx ON spans (workspace_id, ingested_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS sessions_workspace_last_seen_idx ON sessions (workspace_id, last_seen_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS span_evaluations_workspace_trace_idx ON span_evaluations (workspace_id, trace_id)`);
  await pool.query("ANALYZE traces, spans, span_evaluations");
}

// The hot-path workloads. A narrow (recent 24h) time window so the composite is selective.
const now = () => Date.now();
async function timeOnce(fn) {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}
function workloads(repo) {
  const from = new Date(now() - 24 * 3600 * 1000).toISOString();
  const to = new Date(now()).toISOString();
  return {
    listTraces: () => repo.listTraces({ from, to, limit: 50 }, WS),
    aggregateObservability: () => repo.aggregateObservability("24h", WS),
    listSessions: () => repo.listSessions(WS, { limit: 50 }),
  };
}

async function measure(repo) {
  const wl = workloads(repo);
  const out = {};
  for (const [name, fn] of Object.entries(wl)) {
    const samples = [];
    for (let r = 0; r < RUNS; r++) samples.push(await timeOnce(fn));
    out[name] = stats(samples);
  }
  return out;
}

async function explain(pool) {
  const from = new Date(now() - 24 * 3600 * 1000).toISOString();
  const { rows } = await pool.query(
    `EXPLAIN (COSTS OFF) SELECT * FROM traces WHERE workspace_id = $1 AND updated_at >= $2 ORDER BY updated_at DESC LIMIT 50`,
    [WS, from],
  );
  return rows.map((r) => r["QUERY PLAN"]).join(" / ");
}

async function main() {
  const { repo, pool } = createSpanRepository(URI);
  await migrateLatest(pool);
  console.log(`# M95 query-layer benchmark — ${RUNS} runs/query, scales ${SCALES.join("/")} (N/2N/4N)\n`);
  for (const n of SCALES) {
    await seed(pool, repo, n);

    await dropIndexes(pool);
    const before = await measure(repo);
    const planBefore = await explain(pool);

    await createIndexes(pool);
    const after = await measure(repo);
    const planAfter = await explain(pool);

    console.log(`## N=${n}`);
    for (const q of Object.keys(before)) {
      const b = before[q], a = after[q];
      const speedup = b.mean / a.mean;
      console.log(
        `  ${q.padEnd(24)} before ${b.mean.toFixed(2)}±${b.std.toFixed(2)}ms  after ${a.mean.toFixed(2)}±${a.std.toFixed(2)}ms  (${speedup.toFixed(2)}×)`,
      );
    }
    console.log(`  EXPLAIN(traces window) before: ${planBefore}`);
    console.log(`  EXPLAIN(traces window) after : ${planAfter}\n`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
