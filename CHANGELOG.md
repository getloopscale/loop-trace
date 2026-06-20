# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/) and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- OTLP protobuf ingestion: `POST /v1/traces` now accepts `application/x-protobuf` (and gzip) in addition to JSON (M1)
- Trace data model: `sessions` / `traces` / `spans` tables; traces and sessions are aggregates recomputed from spans (M1)
- Trace tree reconstruction: `GET /v1/traces/:traceId` returns the nested span tree assembled by parent/child relationships (M1)
- GenAI attribute extraction: model, provider, and input/output token counts are extracted from spans into typed columns (M1)

### Changed
- Trace/span ids are normalized to canonical lowercase hex on ingestion, so the same trace is consistent across SDK encoders (M1)

### Deprecated

### Removed

### Fixed

### Security

## [0.1.0] - 2026-06-19

### Added
- Monorepo bootstrap: pnpm workspace with `@usetheo/lens-core` and `@usetheo/lens-api`, strict TypeScript, ESLint 9, Vitest (contract/integration/e2e) (M0)
- OTLP/HTTP JSON trace ingestion: `POST /v1/traces` persists spans to Postgres via Drizzle, including recursive flattening of OTLP array/kvlist attributes (M0)
- Span read-back: `GET /v1/spans/:spanId` (M0)
- `docker compose up` brings API + Postgres for a one-command local stack (M0)


### Fixed
- Ingestion requests now fail loud and clear: a persistence error (e.g. database unavailable) returns HTTP 500 with a structured error log instead of a silent partial success (M0)

