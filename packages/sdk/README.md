# @looptrace/sdk

Emit traces to LoopTrace and read your observability data back — from TypeScript/Node, in a few lines.

- **Write** (ingest): `initLoopTrace()` emits OTLP `gen_ai` spans (see below).
- **Read** (query): `LensReadClient` reads traces, spans, sessions, metrics, cost, tool stats and
  datasets back — fully typed, authenticated with your `looptrace_live_*` key.

The read client is **beta**: the surface is stable and typed against the engine's OpenAPI, but it has
not yet accrued sustained production usage. Feedback welcome.

## Install

```bash
npm install @looptrace/sdk
```

Requires Node 20+ (uses the platform-native `fetch`).

## Quickstart — read your data

```ts
import { LensReadClient, LensApiError } from "@looptrace/sdk";

const client = new LensReadClient({
  baseUrl: "https://api.getloopscale.com",
  apiKey: process.env.LENS_API_KEY ?? "looptrace_live_demo",
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

Your `looptrace_live_*` key resolves your workspace at the edge — you never pass a workspace/tenant
parameter. The client sends `Authorization: Bearer <apiKey>` on every request.

### Reaching Lens through the unified edge

If your `loopzero_live_*` platform key reaches Lens through the LoopZero **unified edge** (where the capability lives
under `/v1/lens/*`), set `basePath` so the client composes the right URLs:

```ts
const client = new LensReadClient({
  baseUrl: "https://api.getloopscale.com",
  apiKey: process.env.LENS_API_KEY,
  basePath: "/v1/lens", // default is "/v1" (talking to the engine directly)
});
```

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

## Write — curate your data

The same client mutates your data: create and update datasets, add/remove trace items, and
annotate / tag traces. Curate a regression set from a trace:

```ts
const dataset = await client.createDataset({ name: "regressions" });
const detail = await client.addDatasetItem(dataset.id, { traceId: "trace-123" });
const annotated = await client.annotateTrace("trace-123", { label: "regression", note: "wrong tool call" });
```

### Write methods

| Method | Route | Returns |
|---|---|---|
| `createDataset({ name })` | `POST /v1/datasets` | the dataset (idempotent create-or-get) |
| `updateDataset(id, { name })` | `PUT /v1/datasets/{id}` | the renamed dataset |
| `deleteDataset(id)` | `DELETE /v1/datasets/{id}` | `void` |
| `addDatasetItem(id, { traceId })` or `{ input, output }` | `POST /v1/datasets/{id}/items` | the dataset detail |
| `removeDatasetItem(id, traceId)` | `DELETE /v1/datasets/{id}/items/{traceId}` | the dataset detail |
| `annotateTrace(traceId, { label?, note? })` | `POST /v1/traces/{id}/annotations` | the annotations |
| `deleteAnnotations(traceId)` | `DELETE /v1/traces/{id}/annotations` | the annotations |
| `tagTrace(traceId, { tag })` | `POST /v1/traces/{id}/tags` | the tags |
| `untagTrace(traceId, tag)` | `DELETE /v1/traces/{id}/tags` | the tags |

Idempotent writes (create-or-get, tag/traceId-item, upsert annotation, deletes) are retried on a
transient network failure; a synthetic `addDatasetItem({ input, output })` is not (a lost response
would double-insert) — it surfaces the error for you to decide.

## Advanced — evaluators, labeling, experiments

The client also drives the online-eval + labeling + experiment surface. Create an evaluator and run it:

```ts
const evaluator = await client.createEvaluator({
  name: "errors",
  kind: "rule",
  config: { predicate: "status:error" },
});
const result = await client.runEvaluator(evaluator.id, { limit: 100 });
```

| Group | Methods |
|---|---|
| Evaluators | `createEvaluator` · `updateEvaluator` · `deleteEvaluator` · `runEvaluator` |
| Guards | `createGuard` · `deleteGuard` |
| Labeling queue | `enqueueForLabeling` · `resolveLabelingItem` · `exportLabelingAsDataset` |
| Copilot feedback | `submitAskFeedback` · `deleteAskFeedback` |
| Experiments / replay | `createExperimentRun` · `replaySpan` · `createReplaySession` |

**Billing note:** `runEvaluator` (for an `llm_judge`), `createExperimentRun`, and `replaySpan` re-execute
against your LLM provider (real cost). These are **never auto-retried** on a network/timeout — the client
surfaces the error so a lost response can never double-run / double-bill.

## Discovery

```ts
const { service, version, openapi } = await client.capabilities();
// → { service: "looptrace", version: "…", openapi: "/openapi.json", … }
```

Fetch `baseUrl + openapi` for the machine-readable contract.

## Runnable examples

See [`examples/`](./examples) — each runs against a real engine when `LENS_BASE_URL` and
`LENS_API_KEY` are set, and skips with a clear message otherwise:

```bash
LENS_BASE_URL=https://api.getloopscale.com LENS_API_KEY=looptrace_live_… npx tsx examples/list-traces.ts
```

## Write (ingest) — the other half

```ts
import { initLoopTrace } from "@looptrace/sdk";
initLoopTrace({ serviceName: "my-agent", endpoint: "https://api.getloopscale.com" });
```

Emits OTLP `gen_ai` spans. See the platform docs for the full ingest guide.
