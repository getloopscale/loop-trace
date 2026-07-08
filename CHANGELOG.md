# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/) and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Copilot answer feedback (M83, theo-lens engine half).** A per-tenant thumbs up/down on one Ask-copilot answer, restoring the affordance M72 honestly removed until an endpoint existed (#181). Engine: a `copilot_feedback` table (migration `0023`, workspace-leading unique `(workspace_id, trace_id, turn_id)`) + `SpanRepository.recordAskFeedback` (UPSERT on the unique so a re-vote **toggles** the label up↔down in place, never a duplicate row; workspace-scoped so a same-`(trace,turn)` collision across tenants is two distinct rows). One route under per-verb scope (the **CWE-441 second half**): `POST /v1/traces/:traceId/ask/feedback` → `observability:write`. Feedback is **independent of the LLM provider** (it writes to the store, never calls the model — so it works even when the copilot is down); the body is validated at the boundary (`normalizeAskFeedback`: `turnId` 1-128 chars + `label ∈ {up,down}` → typed `400`), the trace must exist in the caller's workspace (`404`), and a runtime counter (`copilotFeedbackRecorded`) makes feedback volume observable (wiring pillar c). Keyed by the client-side `turnId` because the M33 ask is stateless/single-turn (documented granularity). A vote can be **retracted** via `DELETE /v1/traces/:traceId/ask/feedback?turnId=` (`observability:write`, idempotent `204`) so the UI "clear" persists and never diverges from the store (review fix). Defense-in-depth: a `CHECK (label IN ('up','down'))` DB constraint (migration `0024`) rejects an out-of-domain label even if a future caller bypasses the app boundary. core+api suites green (583 unit + 25 copilot-feedback integration); `tsc`/`eslint` clean. BFF proxy + dashboard thumbs land in the same milestone.
- **Dataset & evaluator rename/delete verbs (M82, theo-lens engine half).** New management verbs so the dashboard can rename and delete curated datasets and online evaluators (previously create-only, no lifecycle). Engine: a typed `NameConflictError` domain error (`packages/core/src/domain/errors.ts`) + an `isUniqueViolation` helper that unwraps Drizzle's wrapped `pg` error (`.cause.code === "23505"`); `SpanRepository.renameDataset`/`deleteDataset` (UPDATE-returning with 409-on-duplicate; **application-level cascade** in a single transaction — experiment_run_items → experiment_runs → dataset_items → datasets, since the D3 convention keeps no Postgres FKs; both workspace-scoped + isUuid-guarded → null/false, never a 500); `EvaluatorRepository.updateEvaluator` (partial SET from provided fields, 409-on-duplicate). Three routes under per-verb `requireScopeOnPrincipal` (the **CWE-441 second half**): `PUT /v1/datasets/:datasetId` + `PUT /v1/evaluators/:id` → `observability:write` (bare `{name}` renames; a kind/config change re-validates the full create union, never a half-typed config; duplicate name → typed `409`); `DELETE /v1/datasets/:datasetId` → `observability:delete` (`204`/`404`, idempotent). Workspace is always the resolved Principal's, never the body. core+api suites green (578 unit + 25 dataset/evaluator integration); `tsc`/`eslint` clean. BFF proxies + dashboard UI land in the same milestone. Plan `.claude/knowledge-base/plans/m82-rename-delete-verbs-plan.md`.
- **New phase roadmap: `ROADMAP-sota-experience-v5.md` (M73–M76) — self-serve & consistency.** Authored from a **live, screen-by-screen usability walkthrough** on the running Model-B edge (`knowledge-base/discoveries/2026-07-08-usability-live-walkthrough.md` — drove the real UI post-v0.25.0, not code-reading). Where v4 fixed the correctness/craft floor, v5 fixes the *self-serve* floor: **M73** empty-state & dead-end unification (Experiments dataset-picker, Ask trace-picker, one-action empty states); **M74** derived-catalog correctness (Agents from the M67 span-kind taxonomy; Sessions prerequisite hint); **M75** list management & unique naming (rename/delete/created across Dashboards/Datasets/Evaluators; no more three boards all "Tracing Overview"; aria-names use the human name); **M76** analytics honesty on small N + unreachable capabilities + polish (min-sample delta suppression, compact sparse charts, LLM-judge evaluator creatable, labeling-queue export guard, sidebar-title/skeleton polish). Grounded in the live audit; reuse-first; each milestone an independent CYCLE. Out of scope: visual redesign, new capabilities, traces/sessions server pagination (#180), copilot feedback endpoint (#181).
- **New phase roadmap: `ROADMAP-sota-experience-v4.md` (M68–M72) — UX-hardening.** Authored from a component-by-component UX/data audit of the shipped observability dashboard (`knowledge-base/discoveries/2026-07-07-ux-audit-component-by-component.md` — 5 parallel senior-UX agents over ~15 screens; craft floor ~74/100, up from 39 pre-v2). Where v2 raised the craft floor and v3 built the Evaluate→Improve workbench, this phase **hardens what shipped**, closing the gap between "the state is present" and "the state is correct + operable + teaches the next action". Milestones: **M68** Data honesty (fix the verified correctness bugs #176 OK-spans-shown-ERROR / #177 experiments-score-fabricated-0.00 / #178 tokens-trend-plots-cost + the KPI-strip fabricated zeros + the alerts status badge + datasets error-as-empty); **M69** Error/empty/loading state integrity (the #175 Alert-body sweep across ~20 sites + hardening the `@usetheo/ui` `Alert` contract + sized/labeled skeletons + instructive empty states); **M70** Navigability & the eval loop (URL-state on the filterable lists + the cross-screen jumps session→traces/item→trace/dataset→experiment/queue→span + guards fix #179 + one capability registry for sidebar+Overview + pagination/counts); **M71** Accessibility baseline (ARIA tree roles, per-row waterfall labels, graph interactivity, copilot `role="log"`, `<Label htmlFor>` everywhere, tokenized chart palette); **M72** Craft polish & completeness (trace-level summary header, SpanDetail cost + event attributes, `formatScore` + formatter routing, write-action feedback, copilot feedback persistence + interactive citations, PII-reveal wiring). Grounded in issues usetheodev/theo-cloud #175–#179. No regressions (RED-first tests pin corrected behavior); reuse-first; data honesty non-negotiable; each milestone live-verified. Grill log `.claude/knowledge-base/grills/ux-hardening-feature-grill.md`.
- **Experiments — regression-dataset-run store + per-verb-scoped run route (M64, theo-lens half).** A new `experiment_runs` + `experiment_run_items` store (migration `0022`, workspace-leading keys; per-row evaluator scores as a `scores` jsonb reusing the M36 `Verdict`) with 3 `SpanRepository` methods — `createExperimentRun` (atomic run+items in a transaction, aggregates from the pure `aggregateRun`), `listExperimentRuns` (dataset-filtered, workspace-scoped, newest-first), `getExperimentRun` (run+items, isUuid-guarded → 404). A **DIP run engine** (`experiment-engine.ts`) loops the dataset items (capped at 25, D3), applies the variant model/prompt override, calls the reused M33 `ReplayClient.run` per item, and scores each output with the enabled **rule** evaluators via the pure `evaluateRule` (D2 — llm_judge deferred, no extra billable call); a per-item provider error is recorded (never a fabricated output) → the run is `partial`. Four routes under per-verb `requireScopeOnPrincipal` (the **CWE-441 second half**): `POST /v1/experiment-runs` → `observability:write`; `GET /v1/experiment-runs` + `…/:runId` + `…/compare` → `observability:read`. Workspace is always the resolved Principal's; the run reuses the M33 provider client + rate limiter (fail-closed 503/429) + a foreign/absent dataset → 404 before any billable call. Security proven: the scope-verb matrix asserts `platform-admin → 403` on the write verb, the route-guard enumeration asserts all 46 data routes carry a guard, a PG integration suite asserts cross-tenant isolation + compare-aligned-by-trace-id (provenance), and a **hermetic ForwardAuth e2e** proves cross-tenant isolation + fail-closed on the new run route through the real edge (theo-data invariant 6). Runtime counters. No new dependency. Full core+api suites green (core 204 + api 354); `tsc`/`eslint` clean. Backs the theo-cloud dashboard experiments UI (M64). Plan `.claude/knowledge-base/plans/m64-experiments-plan.md`.
- **Labeling queues — review remediation: partial-pending UNIQUE + negative-case route tests (M63 review).** The `labeling_queue_items` dedup UNIQUE is now a workspace-leading **partial** index `(workspace_id, trace_id, span_id) WHERE status = 'pending'` (migration `0021`), matching ADR D1 — a span is deduped only while pending, and a **resolved span can be re-enqueued for a fresh review cycle** (the review found the shipped full-UNIQUE silently blocked re-enqueue). Added tests: re-enqueue-after-resolve + paged cross-tenant list (integration), route-level `400` on a malformed/blank enqueue/resolve/export body + `404` on a foreign/missing item (app contract), and score-boundary (0/1/∞) + note/label length-cap (domain). core 191 + api 322 tests green; `tsc`/`eslint` clean.
- **Labeling queues — tenant-isolated Annotate → review → golden dataset store + routes (M63, theo-lens half).** A new `labeling_queue_items` store (migration `0020`, workspace-leading UNIQUE `(workspace_id, trace_id, span_id)`) with 5 `SpanRepository` methods — enqueue (idempotent), server-paginated list (+ status filter), get, resolve (`pending → resolved` with a versioned label/score/note payload), and export-resolved-as-golden-dataset (reuses the M44 dataset store). Five routes under per-verb `requireScopeOnPrincipal` (the **CWE-441 second half**): `GET /v1/labeling-queue` + `GET …/:itemId` → `observability:read`; `POST /v1/traces/:traceId/enqueue-for-labeling`, `POST …/:itemId/resolve`, `POST …/export-as-dataset` → `observability:write`. Workspace is always the resolved Principal's, never the body. The pure `normalizeLabelResolution` requires a label, clamps score to `[0,1]`, and stamps a schema version (taxonomy-drift warn-migrate). Security proven: the scope-verb matrix asserts `platform-admin → 403` on every write verb (least privilege), the route-guard enumeration asserts all 42 data routes carry a per-verb guard, a PG integration suite asserts cross-tenant isolation (ws-B never sees ws-A items) + idempotent enqueue + resolve round-trip + workspace-scoped export + a concurrent-double-enqueue race, and a **hermetic ForwardAuth e2e** proves cross-tenant isolation + fail-closed on the new enqueue write route through the real edge (theo-data invariant 6). Runtime counters (enqueued/resolved/exports). No new dependency. Full core+api suites green (508 tests); `tsc`/`eslint` clean. Backs the theo-cloud dashboard queue UI (M63). Plan `.claude/knowledge-base/plans/m63-labeling-queues-plan.md`.
- **Replay path surfaces real provider cost + optional structured output (M62 Phase 0).** The M55/M33 provider adapter (`packages/core/src/domain/chat.ts`) now reads `usage.cost` **additively** — real USD from providers that report it (probed: OpenRouter returns it by default), `undefined` otherwise (the dashboard renders an em-dash; cost is **never computed/fabricated**, Rule 3). The replay handler (`packages/api/src/server/handlers/replay.ts`) includes `costUsd` in its response and accepts an optional `responseSchema` object, forwarded to the provider as an OpenAI-compatible `response_format` json_schema (structured output); a non-object `responseSchema` is rejected with a typed `400` before any billable call (fail-fast at the boundary). No request-shape change for the token path (zero risk to strict providers); the dashboard BFF is a verbatim passthrough (no Go change). Backs the theo-cloud dashboard M62 side-by-side playground. Full core+api suites green (471 tests); `tsc`/`eslint` clean.
- **New phase roadmap: `ROADMAP-sota-experience-v3.md` (M63–M67) — Evaluate & Improve workbench (Arize-informed).** Authored after a **screen-by-screen study of Arize** (app.arize.com `arize-demo-llm-travel-agent`, driven live via chrome-devtools MCP — 10 screens captured), evidence at `knowledge-base/discoveries/blueprints/arize-ux-screen-by-screen.md`. Where v2 (M57–M62) closes the *presentation-craft* gap, this phase closes the **Evaluate → Improve workbench** the v2 scope explicitly parked: **M63** Labeling Queues (per-span Annotate → review queue → golden dataset export, HITL loop); **M64** Experiments (regression-dataset-from-traces + dataset-run via the M33 provider path + run-to-run compare); **M65** Prompt Hub (saved/named, versioned playgrounds referenced by experiments); **M66** Custom Dashboards (widget board + "Tracing Overview" template, extends M60 without a drag-grid builder); **M67** Agent Graph / Agent Path (agentic control-flow visualization on the trace detail). Adopts Arize's `Observe → Evaluate → Improve` sidebar IA (v2 M59 ships the grouping; this phase populates it). Every new write route (annotations/datasets/experiment-runs/prompt-versions/dashboard-config) enforces the **CWE-441 second half** (per-verb scope + hermetic ForwardAuth cross-tenant e2e — theo-data invariants 1/4/6). Depends on v2 shipping first (esp. M58's span model + Annotate hook). Grounding: `knowledge-base/discoveries/2026-07-06-sota-gap-analysis-v2.md` §§ G4–G8.
- **New phase roadmap: `ROADMAP-sota-experience-v2.md` (M57–M62) — UX craft & experience parity.** Authored after the M50–M56 SOTA-experience phase from a two-axis gap analysis + a deep-research UX blueprint built by reading the cloned frontend source of the four SOTA peers (`knowledge-base/references/{laminar,langfuse,opik,phoenix}`, file:line-cited). Where M50–M56 closed *capability* gaps, this phase closes the *experience-quality* gap (an internal design critique scored the shipped dashboard's craft at 39/100). Milestones: M57 craft-system floor (formatting/timestamps/id+copy/accent discipline/states/a11y/kill-nag); M58 trace-detail reader-mode (Transcript) + waterfall polish + namespace-grouped PII-masked attributes (a surface no peer ships); M59 traces-list density + chip filters + nav IA; M60 KPI-tile+delta+trend analytics; M61 Ask copilot as a conversation thread; M62 playground side-by-side. Reuse-first on `@usetheo/ui` (the peers are the same shadcn/Radix/Tailwind family — composition + craft discipline, not a rewrite). Grounding artifacts: `knowledge-base/discoveries/2026-07-06-sota-gap-analysis-v2.md` + `knowledge-base/discoveries/blueprints/ux-improvement-blueprint.md`.

### Changed

### Deprecated

### Removed

### Fixed
- **Experiments — disabled evaluators no longer corrupt run scores (M64 review).** The run engine's `scoreOutput` now honors the M36 `enabled` flag (`if (!ev.enabled) continue;`, mirroring `evaluator-engine.ts`) — a **disabled** rule evaluator no longer scores experiment rows (which would corrupt pass-counts/pass-rates). Regression test added. Found by the M64 architecture review as a divergence from the reused M36 scoring semantics.
- **Experiments — compare API now returns the aggregate deltas (M64 review).** `GET /v1/experiment-runs/compare` now returns a `deltas` object (the pure `compareRuns` over the first two runs' re-derived `aggregateRun`s) — wiring the previously-orphan `compareRuns` export and adding a `passRateDelta` (the DoD3 aggregate pass-*rate* delta). The dashboard compare view consumes it: aggregate pass-rate/avg-score/cost deltas + a per-row score-delta column (B vs A aligned by source trace), replacing the naive pass-*count*-of-first-two. Handler + domain tests added.

### Security

## [0.39.0] - 2026-07-05

### Added
- **`GET /v1/traces` pagination — `offset` (theo-lens M56).** `listTracesOptionsSchema` + the `listTraces` SQL gain an **`offset`** param (coerced, non-negative) so the list can be paged by `limit` up to a larger export bound (the review found the export's `limit=500`+`offset` pagination was NOT actually supported — the schema was `.strict()` with no `offset`, so page 2 got a 400; this closes that gap). `limit` stays capped at `LIST_TRACES_LIMIT_CAP=500` per request. 1 schema-unit (`offset` coerced/validated/negative-rejected) + 1 real-Postgres integration (two pages with `limit`/`offset` are disjoint — the export's contract). Pairs with the theo-cloud BFF fix (its `pageParams` clamp was raised 100→500 so the export's `limit=500` is forwarded, not silently dropped to the newest-50 default).
- **Documented read API for traces — `docs/lens-read-api.md` (theo-lens M56).** The `GET /v1/traces` filter contract the dashboard already consumes is now **documented as a stable per-tenant read API** so a customer can pull their observability data into their own tooling with a `theo_live_*` key (through the `/v1/lens` edge, `observability:read` scope, Model-B per-tenant isolation). Documents the filter params (`q`/`status`/`model`/`from`/`to`/`min_cost_usd`/`max_cost_usd`/`min_tokens`/`max_tokens`/`session_id`/`order_by`/`limit`/`offset`), the **500-row `limit` cap** (`LIST_TRACES_LIMIT_CAP`) + `offset` pagination, the machine-faithful response shape (`traceListItemSchema`), and the dashboard BFF equivalent (`/v1/dashboard/lens/traces`, browser JWT). A contract test (`read-api-doc.test.ts`) asserts the doc exists and covers the endpoint/auth/params/cap/shape — and that the documented cap matches the code (no drift). Backs the theo-cloud dashboard's M56 traces **Export** (CSV/JSON of the currently-filtered set, bounded by the documented cap with an honest disclosure). No code change to the API (the contract already existed). `pnpm test` (contract, 481) green.
- **`POST /v1/traces/:id/replay` — span replay against the real provider (theo-lens M55).** Re-runs an **edited** message list against the real provider server-side and returns `{ output, promptTokens, completionTokens, totalTokens, latencyMs, model }` — powering the dashboard's prompt playground. Reuses the sanctioned M33 copilot provider path (Rule 9): a new `openaiChatCompletionWithUsage` shares the exact OpenAI-compatible `/chat/completions` fetch/URL/headers as `openaiChatCompletion` and additionally captures the provider's `usage` block (tokens are authoritative, never client-computed — the copilot's string-only `ask` is untouched); an `OpenAICompatibleReplay` `ReplayClient` seam runs it with an optional **model** override (base_url/apiKey stay server config — the client can never redirect the call, so there is **no SSRF surface**). The `replayHandler` mirrors the copilot's fail-closed structure: **rate-limited per workspace** (429 — the billable-abuse guard), **503** when the provider is unconfigured, **400** on an invalid body (empty/oversized messages, bad role, oversized model), **404** when the trace is absent/cross-tenant (the trace is read ONLY to authorize — a foreign trace gets no billable call), **502** on a provider error. The verb is `observability:read` (D3 — an **ephemeral** provider call that mirrors the copilot `ask`; it **never writes** to the trace store — the M44 read-only-body invariant holds, proven by a handler test running against a read-only repo). Runtime counters `replayRuns`/`replayRateLimited`/`replayUnavailable` make the billable endpoint observable (wiring pillar c). Every provider call is bounded by a **30s `AbortSignal.timeout`** so a stalled upstream throws `ChatError` instead of hanging (benefits the copilot too). The **opt-in "save as dataset item"** is supported by extending `POST /v1/datasets/:id/items` to accept a **synthetic** item (`{input, output}` with no source trace) alongside the existing trace-reference form (`{traceId}`): a `addSyntheticDatasetItem` stores the replayed input/output sourced by a generated `replay-{uuid}` id, so the item stays addressable (view + remove) and the unique index dedups correctly — no migration, no nullable trace_id. Blueprint `.claude/knowledge-base/discoveries/blueprints/prompt-playground-span-replay-blueprint.md` (ADRs D1/D2/D3). Tests: `openaiChatCompletionWithUsage` (usage parse + defaults + fail-closed + timeout) + 7 `replayHandler` cases (valid→output/tokens/latency + model override, 400×5 invalid bodies, 503 unconfigured, 429 rate-limited + no-provider-call, 502 provider-error, 404 cross-tenant + no-provider-call, no-mutation) + route-guard enumeration (the replay route carries the scope guard) + real-Postgres integration for the synthetic dataset item + the `{input,output}` endpoint contract. `pnpm test` (contract, 479) + integration (real PG, 11) green; `tsc`/`eslint` clean.
- **`GET /v1/traces` advanced filters — cost range, token range, session (theo-lens M52).** `listTracesOptionsSchema` + the `listTraces` SQL gain `minCostUsd`/`maxCostUsd`/`minTokens`/`maxTokens`/`sessionId` as **trace-level column predicates** (`traces.cost_usd`/`total_tokens`/`session_id` — `gte`/`lte`/`eq`, no span join). Validated at the boundary (`z.coerce.number().nonnegative()` / `z.string().min(1)`; a bad numeric → 400) and mapped from snake_case query keys (`min_cost_usd`/`max_cost_usd`/`min_tokens`/`max_tokens`/`session_id`, mirroring `order_by`→`orderBy`). `!= null` guards so a legitimate `0` bound is honored; an inverted range (`min > max`) fails soft to empty (the from/to-window pattern); the CSV export + `orderBy` compose unchanged. Powers the theo-cloud dashboard's M52 advanced-filter row (forwarded by the M49 BFF whitelist) + saved views (a per-tenant store of the filter query string — engine migration `000053_lens_saved_views` + a theo-cloud `LensSavedViewsHandler`). 2 schema-unit + 4 real-Postgres integration (each filter narrows; inverted range → empty) + 1 API-boundary (400 + forwards) tests; `pnpm test` (contract) + integration green.
- **New phase roadmap: `ROADMAP-sota-experience.md` (M50–M56) — SOTA-experience push.** Authored after M49 shipped, from a code-grounded gap analysis of the shipped Observability dashboard vs the four SOTA peers (langfuse/phoenix/opik/laminar). Confirmed-shipped: traces + search/filters, trace-detail (virtualized, foldable CodeMirror, resizable), sessions/datasets/evaluators/guards/agents/copilot, KPI-tile analytics, + end-to-end tenant isolation (Model B — arguably ahead of the OSS peers). Grep-verified gaps → milestones: **M50** waterfall/timeline span view (the signature observability UX), **M51** time-series analytics (cost/latency/error/throughput trends, replacing KPI-tiles-only), **M52** saved views + advanced filters (cost/token range, tag/session/user), **M53** alerting on threshold breaches (reusing theo-cloud's J-16 SSRF-guarded webhook delivery worker — Rule 9), **M54** trace/run compare + diff, **M55** prompt playground / span replay (edit input, re-run against the real provider, no mutation of the immutable trace body), **M56** data export + documented read API. Continues theo-lens's single `M` sequence (M50+, no renumber/collision; `flip_milestone_checkbox.py`-recognized). With M49 done, M50/M51/M52 are immediately eligible; recommended order by impact: M50 → M51 → M52 → M53 → M54 → M55 → M56. Each milestone stays tenant-isolated through the BFF (Principal-resolved, param-whitelisted — the M49 pattern), XSS-safe, reuse-first (no redundant dep). Out of scope (documented): re-doing the edge/auth, a new TSDB backend, a drag-drop dashboard builder, full experiment-tracking.
- Roadmap amended: added **M49 — Trace search & filters** to `ROADMAP-edge-integration.md` (`/roadmap-feature trace-search-filters`). Depends on M44/M47/M48. Adds a search box + high-value filters (status=error, model, time range) over the `/observability/traces` list — the natural next observability-UX step now that a user can open a trace and see everything in it. Every SOTA peer ships list search/filters; M49 makes the flat trace table navigable, URL-persisted for shareable views. Discovery must first audit whether the list endpoint already accepts filter params (M47 found the tree endpoint complete) and decide client- vs server-side filtering by parsimony. Grill log at `knowledge-base/grills/trace-search-filters-feature-grill.md`.
- Roadmap amended: added **M48 — Trace viewer at scale (virtualization + rich rendering)** to `ROADMAP-edge-integration.md` (`/roadmap-feature trace-viewer-scale-rich`). Depends on M47. Promotes the three deps M47 deliberately deferred by parsimony (`@tanstack/react-virtual` + CodeMirror + `react-resizable-panels` — the stack all four SOTA peers converge on) now that a concrete need (large traces / rich payloads) justifies them: virtualize the span tree above ≈200 spans, syntax-highlight + fold JSON/code, resizable split, `/deps-audit`-gated. Grill log at `knowledge-base/grills/trace-viewer-scale-rich-feature-grill.md`.
- Roadmap amended: added **M47 — Trace-detail view (SOTA span explorer)** to `ROADMAP-edge-integration.md` (`/roadmap-feature trace-detail-view`). Continues the dashboard thread (M44 dashboard → M45 dogfood → M46 design → M47 trace detail). Closes the gap surfaced by dogfood: clicking a trace shows only a tags/annotations panel — no span tree, no per-span input/output — an experience far below Logfire/LangSmith/Langfuse/Arize. Frontend-only (theo-lens `GET /v1/traces/:id` + the BFF `GET /v1/dashboard/lens/traces/{id}` already return the full span tree; the dashboard just never renders it). Grill log at `knowledge-base/grills/trace-detail-view-feature-grill.md`.
- **theo-lens registered as a graduated Level-2 (Model B) capability (M43).** Recorded the graduation as institutional knowledge: a new ADR ([`0001-model-b-level-2-graduation.md`](.claude/knowledge-base/adrs/0001-model-b-level-2-graduation.md)) documenting the Model-B decision + the **6-invariant closure** with grep-findable file:line evidence (M22 module-side scopes/per-verb/mint/fail-closed, M37 route-guard audit, M38 theo-cloud broker, M39 edge wiring, M40 hermetic e2e keystone, M42 live dogfood); the `theo-data/README.md § 1` capabilities table now lists theo-lens as **Level 2 (Model B)** at `/v1/lens` with the `lens:read`/`write`/`delete` (+ `lens:admin`) scopes; `CLAUDE.md` + `README.md` gained platform-integration pointers to the ADR + `ROADMAP-edge-integration.md`. Honest: the live dogfood Status is `wired` (first run), not `running`; no unqualified "production-ready" claim. Closes the M37–M43 edge-integration loop.
- Second roadmap `ROADMAP-edge-integration.md` (milestones `L0`–`L6`): graduate theo-lens into a Level-2 (Model B per-tenant) capability behind the Theo unified edge, mirroring theo-rag's edge roadmap. Scoped to the real gap — M22 already closed the module-side half (scopes/per-verb/mint/fail-closed + a theo-lens-side hermetic proof), so the roadmap is an audit gate (L0) then the theo-cloud broker (L1) → edge wiring (L2) → cross-repo hermetic proof (L3, keystone) → BFF/dogfood/register (L4–L6). MCP proxy is explicitly out of scope (theo-lens has no first-party MCP tools). Reviewed by 2 adversarial agents (accuracy-vs-code + completeness/fidelity): resolved a HIGH (the same-origin SPA's edge/browser-auth path — decided API+BFF, SPA stays single-tenant/dev) + 5 MEDIUM (L6→dogfood dependency, two #77-class e2e assertions in L3, the `L`-prefix checkbox-flip caveat, and two current-state overstatements now citing `internal/promptly` as a 2nd shipped exemplar); report at `knowledge-base/reviews/roadmap-edge-integration-review-2026-07-01.md`. Standardized to the `/roadmap-init` template: full top-matter (Vision/Problem/Users/Scope In+Out/Constraints/Success criteria + North-star), milestone blocks normalized to the template field set (`### L<N> — [ ]` / Objective / Definition of done / Dependencies / Top risks — dropped the `milestone_id:` line and `[KEYSTONE]`/`REQUIRED` header tags), + Revision protocol / Unresolved sections; the integration-specific sections (contract, current-state gap, UI-consumption decision, sequencing) are kept as additive context. Renumbered the milestones from `L0`–`L6` to **`M37`–`M43`**, continuing theo-lens's single `M` sequence (extends `ROADMAP-v4.md`'s `M0`–`M36`) — collision-free (M37+ are unused) and tool-recognized by `flip_milestone_checkbox.py` (`^[EM]\d+$`), so the post-release checkbox flip works automatically (the manual-flip caveat is removed).
- M37 module-side readiness audit: added a live-Hono route-enumeration contract over the full 36-route `/v1/*` data surface (excluding `/v1/admin/*`) to prove every mounted data path carries `requireScopeOnPrincipal`, and refreshed the scope×verb matrix to cover the post-M22 surfaces explicitly — datasets, evaluators, guards, agents, analytics, metrics, sessions, and the M33 copilot — including the least-privilege bar that `lens:platform-admin` remains 403 on every data verb.
- Workspace validation scripts now exist at package level where missing (`packages/api`, `packages/core`, `packages/sdk`, `packages/web`, `examples/agent`) so the recursive gates used by the roadmap (`pnpm -r test`, `pnpm -r typecheck`, `pnpm -r lint`) are executable and evidence-bearing instead of partially implicit in the root-only scripts.


### Changed
- **Auth scope vocabulary renamed `lens:* → observability:*`** (`observability:read`/`write`/`delete`/`admin` + `observability:platform-admin`). The capability is customer-facing as "Observability", so its per-verb scope now matches the product name (parallel to `memory:*`), replacing the internal `lens:*` naming across the enforcement path (`requireScopeOnPrincipal`, the scope hierarchy `observability:platform-admin ⊇ observability:admin`, the admin-keys handler, the copilot/dataset/evaluator/guard/trace routes). This unblocks the customer key-issuance flow: theo-cloud's API-key surface now activates `observability:*` (was the reserved `traces:*`), so a customer can issue a `theo_live_*` key that carries `observability:read`/`write` and use it against the unified `/v1/lens` edge — validated end-to-end (dashboard-issued key → Claude-Code OTLP through the real edge → per-tenant span in the Observability dashboard). **Paths (`/v1/lens/*`, `/v1/dashboard/lens/*`) and the `theo-lens` module name are UNCHANGED** — only the scope strings. 272 contract tests (incl. scope-verb-matrix + route-guard-enumeration) green.
- `ROADMAP-edge-integration.md` v1.1 — TOTAL-integration extension, learning from theo-rag's executed `ROADMAP-edge-integration.md` (M10–M23, shipped end-to-end). theo-rag proved "integrated" does not stop at register + a read-only BFF (its M20): it only became truly integrated after M21–M23 (browser management dashboard, live dashboard dogfood, design coherence). Appended the theo-lens equivalents — **M44** (full lens management dashboard UI: read views + write/delete on the CRUD-able surfaces datasets/evaluators/guards/agents, extending the M41 read BFF, mirrors rag M21), **M45** (local-env dogfood parity for the lens dashboard, mirrors rag M22), **M46** (dashboard design standardization vs theo-memory, mirrors rag M23) — and folded three rag-paid lessons into existing milestones: `lens-up.sh` must preserve `THEO_CLOUD_IMAGE`/`THEO_DASHBOARD_IMAGE` on recreate (M39), BFF contract tests must hit theo-lens's real schema not a stub (M41/M44, the rag `text` vs `content` 422→502 class), and the async-worker-or-writes-stall caveat (M45). Updated Scope/UI-decision/Sequencing/Success-criteria/How-to-drive/Unresolved + SOTA table to the M37–M46 range; MCP stays out of scope; numbering stays collision-free (avoids the rag M10 quality×edge clash via the continuous `M37+` sequence).


### Fixed
- **Hermetic edge e2e (`scripts/e2e-edge.sh`, invariant-6 proof) restored after the `observability:*` scope rename.** The rename updated the enforcement + mint validation but left the hermetic ForwardAuth broker shim (`test/edge/forward-auth-shim.mjs`) still minting `lens:read/write/delete` scopes, which the admin-keys mint endpoint now correctly rejects (`INVALID_SCOPES`) — the write/mint path failed `503 BROKER_UNAVAILABLE` while isolation + fail-closed still passed. Pointed the shim at `observability:read/write/delete`, and refreshed the now-stale `admin-keys.ts` error message + two doc comments (`schema.ts`, `api-key-verifier.ts`) that still said `lens:*`. `pnpm test:e2e:edge` now `EDGE_E2E_PASS` (all 6 assertions: cross-tenant isolation + fail-closed deny + both CWE-441 halves through a real Traefik ForwardAuth edge). Also validated the full production flow with **real Claude Code v2.1.187 telemetry** (interactive session → OTLP through the real `/v1/lens/traces` edge with a customer-issued `observability:*` key → per-tenant spans incl. `claude_code.llm_request`/`tool` rendered in the Observability dashboard).

## [0.38.0] - 2026-07-01

### Added
- "Ask about this step" trace copilot (M33): a `POST /v1/traces/:id/ask` endpoint answers natural-language questions about a selected span/trace via a configurable OpenAI-compatible LLM (reusing the M36 provider seam — no new dependency), fail-closed (503 when no provider configured, 502 on provider failure) + per-workspace rate-limited (429, `THEOLENS_COPILOT_RPM` default 20); an Ask panel in the trace detail (scoped to the selected span, or the whole trace) renders the answer through the XSS-safe markdown renderer; runtime counters (answered / rate-limited / unavailable) make the endpoint observable in production. [Phases 1-5 + review: shared `openaiChatCompletion` chat seam, copilot domain + rate limiter, the `lens:read`-scoped endpoint, the UI Ask panel, an endpoint-overhead benchmark (theo-side ~1.4 ms mean / ~2.1 ms p95, LLM excluded)]


### Changed

- Extracted the M26d dataset routes and the M36 evaluator/copilot route registration out of `app.ts` into dedicated route modules, bringing `app.ts` back under the 500-LoC budget (M33 D5; closes the M36 review's F5 debt). No behaviour change.

## [0.37.0] - 2026-06-30

### Added
- Online Evaluators (M36): theo-lens can now **compute** eval verdicts (not just store ingested ones). Define an evaluator — a deterministic **rule** (reusing the M30 span-query DSL) or an **LLM-judge** (a configurable OpenAI-compatible endpoint via `THEOLENS_JUDGE_*`) — that runs on-demand (`POST /v1/evaluators/:id/run` backfill, bounded by `THEOLENS_EVAL_BACKFILL_MAX`, default 500) or via an opt-in periodic in-process sweep (`THEOLENS_EVAL_SWEEP_HOURS`, default OFF), OFF the ingest hot path. The engine writes one verdict per matched span into the existing `span_evaluations` store, so the M26 read surfaces (trace Evaluations tab, `GET /v1/metrics/evaluators`) light up automatically. Flag-only **guards** (`{evaluator, operator, threshold}`) flag traces whose verdict breaches a threshold (`GET /v1/guards/:id/breaches`). A new **Evaluators** page manages them (list/create/run + guard form). The LLM-judge is fail-closed (a 5xx / unparseable reply / out-of-range or empty verdict throws, never a silent pass) and uses native `fetch` (no new dependency). Everything is per-workspace (M22 invariants); evaluator + guard definitions live in two new workspace-leading tables, and deleting an evaluator cascades its guards. Throughput benchmark committed (`benchmarks/evaluator-throughput.md`: ~156 rule / ~164 mocked-judge evals/sec)


### Changed
- Roadmap consolidated into **`ROADMAP-v4.md`** — a single authoritative view of every delivered milestone (M0–M35, all `[x]`, each with its shipped version), since the work had been split across the phased `ROADMAP.md` (V1, M0–M8), `ROADMAP-v2.md` (V2, M9–M14) and `ROADMAP-v3.md` (V3, M15–M21) plus the CHANGELOG, with M22–M35 never recorded as milestone headers. The three phased files are kept as historical phase records (V1 gains a "superseded — see v4" banner); the M22 block briefly added to V1 was moved into v4 where it belongs (auth/production is a V3.x concern, not V1). New work appends to v4 (next free id M36).
- Roadmap: queued **M36 — Online Evaluators (eval-as-rule + guards)** in `ROADMAP-v4.md` as the next milestone (provisional objective + DoD, to be sharpened by `/grill-me` + `/discover-plan` before `/to-plan`). Closes the evals track by adding the compute/write path on top of M26's read path.


### Fixed
- `/code-quality` audit no longer walks `knowledge-base/references/` (cloned third-party reference repos): the skip-list used `referencia` (PT) instead of the real directory name `references` (EN), so the symbol-fabrication detector parsed ~25k foreign files — wasting minutes and gigabytes of RAM and producing a spurious `FAIL_HARD` verdict that blocked `/review`. Now the references zone is correctly skipped, with a behavioral regression test. (#37)
- Admin key mint (`POST /v1/admin/keys`) is now atomic: the target-workspace upsert and the key insert run in one transaction, so a failed key insert never leaves an orphan workspace row (closes review item LENS-AUTH-4).
- Admin key mint `expires_at` is validated as a strict ISO-8601 datetime instead of any string `Date.parse` accepts (e.g. "Jan 1 2027" is now rejected), matching the documented contract (closes review item LENS-AUTH-3).

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
