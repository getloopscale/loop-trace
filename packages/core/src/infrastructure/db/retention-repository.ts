/**
 * M99 (audit B-M1) — the RetentionRepository role (M23 system-wide age-based prune), extracted from
 * the god-adapter into its own file. Pure function over the shared Drizzle `db` handle; the facade
 * delegates. Behavior-preserving: the cascade SQL + transaction moved verbatim; the retention tests
 * are the proof.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { PruneStats } from "../../domain/observability/retention.js";

export async function prune(db: NodePgDatabase, olderThan: Date): Promise<PruneStats> {
  // M23 trace-granular hard-delete cascade, atomic in one transaction (the tables have NO DB foreign
  // keys — so each dependent table is cleaned explicitly). Order: delete spans/tags/replay of stale
  // traces FIRST (the `stale` subquery reads `traces` while it still holds those rows), THEN the stale
  // traces, THEN now-orphaned sessions.
  const cutoff = olderThan.toISOString();
  const rowCount = (r: { rowCount: number | null }): number => r.rowCount ?? 0;
  return db.transaction(async (tx) => {
    // M22: the stale set is keyed by BOTH (workspace_id, trace_id) so a stale trace in one workspace
    // never cascades a delete onto a same-trace_id row in another. Retention itself is system-wide
    // (age-based operator policy) — only the cascade is workspace-precise.
    const stale = sql`(SELECT workspace_id, trace_id FROM traces WHERE updated_at < ${cutoff})`;
    const spansRes = await tx.execute(sql`DELETE FROM spans WHERE (workspace_id, trace_id) IN ${stale}`);
    const tagsRes = await tx.execute(sql`DELETE FROM trace_tags WHERE (workspace_id, trace_id) IN ${stale}`);
    const replayRes = await tx.execute(sql`DELETE FROM replay_sessions WHERE (workspace_id, trace_id) IN ${stale}`);
    // M26/M26b: eval rows + human annotations of stale traces (avoid orphans). Keyed by (workspace_id, trace_id).
    const evalsRes = await tx.execute(sql`DELETE FROM span_evaluations WHERE (workspace_id, trace_id) IN ${stale}`);
    const annotationsRes = await tx.execute(sql`DELETE FROM annotations WHERE (workspace_id, trace_id) IN ${stale}`);
    // M134 (EC-4): auto-eval job rows of stale traces. This table has no FK either, so it must be
    // enumerated here like every sibling — and it matters twice: unbounded growth, plus a completed
    // row outliving its trace would make the dedup constraint a permanent tombstone.
    const evalJobsRes = await tx.execute(sql`DELETE FROM eval_jobs WHERE (workspace_id, trace_id) IN ${stale}`);
    const tracesRes = await tx.execute(sql`DELETE FROM traces WHERE updated_at < ${cutoff}`);
    // EC-1: the `IS NOT NULL` guard is mandatory — a NULL in a NOT IN set makes the whole predicate
    // UNKNOWN and would silently delete ZERO orphans. The (workspace_id, session_id) pair matches the
    // composite sessions PK so a live session in workspace B is never orphan-deleted by workspace A.
    const sessionsRes = await tx.execute(
      sql`DELETE FROM sessions WHERE (workspace_id, session_id) NOT IN (SELECT workspace_id, session_id FROM traces WHERE session_id IS NOT NULL)`,
    );
    return {
      cutoff,
      spansDeleted: rowCount(spansRes),
      tagsDeleted: rowCount(tagsRes),
      replaySessionsDeleted: rowCount(replayRes),
      tracesDeleted: rowCount(tracesRes),
      sessionsDeleted: rowCount(sessionsRes),
      evaluationsDeleted: rowCount(evalsRes),
      annotationsDeleted: rowCount(annotationsRes),
      evalJobsDeleted: rowCount(evalJobsRes),
    };
  });
}
