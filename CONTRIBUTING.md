# Contributing to Theo Lens (`@usetheo/lens`)

Notes for human contributors and downstream maintainers. This file documents only what a contributor
needs hands-on; it does not restate the engineering process.

## Layout

A pnpm workspace. The packages that matter when you are finding your way in:

| Path | What it is |
|---|---|
| `packages/core` | domain — trace/span model, evaluators, monitors. No HTTP, no SQL driver |
| `packages/api` | Hono server: REST API, OTLP receiver, dashboard BFF, Drizzle schema |
| `packages/web` | React + Vite dashboard |
| `packages/sdk` · `sdk-go/` · `packages/sdk-py` | client SDKs (TS, Go, Python) |

## Build before you typecheck across packages

`@usetheo/lens-api` resolves `@usetheo/lens-core` through its **built** `dist/`, not through source.
A stale or absent `dist/` means the API typechecks against old symbols.

```bash
pnpm build && npx tsc --noEmit
```

This is not a style preference — it is a defect that already shipped. During M136 the typecheck
stayed green while the API imported a symbol that had been renamed in core, and the endpoint 500'd
at runtime. In CI the `Build` step runs **before** `Lint` for the same reason: the
`@typescript-eslint/no-unsafe-*` rules are type-aware, and on a clean checkout without `dist/` the
cross-package imports resolve to `any` and produce a wall of errors in untouched code.

## Integration tests need a real Postgres

~48 suites gate on `THEOLENS_PG_URI` and **self-skip** when it is absent. That is correct on a
laptop without Docker and catastrophic in a required lane, which would report green having executed
nothing. Always go through the script, which sets the variable and the config:

```bash
pnpm test:integration
```

Invoking `vitest` directly without `-c vitest.integration.config.ts` skips the global setup, and
nothing downstream can detect that it did not run.

## Tests

- Unit tests live beside the code as `*.test.ts`; integration tests under `test/` / `tests/`.
- A bug fix starts with the **failing** regression test, then the fix.
- Cover both lenses: an *edge case* is the extreme of a valid input; a *negative case* is an invalid
  one. The first, unhandled, produces a wrong answer; the second, a crash or a silent swallow.
  A suite with only one of them is half a suite.

## Workflows are gated, and the gate is tested

`publish.yml` will not push an image until `gate-ci`, `gate-contract`, `gate-sast` and
`guard-release-on-main` are green. `packages/api/src/server/publish-gate.test.ts` parses **every**
workflow in `.github/workflows/` and fails if any job that calls `build-publish.yml` loses those
`needs:` — or gains an `if:` that defeats them (`always()`, `!cancelled()`, `success() || …`).

If you add a workflow that publishes an image, it must carry the same four dependencies. The test
quantifies over the directory, not over a list of filenames, so it will find yours.

Actions are pinned by **40-character SHA**, never by tag. Tags are mutable and can be repointed
silently by the action owner — that is how the `trivy-action` and `kics-github-action` compromises
worked.

## Commits and branches

Work is born on `workspace` and reaches `main` through `develop`. Never commit directly to `develop`
or `main`: a commit that lands straight on `main` creates a side of the history that no PR to
`develop` can reach or correct, and the divergence only surfaces when you cut a release — which is
exactly when it is most expensive. That happened here; it cost three extra PRs.

Every user-visible change gets a `CHANGELOG.md` entry under `[Unreleased]`, written for the consumer
rather than the author.

## Redaction is the SDK's job

Theo Lens stores what you emit. It does not classify span contents for sensitivity, and the judge
and copilot read them later. If a prompt, tool argument, or user turn can carry a secret, redact it
**at the SDK boundary** — after ingestion is too late, and the retention is indefinite. See
[`SECURITY.md`](./SECURITY.md).
