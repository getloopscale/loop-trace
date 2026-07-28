# theo-lens CD pipeline

Adopted from the ecosystem playbook (`theo-rag/docs/cd-pipeline-playbook.md`). This file records
what is **different here** and why. Everything not mentioned follows the playbook unchanged.

## Behaviour

```
develop push → SAST + Integration → build → GHCR :develop → deploy dev ✓
tag v*  push → build → GHCR :X.Y.Z :latest → SBOM + cosign → deploy SKIPPED
```

The dev deploy passes only when three things hold: the running image's OCI revision label equals
the deployed commit, `/v1/healthz` is green, and `/v1/healthz/ready` is green.

## Where theo-lens differs from the reference

| | theo-rag | theo-lens | Why |
|---|---|---|---|
| Services deployed | `api` + `worker` | `api` only | theo-lens has no worker; evaluation runs in-process on the sweep. |
| Database | `pgvector` in the deploy stack | `postgres` inherited, never touched | The dev host's `theolens_postgres` holds real data — monitors, evaluators, months of traces. A deploy that can recreate the database is a deploy that can lose it. |
| Build step in CI | none | `pnpm build` before `test:integration` | `@usetheo/lens-api` resolves `@usetheo/lens-core` through its built `dist/`, so an unbuilt core imports stale symbols. Not hypothetical: during M136 typecheck stayed green while the API imported a renamed symbol and 500'd at runtime. |
| Probe paths | already canonical | migrated from `/health`, `/ready`, `/version` | The semantics were already right (M94 built the liveness/readiness split deliberately); only the paths were per-service. A deploy gate that must learn per-service paths is a gate nobody reuses. |

## Deploy target

- **Host:** `165.227.121.20` (`theo-e2e-runner`) — shared with the local platform, so nothing here
  may disturb a neighbour.
