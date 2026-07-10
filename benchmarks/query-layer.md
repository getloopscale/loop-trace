# M95 query-layer benchmark

Proves the migration-0025 composite/covering indexes are the **correct** index for the
multi-tenant read hot-paths, and measures the gain at N / 2N / 4N. Run:

```bash
THEOLENS_PG_URI=postgres://… node benchmarks/query-layer.mjs
```

Missing `THEOLENS_PG_URI` → the script **skips** (exit 0) with a message. No PG, no fabricated
numbers.

## What it measures

Seeds a real Postgres with N total rows spread across **10 tenants** (`ws-0`…`ws-9`), `updated_at`
over 30 days — the realistic production shape. It then times three workspace-scoped hot-paths for
one tenant (`ws-0`, ~1/10 of the rows) **without** the 4 M95 indexes (DROP), then **with** them
(CREATE) on the same data:

- `listTraces` (24h window) — the B-H3 de-N+1 path (per-row eval-count subquery).
- `aggregateObservability("24h")` — windowed traffic/latency/cost time-series.
- `listSessions` — session list.

Each query runs 5× per condition; the report is mean ± std + the `EXPLAIN` plan of the traces
window query.

## The honest result (2026-07-10, throwaway PG 16)

```
## N=5000
  listTraces               before 10.47±1.04ms  after 9.06±1.16ms  (1.16×)
  aggregateObservability   before  2.26±0.42ms  after 2.15±0.29ms  (1.05×)
  listSessions             before  2.10±0.60ms  after 1.94±0.23ms  (1.08×)
## N=20000
  listTraces               before 14.89±1.92ms  after 13.63±1.88ms  (1.09×)
  aggregateObservability   before  3.52±0.45ms  after 3.31±0.26ms  (1.06×)
  listSessions             before  1.72±0.20ms  after 1.95±0.19ms  (0.89×)
```

EXPLAIN (traces window):

```
before: Index Scan Backward using traces_updated_at_idx
          Index Cond: (updated_at >= …)
          Filter: (workspace_id = 'ws-0')          ← scans ALL tenants' recent rows, discards 9/10
after : Index Scan Backward using traces_workspace_updated_idx
          Index Cond: ((workspace_id = 'ws-0') AND (updated_at >= …))   ← seeks ONE tenant, no filter
```

## Reading this honestly

- **The win is correctness, proven by EXPLAIN, not a headline multiplier.** `after` moves
  `workspace_id` from a post-scan `Filter` into the `Index Cond` — the planner seeks directly to the
  queried tenant's slice instead of scanning every tenant's recent rows and discarding them.
- **The wall-clock delta is modest at test scale (~1.1×) and scales with tenant count.** The
  single-column `traces_updated_at_idx` cost scales with the recent-row count across **all** tenants
  (the `Filter` throws away 9/10 at 10 tenants, 99/100 at 100 tenants); the composite's cost scales
  only with the **queried** tenant's rows. At 10 tenants and small per-tenant windows the absolute
  saving is small; under real multi-tenant fan-out it grows.
- **A single-tenant benchmark cannot show this** — with one workspace the `workspace_id` filter has
  zero selectivity and the planner correctly prefers the narrower single-column time index. The
  multi-tenant seed is what makes the measurement honest.
- **span_evaluations composite** — the per-row eval-count subquery is served **Index Only** by
  `span_evaluations_workspace_trace_idx` (see `index-usage.integration.test.ts`), removing the
  B-H3 N+1 heap lookups.

## Follow-up (out of M95 scope)

The composites `(workspace_id, time)` supersede the single-column `(time)` indexes for every
workspace-scoped query (which, per the `workspace_id` invariant, is every data-plane query).
Evaluating whether the old single-column time indexes can be dropped — to keep net write cost flat
— is a separate optimization that needs proof they serve no workspace-agnostic query (prune /
maintenance paths). Deferred to its own milestone; see the M95 plan Unresolved Questions.
