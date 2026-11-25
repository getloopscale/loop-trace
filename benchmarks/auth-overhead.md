# M22 — Auth overhead benchmark

**Date:** 2026-06-30 (re-run after the workspace-leading composite-key isolation fix) ·
**Script:** `benchmarks/auth-overhead.mjs` (reproducible) ·
**DB:** Postgres 16 (`postgres:16-alpine`), local · **Node:** v24 · **N:** 500 requests/run × 3 runs (50-request warmup discarded).

## What is measured

The per-request latency the **multi-tenant auth path** adds — `bearerAuth` +
`requireScopeOnPrincipal` + the SHA-256 `looptrace_api_keys` indexed lookup — versus
**single-tenant** (no verifier → `DEFAULT_PRINCIPAL`, no DB lookup). Measured on the
two hot paths: the executions **read** (`GET /v1/traces`) and the OTLP **ingest**
(`POST /v1/traces`, empty envelope to isolate the auth cost from the persistence cost).
Every figure is a real timed `app.request` against a real DB — no fabricated numbers.

## Results (p50 / p95 / mean ± std, ms; averaged over 3 runs)

| Path | mode | p50 | p95 | mean ± std |
|---|---|---|---|---|
| `GET /v1/traces` (read) | single-tenant | 2.83 | 3.95 | 2.90 ± 0.68 |
| `GET /v1/traces` (read) | multi-tenant (auth) | 3.62 | 5.98 | 4.64 ± 5.28 |
| `POST /v1/traces` (ingest, empty) | single-tenant | 0.078 | 0.129 | 0.081 ± 0.039 |
| `POST /v1/traces` (ingest, empty) | multi-tenant (auth) | 1.25 | 2.03 | 1.33 ± 0.37 |

**Auth overhead (p50 delta):** read **+0.79 ms**, ingest **+1.17 ms**.

> Absolute numbers vary run-to-run with machine load (this run was on a busier host
> than the 2026-06-26 baseline — note the wider read multi-tenant std). The **delta**
> is the signal: a sub-1.2 ms p50 constant cost dominated by one SHA-256 + one indexed
> `looptrace_api_keys` probe, independent of trace size. The composite-key isolation fix
> touches only data-table writes (the recompute), not the auth path, so it does not
> change the auth overhead being measured here.

## Interpretation

- The added cost is the **SHA-256 hash of the bearer token + one indexed lookup** on
  `looptrace_api_keys (key_hash)` (a `UNIQUE` index → single-row probe) + the scope check.
- Sub-1.2 ms p50 is a **modest, constant** overhead, independent of trace size (the
  lookup is O(1) on the key, not on the data). It does not scale with ingest volume.
- The read path's absolute latency is dominated by the list query, not auth.
- The fire-and-forget `last_used_at` touch is off the critical path (never awaited).

## Reproduce

```bash
docker compose up -d postgres            # (LOOPTRACE_PG_PORT=55432)
pnpm build                               # compiles dist + copies migrations
cd packages/api
LOOPTRACE_PG_URI="postgresql://looptrace:looptrace@localhost:55432/looptrace" \
  node ../../benchmarks/auth-overhead.mjs
```
