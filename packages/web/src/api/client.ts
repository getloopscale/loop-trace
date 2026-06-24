import type {
  CostByPeriodResponse,
  ListTracesQuery,
  NorthStarResponse,
  ObservabilityRange,
  ObservabilityResponse,
  SessionDetail,
  SessionListResponse,
  ToolStatsResponse,
  TraceCost,
  TraceListResponse,
  TraceTagsResponse,
  TraceTreeNode,
} from "./types.js";

/** Hard cap mirrored from the API so an export pulls the full filtered set, not one page. */
const EXPORT_LIMIT = 500;

/** Build the `/v1/traces` query string from a whitelisted query (+ optional extras). */
function listQueryString(
  q: ListTracesQuery,
  extra?: Record<string, string>,
): string {
  const p = new URLSearchParams();
  if (q.status) p.set("status", q.status);
  if (q.model) p.set("model", q.model);
  if (q.from) p.set("from", q.from);
  if (q.to) p.set("to", q.to);
  if (q.orderBy) p.set("order_by", q.orderBy);
  if (q.dir) p.set("dir", q.dir);
  if (q.tag) p.set("tag", q.tag);
  if (q.q) p.set("q", q.q);
  for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Base URL of the M1 ingestion/read API. Override via `VITE_THEOLENS_API`. */
const BASE = import.meta.env["VITE_THEOLENS_API"] ?? "http://localhost:4318";

/** Thrown on a non-2xx API response so react-query surfaces an error state. */
export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(`API request failed with status ${status}`);
    this.name = "ApiError";
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as T;
}

/** List executions (traces) with an optional whitelisted filter/sort (M9). */
export function listTraces(query: ListTracesQuery = {}): Promise<TraceListResponse> {
  return getJson<TraceListResponse>(`/v1/traces${listQueryString(query)}`);
}

/**
 * Same-origin href for the CSV export of the current filtered list (M9). Carries
 * `format=csv` + the export cap limit so "Export" returns the full filtered set
 * (up to the cap), not just the first page (EC-4).
 */
export function tracesExportHref(query: ListTracesQuery = {}): string {
  return `${BASE}/v1/traces${listQueryString(query, {
    format: "csv",
    limit: String(EXPORT_LIMIT),
  })}`;
}

/** Fetch the reconstructed span tree for one trace. */
export function getTraceTree(traceId: string): Promise<TraceTreeNode> {
  return getJson<TraceTreeNode>(`/v1/traces/${encodeURIComponent(traceId)}`);
}

/** Fetch a trace's cost summary (M5). */
export function getTraceCost(traceId: string): Promise<TraceCost> {
  return getJson<TraceCost>(`/v1/traces/${encodeURIComponent(traceId)}/cost`);
}

/** Fetch day/week cost aggregation (M5). */
export function getCostByPeriod(
  period: "day" | "week",
): Promise<CostByPeriodResponse> {
  return getJson<CostByPeriodResponse>(`/v1/analytics/cost?period=${period}`);
}

/** Fetch per-tool operational stats (M6). */
export function getToolStats(): Promise<ToolStatsResponse> {
  return getJson<ToolStatsResponse>("/v1/analytics/tools");
}

/** Fetch the executions that called a given tool (M6 drill-down). */
export function getTracesForTool(toolName: string): Promise<TraceListResponse> {
  return getJson<TraceListResponse>(
    `/v1/analytics/tools/${encodeURIComponent(toolName)}/traces`,
  );
}

/** Fetch the north-star metrics: traces/day + replay-sessions/week (M8). */
export function getNorthStar(): Promise<NorthStarResponse> {
  return getJson<NorthStarResponse>("/v1/metrics/north-star");
}

/** Fetch the time-series observability metrics over a range (M11). */
export function getObservability(
  range: ObservabilityRange,
): Promise<ObservabilityResponse> {
  return getJson<ObservabilityResponse>(
    `/v1/metrics/observability?range=${range}`,
  );
}

/** Fetch the sessions list, newest-first (M13). */
export function getSessions(): Promise<SessionListResponse> {
  return getJson<SessionListResponse>("/v1/sessions");
}

/** Fetch one session's detail: scoped aggregates + member traces (M13). */
export function getSession(sessionId: string): Promise<SessionDetail> {
  return getJson<SessionDetail>(`/v1/sessions/${encodeURIComponent(sessionId)}`);
}

/** Fetch a trace's tags (M14). */
export function getTraceTags(traceId: string): Promise<TraceTagsResponse> {
  return getJson<TraceTagsResponse>(`/v1/traces/${encodeURIComponent(traceId)}/tags`);
}

/** Add a tag to a trace (M14); returns the updated tag set. Throws ApiError on non-2xx. */
async function mutateTags(path: string, method: "POST" | "DELETE", body?: unknown): Promise<TraceTagsResponse> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as TraceTagsResponse;
}

export function addTraceTag(traceId: string, tag: string): Promise<TraceTagsResponse> {
  return mutateTags(`/v1/traces/${encodeURIComponent(traceId)}/tags`, "POST", { tag });
}

/** Remove a tag — the tag travels in an encoded query param (slash-safe, EC-1). */
export function removeTraceTag(traceId: string, tag: string): Promise<TraceTagsResponse> {
  return mutateTags(
    `/v1/traces/${encodeURIComponent(traceId)}/tags?tag=${encodeURIComponent(tag)}`,
    "DELETE",
  );
}

/**
 * Record that a trace's replay was opened (M8 north-star). Fire-and-forget +
 * fail-soft (D3): a metrics ping must never degrade the replay UX, so any error
 * (network/5xx) is swallowed — the replay works from already-fetched data.
 */
export function recordReplaySession(traceId: string): void {
  void fetch(`${BASE}/v1/replay-sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ traceId }),
  }).catch(() => {
    /* fail-soft: the replay does not depend on this metric ping */
  });
}
