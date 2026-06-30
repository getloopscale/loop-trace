# Theo Lens — Cloud Module Implementation Handoff

> **Status:** PLANNING COMPLETE — ready for the Cycle 6+1 loop. No code written yet.
> **Author:** planning session (theo-cloud-rooted), 2026-06-30.
> **Owner decisions locked** — see § 1. Do **not** re-litigate them; implement against them.
> **This is a spec/handoff, not instructions to the model reading it** — execute via the pipeline.

This document is the single source of truth for adding a **Theo Lens** module to the Theo
cloud product, mirroring the existing **Memory** module exactly. It spans **two repos** and is
split into two sequential workstreams (A → B). Drive each workstream from a session **rooted in
its own repo** (the Cycle 6+1 pipeline, git, CHANGELOG and release are per-repo).

---

## 0. What & why (one screen)

**Theo Lens** (`theo-data/theo-lens`) is an **OpenTelemetry-native trace explorer for AI agents**
("Jaeger for AI agents"): instrument an agent in a few lines, send spans over OTLP, and explore
every execution, session replay, cost, and tool-call breakdown. It is a sibling data-plane
capability of `theo-memory` in the `theo-data` monorepo.

The goal: surface Lens in the **Theo cloud product** the same way **Memory** is surfaced today —
a cloud-API proxy slice (`internal/themory` → `internal/thelens`) plus a dashboard module
(`pages/memory.tsx` → `pages/lens.tsx`), talking to the backend service over **HTTP only**
(acyclic invariant — `theo-cloud` never imports Go from `theo-lens`).

The design assets for the dashboard already exist at
`theo-cloud/theo-cloud/dashboard/docs/theo-lens/` (Violet Forge DS bundle + the **TraceList**
template). The professional design handoff lives at
`theo-data/theo-lens/docs/design/theo-lens-design-handoff.md`.

---

## 1. Locked decisions (from the planning session — do not change without an ADR)

| # | Decision | Value |
|---|---|---|
| D1 | **Dashboard UI scope (v1)** | **Landing + TraceList** (metrics landing page *plus* a navigable trace table). **TraceDetail 3-pane is deferred** to a later milestone. |
| D2 | **Tenancy technique** | **Exactly the `theo-memory` convention** — i.e. the `theo-data` house pattern: edge ForwardAuth mints a per-tenant key → service enforces scope per verb → `workspace_id == tenant_id` → resolve a `Principal`, never trust the body → fail-closed → prove isolation through the real edge. |
| D3 | **Memory subsystems to mirror** | **Mirror everything**: client + broker + admin + contract test, routes, **webhooks + exports + delivery history + background worker**, PG migrations, dashboard page, nav, governance, openapi. |
| D4 | **Repo split** | **Both repos, same program**, sequenced **A → B** (real integration, not contract-first-dark). |
| D5 | **Pipeline** | **Full Cycle 6+1 loop** per repo (`/auto-plan` full-pipeline, which pauses at plan-confidence, review, and the human PR-approval gate). |

> **Consequence of D2 + the current state of theo-lens:** the `theo-memory` tenancy technique
> depends on capabilities `theo-lens` **does not have yet** (no auth, no `workspace_id`, no
> scope-in-path, no admin-key API). Therefore **Workstream A (theo-lens M22) is a hard
> prerequisite** and must ship before B's integration is real.

---

## 2. The two workstreams & sequencing

```
RUN 1 — Workstream A · theo-lens M22  (repo: theo-data, service: theo-lens)
  Give theo-lens its half of the theo-data tenant-isolation convention:
    Bearer auth + workspace_id on every table + scope-in-path endpoints + admin-key minting.
  ~60% can be copied/adapted from theo-memory. Est. ~1 week (19–28h senior).
  Exit: develop→main PR in theo-data, semver tag.
        ↓ (prerequisite for B's real tenant isolation)
RUN 2 — Workstream B · theo-cloud Lens module  (repo: theo-cloud, the cloud-API + dashboard)
  Mirror the Memory vertical slice for Lens, talking HTTP-only to theo-lens.
  ~22 files / ~8.5k LoC. Exit: develop→main PR in theo-cloud, semver tag.
```

**How to run each:** open a session **rooted at the repo** (`theo-data` for A, `theo-cloud/theo-cloud`
for B), confirm branch `develop`, then `/auto-plan "{slug}"` (full pipeline). Each run gates at
plan-confidence, review, and a human-approved PR (never auto-merge to `main` — Unbreakable Rule 4).

