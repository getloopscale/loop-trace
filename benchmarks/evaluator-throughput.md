# M36 — Evaluator throughput benchmark

**Date:** 2026-06-30 · **Script:** `benchmarks/evaluator-throughput.mjs` (reproducible) ·
**DB:** Postgres 16 (`postgres:16-alpine`), local · **Node:** v24 · **N:** 200 single-span traces · **RUNS:** 3.

## What is measured

The engine's **compute/write throughput** (evals/sec) for two evaluator kinds over N
already-persisted single-span traces, off the ingest hot path (ADR D5):

- **rule** — `status:error` predicate (deterministic, no network).
- **llm_judge (mocked)** — a deterministic in-process judge stub (`judge()` returns a
  fixed verdict). The stub isolates the engine + DB cost from real LLM latency, so the
  number reflects looptrace throughput, not the model's.

Every figure is a real timed `runEvaluator` against a real DB — no fabricated numbers.

## Results (evals/sec, mean ± std over 3 runs)

| Evaluator kind | evals/sec (mean ± std) |
|---|---|
| rule (`status:error`) | **156 ± 12** |
| llm_judge (mocked, deterministic stub) | **164 ± 8** |

## Interpretation

- The two kinds are within noise of each other because the **dominant cost is the DB
  round-trips**, not the eval logic: per trace the engine does one `getTraceTree` read,
  and per matched span one `writeVerdict` upsert. The rule/judge computation itself is
  negligible (the mocked judge resolves instantly).
- At ~160 evals/sec, the **D7 backfill cap of 500** completes in ~3 s — comfortably
  off the hot path (D5), validating the cap as a safe default.
- A real `llm_judge` is bounded by the model endpoint latency (typically 100s of ms per
  call), so production judge throughput is LLM-bound, not engine-bound — which is exactly
  why runs are off the ingest hot path and bounded by the cap.
- **Optimization headroom (follow-up):** batching the per-span `writeVerdict` into a
  single multi-row upsert per trace would cut the round-trips and raise rule throughput;
  deferred (YAGNI until a workload needs it).

## Reproduce

```bash
docker compose up -d postgres            # (LOOPTRACE_PG_PORT=55432)
pnpm build                               # compiles dist + copies migrations
LOOPTRACE_PG_URI="postgresql://looptrace:looptrace@localhost:55432/looptrace" \
  node benchmarks/evaluator-throughput.mjs
```
