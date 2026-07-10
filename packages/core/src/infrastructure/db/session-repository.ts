/**
 * M99 (audit B-M1) — the SessionRepository role (M13 session list + detail), extracted from the
 * god-adapter into its own file. Pure functions over the shared Drizzle `db` handle; the facade
 * delegates. Behavior-preserving: the SQL moved verbatim; the session integration tests are the proof.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { DEFAULT_WORKSPACE_ID } from "../../domain/principal.js";
import { round3 } from "../../domain/tool-stats.js";
import {
  isoTimestamp,
  shapeSessionDetail,
  type RawSessionDetail,
  type SessionDetailResponse,
  type SessionListItem,
  type SessionListResponse,
} from "../../domain/session.js";
import { LATENCY_MS_EXPR, preview, traceRowToItem } from "./repo-shared.js";
import { sessions, traces } from "./schema.js";

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
           coalesce(sum(t.total_tokens), 0)::int AS "totalTokens",
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
             LIMIT 1) AS "firstMessageRaw"
    FROM sessions s
    LEFT JOIN traces t ON t.session_id = s.session_id AND t.workspace_id = s.workspace_id
    WHERE s.workspace_id = ${workspaceId}
    GROUP BY s.session_id, s.first_seen_at, s.last_seen_at
    ORDER BY s.last_seen_at DESC, s.session_id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
  const rows = res.rows as unknown as {
    sessionId: string;
    firstSeenAt: Date;
    lastSeenAt: Date;
    traceCount: number;
    costUsd: number;
    totalTokens: number;
    errorCount: number;
    evaluationsCount: number;
    firstMessageRaw: string | null;
  }[];
  const sessionsOut: SessionListItem[] = rows.map((r) => {
    const item: SessionListItem = {
      sessionId: r.sessionId,
      firstSeenAt: isoTimestamp(r.firstSeenAt),
      lastSeenAt: isoTimestamp(r.lastSeenAt),
      traceCount: r.traceCount,
      costUsd: round3(r.costUsd ?? 0),
      totalTokens: r.totalTokens ?? 0,
      errorRate: r.traceCount === 0 ? 0 : round3(r.errorCount / r.traceCount),
    };
    // EC-1: only surface a non-empty, non-whitespace first message.
    if (r.firstMessageRaw != null && r.firstMessageRaw.trim() !== "") {
      item.firstMessagePreview = preview(r.firstMessageRaw);
    }
    // M26d: per-session eval count (>0 → shown; 0 → omitted, no "0" column).
    if (r.evaluationsCount > 0) item.evaluationsCount = r.evaluationsCount;
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
           coalesce(sum(total_tokens), 0)::int AS "totalTokens",
           count(*) FILTER (WHERE status_code = 'error')::int AS "errorCount",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ${sql.raw(LATENCY_MS_EXPR)})
             FILTER (WHERE start_time_unix_nano ~ '^\\d+$' AND end_time_unix_nano ~ '^\\d+$')::double precision AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY ${sql.raw(LATENCY_MS_EXPR)})
             FILTER (WHERE start_time_unix_nano ~ '^\\d+$' AND end_time_unix_nano ~ '^\\d+$')::double precision AS p95
    FROM traces
    WHERE session_id = ${sessionId} AND workspace_id = ${workspaceId}
  `);
  const agg = (aggRes.rows as unknown as {
    traceCount: number;
    costUsd: number | null;
    totalTokens: number | null;
    errorCount: number;
    p50: number | null;
    p95: number | null;
  }[])[0]!;

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
