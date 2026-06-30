# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/) and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Online Evaluators (M36, in progress): theo-lens can now **compute** eval verdicts (not just store ingested ones) — an evaluator (deterministic **rule** reusing the M30 span-query DSL, or an **LLM-judge** via a configurable OpenAI-compatible endpoint) runs on-demand or via an opt-in periodic sweep and writes verdicts into the existing `span_evaluations` store (M26 read surfaces light up automatically); flag-only **guards** flag traces whose verdict breaches a threshold. Per-workspace (M22). [Phase 1: `evaluators`/`guards` tables + rule/guard domain engine]

### Changed
- Roadmap consolidated into **`ROADMAP-v4.md`** — a single authoritative view of every delivered milestone (M0–M35, all `[x]`, each with its shipped version), since the work had been split across the phased `ROADMAP.md` (V1, M0–M8), `ROADMAP-v2.md` (V2, M9–M14) and `ROADMAP-v3.md` (V3, M15–M21) plus the CHANGELOG, with M22–M35 never recorded as milestone headers. The three phased files are kept as historical phase records (V1 gains a "superseded — see v4" banner); the M22 block briefly added to V1 was moved into v4 where it belongs (auth/production is a V3.x concern, not V1). New work appends to v4 (next free id M36).
- Roadmap: queued **M36 — Online Evaluators (eval-as-rule + guards)** in `ROADMAP-v4.md` as the next milestone (provisional objective + DoD, to be sharpened by `/grill-me` + `/discover-plan` before `/to-plan`). Closes the evals track by adding the compute/write path on top of M26's read path.

### Deprecated

### Removed

