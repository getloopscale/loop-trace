# looptrace CD pipeline

Adopted from the ecosystem playbook. This file records what is **different here** and why.
Everything not mentioned follows the playbook unchanged.

> **Deliberately free of environment topology.** This repository is Apache-2.0 and headed for
> publication, and the runbook's Step 7 is explicit: a public repo carries no IP, path, user or SSH
> key. An earlier revision of this file listed the dev host's address, the runner's address and the
> deploy directory — all of it now lives in the operations repo, where it belongs. What stays here is
> what a reader outside the team can act on.

## Behaviour

```
develop push → gates (ci · integration · sast) → build → GHCR :develop → host reconciles (pull)
tag v*  push → guard-release-on-main → build → GHCR :X.Y.Z :latest → SBOM + cosign
```

Nothing reaches the registry before the suite is green. The `image` job declares
`needs: [gate-ci, gate-contract, gate-sast, guard-release-on-main]`, and a test under
`packages/api/src/server/publish-gate.test.ts` fails if any publisher — in **any** workflow — loses
that dependency. Before this, the image was built **in parallel** with the gates: a push with a red
test published `:develop`, and the environment picked it up minutes later.

## Deploy is PULL, not push

The pipeline **does not deploy**. It publishes `:develop`; a reconciler on the host converges to it
under a systemd timer, and the entire operational half lives outside this repository.

Two independent reasons, the first irreversible:

1. **This repo is going public**, and a published history is public *retroactively*. A push deploy
   needs a private key, a hostname and a path in CI — none of which can be un-published later.
2. **A push deploy verifies once.** A container restarting from an old image, a manual
   `docker compose up`, or a deploy that fails with no successor all leave the environment silently
   stale. A reconciler re-verifies every 5 minutes.

The reconciler converges on **three** axes, and the last two are the ones people skip:

| Axis | Failure it prevents |
|---|---|
| Image | the ordinary case: an old image still running |
| Run state | a deliberate `docker stop` is **not** undone by `restart: unless-stopped`. The container sits stopped **with the correct image** — an image-only reconciler reports "up to date" |
| Provenance | the CI job that stamped the git sha is gone. Without re-stamping, `/v1/version` reports the old commit **permanently**: the image already matches, so nothing would ever trigger a correction |

A separate hourly check reports that reconciliation has **stopped** — comparing against the last
successful `publish`, not the tip of `develop`, because `publish` has `paths-ignore` and the branch
legitimately advances without producing an image. Correction and detection are deliberately
separate: an agent that only corrects fails silently when it is itself the thing that died.

## Where looptrace differs from the reference

| | reference | looptrace | Why |
|---|---|---|---|
| Services deployed | `api` + `worker` | `api` only | no worker; evaluation runs in-process on the sweep |
| Database | recreated with the stack | inherited, never touched | the dev database holds real data — monitors, evaluators, months of traces. A deploy that can recreate the database is a deploy that can lose it |
| Build step in CI | none | `pnpm build` before `test:integration` | `@looptrace/api` resolves `@looptrace/core` through its built `dist/`, so an unbuilt core imports stale symbols. Not hypothetical: during M136 typecheck stayed green while the API imported a renamed symbol and 500'd at runtime |
| Probe paths | already canonical | migrated from `/health`, `/ready`, `/version` | the semantics were already right (M94 built the liveness/readiness split deliberately); only the paths were per-service. A gate that must learn per-service paths is a gate nobody reuses |

## Runtime config lives on the host, not in a process

The host keeps a `.env` at mode `0600`. This is the playbook's rule and it earned its place the hard
way: looptrace ran for months as a bare `node` process launched by hand. Restarting it during a
deploy, the env exports were retyped from memory and the LLM-judge key was omitted — the judge
constructs fail-closed to `null` when unconfigured and logs nothing at boot, so the environment ran
with judge evaluation **silently disabled** and no probe would ever have reported it.

Config that exists only inside a running process is config you lose the first time a human restarts
that process under pressure.

## Secrets and variables

