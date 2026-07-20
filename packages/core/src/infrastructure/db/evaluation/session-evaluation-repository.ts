/**
 * M131 B1 — persistence for session-level Session Coherence verdicts. Pure functions over the shared
 * Drizzle handle (same shape as the M99 role split). UPSERT keyed (workspace, session_id, name) so a
 * re-judge overwrites in place; `session_version` lets the runner (B3) skip the judge on a cache hit.
 */
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { DEFAULT_WORKSPACE_ID } from "../../../domain/principal.js";
import { sessionEvaluations } from "../schema.js";

export interface SessionVerdictRecord {
  sessionId: string;
  name: string;
  verdict: string;
  score: number | null;
  reasoning: string | null;
  model: string | null;
  sessionVersion: string;
}

/** UPSERT one verdict per (workspace, session_id, name). Re-judging overwrites; evaluatedAt bumps. */
export async function upsertSessionVerdict(
  db: NodePgDatabase,
  rec: SessionVerdictRecord,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<void> {
  await db
    .insert(sessionEvaluations)
    .values({
      workspaceId,
      sessionId: rec.sessionId,
      name: rec.name,
      verdict: rec.verdict,
      score: rec.score,
      reasoning: rec.reasoning,
      model: rec.model,
      sessionVersion: rec.sessionVersion,
    })
    .onConflictDoUpdate({
      target: [sessionEvaluations.workspaceId, sessionEvaluations.sessionId, sessionEvaluations.name],
      set: {
        verdict: rec.verdict,
        score: rec.score,
        reasoning: rec.reasoning,
        model: rec.model,
        sessionVersion: rec.sessionVersion,
        evaluatedAt: sql`now()`,
      },
    });
}

/** Read the stored verdict for a session's evaluator name, or null when never judged. */
export async function getSessionVerdict(
  db: NodePgDatabase,
  sessionId: string,
  name: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<SessionVerdictRecord | null> {
  const rows = await db
    .select()
    .from(sessionEvaluations)
    .where(
      and(
        eq(sessionEvaluations.workspaceId, workspaceId),
        eq(sessionEvaluations.sessionId, sessionId),
        eq(sessionEvaluations.name, name),
      ),
    )
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    sessionId: r.sessionId,
    name: r.name,
    verdict: r.verdict,
    score: r.score,
    reasoning: r.reasoning,
    model: r.model,
    sessionVersion: r.sessionVersion,
  };
}
