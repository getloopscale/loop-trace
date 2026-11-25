# M95 query-layer benchmark

Proves the migration-0025 composite/covering indexes are the **correct, planner-preferred** index
for the multi-tenant read hot-paths, and measures the gain at N / 2N / 4N. Run:

```bash
LOOPTRACE_PG_URI=postgres://… node benchmarks/query-layer.mjs
```

Missing `LOOPTRACE_PG_URI` → the script **skips** (exit 0). No PG, no fabricated numbers.

## What it measures

Seeds a real Postgres with N rows spread across **10 tenants** (`ws-0`…`ws-9`), every row within the
last 24h so the 24h workload window captures the full set — this isolates the variable under test:
the `workspace_id` selectivity (~1/10). It then times three workspace-scoped hot-paths for one tenant
(`ws-0`) **without** the 4 M95 indexes (DROP), then **with** them (CREATE) on the same data:

- `listTraces` (24h window, `ORDER BY updated_at DESC LIMIT 50`) — the dominant dashboard read, + the
  B-H3 de-N+1 per-row eval-count subquery.
- `aggregateObservability("24h")` — windowed traffic/latency/cost time-series (no LIMIT).
- `listSessions` (`ORDER BY last_seen_at DESC LIMIT 50`) — seeded across the same tenants.

Each query runs 5× per condition; the report is mean ± std + the `EXPLAIN` of the traces window query.

## The honest result (2026-07-10, throwaway PG 16, 10 tenants)

```
## N=5000
  listTraces               before  9.09±2.36ms  after  9.27±1.56ms  (0.98×)
  aggregateObservability   before  2.51±0.55ms  after  2.88±0.28ms  (0.87×)
  listSessions             before  5.23±0.97ms  after  3.45±0.31ms  (1.51×)
## N=10000
  listTraces               before 12.13±2.41ms  after 11.61±1.65ms  (1.04×)
  aggregateObservability   before  3.16±0.47ms  after  2.60±0.20ms  (1.22×)
  listSessions             before  3.91±0.79ms  after  4.26±0.56ms  (0.92×)
## N=20000
  listTraces               before 18.41±1.99ms  after 18.37±3.80ms  (1.00×)
  aggregateObservability   before  3.09±0.33ms  after  3.66±0.50ms  (0.85×)
  listSessions             before  4.42±0.82ms  after  4.39±1.04ms  (1.01×)
```

Higher-selectivity probe (50 tenants, 100k rows, query 1/50): `listTraces` 0.95×, `aggregateObservability` 0.89×.

EXPLAIN (traces window, `ORDER BY updated_at DESC LIMIT 50`):

```
before: Index Scan Backward using traces_updated_at_idx
          Index Cond: (updated_at >= …)
          Filter: (workspace_id = 'ws-0')          ← scans other tenants' recent rows, discards them
after : Index Scan Backward using traces_workspace_updated_idx
          Index Cond: ((workspace_id = 'ws-0') AND (updated_at >= …))   ← single range scan, one tenant
```

## Reading this honestly

- **The wall-clock delta at test scale (≤100k rows / ≤50 tenants) is within measurement noise (~0.85×–1.5×, std overlaps).** These tables were *already* indexed on both `workspace_id` (`traces_workspace_id_idx`, …) **and** the time column (`traces_updated_at_idx`, …) before M95, so Postgres could already reach one tenant's recent rows via a single-column index or a bitmap-AND. At this size everything is cache-resident and the differences are sub-millisecond. **This benchmark does not — and honestly cannot — show a wall-clock win at this scale.** Do not cite a speedup multiplier from it.
- **What it DOES prove is correctness: the composite is the planner-preferred index for the dominant `ORDER BY time DESC LIMIT` read.** EXPLAIN shows `after` replaces `Index Scan + Filter(workspace_id)` (or a bitmap-AND of two single-column indexes) with a **single pre-sorted range scan** on `(workspace_id, updated_at)` — `workspace_id` moves from a post-scan `Filter` into the `Index Cond`. That is the textbook multi-tenant index for this access pattern; its benefit over bitmap-AND-plus-sort is **latent** and grows with per-tenant volume toward the 10M-row `scale_traces` target (the bitmap build + sort the two single-column indexes need scales with row count; the composite range scan does not).
- **The one measured, concrete structural win is the `span_evaluations(workspace_id, trace_id)` covering index** — it makes the `listTraces` per-row eval-count subquery an **Index Only Scan** (proven in `index-usage.integration.test.ts`), removing the per-trace heap lookups (the B-H3 de-N+1). That win is real at any scale and is not a wall-clock-noise question.
- **A single-tenant benchmark cannot show any of this** — with one workspace the `workspace_id` filter has zero selectivity and the planner correctly prefers the narrower single-column time index. The 10-tenant seed is what makes the EXPLAIN honest.

## Why keep the traces/spans/sessions composites despite the flat wall-clock

They are the **correct, planner-chosen** index for the workspace-scoped `ORDER BY time` reads (a single
pre-sorted range scan vs a bitmap-AND-then-sort of two single-column indexes), and their write cost is a
modest btree on already-heavily-indexed tables. The honest position is: **correctness proven now,
wall-clock benefit latent at the target scale, not demonstrated at test scale.** The dropped jsonb GIN was
different — it could not be used *at all* by the M92 `->>=` predicate (Seq-Scan regardless), so it was pure
write-cost and was removed. "Keep an index only if it is at least the planner-preferred plan for a real
query" is the bar applied consistently: the four composites pass it; the GIN did not.

## Follow-up (out of M95 scope)

- The composites `(workspace_id, time)` supersede the single-column `(time)` indexes for every
  workspace-scoped query (which, per the `workspace_id` invariant, is every data-plane query). Evaluating
  whether the old single-column time indexes can be dropped — to keep net write cost flat — needs proof
  they serve no workspace-agnostic query (prune / maintenance). Deferred.
- Re-running this benchmark at ≥ 1M rows/tenant would move the latent composite benefit into measurable
  wall-clock; deferred until a single tenant's volume warrants it (same trigger as `spans` partitioning).
