# M33 — Copilot endpoint-overhead benchmark

**Date:** 2026-06-30 · **Script:** `benchmarks/copilot-overhead.mjs` (reproducible) ·
**DB:** Postgres 16 (`postgres:16-alpine`), local · **Node:** v24.18.0 ·
**CPU:** 13th Gen Intel Core i7-1355U (12 cores), 16 GB · **N:** 200 ask requests/run · **RUNS:** 3.

## What is measured

The **looptrace-side latency** of `POST /v1/traces/:traceId/ask` — everything looptrace does
around the LLM call: the per-workspace rate-limit check (D3), the `getTraceTree` read,
the bounded prompt assembly (`buildCopilotPrompt`), and the 32 KiB answer cap (EC-6).

A **deterministic in-process mock chat client** (`ask()` returns a fixed string
instantly) stands in for the provider, so the figure excludes the (provider-bound) LLM
round-trip. This isolates what looptrace adds on top of the model — the model latency is
the dominant, provider-dependent term in production and is measured separately, not here.

Every figure is a real timed `app.request` against a real DB — no fabricated numbers.

## Results (latency in ms, over 3 runs of 200 requests)

| Percentile | mean ± std (ms) |
|---|---|
| p50 | **1.35 ± 0.12** |
| p95 | **2.10 ± 0.36** |
| mean | **1.44 ± 0.17** |

(20 warm-up requests per process are excluded from the measurement.)

## Interpretation

- LoopTrace-side overhead is **~1.4 ms mean / ~2.1 ms p95** — negligible next to a real LLM
  call (typically 100s of ms to seconds). The endpoint is dominated by the provider
  round-trip, exactly as designed: looptrace grounds + bounds the request cheaply and
  lets the model do the expensive work.
- The dominant looptrace-side cost is the single `getTraceTree` DB read; rate-limit check and
  prompt assembly are in-memory and sub-millisecond.
- **Fail-closed is free:** the 503 (no provider) / 429 (rate-limited) paths short-circuit
  before the DB read, so a disabled or throttled deployment answers even faster.
- **Optimization headroom (follow-up):** none warranted — the endpoint is LLM-bound in
  production; optimizing a ~1.4 ms looptrace-side path would be premature (YAGNI).

## Reproduce

```bash
docker compose up -d postgres            # (LOOPTRACE_PG_PORT=55432)
pnpm build                               # compiles dist + copies migrations
LOOPTRACE_PG_URI="postgresql://looptrace:looptrace@localhost:55432/looptrace" \
  node benchmarks/copilot-overhead.mjs
```
