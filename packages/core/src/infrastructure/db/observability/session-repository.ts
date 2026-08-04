/**
 * M99 (audit B-M1) — the SessionRepository role (M13 session list + detail), extracted from the
 * god-adapter into its own file. Pure functions over the shared Drizzle `db` handle; the facade
 * delegates. Behavior-preserving: the SQL moved verbatim; the session integration tests are the proof.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { rowsAs } from "../../../domain/sql-rows.js";
import { DEFAULT_WORKSPACE_ID } from "../../../domain/principal.js";
import { round3, roundUsd } from "../../../domain/observability/tool-stats.js";
import {
  isoTimestamp,
  shapeSessionDetail,
  type RawSessionDetail,
  type SessionDetailResponse,
  type SessionListItem,
  type SessionListResponse,
} from "../../../domain/observability/session.js";
import { END_USER_ID_SQL, LATENCY_MS_EXPR, preview, traceRowToItem } from "../repo-shared.js";
import { sessions, traces } from "../schema.js";


/** M100 (B-L1) — the raw session-list row (a renamed SELECT alias now fails loudly at rowsAs). */
export const sessionListRowSchema = z.object({
  sessionId: z.string(),
  firstSeenAt: z.union([z.date(), z.string()]),
  lastSeenAt: z.union([z.date(), z.string()]),
  traceCount: z.number(),
  costUsd: z.number(),
  totalTokens: z.number(),
  errorCount: z.number(),
  evaluationsCount: z.number(),
  firstMessageRaw: z.string().nullable(),
  // M131 A1/A2/A3 — Arize-parity residual columns (correlated scalar subqueries, N+1-free).
  lastMessageRaw: z.string().nullable(),
  durationMs: z.number().nullable(),
  userIdRaw: z.string().nullable(),
});

/** M100 (B-L1) — the raw session-detail aggregate row. */
export const sessionAggRowSchema = z.object({
  traceCount: z.number(),
  costUsd: z.number().nullable(),
  totalTokens: z.number().nullable(),
  errorCount: z.number(),
  p50: z.number().nullable(),
  p95: z.number().nullable(),
});

