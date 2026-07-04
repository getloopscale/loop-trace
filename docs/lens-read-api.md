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

## Dashboard equivalent (browser session)

The Theo dashboard reaches the same data through a **BFF** at `GET /v1/dashboard/lens/traces?<same
params>`, authenticated by a **browser session JWT** (not a `theo_live_*` key). The filter contract is
identical; the difference is only the auth surface (session JWT vs. customer API key). Programmatic
customers use `GET /v1/lens/traces` with a `theo_live_*` key as documented above.
