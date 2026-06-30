# M22 — Cycle kickoff (theo-lens auth + workspace_id + scope-in-path + admin-key minting)

> Prepared 2026-06-30 from a session rooted in the parent workspace `theo-data`.
> **Run the cycle from a session rooted at THIS repo** (`theo-data/theo-lens`), branch `develop`.
> This is Workstream A of `docs/cloud-lens-module-handoff.md`; the ROADMAP anchor is `ROADMAP-v3.md` M22.
> It also satisfies `theo-data/ROADMAP.md` **M2** ("theo-lens graduated to Level 2") — but the work,
> commits, CHANGELOG, gates and PR all belong to the `theo-lens` repo (its own git + remote).

## 0. Goal to set in the theo-lens session

```
/goal Execute o CYCLE completo (discover→plan→implement→review) para M22 do theo-lens
(auth + workspace_id + scope-in-path + admin-key minting). FAANG level, sem retrabalho,
sem workarounds. Todos os DoDs e critérios de aceite validados com evidência. Não aceito
entrega sem evidências de 100% funcional. Só pare em READY_TO_MERGE. Máximo rigor em todos
os gates do cycle — não pular nenhuma etapa.
```

## 1. What M22 is

theo-lens today has **no auth anywhere** — ingestion and reads are fully open. M22 gives it its
half of the `theo-data` tenant-isolation convention so it can graduate to Level 2 (per-tenant
isolation proven through the real edge). Reference implementation to copy: **`theo-memory`**.

## 2. Pre-conditions (verified 2026-06-30)

- ✅ Branch `develop`; working tree clean except untracked `docs/` (this file + the handoff).
- ✅ Toolchain bootstrapped: `pnpm-workspace.yaml`, packages `api / core / sdk / web` (Node/TS).
- ✅ Cycle kit present in `.claude/skills/` (discover-plan, to-plan, implement, review, ralph-loop…).
- ✅ No prior plan/blueprint for M22 → cycle starts at DISCOVER.
- ⚠️ `.claude/knowledge-base/references/` is empty in theo-lens (see §5 for how to seed it).

## 3. Prior art (cite these — do NOT re-derive)

1. **`docs/cloud-lens-module-handoff.md` § 3** — the detailed Workstream-A spec already contains:
   the scopes enum, the non-destructive schema migration plan, the scope-in-path endpoint map,
   the admin key-minting API, the edge wiring, and the test plan. This is effectively a blueprint.
2. **theo-memory reference impl** (sibling repo `../theo-memory/`), exact files from handoff § 3.3:
   - App + bearer middleware: `packages/api/src/server/app.ts`
   - `bearerAuth` + `requireScopeOnPrincipal` + `getPrincipal`: `…/auth/middleware.ts`
   - Scope hierarchy: `…/auth/scope-hierarchy.ts`; verifiers: `…/auth/{bearer,api-key}-verifier.ts`
   - Admin key minting: `…/handlers/admin-keys.ts` (`POST /v1/admin/keys` + list/delete/rotate/lineage)
   - Schema (workspaces / theo_api_keys / admin_config): `packages/core/src/infrastructure/db/schema.ts`
   - Migrations to mirror: `0012_theo_api_keys.sql`, `0016_workspaces.sql`, `0017_workspace_members.sql`

## 4. Non-negotiable gates (the 6 invariants — from `theo-data/CLAUDE.md`)

M22 is **not done** until invariants 1, 4, and 6 are present (honesty rule — do not report
"integrated" while the data-plane half is open):

1. **CWE-441 both halves:** edge strips the customer key (ForwardAuth `Del`-then-set) **and** the
   service enforces scope per verb.
2. `workspace_id == tenant_id` — every row carries `workspace_id`; every query scoped by the Principal.
3. Resolve a `Principal{workspaceId, role, scopes}` from the credential — never trust the body.
4. Per-verb scope: `requireScopeOnPrincipal(lens:read|write|delete)` on EVERY data route;
   `lens:platform-admin` ⊃ `lens:admin` only (never a data scope).
5. Fail closed — missing/unresolvable credential → `401` in multi-tenant mode.
6. Prove isolation through the REAL edge — a hermetic ForwardAuth e2e job asserts cross-tenant
   isolation + fail-closed deny (`make e2e-edge`, the `#113` pattern).

## 5. DoD (must all be evidenced before READY_TO_MERGE)

From `theo-data/ROADMAP.md` M2 + `theo-lens/ROADMAP-v3.md` M22 + handoff § 3.4:

- [ ] `workspace_id text NOT NULL` on `spans`, `traces`, `sessions`, `replay_sessions`,
      `trace_tags`, `span_evaluations`, `annotations` (decide datasets global vs scoped);
      `workspaces`, `users/members`, `theo_api_keys`, `admin_config` tables added; existing rows
      backfilled to `workspace_id='default'`; default workspace + bootstrap admin seeded.
