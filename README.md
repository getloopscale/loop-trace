# Theo Lens

**See what your AI agents actually did.** Theo Lens is an OpenTelemetry-native
trace explorer for AI agents — instrument an agent in a few lines, send its
spans over OTLP, and explore every execution, session replay, cost, and
tool-call breakdown in a UI. Think "Jaeger for AI agents".

One command brings up the whole thing — API, database, and UI — at
**http://localhost:4318**.

## Quickstart — zero to your first trace

You need Docker and Node ≥ 20 (with `pnpm`).

### 1. Start the stack

```bash
git clone https://github.com/usetheodev/theo-lens.git
cd theo-lens
docker compose up -d
```

`docker compose up` brings up Postgres + the API, applies the database
migrations on boot, and serves the Trace Explorer UI from the API at the same
origin. Open **http://localhost:4318** — the UI is there, ready and empty.

### 2. Instrument an agent

The SDK instruments a TS/Node agent in ≤ 10 lines. The runnable example lives at
[`examples/agent/index.ts`](examples/agent/index.ts):

```ts
import { initTheoLens, startAgent, recordToolCall } from "@usetheo/lens-sdk";

const theo = initTheoLens({ endpoint: "http://localhost:4318", serviceName: "example-agent" });
const traceId = await startAgent(theo.tracer, "checkout", async (span) => {
  span.setModel("gpt-4o").setProvider("openai").setUsage({ inputTokens: 12, outputTokens: 8 });
  recordToolCall(span, "search-products", { query: "running shoes" });
  return span.raw.spanContext().traceId;
});
await theo.shutdown();
```

Run the example against the running stack:

```bash
THEOLENS_ENDPOINT=http://localhost:4318 pnpm tsx examples/agent/index.ts
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
pnpm --filter @usetheo/lens-sdk pack --pack-destination .
npm install ./usetheo-lens-sdk-0.0.0.tgz
```

(Within this monorepo, packages reference the SDK via the pnpm workspace.)

## How it works

- **SDK** (`@usetheo/lens-sdk`) emits OTLP `gen_ai` spans over HTTP.
- **API** (`@usetheo/lens-api`, [Hono](https://hono.dev)) ingests OTLP
  (`POST /v1/traces`, JSON + protobuf), persists spans to Postgres via
  [Drizzle](https://orm.drizzle.team), and exposes read endpoints under `/v1/*`.
  It also serves the built UI same-origin, so there is one port and no CORS.
- **UI** (`@usetheo/lens-web`, React + Vite) is the Trace Explorer: execution
  list, span tree, session replay, cost view, and tool analytics.
- **Storage** is plain Postgres 16. Spans are the source of truth; traces and
  sessions are aggregates recomputed from spans.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `THEOLENS_PG_URI` | (required by the API) | Postgres connection string |
| `THEOLENS_PORT` | `4318` | Port the API + UI listen on |
| `THEOLENS_WEB_DIST` | `packages/web/dist` | CWD-relative path to the built UI bundle |
| `THEOLENS_PG_PORT` | `5432` | Host port mapped to Postgres in compose |
| `THEOLENS_API_PORT` | `4318` | Host port mapped to the API in compose |

## V1 ship criterion

The V1 ship criterion is a single automated end-to-end test that walks the whole
journey from a clean `docker compose up`: bring up the stack, instrument and run
the example agent, ingest spans over OTLP, see the execution tree in the
Explorer, walk the session replay, and check cost + tool analytics. It is the
binary gate — when it is green, the journey works end to end:

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
pnpm test:integration      # integration tests (needs THEOLENS_PG_URI)
pnpm test:e2e              # end-to-end against a composed stack
pnpm --filter @usetheo/lens-web dev   # UI dev server (calls the API on :4318)
```

## License

Apache-2.0
