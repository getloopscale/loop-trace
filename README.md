# LoopTrace

**See what your AI agents actually did.** LoopTrace is an OpenTelemetry-native
trace explorer for AI agents — instrument an agent in a few lines, send its
spans over OTLP, and explore every execution, session replay, cost, and
tool-call breakdown in a UI. Think "Jaeger for AI agents".

One command brings up the whole thing — API, database, and UI — at
**http://localhost:4318**.

## Quickstart — zero to your first trace

You need Docker and Node ≥ 20 (with `pnpm`).

### 1. Start the stack

```bash
git clone https://github.com/getloopscale/looptrace.git
cd looptrace
docker compose up -d
```

`docker compose up` brings up Postgres + the API, applies the database
migrations on boot, and serves the Trace Explorer UI from the API at the same
origin. Open **http://localhost:4318** — the UI is there, ready and empty.

### 2. Instrument an agent

The SDK instruments a TS/Node agent in ≤ 10 lines:

```ts
import { initLoopTrace, startAgent, recordToolCall } from "@looptrace/sdk";

const looptrace = initLoopTrace({ endpoint: "http://localhost:4318", serviceName: "example-agent" });
const traceId = await startAgent(looptrace.tracer, "checkout", async (span) => {
  span.setModel("gpt-4o").setProvider("openai").setUsage({ inputTokens: 12, outputTokens: 8 });
  recordToolCall(span, "search-products", { query: "running shoes" });
  return span.raw.spanContext().traceId;
});
await looptrace.shutdown();
```

Point your instrumented agent at the running stack and run it:

```bash
LOOPTRACE_ENDPOINT=http://localhost:4318 pnpm tsx path/to/your-agent.ts
```

### 3. See the trace

Refresh **http://localhost:4318** — your execution appears in the list. Click in
to explore the span tree, step through the session replay, and view cost +
tool analytics.

That's the whole loop: **install the SDK → instrument → `docker compose up` →
see the trace.**

## Installing the SDK in your own project

The SDK packs into a local tarball you can install anywhere:

```bash
pnpm --filter @looptrace/sdk pack --pack-destination .
npm install ./looptrace-sdk-0.0.0.tgz
```

(Within this monorepo, packages reference the SDK via the pnpm workspace.)

## Observe Claude Code in LoopTrace

Claude Code is itself an AI agent — point its OpenTelemetry trace export at a running
LoopTrace and its sessions show up as first-class executions (model, tokens, cost, input,
and session grouping). With the stack up (`docker compose up` → `http://localhost:4318`):

```bash
# set the traces-only recipe in your shell, then run Claude Code as usual
eval "$(scripts/looptrace-instrument-claude.sh)"          # or: ... <your-looptrace-endpoint>
claude -p "summarize this repo"
```

The helper enables Claude Code's telemetry + beta trace export, disables metrics/logs
(LoopTrace ingests spans), and routes OTLP/HTTP to `<endpoint>/v1/traces`. Open the Trace
Explorer to see the run as a waterfall with cost and tokens, grouped into a session.

