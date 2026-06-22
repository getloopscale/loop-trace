import { z } from "zod";

import { round3 } from "./tool-stats.js";
import { traceListItemSchema, type TraceListItem } from "./trace-list.js";

/**
 * Session DTOs (M13). A session groups traces that share an explicit `session.id`
 * / `gen_ai.conversation.id`. Scoped aggregates are summed over the spans-derived
 * `traces` table (so a session total equals the sum of its traces' shown values —
 * no drift, ADR D2). `.strict()` so Drizzle columns never leak (M3 risk #2).
 */
export const sessionListItemSchema = z
  .object({
    sessionId: z.string().min(1),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
    traceCount: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    errorRate: z.number().min(0).max(1),
  })
  .strict();

export const sessionListResponseSchema = z
  .object({ sessions: z.array(sessionListItemSchema) })
  .strict();

export const sessionDetailResponseSchema = z
  .object({
    sessionId: z.string().min(1),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
    traceCount: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    errorRate: z.number().min(0).max(1),
    latencyP50Ms: z.number().nonnegative(),
    latencyP95Ms: z.number().nonnegative(),
    traces: z.array(traceListItemSchema),
  })
  .strict();

export type SessionListItem = z.infer<typeof sessionListItemSchema>;
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export type SessionDetailResponse = z.infer<typeof sessionDetailResponseSchema>;

/** Raw per-session aggregate rows from the DB, before pure shaping. */
export interface RawSessionDetail {
  sessionId: string;
  firstSeenAt: Date | string;
  lastSeenAt: Date | string;
  traceCount: number;
  /** SUM(cost_usd) — NULL when every member trace is tokenless (EC-1). */
  costUsd: number | null;
  totalTokens: number | null;
  errorCount: number;
  /** percentile_cont — NULL when no member trace has a numeric duration (EC-1). */
  p50: number | null;
  p95: number | null;
  traces: TraceListItem[];
}

/** A timestamp → ISO date-time; an unparseable value falls back to its string. */
export function isoTimestamp(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

/**
 * Pure shaping of a raw session aggregate into the detail DTO (M13). errorRate
 * guards divide-by-zero; NULL cost/tokens/latency coalesce to 0 (EC-1 — an
 * all-tokenless session is valid, not an error); floats are round3-ed.
 * Deterministic + unit-testable; the SQL is cross-checked against it in integration.
 */
export function shapeSessionDetail(raw: RawSessionDetail): SessionDetailResponse {
  return {
    sessionId: raw.sessionId,
    firstSeenAt: isoTimestamp(raw.firstSeenAt),
    lastSeenAt: isoTimestamp(raw.lastSeenAt),
    traceCount: raw.traceCount,
    costUsd: round3(raw.costUsd ?? 0),
    totalTokens: raw.totalTokens ?? 0,
    errorRate: raw.traceCount === 0 ? 0 : round3(raw.errorCount / raw.traceCount),
    latencyP50Ms: round3(raw.p50 ?? 0),
    latencyP95Ms: round3(raw.p95 ?? 0),
    traces: raw.traces,
  };
}
