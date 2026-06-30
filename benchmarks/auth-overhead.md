# M22 — Auth overhead benchmark

**Date:** 2026-06-26 · **Script:** `benchmarks/auth-overhead.mjs` (reproducible) ·
**DB:** Postgres 16 (`postgres:16-alpine`), local · **Node:** v24 · **N:** 500 requests/run × 3 runs (50-request warmup discarded).

## What is measured

The per-request latency the **multi-tenant auth path** adds — `bearerAuth` +
`requireScopeOnPrincipal` + the SHA-256 `theo_api_keys` indexed lookup — versus
**single-tenant** (no verifier → `DEFAULT_PRINCIPAL`, no DB lookup). Measured on the
two hot paths: the executions **read** (`GET /v1/traces`) and the OTLP **ingest**
(`POST /v1/traces`, empty envelope to isolate the auth cost from the persistence cost).
Every figure is a real timed `app.request` against a real DB — no fabricated numbers.

## Results (p50 / p95 / mean ± std, ms; averaged over 3 runs)

| Path | mode | p50 | p95 | mean ± std |
|---|---|---|---|---|
| `GET /v1/traces` (read) | single-tenant | 1.22 | 1.78 | 1.25 ± 0.30 |
| `GET /v1/traces` (read) | multi-tenant (auth) | 1.75 | 2.31 | 1.79 ± 0.39 |
| `POST /v1/traces` (ingest, empty) | single-tenant | 0.016 | 0.026 | 0.018 ± 0.017 |
| `POST /v1/traces` (ingest, empty) | multi-tenant (auth) | 0.53 | 0.74 | 0.56 ± 0.19 |

**Auth overhead (p50 delta):** read **+0.54 ms**, ingest **+0.51 ms**.

## Interpretation

- The added cost is the **SHA-256 hash of the bearer token + one indexed lookup** on
  `theo_api_keys (key_hash)` (a `UNIQUE` index → single-row probe) + the scope check.
- ~0.5 ms p50 is a **modest, constant** overhead, independent of trace size (the lookup
  is O(1) on the key, not on the data). It does not scale with ingest volume.
- The read path's absolute latency (1.2–1.8 ms) is dominated by the list query, not auth.
- The fire-and-forget `last_used_at` touch is off the critical path (never awaited).

## Reproduce

```bash
docker compose up -d postgres            # (THEOLENS_PG_PORT=55432)
pnpm build                               # compiles dist + copies migrations
cd packages/api
THEOLENS_PG_URI="postgresql://theolens:theolens@localhost:55432/theolens" \
  node ../../benchmarks/auth-overhead.mjs
```
