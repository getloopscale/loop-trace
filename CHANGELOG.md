# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/) and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security

## [0.26.0] - 2026-06-24

### Added
- Global date-range picker: a single time control in the top bar (Last 1 hour / 24 hours / 7 days / 30 days, default 7 days) drives the dashboard, the summary strip, the executions list, and the CSV export — replacing the per-list From/To inputs so there is one clear, sticky time window. The summary KPI labels reflect the selected range. Plus a saved-view selector that names and stores executions filter sets (status / model / tag / search / sort) for one-click reuse. Both persist in the browser and degrade safely if storage is unavailable (M29b)

## [0.25.0] - 2026-06-24

### Added
- Span-kind colour identity: every span kind now reads one consistent colour everywhere — the executions kind badge, the trace span-tree glyph, and the Agent Graph/Path nodes all draw from a single canonical map (AGENT violet · LLM orange · TOOL amber · RETRIEVER blue · EMBEDDING green), and the executions list gains a colored model pill per model. Token-based (no raw hex); the colour is always paired with its text label (M29)

## [0.24.0] - 2026-06-24

### Added
- Demo dataset: `pnpm db:seed:demo` seeds an idempotent multi-agent travel-agent trace set (a `TripAgentGraph` orchestrating `local_agent`/`research_agent`/`budget_agent`/`itinerary_agent`, each with ChatOpenAI LLM, tool, and retriever spans) so every screen — Executions, the trace 3-pane, Agent Graph, Agent Path, Sessions — shows rich, realistic content out of the box. Goes through the real OTLP ingestion path; re-running never duplicates (M28)
- Command palette: press Cmd/Ctrl+K anywhere to jump to any view or open a trace by ID (M-UX)
- Roadmap amended: added the AI-observability peer-parity track to ROADMAP-v3.md — M28 (travel-agent demo dataset seeder), M29 (parity UI deltas + analytics polish), M30 (span query filter language), M31 (Live mode); M26 (online evals) referenced as the track's evals milestone (`/roadmap-feature arize-feature-parity`)
- Roadmap: absorbed learnings from a 2nd studied peer (Grafana Sigil) — extended M29 (KPI delta %, model pills, Time-to-First-Token, Breakdown-by dimension), enriched M26's design (eval-as-rule + Guards + inline span verdicts + human feedback), and added net-new M32 (versioned agents catalog) and M33 ("Ask about this step" trace copilot)


### Changed
- The whole UI is now uniformly dark (Violet Forge): the executions filter toolbar, the trace span tree/waterfall, the cost & tool analytics tables, the session-detail metrics, the input/output code blocks, the tag chips, the replay controls, and every loading/empty/error state were migrated off the last light-theme stylesheet onto the design system. Loading states now show shimmer skeletons instead of "Loading…" text, and empty states can offer a next-step action. No behavior, route, or data change — presentation only (M-UX)


### Fixed
- The web production bundle (`vite build`) failed to compile under strict TypeScript (`exactOptionalPropertyTypes`): `TraceTable` forwarded a `boolean | undefined` `loading` prop to the design-system `DataTable` (which accepts `boolean` or omitted). Coerced to `loading ?? false` so the UI bundle builds again (M18 regression)

## [0.23.0] - 2026-06-24

### Added
- Full-text search: the executions list gains a search box (`GET /v1/traces?q=`) that finds traces by the text of *any* span's input or output (prompt/response) — not just the root — backed by a Postgres GIN-indexed `tsvector` over span content. Queries are user-friendly (`websearch_to_tsquery`: bare words AND, "quoted phrases", `or`, `-exclude`) and never error on odd input; results are relevance-ranked by default and compose with the existing status/model/time/tag filters and the CSV export. One index-only migration; no new dependency (M24)

## [0.22.0] - 2026-06-24

