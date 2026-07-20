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
    /**
     * M20: the session's first user message — root-span input of the earliest
     * member trace, truncated (≤120 chars). Optional + omitted when the earliest
     * root has null/empty/whitespace input (EC-1). Additive; `.strict()` preserved.
     */
    firstMessagePreview: z.string().optional(),
    /**
     * M26d: per-session count of online-eval rows across the session's traces (the
     * sessions-list "Evals" column — session-level twin of the per-trace count).
     * Optional + omitted when 0 so `.strict()` stays additive.
     */
    evaluationsCount: z.number().int().nonnegative().optional(),
    /**
     * M131 A1 — the session's last assistant reply (latest root-span output, ≤120 chars).
     * Optional + omitted when the latest root has null/empty output (EC). Additive; `.strict()` preserved.
     */
    lastMessagePreview: z.string().optional(),
    /**
     * M131 A2 — session duration in ms (span event-time: max end − min start over member spans).
     * Optional + omitted when no numeric-bound spans (→ em-dash). A real 0 is shown.
     */
    durationMs: z.number().nonnegative().optional(),
    /**
     * M131 A3 — best-effort user id from `attributes->>'user.id'` (fallback `gen_ai.user.id`).
     * Optional + omitted when absent (→ em-dash), never fabricated. Producer-emit is out of M131 scope.
     */
    userId: z.string().optional(),
  })
  .strict();

export const sessionListResponseSchema = z
  .object({
    sessions: z.array(sessionListItemSchema),
    // M81 — server-side pagination (mirrors trace-list): `total` is the workspace-scoped session count;
    // `limit`/`offset` echo the applied window. Defaulted so an older response still parses.
    total: z.number().int().nonnegative().default(0),
    limit: z.number().int().nonnegative().default(0),
    offset: z.number().int().nonnegative().default(0),
  })
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