### Fixed
- `/code-quality` audit no longer walks `knowledge-base/references/` (cloned third-party reference repos): the skip-list used `referencia` (PT) instead of the real directory name `references` (EN), so the symbol-fabrication detector parsed ~25k foreign files — wasting minutes and gigabytes of RAM and producing a spurious `FAIL_HARD` verdict that blocked `/review`. Now the references zone is correctly skipped, with a behavioral regression test. (#37)
- Admin key mint (`POST /v1/admin/keys`) is now atomic: the target-workspace upsert and the key insert run in one transaction, so a failed key insert never leaves an orphan workspace row (closes review item LENS-AUTH-4).
- Admin key mint `expires_at` is validated as a strict ISO-8601 datetime instead of any string `Date.parse` accepts (e.g. "Jan 1 2027" is now rejected), matching the documented contract (closes review item LENS-AUTH-3).

### Security

## [0.36.0] - 2026-06-30

### Added
- Authentication & multi-tenant workspace isolation (M22): theo-lens is now a tenant-isolated data-plane capability. Per-tenant API keys (`theo_live_*`, SHA-256-stored) resolve a Principal (workspace + scopes); every data route is gated by per-verb scope (`lens:read`/`lens:write`/`lens:delete`); every query is scoped by `workspace_id` (cross-tenant isolation proven per repository method); an admin key surface (`/v1/admin/keys` mint/list/revoke) lets the gateway mint per-tenant keys with anti-escalation (a `lens:platform-admin` key is 403 on every data verb); multi-tenant mode (`THEOLENS_REQUIRE_CREDENTIAL`) fails closed (401 missing/bad credential, 503 backend error — never a privileged default); single-tenant deployments collapse to a `default` workspace unchanged. Isolation is proven end-to-end through a hermetic ForwardAuth edge contract, with a committed auth-overhead benchmark (sub-1.2 ms p50). Closes the open-ingestion/open-read security gap


### Security
- Hardened cross-tenant isolation at the storage layer (M22): every client-supplied identifier (`trace_id`, `session_id`, `span_id`) is now part of a **workspace-leading composite key**, and every unique constraint (`trace_tags`, `span_evaluations`, `annotations`, `dataset_items`) is workspace-leading. Previously a shared/low-entropy id colliding across workspaces could alias rows — leaking another tenant's session/trace aggregates and span content on read, flipping trace ownership on the ingest recompute, or silently dropping the second tenant's span on insert. Every correlated subquery and aggregate join (session detail, session list, trace list filters/search, evaluator rollups) is now `workspace_id`-scoped, the retention prune cascade is workspace-precise, and the admin bootstrap token is compared in constant time. Proven by a full-collision isolation test (identical `span_id`+`trace_id`+`session_id` across two workspaces stay isolated across every read + aggregate), and end-to-end through a hermetic **real-Traefik ForwardAuth edge** (`pnpm test:e2e:edge`): two-tenant isolation, no-key deny at the edge, and the customer key stripped + never reaching the service (both CWE-441 halves)

## [0.35.0] - 2026-06-26

### Changed
- Trace detail now opens on the first span that actually has input/output instead of the trace's root — so a Claude Code trace shows its first tool's command + result immediately (the root `llm_request` carries no I/O), without hunting through the tree. The executions list's input/output preview likewise comes from a representative span: the root when it has I/O, otherwise the earliest child that does. Non-Claude traces (whose root carries the I/O) are unchanged (M35)

## [0.34.0] - 2026-06-26

### Added
- Claude Code traces now surface their real content: each `claude_code.tool` span shows the **tool's input** (the Bash command or the file path) and the **tool's result** (Bash output / file content / edit diff), and is named + classified as a **tool** so it appears in Tools analytics and the Agents catalog. LLM request spans also surface **time-to-first-token (TTFT)** and **prompt-cache token counts** (cache read / cache creation) in the trace detail (M34)

## [0.33.0] - 2026-06-25

### Added
- Agents catalog: a new **Agents** page lists your agents as first-class entities — derived from the `agent.name` / `agent.version` / `agent.system_prompt` span attributes — with each agent's run count, versions, tools used, latest system prompt, and health badges (stale > 30 days · high churn = many versions · anonymous). The demo seeds multi-version agents so the catalog shows real version history out of the box (M32)

## [0.32.0] - 2026-06-25

### Added
- Datasets: curate named sets of example traces. A new **Datasets** page lists your datasets; **"Add to Dataset"** on any executions row snapshots that trace's input/output into a dataset (creating it on the fly) — the snapshot is durable, so a curated example survives even after the source trace is pruned. The sessions list also gains a **Session Evaluations** count column (M26d)

## [0.31.0] - 2026-06-25

### Added
- Human feedback (annotations write-path): you can attach a 👍/👎 plus an optional free-text note to a trace or a span — stored, listed newest-first, and editable (re-submitting replaces, latest wins). Surfaced in a writable trace-detail **Annotations** tab + a per-row quick-annotate in the executions list, which also gains an **Evals** count column (M26b)


### Changed
- Retention prune now also hard-deletes a pruned trace's online-eval rows and human annotations (closes an orphan-row gap), reporting `evaluationsDeleted` / `annotationsDeleted` (M26b)

## [0.30.0] - 2026-06-25

### Added
- Online evals (read-path): evaluation results that arrive as span attributes (`eval.<name>.score` / `.label` / `.explanation`) are now extracted at ingest into a queryable store, surfaced per-span on the trace tree, and aggregated per-evaluator via a new `GET /v1/metrics/evaluators` endpoint (avg score + label distribution over the selected date range). A new **Evals & Metrics** page shows one Online Evaluator card per evaluator, and the trace detail gains an **Evaluations** tab listing a span's eval results (M26)

## [0.29.0] - 2026-06-25

### Added
- Live mode: a "Live" toggle in the top bar puts every view into continuous fast refresh (a pulsing badge shows it's on), so new traces appear without touching the auto-refresh dropdown; toggling off restores your chosen interval. Built on the existing visibility-aware polling — no new connection (M31)
- Span query, everywhere: the "Filter spans" bar moved into the shared top toolbar so one query now drives every project view — the executions list AND the Agent Graph / Agent Path trace pickers all narrow to the same span-query. A structured "Add Filter" builder (pick a field + value) appends a clause without typing the DSL by hand. The query is remembered across reloads (M30b)

## [0.28.0] - 2026-06-25

### Added
- Span query filter: a "Filter spans" bar on the executions list accepts a `field:value` query (`kind:llm status:error model:gpt-4o name:"…"`, space-separated, implicit AND) — a trace matches when one of its spans satisfies every clause. `kind:` matches the same semantic kind the UI shows (derived from the span's signals, not the raw OTLP kind). Parsed server-side, tolerant of half-typed input, and carried into the CSV export (M30)

## [0.27.0] - 2026-06-25

### Added
- Executions list: a row now expands in place to show its span tree inline — each child span with its kind badge (agent/LLM/tool/retriever colour), name, latency and tokens — so you can scan an agent run without leaving the list. The tree loads only when you expand a row (M29d)
- Executions list: a "Columns" menu hides/shows table columns; the choice is remembered across reloads (the Name column always stays) (M29d)
- Trace detail: the Input/Output panel has a Pretty/Raw toggle — Pretty renders markdown (default), Raw shows the exact unrendered text (M29d)
- Roadmap amended: added M29d (inline span-tree expansion + configurable columns + trace Pretty/Raw & sub-views) to the Arize peer-parity track, and sharpened M26/M30/M33 with details from a live teardown of the authenticated Arize demo (`/roadmap-feature arize-live-parity`)

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

