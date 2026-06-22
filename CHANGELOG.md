# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/) and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- V1 ship gate: a single automated end-to-end test walks the full journey from a clean `docker compose up` — start the stack, instrument and run the example agent, ingest spans, see the execution tree, walk the session replay, and check cost + tool analytics — so V1 readiness is a binary, reproducible check (`pnpm test:e2e`) (M8)
- North-star metrics in Lens itself: a `/metrics` view and `GET /v1/metrics/north-star` show traces ingested per day and replay sessions opened per week (M8)
- Executions list search: `GET /v1/traces` accepts filter (status, model, time range) + sort (recency / latency / tokens / cost) so you can find a specific execution instead of scrolling a flat list; each execution now shows an ok/error status (a trace is error if any of its spans errored); the filtered list exports to CSV/JSON (M9)

### Changed

### Deprecated

### Removed

### Fixed

### Security

## [0.8.0] - 2026-06-21

### Added
- One-command stack: `docker compose up` now serves the Trace Explorer UI from the API at the same origin (http://localhost:4318) and applies database migrations on boot, so a clean checkout is ready to receive spans and view them with no manual migration or second service (M7)

## [0.7.0] - 2026-06-21

### Added
- Tool analytics: tool-call spans are extracted to a typed indexed `tool_name` at ingest; `GET /v1/analytics/tools` ranks tools by call count / latency p50/p95 / error rate over a recent window, and `GET /v1/analytics/tools/:name/traces` drills down to the executions that called a tool — rendered as a sortable ranking view + drill-down in the UI. Tool error rate counts both numeric and textual ERROR span status consistently, and latency ignores clock-skewed negative durations (M6)

## [0.6.0] - 2026-06-20

### Added
- Cost analytics: per-execution USD cost is computed from span token attributes via a configurable per-model price table and stored at ingest; `GET /v1/traces/:id/cost` and `GET /v1/analytics/cost?period=day|week` expose per-trace and day/week cost, rendered as a total in the trace detail and a period view in the UI (M5)

## [0.5.0] - 2026-06-20

### Added
- Session Replay in the Trace Explorer: step through a session's spans (forward/back/jump, ArrowLeft/Right) in deterministic temporal/causal order with the active span highlighted — computed from persisted spans, no agent re-execution (M4)

## [0.4.0] - 2026-06-20

### Added
- Trace Explorer UI (`packages/web`, React + Vite): list executions, explore a session's span tree (nesting, duration, status), and inspect span detail (model/provider/tokens/attributes/error) with loading/error/empty states (M3)
- `GET /v1/traces`: list executions newest-first as a stable JSON contract decoupled from the storage schema (M3)

## [0.3.0] - 2026-06-20

### Added
- `@usetheo/lens-sdk`: instrument a TS/Node agent in ≤10 lines and emit OTLP `gen_ai` spans to Theo Lens — `initTheoLens`, `startAgent`, `recordToolCall`, with `setModel`/`setResponseModel`/`setProvider`/`setUsage` helpers (M2)
- Example agent under `examples/agent/` showing the ≤10-line onboarding, validated end-to-end (M2)

## [0.2.0] - 2026-06-20

### Added
- OTLP protobuf ingestion: `POST /v1/traces` now accepts `application/x-protobuf` (and gzip) in addition to JSON (M1)
- Trace data model: `sessions` / `traces` / `spans` tables; traces and sessions are aggregates recomputed from spans (M1)
- Trace tree reconstruction: `GET /v1/traces/:traceId` returns the nested span tree assembled by parent/child relationships (M1)
- GenAI attribute extraction: model, provider, and input/output token counts are extracted from spans into typed columns (M1)


### Changed
- Trace/span ids are normalized to canonical lowercase hex on ingestion, so the same trace is consistent across SDK encoders (M1)


### Fixed
- Trace tree reconstruction is robust to malformed input: cyclic parent links are broken so the trace view never fails to render, and traces with multiple root spans return a single tree (M1)
- Concurrent ingestion of the same trace computes exact, stable token/cost totals (no double-counting on retried batches, no lost updates under load) (M1)

## [0.1.0] - 2026-06-19

### Added
- Monorepo bootstrap: pnpm workspace with `@usetheo/lens-core` and `@usetheo/lens-api`, strict TypeScript, ESLint 9, Vitest (contract/integration/e2e) (M0)
- OTLP/HTTP JSON trace ingestion: `POST /v1/traces` persists spans to Postgres via Drizzle, including recursive flattening of OTLP array/kvlist attributes (M0)
- Span read-back: `GET /v1/spans/:spanId` (M0)
- `docker compose up` brings API + Postgres for a one-command local stack (M0)


### Fixed
- Ingestion requests now fail loud and clear: a persistence error (e.g. database unavailable) returns HTTP 500 with a structured error log instead of a silent partial success (M0)