The host-facing credentials are **gone** — the deploy that needed them no longer exists here, and
the SSH key was **rotated**, not merely unreferenced (a key that reached a CI runner is compromised
the moment the repo is public; deleting the secret stops future use by this workflow and nothing
else). What remains:

| Name | Kind | Purpose |
|---|---|---|
| `LOOPTRACE_PLATFORM_ADMIN_BOOTSTRAP` | secret | bootstrap admin token — mints API keys |
| `LOOPTRACE_JUDGE_API_KEY` | secret | LLM-judge provider key |
| `LOOPTRACE_JUDGE_BASE_URL` | variable | provider endpoint — not a secret |
| `GITHUB_TOKEN` | auto | pushes to GHCR; no PAT |

## The integration lane cannot pass by skipping

~48 integration suites gate on `LOOPTRACE_PG_URI` and self-skip when it is absent — correct on a
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

Roll the CHANGELOG on `develop`, open the release PR, merge it, then tag the merge commit. The `v*`
push builds and signs. `guard-release-on-main` refuses to publish `:latest` from a tag that is not
contained in `main` — resolved through the API rather than a checkout, because this repo's full
history is expensive to fetch.

## What the first two pipeline runs found

Recorded because the value of a new CI lane is mostly in its first runs, and that value disappears
from memory quickly once everything is green.

| Finding | Class |
|---|---|
| `allowBuilds` held the literal placeholder `set this to true or false` | fatal on a clean install, invisible locally — the pnpm store already held approved builds |
| No supply-chain settings at all (`minimumReleaseAge`, `trustPolicy`, `blockExoticSubdeps`) | hardening that had never been configured |
| Runtime container ran as root | `USER node` |
| 11 CVEs in pnpm, plus npm's vendored `sigstore`/`tar`/`undici` | both package managers deleted from the runtime image after their last use |
| Four mutable action tags in the pre-existing sdk workflows | SHA-pinned |
| `sdk-go` / `sdk-py` targeting a runner class with billing blocked | red on every commit for ≥4 commits: the job never started |

Two of these — the `allowBuilds` placeholder and the judge key this pipeline work also recovered —
are the same defect wearing different clothes: **state that exists only on the machine of someone
who ran it before.** The workspace installed correctly because a previous install had approved those
builds; the judge was configured because someone had once exported it. Both were correct for anyone
who had already seen the system work and broken for everyone else.

That is the concrete value of a pipeline, and it is not automation: it is executing somewhere that
does not share your machine's memory.

### The hardening needed narrowing, and that is not a climb-down

`trustPolicy: no-downgrade` and `minimumReleaseAge` immediately rejected the existing lockfile. The
rejections split cleanly:

- `@usetheo/ui`, `@theokit/ui` — **our own packages**, published inside the 7-day window. The rule
  exists to guard against an unknown publisher; waiting a week to consume a fix we just shipped buys
  nothing. Excluded by scope.
- `semver@6.3.1`, `tailwind-merge@2.6.1`, `undici-types@6.21.0` — old, ubiquitous, transitive. They
  read as "downgrades" because they predate npm provenance attestations, not because anything
  changed hands. Excluded by **exact version**.

Both exception lists are deliberately narrow: version-pinned trust exceptions and org-scoped age
exceptions mean a genuine takeover of any other package still fails the install. An exception list
that would have accepted the next compromise too is not an exception list, it is an off switch.

### Deleting beat bumping

The image gate found CVEs in npm, then in pnpm. Bumping pnpm 11.1.0 → 11.5.3 cleared 8 of 11 and
left 3 open in the newest release. That is the signal to stop bumping: a package manager in a
runtime image is a permanent subscription to someone else's CVE feed.

Neither manager runs at runtime — the start command is `node`. So both are deleted after their last
use, and the whole class of finding is gone rather than repeatedly patched. The delete is chained
into the same `RUN` as the install; a separate layer would leave the binaries recoverable in the
layer beneath, which Trivy still scans and an attacker still reaches.

The build stage keeps pnpm pinned and current. There it does real work, and a vulnerability in it is
worth knowing about.
