/**
 * M99 (audit B-M1) — the CopilotFeedbackRepository role (M83 answer thumbs up/down), extracted from
 * the god-adapter into its own file. Pure functions over the shared Drizzle `db` handle; the facade
 * delegates. Behavior-preserving: the SQL moved verbatim; the copilot-feedback tests are the proof.
 */
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { AskFeedbackInput, CopilotFeedbackRecord } from "../../domain/evaluation/copilot-feedback.js";
import { DEFAULT_WORKSPACE_ID } from "../../domain/principal.js";
import { copilotFeedback } from "./schema.js";

export async function recordAskFeedback(
  db: NodePgDatabase,
  traceId: string,
  input: AskFeedbackInput,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<CopilotFeedbackRecord> {
  // UPSERT on (workspace_id, trace_id, turn_id): a re-vote toggles the label (up↔down) in place,
  // never a duplicate row. Workspace-leading unique keeps a same-turn collision tenant-isolated.
  const rows = await db
    .insert(copilotFeedback)
    .values({
      workspaceId,
      traceId,
      turnId: input.turnId,
      spanId: input.spanId ?? "",
      label: input.label,
      question: input.question ?? null,
    })
    .onConflictDoUpdate({
      target: [copilotFeedback.workspaceId, copilotFeedback.traceId, copilotFeedback.turnId],
      set: { label: input.label, question: input.question ?? null, updatedAt: new Date() },
    })
    .returning();
  const r = rows[0]!;
  return {
    id: r.id,
    traceId: r.traceId,
    turnId: r.turnId,
    label: r.label as CopilotFeedbackRecord["label"],
    updatedAt: r.updatedAt.toISOString(),
    ...(r.spanId ? { spanId: r.spanId } : {}),
    ...(r.question != null ? { question: r.question } : {}),
  };
}

export async function deleteAskFeedback(
  db: NodePgDatabase,
  traceId: string,
  turnId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<boolean> {
  // Retract the vote (the UI "clear"). Workspace-scoped; idempotent — no matching row → false.
  const deleted = await db
    .delete(copilotFeedback)
    .where(
      and(
        eq(copilotFeedback.workspaceId, workspaceId),
        eq(copilotFeedback.traceId, traceId),
        eq(copilotFeedback.turnId, turnId),
      ),
    )
    .returning({ id: copilotFeedback.id });
  return deleted.length > 0;
}