- [ ] Auth middleware (`bearerAuth`, `requireScopeOnPrincipal`, scope-hierarchy, verifiers) mounted
      on `/v1/*` before data routes; dev fallback `DEFAULT_PRINCIPAL` for single-tenant local.
- [ ] Every read query gets `AND workspace_id = $principal.workspaceId`; every ingest `INSERT`
      sets `workspace_id` from the Principal (never the body).
- [ ] Scope-in-path endpoints mirroring theo-memory (`POST /v1/scopes/lens/:projectId/traces`,
      `GET /v1/scopes/:type/:id/{traces,sessions,analytics/*,metrics/*}`…); legacy global `/v1/*`
      only as a `default`-workspace fallback behind `lens:read` if backward-compat is needed.
- [ ] Admin API `POST /v1/admin/keys` (+ list/delete/rotate/lineage) gated `lens:admin`;
      bootstrap token `THEOLENS_ADMIN_BOOTSTRAP_TOKEN` (single-use, atomic consume).
- [ ] Edge ForwardAuth route registered per `theo-cloud/theo-workspace/docs/adding-a-microservice.md`.
- [ ] **Tests:** contract test asserts every query carries the `workspace_id` filter; hermetic
      ForwardAuth e2e (`make e2e-edge`) asserts cross-tenant isolation + fail-closed. **Ship gate.**

## 6. Seed references for DISCOVER (optional but recommended)

theo-lens `references/` is empty. The parent workspace already cloned relevant SOTA peers. To let
`/discover-plan` cite real local sources, copy the two most relevant (multi-tenant gateway +
virtual-keys/admin) from the parent:

```bash
# from the theo-lens repo root:
mkdir -p .claude/knowledge-base/references
cp -r ../.claude/knowledge-base/references/litellm           .claude/knowledge-base/references/
cp -r ../.claude/knowledge-base/references/envoy-ai-gateway  .claude/knowledge-base/references/
# (theo-memory is the primary reference — it's the sibling ../theo-memory, cited directly in plans)
```

> If you skip this, DISCOVER leans on handoff § 3 + theo-memory directly — which is enough for M22
> (it is a "copy the proven pattern" milestone, not novel research). Keep DISCOVER light.

## 7. Cycle sequence (max rigor — no skipped phases)

Run each chain in order; honor every gate. Stop at `READY_TO_MERGE` (do NOT auto-release).

```
DISCOVER  /discover-plan theo-lens-m22-auth-tenancy
          /discover-edge-cases theo-lens-m22-auth-tenancy
          /discover-plan-confidence theo-lens-m22-auth-tenancy   (INVALID → rewrite)
          /discover-execute theo-lens-m22-auth-tenancy           (ralph-loop → BLUEPRINT_COMPLETE)
          /discover-confidence theo-lens-m22-auth-tenancy        (→ /discover-improve if NEEDS_REVISION)
PLAN      /to-plan "graduate theo-lens to Level 2: auth + workspace_id + scope-in-path + admin-key minting"
          /edge-case-plan theo-lens-m22-auth-tenancy
          /deps-audit theo-lens-m22-auth-tenancy
          /plan-confidence theo-lens-m22-auth-tenancy            (≥ SHIPPABLE_WITH_CAVEATS to proceed;
                                                                  low → /plan-improve → re-score)
IMPLEMENT /implement theo-lens-m22-auth-tenancy                  (ralph-loop TDD → IMPLEMENTATION_COMPLETE;
                                                                  then validation halt-loop → VALIDATION_GATE_PASSED)
QUALITY   /code-quality theo-lens-m22-auth-tenancy               (must be PASS / PASS_WITH_CAVEATS)
REVIEW    /review theo-lens-m22-auth-tenancy                     (target READY_TO_MERGE)
```

Alternatively `/auto-plan "theo-lens-m22-auth-tenancy"` chains all of the above and pauses at the
human gates — but it continues into RELEASE; if you want to hard-stop at READY_TO_MERGE, run the
phases above explicitly (or stop /auto-plan at the review verdict before approving the release PR).

## 8. After READY_TO_MERGE (back in the parent workspace)

theo-lens ships its own `develop→main` PR + tag. The parent `theo-data/ROADMAP.md` M2 checkbox is a
separate tracking artifact in a separate repo — flip it by hand (or via a `/roadmap-feature`-style
edit) once theo-lens M22 is merged; `cycle-release` in theo-lens will NOT flip the theo-data box
(different repo). Record the theo-lens release SHA next to M2 when you flip it.
```