How it works: an extensible **agent adapter** (selected by the span's `service.name`)
maps Claude Code's attribute convention onto LoopTrace's typed fields — so other external
agents integrate by adding one adapter, with no change to existing traces.

**Caveats.** Claude Code's trace export is **beta** (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`);
the span schema may change. Claude Code spans carry `user.email` / `user.id` /
`account_uuid` and — with `OTEL_LOG_USER_PROMPTS=1` — the prompt text, so send telemetry
only to a LoopTrace you trust.

## Monitors, and why they are not guardrails

A **Monitor** is a threshold over evaluator verdicts. It runs *after* the fact: a trace is scored,
the score crosses a line you set, and — since M135 — the breach notifies through your webhook. It
observes. It never sits in your request path and it never blocks anything.

A **guardrail** is the opposite: something inline in *your* application that inspects a request or a
response and refuses it. LoopTrace does not provide one, and deliberately so — an observability data
plane is not a policy-enforcement proxy, and putting one in the request path would mean an outage in
the observability layer becomes an outage in your product.

`guardrail` therefore appears in LoopTrace in exactly one place: as a **span kind**. When your app's
own blocker runs, you emit a span of kind `guardrail` and LoopTrace records what it did. The blocking
is yours; the observation is ours. Both reference implementations in this space draw the line in the
same place — Arize Phoenix states it plainly: *"Phoenix doesn't block requests — your app does.
Guardrails block in real-time. Evaluators measure asynchronously."*

The capability was called "Guards" until v0.62.0. The name promised enforcement that was never
implemented and, per the above, was never going to be. `/v1/guards*` remains as a deprecated alias
for one release; `/v1/monitors*` is canonical.

| | Runs | Can block? | Lives in |
|---|---|---|---|
| Evaluator | after the trace | no | LoopTrace |
| **Monitor** | after the evaluator | **no** | LoopTrace |
| Guardrail | inline, on the request | yes | **your application** |

## How it works

- **SDK** (`@looptrace/sdk`) emits OTLP `gen_ai` spans over HTTP.
- **API** (`@looptrace/api`, [Hono](https://hono.dev)) ingests OTLP
  (`POST /v1/traces`, JSON + protobuf), persists spans to Postgres via
  [Drizzle](https://orm.drizzle.team), and exposes read endpoints under `/v1/*`.
  It also serves the built UI same-origin, so there is one port and no CORS.
- **UI** (`@looptrace/web`, React + Vite) is the Trace Explorer: execution
  list, span tree, session replay, cost view, and tool analytics.
- **Storage** is plain Postgres 16. Spans are the source of truth; traces and
  sessions are aggregates recomputed from spans.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `LOOPTRACE_PG_URI` | (required by the API) | Postgres connection string |
| `LOOPTRACE_PORT` | `4318` | Port the API + UI listen on |
| `LOOPTRACE_WEB_DIST` | `packages/web/dist` | CWD-relative path to the built UI bundle |
| `LOOPTRACE_PG_PORT` | `5432` | Host port mapped to Postgres in compose |
| `LOOPTRACE_API_PORT` | `4318` | Host port mapped to the API in compose |

## V1 ship criterion

The V1 ship criterion is a single automated end-to-end test that walks the whole
journey from a clean `docker compose up`: bring up the stack, instrument and run
an agent, ingest spans over OTLP, see the execution tree in the Explorer, walk
the session replay, and check cost + tool analytics. It is the binary gate —
when it is green, the journey works end to end:

```bash
pnpm test:e2e   # includes the 6-step ship gate from a clean composed stack
```

The product target is that a developer completes this journey in **under 15
minutes**. The automated gate runs in seconds; the 15-minute figure is the
human-onboarding budget, stated against a **reference environment** so the number
is reproducible:

- **Reference environment:** a developer laptop with a 4-core/8-thread CPU, 16 GB
  RAM, an SSD, and a broadband connection (for the first image pull). Cold start
  is dominated by the one-time Docker image build/pull; subsequent `docker
  compose up` runs are near-instant. On constrained hardware or a slow network
  the first run can take longer — the budget is about the steps, not the bytes.

## North-star metrics

Lens watches its own usage. The `/metrics` view (and `GET /v1/metrics/north-star`)
shows **traces ingested per day** (real telemetry arriving) and **replay sessions
per week** (active debugging engagement).

## Development

```bash
pnpm install
pnpm build                 # typecheck + compile the libraries
pnpm test                  # contract tests (no Postgres needed)
pnpm test:integration      # integration tests (needs LOOPTRACE_PG_URI)
pnpm test:e2e              # end-to-end against a composed stack
pnpm --filter @looptrace/web dev   # UI dev server (calls the API on :4318)
```

## Platform integration

LoopTrace is a **Level-2 (Model B) capability** behind the LoopZero unified edge at `/v1/lens` — a customer
uses it multi-tenant with a single `loopzero_live_*` platform key; the edge mints a per-tenant key and
LoopTrace enforces scope per verb (`observability:read`/`observability:write`/`observability:delete`). All six data-plane invariants are
closed — see [`.claude/knowledge-base/adrs/0001-model-b-level-2-graduation.md`](./.claude/knowledge-base/adrs/0001-model-b-level-2-graduation.md)
(the M37–M43 edge-integration roadmap was retired in `675e6cb`). Multi-tenant UI is the
central LoopZero dashboard via the `/v1/dashboard/lens/*` read BFF (the same-origin SPA in this repo stays
single-tenant / local-dev).

## License

Apache-2.0
