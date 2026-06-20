import type {
  CostByPeriodResponse,
  TraceCost,
  TraceListResponse,
  TraceTreeNode,
} from "./types.js";

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

/** List executions (traces) newest-first. */
export function listTraces(): Promise<TraceListResponse> {
  return getJson<TraceListResponse>("/v1/traces");
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
