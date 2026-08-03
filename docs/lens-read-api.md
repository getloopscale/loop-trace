# theo-lens read API — traces

A stable, per-tenant **read API** for pulling your observability data into your own tooling. This is
the same contract the Theo dashboard consumes; documented here (M56) so you can consume it directly
with a `theo_live_*` key.

## Authentication (per-tenant, Model B)

Call the API through the Theo unified edge with a customer API key:

```
Authorization: Bearer theo_live_...
```

- The edge (`/v1/lens`) strips your customer key and mints a **per-tenant** gateway key (Model B), so
  the service only ever sees a workspace-scoped credential — **you can only read your own workspace's
  traces** (cross-tenant access is impossible, not merely denied).
- The **`observability:read`** scope is required. A key without it is `403` on every read verb; the
  platform-admin/minting key is `403` on data verbs (least privilege).
- A missing/unresolvable credential is `401` (fail-closed).

## `GET /v1/traces` — list traces (filtered)

Returns the newest-first trace list for your workspace, honoring the filter params below.

```
GET https://<your-edge-host>/v1/lens/traces?status=error&model=claude-opus-4-8&limit=500
Authorization: Bearer theo_live_...
```

### Filter parameters

| Param | Type | Meaning |
|---|---|---|
| `q` | string | Full-text search over trace name + span content (`websearch_to_tsquery`). |
| `status` | string | `error` narrows to error traces (any non-OK status code). |
| `model` | string | Exact model match (e.g. `claude-opus-4-8`). |
| `from` | RFC-3339 datetime (offset) | Lower time bound (inclusive) on the trace start. |
| `to` | RFC-3339 datetime (offset) | Upper time bound (inclusive). |
| `min_cost_usd` / `max_cost_usd` | number ≥ 0 | Trace cost range (USD). |
| `min_tokens` / `max_tokens` | integer ≥ 0 | Total-token range. |
| `session_id` | string | Restrict to one session. |
| `order_by` | string | Sort column (default: newest first). |
| `limit` | integer 1–500 | Page size. **Capped at 500 per request** (`LIST_TRACES_LIMIT_CAP`). |
| `offset` | integer ≥ 0 | Pagination offset. |

An invalid numeric value (e.g. a non-number `min_cost_usd`) returns `400`. An inverted range
(`min > max`) returns an empty page (soft-fail), not an error.

### Pagination + the 500 cap

`limit` is **capped at 500 rows per request**. To pull more than 500, page with `offset`:

```
GET /v1/lens/traces?status=error&limit=500&offset=0
GET /v1/lens/traces?status=error&limit=500&offset=500
...
```

Stop when a page returns fewer than 500 rows (that is the last page). The Theo dashboard's **Export**
action does exactly this, bounded by a documented **export cap of 5,000 rows** (10 pages of 500) with
an explicit "Exported N traces / export cap reached — narrow filters" disclosure — it never silently
truncates. Programmatic consumers page with `offset` up to whatever bound they choose.

### Response shape

```jsonc
{
  "traces": [
    {
      "traceId": "…",              // stable id
      "sessionId": "…",            // optional — the session this trace belongs to
      "name": "…",                 // optional — the trace/root operation name
      "model": "claude-opus-4-8",  // optional — the root LLM model
      "statusCode": "0",           // optional — OTLP status ("0" = OK)
      "durationMs": 1234,          // optional — wall-clock
      "costUsd": 0.0123,           // optional — trace cost (USD)
      "totalTokens": 4096,         // optional — total tokens
      "startTimeUnixNano": "…",    // optional — trace start (ns as a string)
      "endTimeUnixNano": "…",      // optional
      "rootOperationName": "…",    // optional
      "rootToolName": "…",         // optional
      "inputPreview": "…",         // optional — truncated
      "outputPreview": "…",        // optional — truncated
      "evaluationsCount": 0        // optional
    }
  ]
}
```

All fields except `traceId` are optional (absent when not applicable). The JSON is the
machine-faithful shape — the dashboard's JSON export is this array verbatim, and the CSV export is the
same columns (formula-injection-safe + RFC-4180).

## Related endpoints

Same per-tenant edge + auth (`theo_live_*` + `observability:read`); the `/v1/lens` prefix is the edge
route (the theo-lens paths are `/v1/traces/:id`, etc.):

- `GET /v1/lens/traces/:id` — the reconstructed span tree for one trace.
- `GET /v1/lens/traces/:id/cost` — the per-trace cost summary.
- `GET /v1/lens/metrics/observability?range=` — time-series traffic / error-rate / latency / cost-by-model.
- `GET /v1/lens/analytics/usage-by-user?days=&limit=&offset=` — token and cost consumption grouped by
  **end user** (M140). See below.

### `GET /v1/analytics/usage-by-user` — consumption per end user

Groups your workspace's spans by the end-user identity your SDK recorded — `user.id`, falling back to
the OpenTelemetry `gen_ai.user.id`. Windowed over ingestion time (`days`, default 30, max 365) and
paged (`limit` default 50, max 500; `offset` default 0, max 10000).

**A value above any ceiling is REFUSED with `400 INVALID_QUERY`, never quietly reduced.** The
distinction matters when you page: `windowDays` is echoed in the response, but `limit` is not, so a
silently-clamped `limit=100000` would hand you 500 rows with nothing saying so — and you would then
advance `offset` by 100000 and read the wrong pages without any signal that something was wrong.
The ceilings themselves are inclusive: `?days=365&limit=500&offset=10000` is valid.

```json
{
  "users": [
    { "userId": "u-42", "spans": 120, "inputTokens": 3261202, "outputTokens": 12590407,
      "cacheReadTokens": 0, "cacheCreationTokens": 0, "costUsd": 41.23 }
  ],
  "unpricedSpans": 0,
  "totalUsers": 2,
  "windowDays": 30
}
```

Three things worth knowing before you act on the numbers:

- **`costUsd` is an estimate of observed consumption, not a bill.** theo-lens reports what it saw;
  billing lives elsewhere. The figure is derived from a price table that may not cover every model.
- **`unpricedSpans` is how that gap is made visible.** It counts spans that carried tokens but whose
  model had no price entry — their tokens are in the totals, their cost is not. When it is non-zero,
  `costUsd` is **low by an unknown amount**. It counts only spans that actually consumed tokens, so a
  workspace full of non-LLM spans does not report a phantom gap.
- **`userId` is whatever your SDK put in the attribute.** If you send e-mail addresses, this endpoint
  returns an aggregated, ordered list of them. Redaction belongs at ingestion, in your instrumentation
  — not here. Spans carrying neither key are grouped under the literal id `unattributed` rather than
  dropped, so "nobody consumed this" never gets confused with "we could not tell who did".

## Dashboard equivalent (browser session)

The Theo dashboard reaches the same data through a **BFF** at `GET /v1/dashboard/lens/traces?<same
params>`, authenticated by a **browser session JWT** (not a `theo_live_*` key). The filter contract is
identical; the difference is only the auth surface (session JWT vs. customer API key). Programmatic
customers use `GET /v1/lens/traces` with a `theo_live_*` key as documented above.
