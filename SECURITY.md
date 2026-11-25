# Security Policy

## Supported versions

LoopTrace is **pre-release**. Security fixes land on the latest published version only; there are
no maintained backport branches yet. That will change when the project cuts `v1.0.0`.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it through GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**), which opens a channel visible only to the maintainers.

Include, as far as you can determine them:

- what the issue is and which component it affects (core, REST API, OTLP receiver, dashboard BFF,
  SDK for Go/Python/TS, Docker image);
- a reproduction — the smallest sequence of calls or configuration that triggers it;
- the impact you believe it has (data exposure across which boundary, privilege gained, and by whom);
- the version, commit, or image digest you tested. `GET /v1/version` reports the deployed commit.

We will acknowledge the report and tell you whether we can reproduce it. If we can, we will agree a
disclosure timeline with you before publishing. If we cannot, we will say so and explain what we
tried rather than letting the report go quiet.

## What is in scope

The boundaries this project is responsible for enforcing:

- **Tenant isolation** — a credential bound to one tenant reading or writing another's traces,
  spans, sessions, datasets, evaluators, or monitors. Cross-tenant access is expected to return 404,
  not 403: the existence of another tenant's object is itself information.
- **Per-verb scope enforcement** — `observability:read` / `observability:write` /
  `observability:delete` on data routes and `observability:admin` on the key lifecycle. A key
  holding one verb must not reach another.
- **Anti-escalation on minting** — `observability:platform-admin` implies `observability:admin` and
  never a data scope. A plain admin key must not be able to mint `observability:platform-admin`, nor
  mint for a tenant it does not own.
- **The single-use admin bootstrap** — the bootstrap token authenticates as a synthetic
  platform-admin **only** while it has not been consumed. The consume-first flip is a
  compare-and-set; two concurrent bootstrap mints must yield exactly one success.
- **Fail-closed credential resolution** — with `LOOPTRACE_REQUIRE_CREDENTIAL=true`, a request that
  resolves no principal returns 401. It must never collapse into a default owner principal.
- **Secret handling** — credentials leaking into logs, traces, error messages, or span attributes.
  This one deserves emphasis for a tracing product: **spans are the payload**. A defect that copies
  an inbound `Authorization` header into a stored span attribute is a credential disclosure with
  indefinite retention, not a logging bug.
- **Injection** into the SQL layer or the LLM-judge path — including prompt injection carried by
  *ingested span content*, which is attacker-influenced by construction and reaches the judge and
  the copilot.
- **The published Docker image** and the dependency tree it ships.

## What is out of scope

- The security of *your* Postgres deployment, network, or reverse proxy.
- Denial of service through resource exhaustion on a self-hosted instance you control.
- Anything requiring an already-compromised host or database superuser.
- Running with `LOOPTRACE_REQUIRE_CREDENTIAL` unset or false. That is a local-development
  affordance — it resolves a default principal and is not a supported deployment posture.
- Findings from an automated scanner with no demonstrated exploit path — we will read them, but a
  report without a reproduction is triaged as a bug, not a vulnerability.

## A note on ingested telemetry

LoopTrace stores what your agents emit and answers questions from it. It does **not** classify span
contents for sensitivity, and neither the copilot nor the LLM judge re-checks whether a span is
trustworthy before it reaches the model.

Two consequences worth stating plainly:

1. **Prompt inputs and tool arguments frequently contain secrets** — API keys pasted into a prompt,
   tokens in a tool call, PII in a user turn. If your agent emits them as span attributes, they are
   stored. Redact at the SDK boundary, not after ingestion.
2. **A trace is attacker-influenced input.** Anything a user can type into your agent can end up in
   a span, and that span is later fed to a judge or a copilot. Treat trace content as untrusted
   text, exactly as you would treat the original prompt.

Treat a tenant's trace store as being as sensitive — and as trusted — as the most sensitive and
least trustworthy span written into it.
