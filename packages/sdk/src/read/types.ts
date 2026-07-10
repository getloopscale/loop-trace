/**
 * Clean, named response + request types for the read SDK (M103).
 *
 * Response types are RE-EXPORTED aliases over the generated OpenAPI component schemas
 * (`src/__generated__/openapi.ts`, produced by `openapi-typescript` — ADR-1) so callers get
 * ergonomic names (`TraceListResponse`) instead of `components["schemas"]["TraceListResponse"]`.
 * The generated file is the single source of truth; a drift gate keeps it honest.
 *
 * Request option types are HAND-WRITTEN: the engine's OpenAPI does not declare query
 * parameters, so the typed option → snake_case query mapping lives in the client. Options are
 * a small, bounded surface (the documented query params in `packages/api/src/server/app.ts`).
 */
import type { components } from "../__generated__/openapi.js";

type Schemas = components["schemas"];

/** `GET /v1/traces` — paginated trace list `{ traces, total, limit, offset }`. */
export type TraceListResponse = Schemas["TraceListResponse"];
/** `GET /v1/spans/{spanId}` — a single enriched span. */
export type Span = Schemas["Span"];
/** `GET /v1/metrics/observability` — the observability time-series + rollups. */
export type ObservabilityResponse = Schemas["ObservabilityResponse"];
/** `GET /v1/sessions` — paginated session list. */
export type SessionListResponse = Schemas["SessionListResponse"];
/** `GET /v1/analytics/cost` — cost broken down by period. */
export type CostByPeriodResponse = Schemas["CostByPeriodResponse"];
/** `GET /v1/analytics/tools` — tool-call usage stats. */
export type ToolStatsResponse = Schemas["ToolStatsResponse"];
/** A single dataset entity. */
export type Dataset = Schemas["Dataset"];
/** `GET /v1/datasets` — the workspace's datasets, wrapped as `{ datasets: Dataset[] }`. */
export type DatasetsResponse = Schemas["DatasetsResponse"];
/** A dataset + its items (the detail view returned by item add/remove). */
export type DatasetDetail = Schemas["DatasetDetail"];
/** `{ tags: string[] }` — a trace's tags after a tag/untag write. */
export type TraceTagsResponse = Schemas["TraceTagsResponse"];
/** `{ annotations: [...] }` — a trace's annotations after an annotate/delete write. */
export type AnnotationsResponse = Schemas["AnnotationsResponse"];

/** Options for {@link LensReadClient.listTraces} — map to snake_case query params. */
export interface ListTracesOptions {
  status?: string;
  model?: string;
  limit?: number;
  offset?: number;
  /** Wire param `session_id`. */
  sessionId?: string;
}

/** Options for {@link LensReadClient.listSessions}. */
export interface ListSessionsOptions {
  limit?: number;
  offset?: number;
}

/** The rolling window for observability metrics (engine default `24h` when omitted). */
export interface ObservabilityOptions {
  range?: string;
}

/** The aggregation period for cost analytics. */
export interface CostByPeriodOptions {
  period?: string;
}

/**
 * Request bodies for the write surface (M107). Hand-written (small, 1-3 fields) — the v11 split:
 * responses are generated from the OpenAPI, request bodies are typed interfaces here. The M109
 * hermetic contract test proves each body is accepted by the real engine.
 */
/** Create a dataset by name (idempotent create-or-get). */
export interface CreateDatasetBody {
  name: string;
}
/** Rename a dataset. */
export interface UpdateDatasetBody {
  name: string;
}
/** Add an item to a dataset - a captured trace (`traceId`) and/or a synthetic `input`/`output` pair. */
export interface AddDatasetItemBody {
  traceId?: string;
  input?: string;
  output?: string;
}
/** Annotate a trace - at least one of `label` / `note` is required by the engine. */
export interface AnnotateBody {
  label?: string;
  note?: string;
}
/** Tag a trace with a single tag (1-64 chars). */
export interface TagBody {
  tag: string;
}

/**
 * The `GET /v1` discovery document — service identity + the machine-contract pointer. Hand-written:
 * `/v1` is intentionally excluded from `/openapi.json` (a discovery/infra route, not a data route),
 * so there is no generated component to alias.
 */
export interface Capabilities {
  service: string;
  version: string;
  capability: string;
  /** Path to the OpenAPI document (relative to the base URL). */
  openapi: string;
  docs: string;
}