export async function listSessions(
  db: NodePgDatabase,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
  opts: { limit?: number; offset?: number } = {},
): Promise<SessionListResponse> {
  // M81 — server-side pagination: clamp the window (default 50, cap 500 like traces) and expose a
  // workspace-scoped total (count of SESSIONS, the GROUP BY grain). The BFF already forwards limit/offset.
  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 50)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  // One row per real session (only session.id-bearing traces — D3), with scoped aggregates summed over
  // the spans-derived traces table (D2). LEFT JOIN so a session with zero member traces still lists.
  // The first user message is the input of the earliest root span across the session (a correlated
  // scalar subquery); the `~ '^\d+$'` guard keeps the numeric ORDER BY cast from erroring on garbage nanos.
  const res = await db.execute(sql`
    SELECT s.session_id AS "sessionId",
           s.first_seen_at AS "firstSeenAt",
           s.last_seen_at AS "lastSeenAt",
           count(t.trace_id)::int AS "traceCount",
           coalesce(sum(t.cost_usd), 0)::double precision AS "costUsd",
           coalesce(sum(t.total_tokens), 0)::double precision AS "totalTokens",
           count(t.trace_id) FILTER (WHERE t.status_code = 'error')::int AS "errorCount",
           (SELECT count(*)::int
              FROM span_evaluations se
             WHERE se.workspace_id = ${workspaceId}
               AND se.trace_id IN (SELECT te.trace_id FROM traces te
                                    WHERE te.session_id = s.session_id
                                      AND te.workspace_id = ${workspaceId})) AS "evaluationsCount",
           (SELECT sp.input_value
              FROM spans sp
              JOIN traces tt ON tt.trace_id = sp.trace_id AND tt.workspace_id = ${workspaceId}
             WHERE tt.session_id = s.session_id
               AND sp.workspace_id = ${workspaceId}
               AND sp.parent_span_id IS NULL
               AND sp.start_time_unix_nano ~ '^\\d+$'
             ORDER BY sp.start_time_unix_nano::numeric ASC
             LIMIT 1) AS "firstMessageRaw",
           -- M131 A1 — last message = LATEST root span's output (final assistant reply), symmetric to first.
           (SELECT sp.output_value
              FROM spans sp
              JOIN traces tt ON tt.trace_id = sp.trace_id AND tt.workspace_id = ${workspaceId}
             WHERE tt.session_id = s.session_id
               AND sp.workspace_id = ${workspaceId}
               AND sp.parent_span_id IS NULL
               AND sp.start_time_unix_nano ~ '^\\d+$'
             ORDER BY sp.start_time_unix_nano::numeric DESC
             LIMIT 1) AS "lastMessageRaw",
           -- M131 A2 — duration = span event-time (max end − min start) over member spans, ms, clamped ≥0.
           (SELECT greatest(0, (max(sp.end_time_unix_nano::numeric) - min(sp.start_time_unix_nano::numeric)) / 1e6)::double precision
              FROM spans sp
              JOIN traces tt ON tt.trace_id = sp.trace_id AND tt.workspace_id = ${workspaceId}
             WHERE tt.session_id = s.session_id
               AND sp.workspace_id = ${workspaceId}
               AND sp.start_time_unix_nano ~ '^\\d+$'
               AND sp.end_time_unix_nano ~ '^\\d+$') AS "durationMs",
           -- M131 A3 — user id via the single END_USER_ID_SQL definition (M140 ADR D1); NULL → em-dash.
           (SELECT ${END_USER_ID_SQL("sp")}
              FROM spans sp
              JOIN traces tt ON tt.trace_id = sp.trace_id AND tt.workspace_id = ${workspaceId}
             WHERE tt.session_id = s.session_id
               AND sp.workspace_id = ${workspaceId}
               AND ${END_USER_ID_SQL("sp")} IS NOT NULL
             LIMIT 1) AS "userIdRaw"
    FROM sessions s
    LEFT JOIN traces t ON t.session_id = s.session_id AND t.workspace_id = s.workspace_id
    WHERE s.workspace_id = ${workspaceId}
    GROUP BY s.session_id, s.first_seen_at, s.last_seen_at
    ORDER BY s.last_seen_at DESC, s.session_id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
  const rows = rowsAs(res, sessionListRowSchema, "listSessions");
  const sessionsOut: SessionListItem[] = rows.map((r) => {
    const item: SessionListItem = {
      sessionId: r.sessionId,
      firstSeenAt: isoTimestamp(r.firstSeenAt),
      lastSeenAt: isoTimestamp(r.lastSeenAt),
      traceCount: r.traceCount,
      // 6 casas, não 3: a LISTA sofria o mesmo zeramento do detalhe (LT-063 / #121).
      costUsd: roundUsd(r.costUsd ?? 0),
      totalTokens: r.totalTokens ?? 0,
      errorRate: r.traceCount === 0 ? 0 : round3(r.errorCount / r.traceCount),
    };
    // EC-1: only surface a non-empty, non-whitespace first message.
    if (r.firstMessageRaw != null && r.firstMessageRaw.trim() !== "") {
      item.firstMessagePreview = preview(r.firstMessageRaw);
    }
    // M26d: per-session eval count (>0 → shown; 0 → omitted, no "0" column).
    if (r.evaluationsCount > 0) item.evaluationsCount = r.evaluationsCount;
    // M131 A1 — last message (final assistant reply), truncated; omitted when null/whitespace (EC).
    if (r.lastMessageRaw != null && r.lastMessageRaw.trim() !== "") {
      item.lastMessagePreview = preview(r.lastMessageRaw);
    }
    // M131 A2 — session duration in ms (span event-time); omitted when no numeric-bound spans (→ em-dash).
    if (r.durationMs != null) item.durationMs = round3(r.durationMs);
    // M131 A3 — best-effort user id; omitted when absent (→ em-dash), never fabricated.
    if (r.userIdRaw != null && r.userIdRaw.trim() !== "") item.userId = r.userIdRaw;
    return item;
  });
  // M81: workspace-scoped total (one row per session — matches the GROUP BY grain).
  const totalRes = await db.execute(
    sql`SELECT count(*)::int AS n FROM sessions s WHERE s.workspace_id = ${workspaceId}`,
  );
  const total = (totalRes.rows[0] as { n: number } | undefined)?.n ?? 0;
  return { sessions: sessionsOut, total, limit, offset };
}

export async function getSessionDetail(
  db: NodePgDatabase,
  sessionId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<SessionDetailResponse | null> {
  // Absent session → null (route 404). "Absent" = no row in the workspace's sessions.
  const sessionRows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.sessionId, sessionId), eq(sessions.workspaceId, workspaceId)))
    .limit(1);
  const session = sessionRows[0];
  if (!session) return null;

  // Scoped aggregates over the member traces. count/cost/tokens cover ALL member traces; the latency
  // percentile FILTERs to numeric-bound traces only and clamps clock skew via greatest(0, …).
  const aggRes = await db.execute(sql`
    SELECT count(*)::int AS "traceCount",
           coalesce(sum(cost_usd), 0)::double precision AS "costUsd",
           coalesce(sum(total_tokens), 0)::double precision AS "totalTokens",
           count(*) FILTER (WHERE status_code = 'error')::int AS "errorCount",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ${sql.raw(LATENCY_MS_EXPR)})
             FILTER (WHERE start_time_unix_nano ~ '^\\d+$' AND end_time_unix_nano ~ '^\\d+$')::double precision AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY ${sql.raw(LATENCY_MS_EXPR)})
             FILTER (WHERE start_time_unix_nano ~ '^\\d+$' AND end_time_unix_nano ~ '^\\d+$')::double precision AS p95
    FROM traces
    WHERE session_id = ${sessionId} AND workspace_id = ${workspaceId}
  `);
  const agg = rowsAs(aggRes, sessionAggRowSchema, "getSessionDetail")[0]!;

  // Member traces as the stable list DTO (reuses the M3 mapping).
  const memberRows = await db
    .select()
    .from(traces)
    .where(and(eq(traces.sessionId, sessionId), eq(traces.workspaceId, workspaceId)))
    .orderBy(desc(traces.updatedAt));

  const raw: RawSessionDetail = {
    sessionId: session.sessionId,
    firstSeenAt: session.firstSeenAt,
    lastSeenAt: session.lastSeenAt,
    traceCount: agg.traceCount,
    costUsd: agg.costUsd,
    totalTokens: agg.totalTokens,
    errorCount: agg.errorCount,
    p50: agg.p50,
    p95: agg.p95,
    traces: memberRows.map(traceRowToItem),
  };
  return shapeSessionDetail(raw);
}