### Added
- Data retention: an opt-in policy hard-prunes trace data older than `THEOLENS_RETENTION_DAYS` so the database stops growing forever — trace-granular (a whole trace with its spans, tags, replay rows, and any now-orphaned session), atomic, keyed on the trace's last activity. Runs via the `pnpm db:prune` command and an opt-in in-process sweep (`THEOLENS_RETENTION_SWEEP_HOURS`, default 6h). Default OFF — nothing is ever deleted unless an operator sets a retention window; an invalid/zero window stays disabled (never a delete-all). No schema migration; no new dependency (M23)

## [0.21.0] - 2026-06-23

### Added
- Agent Graph + Agent Path (Arize): two span-derived flow visualizations of an agent run — Agent Graph (a node per agent/operation, edges per parent→child handoff, kind-colored, with Start/End terminals) and Agent Path (a Sankey of span flow by semantic kind with a kind legend) — rendered per-trace client-side (a trace picker defaults to the most-recent) from the existing `GET /v1/traces[/:id]` span tree, using `d3-sankey` (chosen via deps-audit, 0 CVE) for a crossing-minimized layout. Wired into the project Tabs; no backend change (M21)

## [0.20.0] - 2026-06-23

### Added
- Sessions list + metrics dashboard redesign (Arize): the sessions list becomes a dense `@theokit/ui` DataTable led by the session's first user message (first message · messages · duration · tokens · cost · start · end), and the metrics view becomes the "Pinned Charts" dashboard — Traffic / Span Latency / Tokens / Cost stat-cards with a global Line / Stacked-bar / Distribution chart-type toggle, north-star metrics re-homed into it. The first message is derived from the earliest trace's root span via a query-only enrichment of `GET /v1/sessions` (no schema migration); charts reuse the existing M11 series with zero new dependency (M20)

## [0.19.0] - 2026-06-23

### Added
- Trace detail 3-pane: the trace view is now an Arize-style 3-pane layout — a waterfall span tree (left) selects a span that drives a tabbed info panel (Trace Info / Attributes / Events, center) and an always-visible Input/Output panel (right, XSS-safe markdown). Built by recomposing the existing M10 tree + M12 markdown/JSON primitives on `@theokit/ui` Tabs; replay/keyboard navigation, the session link, cost, and tags are preserved. Zero new dependency, no backend change (M19)

## [0.18.0] - 2026-06-23

### Added
- Traces list redesign: the executions list is now an Arize-style dense table (`@theokit/ui` DataTable) with kind badges, status, model, input/output previews, start/end, latency, tokens and cost — sortable via the column headers — topped by a 24h summary strip (traffic / latency p95 / tokens / cost sparklines). `GET /v1/traces` list items are enriched (model, cost, root operation/tool signals, end time, input/output preview) derived from the trace's root span + existing columns with no schema migration; the semantic kind badge is classified client-side. M9 filters/export and the M16 auto-refresh are preserved (M18)

## [0.17.0] - 2026-06-23

### Added
- Design-system app shell: the Trace Explorer is rebuilt on the `@theokit/ui` design system (Violet Forge, dark) with a persistent left sidebar (Executions / Sessions / Dashboards / Metrics / Tools / Cost), a top bar, and an Arize-style project-view tab strip (Traces / Spans / Agent Graph / Agent Path), so every view now lives inside one consistent dark shell instead of ad-hoc per-page headers. All existing views and behavior (including the M16 auto-refresh control) are preserved; Spans / Agent Graph / Agent Path show a placeholder until their milestone. First milestone of the V3 UX track (M17)


### Security
- Cleared GHSA-vqpr-j7v3-hqw9 (valibot `EMOJI_REGEX` ReDoS, HIGH) pulled transitively by `@theokit/ui`: forced the patched `valibot` (≥1.2.0) across the tree via a `pnpm-workspace.yaml` override (M17)

## [0.16.0] - 2026-06-23

