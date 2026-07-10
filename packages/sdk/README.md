# @usetheo/lens-sdk

Emit traces to Theo Lens and read your observability data back — from TypeScript/Node, in a few lines.

- **Write** (ingest): `initTheoLens()` emits OTLP `gen_ai` spans (see below).
- **Read** (query): `LensReadClient` reads traces, spans, sessions, metrics, cost, tool stats and
  datasets back — fully typed, authenticated with your `theo_live_*` key.

The read client is **beta**: the surface is stable and typed against the engine's OpenAPI, but it has
not yet accrued sustained production usage. Feedback welcome.

## Install

```bash
npm install @usetheo/lens-sdk
```

Requires Node 20+ (uses the platform-native `fetch`).

## Quickstart — read your data

```ts
import { LensReadClient, LensApiError } from "@usetheo/lens-sdk";

const client = new LensReadClient({
  baseUrl: "https://api.usetheo.dev",
  apiKey: process.env.LENS_API_KEY ?? "theo_live_demo",
});

const { traces } = await client.listTraces({ limit: 50 });
const metrics = await client.observability({ range: "24h" });

try {
  await client.getSpan("missing-span");
} catch (err) {
  if (err instanceof LensApiError && err.code === "NOT_FOUND") {
    // handle a typed, non-2xx failure — switch on `err.code`, read `err.status` / `err.details`
  }
}
```

Your `theo_live_*` key resolves your workspace at the edge — you never pass a workspace/tenant
parameter. The client sends `Authorization: Bearer <apiKey>` on every request.

## Read methods

| Method | Route | Returns |
|---|---|---|
| `listTraces(opts?)` | `GET /v1/traces` | `{ traces, total, limit, offset }` |
| `getSpan(spanId)` | `GET /v1/spans/{spanId}` | a single enriched span |
| `observability(opts?)` | `GET /v1/metrics/observability` | traffic / latency / tokens time-series |
| `listSessions(opts?)` | `GET /v1/sessions` | paginated sessions |
| `costByPeriod(opts?)` | `GET /v1/analytics/cost` | cost per period |
| `toolStats()` | `GET /v1/analytics/tools` | tool-call usage stats |
| `listDatasets()` | `GET /v1/datasets` | `{ datasets }` |
| `capabilities()` | `GET /v1` | service identity + the `/openapi.json` pointer |

## Errors

Every non-2xx surfaces as a single typed `LensApiError` with `status`, `code`, `message`, and optional
`details` (field-level validation problems). Switch on `code` — no string-matching.

## Resilience

Transient failures (`408`/`429`/`5xx`, network resets, timeouts) are retried with bounded exponential
backoff that honors `Retry-After`; a fatal `4xx` fails fast. Tune with `maxRetries` (default 2) and
`timeoutMs` (default 30_000):

```ts
const client = new LensReadClient({ baseUrl, apiKey, maxRetries: 3, timeoutMs: 10_000 });
```

## Discovery

```ts
const { service, version, openapi } = await client.capabilities();
// → { service: "theo-lens", version: "…", openapi: "/openapi.json", … }
```

Fetch `baseUrl + openapi` for the machine-readable contract.

## Runnable examples

See [`examples/`](./examples) — each runs against a real engine when `LENS_BASE_URL` and
`LENS_API_KEY` are set, and skips with a clear message otherwise:

```bash
LENS_BASE_URL=https://api.usetheo.dev LENS_API_KEY=theo_live_… npx tsx examples/list-traces.ts
```

## Write (ingest) — the other half

```ts
import { initTheoLens } from "@usetheo/lens-sdk";
initTheoLens({ serviceName: "my-agent", endpoint: "https://api.usetheo.dev" });
```

Emits OTLP `gen_ai` spans. See the platform docs for the full ingest guide.