- **Directory:** `/home/user/theo-data-plane/theo-lens`
- **Runner:** `theo-ci-theo-lens` on `167.172.23.229` (`theo-ci-runner`), one runner per repo.
- **Port:** the API publishes `18084` (Caddy and theo-cloud's `LENS_BASE_URL` both point at it);
  Postgres stays on `5434` so it cannot collide with a sibling.

## Runtime config lives on the host, not in a process

`/home/user/theo-data-plane/theo-lens/.env`, mode `0600`, written by the deploy from repo secrets.

This is the playbook's rule and it earned its place here the hard way. theo-lens ran for months as
a bare `node` process launched by hand. Restarting it during the M136 deploy, the env exports were
retyped from memory and `THEOLENS_JUDGE_API_KEY` was omitted — the judge constructs fail-closed to
`null` when unconfigured and logs nothing at boot, so dev-public ran with LLM-judge evaluation
silently disabled and no probe would ever have reported it.

Config that exists only inside a running process is config you lose the first time a human restarts
that process under pressure. The `.env` survives the restart; the pipeline rewrites it every deploy.

## Secrets and variables

| Name | Kind | Purpose |
|---|---|---|
| `DEV_SSH_KEY` | secret | Dedicated ed25519 deploy key; the runner SSHes to the dev host with it |
| `THEOLENS_PLATFORM_ADMIN_BOOTSTRAP` | secret | Bootstrap admin token — mints API keys |
| `THEOLENS_JUDGE_API_KEY` | secret | LLM-judge provider key |
| `DEV_HOST` | variable | `165.227.121.20` |
| `DEV_DEPLOY_DIR` | variable | `/home/user/theo-data-plane/theo-lens` |
| `THEOLENS_JUDGE_BASE_URL` | variable | `https://api.openai.com/v1` — not a secret |
| `GITHUB_TOKEN` | auto | Pushes to GHCR and pulls on the host; no PAT |

## The integration lane cannot pass by skipping

~48 integration suites gate on `THEOLENS_PG_URI` and self-skip when it is absent — correct on a
laptop without Docker, catastrophic for a required lane, which would report green having executed
nothing.

Be precise about what the guard in `test/integration-global-setup.ts` does and does not buy: a URI
that is *set but broken* does NOT cause a silent skip, because the suites gate on the variable being
**present** — they run and fail loudly. The guard's actual value is naming a mis-resolved service
port once instead of scattering it across 48 connection errors. The genuinely silent path — the
variable unset AND the globalSetup not running, because vitest was invoked without
`-c vitest.integration.config.ts` — cannot be closed from inside a setup that did not run. The CI
lane closes it by always going through `pnpm test:integration`.

## Cutting a release

Unchanged from the playbook: roll the CHANGELOG on `develop`, open the release PR, a **human**
merges it (Unbreakable Rule 4), then tag the merge commit. The `v*` push builds and signs; the dev
host is untouched — verify with `GET /v1/version` still showing the previous develop sha.

## What the first two pipeline runs found

Recorded because the value of a new CI lane is mostly in its first runs, and that value disappears
from memory quickly once everything is green.

| Finding | Class |
|---|---|
| `allowBuilds` held the literal placeholder `set this to true or false` | Fatal on a clean install, invisible locally — the pnpm store already held approved builds |
| No supply-chain settings at all (`minimumReleaseAge`, `trustPolicy`, `blockExoticSubdeps`) | Hardening that had never been configured |
| Runtime container ran as root | `USER node` |
| 11 CVEs in pnpm, plus npm's vendored `sigstore`/`tar`/`undici` | Both package managers deleted from the runtime image after their last use |
| Four mutable action tags in the pre-existing sdk workflows | SHA-pinned |
| `sdk-go` / `sdk-py` targeting `ubuntu-latest` | Red on every commit for ≥4 commits: GitHub-hosted minutes are billing-blocked, so the job never started |

Two of these — the `allowBuilds` placeholder and the `THEOLENS_JUDGE_API_KEY` this pipeline work
also recovered — are the same defect wearing different clothes: **state that exists only on the
machine of someone who ran it before.** The workspace installed correctly because a previous
install had approved those builds; the judge was configured because someone had once exported it.
Both were correct for anyone who had already seen the system work and broken for everyone else.

That is the concrete value of a pipeline, and it is not automation: it is executing somewhere that
does not share your machine's memory.

### The hardening needed narrowing, and that is not a climb-down

`trustPolicy: no-downgrade` and `minimumReleaseAge` immediately rejected the existing lockfile.
The rejections split cleanly:

- `@usetheo/ui`, `@theokit/ui` — **our own packages**, published inside the 7-day window. The rule
  exists to guard against an unknown publisher; waiting a week to consume a fix we just shipped
  buys nothing. Excluded by scope.
- `semver@6.3.1`, `tailwind-merge@2.6.1`, `undici-types@6.21.0` — old, ubiquitous, transitive.
  They read as "downgrades" because they predate npm provenance attestations, not because
  anything changed hands. Excluded by **exact version**.

Both exception lists are deliberately narrow: version-pinned trust exceptions and org-scoped age
exceptions mean a genuine takeover of any other package still fails the install. An exception list
that would have accepted the next compromise too is not an exception list, it is an off switch.

### Deleting beat bumping

The image gate found CVEs in npm, then in pnpm. Bumping pnpm 11.1.0 → 11.5.3 cleared 8 of 11 and
left 3 open in the newest release. That is the signal to stop bumping: a package manager in a
runtime image is a permanent subscription to someone else's CVE feed.

Neither manager runs at runtime — the start command is `node`. So both are deleted after their
last use, and the whole class of finding is gone rather than repeatedly patched. The delete is
chained into the same `RUN` as the install; a separate layer would leave the binaries recoverable
in the layer beneath, which Trivy still scans and an attacker still reaches.

The build stage keeps pnpm pinned and current. There it does real work, and a vulnerability in it
is worth knowing about.