### Added
- Live auto-refresh: the executions list, dashboards, sessions, metrics, and tool/cost analytics views refresh themselves on a configurable interval (Off / 5s / 10s / 30s / 1m, default Off) via a toolbar control with an "updated Xs ago" freshness indicator (announced to assistive tech), so an operator watching agents run live (e.g. a Claude Code session ingesting via M15) never reloads the page. Polling pauses while the browser tab is hidden and the open trace view is never auto-refreshed. Built on the existing react-query layer (`refetchInterval`) — zero new dependency, no backend change (M16)

## [0.15.0] - 2026-06-23

### Added
- Claude Code integration: point Claude Code's OpenTelemetry trace export at Theo Lens (helper `scripts/theo-instrument-claude.sh`) and its agent sessions appear as first-class executions — model, tokens, cost, input, and session grouping all populate. Built on an extensible **agent-adapter** seam (selected by `service.name`) so other external agents (Codex, …) integrate by adding one adapter, with zero change to existing traces. Verified by dogfooding a real Claude Code session into Theo Lens (M15)

## [0.14.0] - 2026-06-22

### Added
- Tags: attach free-form tags to a trace (`POST`/`DELETE`/`GET /v1/traces/:id/tags`) and filter the executions list by tag (`GET /v1/traces?tag=`). The trace view gains an add/remove-tags panel and the list toolbar a tag filter. Tags are a lightweight grouping orthogonal to sessions (a trace can have both), stored in a side table with no change to spans/traces; adding a tag is idempotent and tagging a non-existent trace returns 404 (M14)

## [0.13.0] - 2026-06-22

### Added
- Sessions: `GET /v1/sessions` (newest-first) + `GET /v1/sessions/:id` group related traces (a multi-turn conversation / workflow sharing a `session.id` / `gen_ai.conversation.id`) and show session-scoped metrics — total cost, tokens, latency p50/p95, error rate — plus the member trace list. A `/sessions` view + a trace→session link render these with loading/error/empty states; traces without a session id stay standalone and are never grouped into a fabricated session (M13)

## [0.12.0] - 2026-06-22

### Added
- Rich span detail: the span detail panel now renders distinct Input / Output / Events / Attributes / Status sections — input/output as XSS-safe markdown, events and attributes as collapsible JSON with copy-to-clipboard — instead of one raw JSON dump. The SDK gains `setInput`/`setOutput` (emitting `input.value`/`output.value`), ingest captures those plus OTLP span events (bounded to 8 KiB text / 50 events to avoid storing unbounded blobs), and spans without the new fields still render gracefully (M12)

## [0.11.0] - 2026-06-22

### Added
- Observability dashboards: a `/dashboards` view and `GET /v1/metrics/observability?range=1h|24h|7d|30d` show time-series traffic + error rate, latency percentiles (p50/p75/p95/p99), and tokens + cost broken down by model over a selectable time range — each metric as an accessible data table plus a lightweight inline-SVG sparkline (no charting dependency added) (M11)

## [0.10.0] - 2026-06-22

### Added
- Trace waterfall: the span tree now shows a time-aligned bar per span (proportional offset + duration) so you can see where a trace spent its time, plus a span-kind icon (LLM / tool / retriever / chain) and a trace-level "contains an error" indicator that surfaces a failure anywhere in the tree (M10)

## [0.9.0] - 2026-06-22

### Added
- V1 ship gate: a single automated end-to-end test walks the full journey from a clean `docker compose up` — start the stack, instrument and run the example agent, ingest spans, see the execution tree, walk the session replay, and check cost + tool analytics — so V1 readiness is a binary, reproducible check (`pnpm test:e2e`) (M8)
- North-star metrics in Lens itself: a `/metrics` view and `GET /v1/metrics/north-star` show traces ingested per day and replay sessions opened per week (M8)
- Executions list search: `GET /v1/traces` accepts filter (status, model, time range) + sort (recency / latency / tokens / cost) so you can find a specific execution instead of scrolling a flat list; each execution now shows an ok/error status (a trace is error if any of its spans errored); the filtered list exports to CSV/JSON (M9)

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