> The planning session that produced this handoff was anchored to `theo-cloud` and **cannot drive
> theo-data's pipeline** (sibling repo, cwd is pinned). That is the *only* reason this is a handoff
> rather than an in-place execution.

---

## 3. Workstream A — theo-lens M22 (repo: `theo-data`, service `theo-lens`)

**Roadmap anchor:** `theo-data/theo-lens/ROADMAP-v3.md:209` — *M22 — Auth + ingestion API keys +
projects/multi-tenant (P0)*. Currently `[ ]` (not shipped).

### 3.1 Current state (the gap)
- **No auth** anywhere — `theo-data/theo-lens/packages/api/src/server/app.ts:1-425` mounts zero auth middleware.
- **No tenant discriminator** — `theo-data/theo-lens/packages/core/src/infrastructure/db/schema.ts:30-259`: `spans`, `traces`, `sessions`, `annotations`, `datasets` have **no** `workspace_id`/`subject`.
- **No admin/control-plane API** for minting per-tenant keys.
- Endpoints are global: `GET /v1/traces`, `POST /v1/traces`, `GET /v1/sessions`, `GET /v1/spans/:id`, `/v1/analytics/*`, `/v1/metrics/*`.

### 3.2 The `theo-data` convention to satisfy (6 invariants)
Source of truth: `theo-data/CLAUDE.md` (lines 36–66) + reference impl `theo-memory`.
1. **Close CWE-441 with both halves:** edge strips the customer key (ForwardAuth `Del`-then-set) so the service only sees a gateway-minted per-tenant key; **the service enforces scope per verb**.
2. **`workspace_id == tenant_id`** — every row carries `workspace_id`; every query scoped by the resolved Principal's workspace.
3. **Resolve a `Principal`, never trust the body** — auth resolves `Principal{workspaceId, role, scopes}` from the credential; handlers read workspace from the Principal.
4. **Per-verb scope enforcement** — `requireScopeOnPrincipal(lens:read|write|delete)` on every data route; `platform-admin` implies only `admin` (key lifecycle), never a data scope.
5. **Fail closed** — missing/unresolvable credential → `401` in multi-tenant mode.
6. **Prove isolation through the REAL edge** — a hermetic ForwardAuth e2e job asserting cross-tenant isolation + fail-closed deny (`make e2e-edge`, the `#113` pattern).

### 3.3 theo-memory reference (copy ~60%)
| What | theo-memory file:line |
|---|---|
| App + bearer middleware mount | `theo-data/theo-memory/packages/api/src/server/app.ts:9-58, 176-406` |
| `bearerAuth` + `requireScopeOnPrincipal` + `getPrincipal` | `…/auth/middleware.ts:13-216` |
| Scope hierarchy (admin ⊃ read/write/delete) | `…/auth/scope-hierarchy.ts` |
| Bearer/API-key verifiers | `…/auth/bearer-verifier.ts`, `…/auth/api-key-verifier.ts` |
| Admin key-minting handler (`POST /v1/admin/keys` + list/delete/rotate/lineage) | `…/handlers/admin-keys.ts:171-438` |
| Scope verifier (admin gate) | `…/auth/scope-verifier.ts:77-157` |
| Schema: workspaces / theo_api_keys / admin_config | `…/core/src/infrastructure/db/schema.ts:83-135, 590-641` |
| Migrations to mirror | `…/core/dist/infrastructure/db/migrations/0012_theo_api_keys.sql`, `0016_workspaces.sql`, `0017_workspace_members.sql` |

