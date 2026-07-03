# AGENTS.md

Guidance for Codex-compatible agents working in `theo-lens`.

## Purpose

Theo Lens is an OpenTelemetry-native trace explorer for AI agents.

Core product loop:

1. Instrument an agent with `@usetheo/lens-sdk`.
2. Send OTLP traces to the API at `POST /v1/traces`.
3. Persist spans in Postgres.
4. Explore traces, sessions, replay, costs, tools, evaluators, and agents in the web UI.

Keep that loop intact. Prefer changes that preserve or improve the "zero to first trace" path documented in `README.md`.

## Repository Shape

- `packages/sdk`: TS/Node instrumentation SDK.
- `packages/api`: Hono HTTP API, OTLP ingest, auth, route wiring, static UI serving.
- `packages/core`: domain logic, schemas, repository interfaces, Drizzle/Postgres implementation.
- `packages/web`: React/Vite frontend.
- `examples/agent`: runnable instrumentation example.
- `tests/e2e`: end-to-end ship gate and UI/API coverage.
- `knowledge-base`: plans, audits, release notes, and project history. Read only when it materially helps.

## Working Rules

- Read the relevant package before editing. Do not guess architectural intent from filenames alone.
- Prefer small, local changes over broad refactors unless the task explicitly requires structural work.
- Preserve the package split:
  - `core` owns domain rules and persistence behavior.
  - `api` should stay thin and boundary-focused.
  - `web` should not reimplement backend business rules when shared behavior already exists in `core` or API DTOs.
- Do not silently change public API shapes, OTLP ingestion semantics, workspace/auth behavior, or migration history without updating tests and docs.
- Do not introduce a second way to do the same thing if the repo already has a clear pattern.

## Source Of Truth

- Spans are the source of truth.
- Traces, sessions, tool analytics, cost analytics, agents, and observability views are derived from spans.
- When in doubt, follow the contracts in `packages/core/src/domain` and the `SpanRepository` interface before changing route or UI behavior.

## Common Commands

Install and build:

```bash
pnpm install
pnpm build
```

Tests:

```bash
pnpm test
pnpm test:integration
pnpm test:e2e
```

Local stack:

```bash
docker compose up -d
docker compose down
```

Useful targeted workflows:

```bash
pnpm --filter @usetheo/lens-web dev
pnpm --filter @usetheo/lens-sdk pack --pack-destination .
pnpm db:seed:demo
pnpm db:prune
```

## Validation Expectations

Choose the smallest validation that proves the change:

- UI-only change: run the relevant `packages/web` tests, and build or typecheck the web package if needed.
- API or domain change: run the relevant contract/integration tests.
- OTLP ingest, trace derivation, auth, persistence, or end-to-end UX change: prefer `pnpm test:e2e` or the narrowest integration/e2e coverage that exercises the behavior.

Before finishing:

- Run at least one verification command unless the environment blocks it.
- Report exactly what was verified and what was not.

## Editing Guidance

- Keep changes ASCII unless the file already requires Unicode.
- Follow existing TypeScript style and naming.
- Reuse existing schemas, DTOs, hooks, and helper functions before adding new ones.
- For new API inputs/outputs, validate at the boundary and keep DTOs explicit.
- For DB changes, prefer additive migrations and keep Drizzle schema and migrations aligned.
- For frontend changes, preserve the existing route structure, query-state patterns, and React Query usage.

## Auth, Multi-Tenancy, And Safety

- Treat workspace isolation as a hard invariant.
- Do not weaken `requireScope`, bearer auth, API key verification, or admin-key behavior without explicit intent and tests.
- Fail closed on auth-sensitive paths.
- Avoid logging secrets, tokens, prompts, or user-identifying telemetry unless the existing code already does so intentionally and the task requires touching it.

## Frontend Notes

- The web app is routed from `packages/web/src/main.tsx`; there is no central `App.tsx`.
- Prefer extending existing pages, hooks, and components over adding parallel patterns.
- Keep operator workflows dense and practical; Theo Lens is an observability tool, not a marketing site.

## Backend Notes

- The API boots through `packages/api/src/server/index.ts` and wires the app in `packages/api/src/server/app.ts`.
- Static UI serving is same-origin from the API. Be careful not to break that deployment model.
- Repository behavior lives in `packages/core/src/infrastructure/db/drizzle-span-repository.ts`; changes there often need integration coverage.

## Documentation

- Update `README.md` when the developer workflow, startup flow, or externally visible behavior changes.
- If a task materially changes architecture, invariants, or rollout assumptions, add or update a note in `knowledge-base` only if the task benefits from long-lived project memory.

## Platform Context

This repo also contains a `CLAUDE.md` with a pointer to the wider Theo platform local integration workflow. Use it when the task involves the shared Theo platform or unified edge, not for ordinary repo-local changes.
