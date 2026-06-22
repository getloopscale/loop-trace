import type { Span } from "./span.js";
import type { TraceListResponse } from "./trace-list.js";
import type { CostByPeriodResponse, CostPeriod, TraceCost } from "./cost.js";
import type { ToolStatsResponse } from "./tool-stats.js";
import type { NorthStarResponse } from "./north-star.js";

/** A span plus its reconstructed children — the trace tree node. */
export interface TraceTreeNode extends Span {
  children: TraceTreeNode[];
}

/**
 * Persistence port for spans (DIP). The domain declares the contract; the
 * infrastructure layer (Drizzle/Postgres) implements it.
 */
export interface SpanRepository {
  /** Persist a batch of spans and recompute the trace/session aggregates. */
  save(spans: Span[]): Promise<void>;
  /** Read a single span by its spanId, or null if absent. */
  getBySpanId(spanId: string): Promise<Span | null>;
  /** Reconstruct the tree of spans sharing a trace_id, or null if none exist. */
  getTraceTree(traceId: string): Promise<TraceTreeNode | null>;
  /** List executions (traces) newest-first as the stable UI list DTO (M3 D2). */
  listTraces(limit?: number): Promise<TraceListResponse>;
  /** Per-trace cost summary (M5), or null if the trace is absent. */
  getTraceCost(traceId: string): Promise<TraceCost | null>;
  /** Cost aggregated into day/week time buckets (M5). */
  aggregateCostByPeriod(period: CostPeriod): Promise<CostByPeriodResponse>;
  /** Per-tool operational stats (count/p50/p95/error-rate) over a recent window (M6). */
  aggregateToolStats(): Promise<ToolStatsResponse>;
  /** Executions (traces) that called a given tool, newest-first (M6 drill-down). */
  listTracesForTool(toolName: string, limit?: number): Promise<TraceListResponse>;
  /** Record that a trace's replay was opened in the UI (M8 north-star). */
  recordReplaySession(traceId: string): Promise<void>;
  /** North-star metrics: traces ingested per day + replay sessions per week (M8). */
  aggregateNorthStar(): Promise<NorthStarResponse>;
}