### 3.4 A — implementation checklist (TDD per the cycle)
1. **Scopes enum:** `lens:ingest` (POST traces), `lens:read` (GET traces/sessions/analytics/metrics), `lens:write` (tags/annotations/datasets mutations), `lens:admin` (admin routes). `lens:platform-admin` ⊃ `lens:admin` only.
2. **Schema migration (non-destructive):** add `workspace_id text NOT NULL DEFAULT 'default'` to `spans`, `traces`, `sessions`, `replay_sessions`, `trace_tags`, `span_evaluations`, `annotations` (decide if `datasets` are global or scoped). Add `workspaces`, `users`/`members`, `theo_api_keys`, `admin_config` tables (copy from theo-memory). Backfill existing rows → `workspace_id='default'`; seed a `default` workspace + bootstrap admin.
3. **Auth middleware:** copy `bearerAuth`, `requireScopeOnPrincipal`, scope-hierarchy, verifiers; mount on `/v1/*` before data routes. Dev fallback `DEFAULT_PRINCIPAL` (workspace `default`) for single-tenant local mode.
4. **Repository scoping:** every read query gets `AND workspace_id = $principal.workspaceId`; every ingest `INSERT` sets `workspace_id` from the Principal (never the body).
5. **Endpoints — scope-in-path** (mirror theo-memory's `/v1/scopes/:type/:id/...`):
   - ingest: `POST /v1/scopes/lens/:projectId/traces` (OTLP)
   - reads: `GET /v1/scopes/:type/:id/traces`, `…/traces/:traceId`, `…/spans/:spanId`, `…/sessions`, `…/sessions/:id`, `…/analytics/*`, `…/metrics/*`
   - Keep legacy global `/v1/*` only as a `default`-workspace fallback behind `requireScopeOnPrincipal('lens:read')` if backward-compat with existing OTLP exporters is needed (decide in plan).
6. **Admin API:** copy `POST /v1/admin/keys` (+ list/delete/rotate/lineage), gated `lens:admin`; bootstrap token `THEOLENS_ADMIN_BOOTSTRAP_TOKEN` (single-use, atomic consume).
7. **Edge wiring:** register the ForwardAuth route per `theo-cloud/theo-workspace/docs/adding-a-microservice.md` + `tenancy-contract.md`; the cloud-side ForwardAuth reference is `theo-cloud/internal/routes/forward_auth.go`.
8. **Tests (critical):** contract tests assert every query carries the `workspace_id` filter; hermetic ForwardAuth e2e asserts cross-tenant isolation + fail-closed (`make e2e-edge`). This is the M22 ship gate.

### 3.5 A — risks
- **Cross-workspace leak** (a query missing `WHERE workspace_id`) — CRITICAL. Mitigate with contract tests per query.
- **Breaking existing OTLP exporters** hitting global `/v1/traces` — keep a `default`-workspace fallback or a deprecation window.
- **Key-rotation lineage / bootstrap atomicity** — copy theo-memory's constraints + tests verbatim.

---

## 4. Workstream B — theo-cloud Lens module (repo: `theo-cloud/theo-cloud`)

Mirror of the Memory vertical slice. **Reference everything against the Memory files cited below.**
Talk to theo-lens **over HTTP only** (acyclic invariant — `theo-cloud/CLAUDE.md` Rule 6).

### 4.1 The seam contract (`openapi/thelens.yaml`)
Author a `theo-cloud/openapi/thelens.yaml` that mirrors `theo-cloud/openapi/themory.yaml`'s shape
but for the **scoped Lens endpoints that A exposes** (the subset the cloud-API actually calls):
`GET /v1/scopes/{type}/{id}/traces`, `…/traces/{traceId}`, `…/sessions`, `…/sessions/{id}`,
`…/analytics/cost`, `…/analytics/tools`, `…/metrics/observability`, `…/metrics/north-star`,
plus admin `POST /v1/admin/keys` (for the broker). A consumer-driven **contract test**
(`internal/thelens/contract_test.go`, mirror of `internal/themory/contract_test.go`) pins it via
kin-openapi/openapi3filter.

### 4.2 B — file checklist (dependency order)
| # | File | New/Edit | Mirror of |
|---|---|---|---|
| 1 | `internal/config/config.go` | Edit (+~40 LoC) | `TheLensBaseURL`/`TheLensAPIKey`/`TheLensPlatformAdminKey`/`TheLensSkipCapabilityCheck`, mirror `Themory*` at `config.go:95-116` |
| 2 | `openapi/thelens.yaml` | New (~250) | `openapi/themory.yaml` |
| 3 | `internal/thelens/client.go` | New (~800) | `internal/themory/client.go:1-855` |
| 4 | `internal/thelens/admin_client.go` | New (~200) | `internal/themory/admin_client.go` |
| 5 | `internal/thelens/broker.go` | New (~200) | `internal/themory/broker.go` (per-tenant LRU + singleflight, fail-closed) |
| 6 | `internal/thelens/contract_test.go` | New (~300) | `internal/themory/contract_test.go` |
| 7 | `internal/routes/lens.go` | New (~900) | `internal/routes/memory.go:1-833` (handlers, `writeUpstreamError` fail-closed allowlist, id regex guards) |
| 8 | `internal/routes/lens_webhooks.go` | New (~250) | `internal/routes/memory_webhooks.go:1-235` |
| 9 | `internal/routes/lens_webhook_deliveries.go` | New (~350) | `internal/routes/memory_webhook_deliveries.go:1-346` |
| 10 | `internal/routes/lens_exports.go` | New (~350) | `internal/routes/memory_exports.go:1-336` |
| 11 | `internal/lens_webhook_worker/worker.go` | New (~300) | `internal/memory_webhook_worker/worker.go:1-264` (FOR UPDATE SKIP LOCKED, backoff, dead_letter @9) |
| 12 | `internal/lens_webhook_worker/dispatcher.go` | New (~200) | `internal/memory_webhook_worker/dispatcher.go` |
| 13 | `cmd/main.go` | Edit (+~200) | broker init + `/v1/lens/*` (Bearer scopes) + `/v1/dashboard/lens/*` (requireJWT) + worker goroutine + metering/scope registration (grep `"memory": {Minter: themoryBroker`) |
| 14 | `dashboard/src/pages/lens.tsx` | New (~250) | `dashboard/src/pages/memory.tsx:1-234` **+ a TraceList table** (D1) |
| 15 | `dashboard/src/pages/lens.test.tsx` | New (~150) | `dashboard/src/pages/memory.test.tsx` |
| 16–19 | `tests/unit/lens_{handlers,webhooks,exports,webhook_deliveries}_test.go` | New | `tests/unit/memory_*_test.go` |
| 20 | `tests/e2e/lens_e2e_test.go` | New (~600) | `tests/e2e/memory_e2e_test.go` |
| 21 | `dev/sql/02-create-lens-tables.sql` | New (~80) | `lens_webhooks`, `lens_webhook_deliveries`, `lens_exports` (schemas in § 4.4) |
| 22 | `docs/dashboard-governance.md` | Edit (+~50) | add a **Lens Section** mandate mirroring the Memory Section |

### 4.3 B — route surface (mirror Memory's dual surface)
- **SDK surface** `/v1/lens/*` — `auth.RequireScope(db, "lens:read"|"lens:write"|"lens:admin")` per verb.
  - `GET /list` (traces), `GET /metrics`, `GET /sessions`, `GET /analytics/*` → `lens:read`
  - `/webhooks/*`, `/exports/*` → `lens:admin`
- **Dashboard surface** `/v1/dashboard/lens/*` — `requireJWT` (browser sessions), same handlers.
- **Broker init:** `thelens.NewBroker(adminClient, 1024, time.Hour, []string{"lens:read","lens:write","lens:admin"})`; key resolver mints per-tenant via `KeyForTenant(ctx, u.AccountID, u.TenantID)`; fail-closed (no master fallback).

### 4.4 B — PG schemas (mirror Memory)
```sql
CREATE TABLE lens_webhooks (
  id TEXT PRIMARY KEY,           -- lwh-{16hex}
  subject TEXT NOT NULL, tenant_id TEXT NOT NULL,
  url TEXT NOT NULL, label TEXT NOT NULL,
  events JSONB NOT NULL, secret TEXT NOT NULL,   -- whsec_<43 b64url>
  created_at TIMESTAMP DEFAULT NOW(), revoked_at TIMESTAMP NULL );
CREATE TABLE lens_webhook_deliveries (
  id TEXT PRIMARY KEY,           -- lwd-{16hex}
  webhook_id TEXT NOT NULL REFERENCES lens_webhooks(id),
  event_type TEXT NOT NULL, payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INT DEFAULT 0,
  last_response_status INT NULL, last_response_body TEXT NULL, last_error_message TEXT NULL,
  next_attempt_at TIMESTAMP NULL, created_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP NULL,
  CHECK (status IN ('pending','delivering','delivered','failed','dead_letter')) );
CREATE TABLE lens_exports (
  id TEXT PRIMARY KEY,           -- lens-export-{uuid}
  subject TEXT NOT NULL, tenant_id TEXT NOT NULL, display_name TEXT NULL,
  status TEXT DEFAULT 'pending', error_message TEXT NULL, file_path TEXT NULL,
  created_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP NULL );
```

### 4.5 B — webhook events & export semantics (decide in `/to-plan`)
- **Events:** Lens is read-mostly, so candidate events are observability-shaped, e.g.
  `lens.trace.errored`, `lens.trace.ingested`, `lens.eval.completed`. Confirm the real set against
  what theo-lens can emit (it may need an outbound hook in A — coordinate across the seam).
- **Export:** "export" of a Lens dataset = paginate traces (or a dataset) → JSON file, mirroring
  `memory_exports` worker. Confirm whether the unit of export is traces, sessions, or datasets.

### 4.6 B — dashboard (Landing + TraceList, D1)
- `pages/lens.tsx`: `useRequireAuth()`; query `GET /v1/dashboard/lens/metrics` (`throwOnError:true`);
  loading → skeletons; error → `Alert` (never fabricate zeros — Memory ADR D2); success → StatTiles +
  observability charts **+ a navigable TraceList table** of `GET /v1/dashboard/lens/list`.
- DS: import from `@usetheo/ui` (`Alert`, `Button`, `Card`, `PageShell`, `Skeleton`, `StatTile`,
  `TokenUsageChart`, `Table`/`DataTable`) — the Violet Forge bundle + the **TraceList** reference
  template are already at `dashboard/docs/theo-lens/`.
- Nav/sidebar: register the Lens route alongside Memory.
- **CR-9 (cloud abstraction):** never leak internal infra terms in user-facing strings
  (`Kubernetes`/`cluster`/`tenant_id`/etc.) — use product language (trace, run, span, cost).
- Add the **Lens Section** mandate to `docs/dashboard-governance.md`.

---

## 5. theo-lens API surface (what B proxies) — current global form
Source: `theo-data/theo-lens/packages/api/src/server/app.ts:44-65` (will become scope-in-path after A).
- Ingest: `POST /v1/traces` (OTLP json/protobuf+gzip)
- Traces: `GET /v1/traces` (filters: status/model/from/to/order_by/dir/limit/q/span_query/tag/format), `GET /v1/traces/:id` (span tree), `GET /v1/traces/:id/cost`, `GET /v1/spans/:id`
- Sessions: `GET /v1/sessions`, `GET /v1/sessions/:id`
- Analytics/metrics: `GET /v1/analytics/cost`, `/v1/analytics/tools`, `/v1/agents`, `/v1/metrics/north-star`, `/v1/metrics/observability`, `/v1/metrics/evaluators`
- Tags / annotations / datasets / replay-sessions (later milestones).
- Health: `GET /v1/health`, `GET /v1/health/db`. Port `:4318` (`THEOLENS_PORT`).

`TraceListItem` shape: `traceId, sessionId?, name?, startTimeUnixNano, durationMs, statusCode,
totalTokens, model?, costUsd?, inputPreview?, outputPreview?, evaluationsCount?`
(`theo-data/theo-lens/packages/core/src/domain/trace-list.ts`).

---

## 6. References
- **theo-lens** README `theo-data/theo-lens/README.md`; routes `…/packages/api/src/server/app.ts`; schema `…/packages/core/src/infrastructure/db/schema.ts`; roadmap `…/ROADMAP-v3.md`; design handoff `…/docs/design/theo-lens-design-handoff.md`.
- **theo-memory** (reference impl for A): `theo-data/theo-memory/packages/api/src/server/{app.ts,auth/,handlers/admin-keys.ts}`.
- **theo-data convention:** `theo-data/CLAUDE.md` (6 invariants); edge wiring `theo-cloud/theo-workspace/docs/{adding-a-microservice,tenancy-contract,local-env-system-design}.md`.
- **theo-cloud Memory slice (reference impl for B):** `internal/themory/`, `internal/routes/memory*.go`, `internal/memory_webhook_worker/`, `dashboard/src/pages/memory.tsx`, `openapi/themory.yaml`, `docs/dashboard-governance.md`, `internal/routes/forward_auth.go`.
- **Dashboard design assets:** `theo-cloud/theo-cloud/dashboard/docs/theo-lens/` (Violet Forge DS + TraceList template).

---

## 7. How to start (per repo)
1. **RUN 1 (theo-data):** open a session rooted at `/home/user/Projetos/usetheo/theo-data`,
   confirm `git branch --show-current` == `develop`, then `/auto-plan "theo-lens-m22-auth-tenancy"`
   (cite this handoff § 3 as prior art). Ship the develop→main PR for the `theo-lens` service.
2. **RUN 2 (theo-cloud):** after A is merged, open a session rooted at
   `/home/user/Projetos/usetheo/theo-cloud/theo-cloud`, confirm `develop`, then
   `/auto-plan "theo-cloud-lens-module"` (cite this handoff § 4 as prior art).
3. Both runs gate at plan-confidence, review, and a **human-approved** PR. Never auto-merge `main`.
