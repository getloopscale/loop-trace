/**
 * M99 (audit B-M1) — the AnnotationRepository role (trace tags + human annotations), extracted from
 * the god-adapter into its own file. Pure functions over the shared Drizzle `db` handle; the facade
 * delegates. Behavior-preserving: the SQL moved verbatim; the tags/annotations tests are the proof.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { Annotation, NormalizedAnnotation } from "../../../domain/observability/annotation.js";
import { DEFAULT_ANNOTATOR_KIND } from "../../../domain/observability/annotation.js";
import { DEFAULT_WORKSPACE_ID } from "../../../domain/principal.js";
import { annotations, traceTags, traces } from "../schema.js";

export async function addTag(
  db: NodePgDatabase,
  traceId: string,
  tag: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<boolean> {
  // M14 (D2): you can only tag a real trace. Returns false → route 404 when the trace does not exist.
  // The insert is idempotent (UNIQUE(trace_id,tag) + ON CONFLICT DO NOTHING). NOTE: the existence
  // check is advisory, not transactional (M101 hardens this) — traces are recompute-owned aggregates
  // and never hard-deleted outside prune, so the SELECT→INSERT window is unreachable today.
  const existing = await db
    .select({ traceId: traces.traceId })
    .from(traces)
    .where(and(eq(traces.traceId, traceId), eq(traces.workspaceId, workspaceId)))
    .limit(1);
  if (existing.length === 0) return false;
  await db
    .insert(traceTags)
    .values({ traceId, tag, workspaceId })
    .onConflictDoNothing({ target: [traceTags.workspaceId, traceTags.traceId, traceTags.tag] });
  return true;
}

export async function removeTag(
  db: NodePgDatabase,
  traceId: string,
  tag: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<void> {
  // Idempotent (D2): a no-op when the tag/trace is absent (within the workspace).
  await db
    .delete(traceTags)
    .where(
      and(eq(traceTags.traceId, traceId), eq(traceTags.tag, tag), eq(traceTags.workspaceId, workspaceId)),
    );
}

export async function listTags(
  db: NodePgDatabase,
  traceId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<string[]> {
  // Ordered for a stable UI / deterministic test (EC-6); empty when none.
  const rows = await db
    .select({ tag: traceTags.tag })
    .from(traceTags)
    .where(and(eq(traceTags.traceId, traceId), eq(traceTags.workspaceId, workspaceId)))
    .orderBy(asc(traceTags.tag));
  return rows.map((r) => r.tag);
}

export async function upsertAnnotation(
  db: NodePgDatabase,
  traceId: string,
  ann: NormalizedAnnotation,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<boolean> {
  // M26b (D2): one annotation per (trace, span, name, annotatorKind) — re-submitting REPLACES
  // label/note/updatedAt (latest wins). `span_id = ''` sentinel = trace-level. Advisory trace-exists
  // check (like addTag) → false → route 404; same orphan-window reasoning (M101).
  const existing = await db
    .select({ traceId: traces.traceId })
    .from(traces)
    .where(and(eq(traces.traceId, traceId), eq(traces.workspaceId, workspaceId)))
    .limit(1);
  if (existing.length === 0) return false;
  const spanId = ann.spanId ?? "";
  await db
    .insert(annotations)
    .values({
      workspaceId,
      traceId,
      spanId,
      name: ann.name,
      label: ann.label ?? null,
      note: ann.note ?? null,
      annotatorKind: ann.annotatorKind,
    })
    .onConflictDoUpdate({
      target: [
        annotations.workspaceId,
        annotations.traceId,
        annotations.spanId,
        annotations.name,
        annotations.annotatorKind,
      ],
      set: { label: ann.label ?? null, note: ann.note ?? null, updatedAt: sql`now()` },
    });
  return true;
}

export async function listAnnotations(
  db: NodePgDatabase,
  traceId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<Annotation[]> {
  // Newest-first (D2); trace-level (span_id '') + all spans'. Empty when none.
  const rows = await db
    .select()
    .from(annotations)
    .where(and(eq(annotations.traceId, traceId), eq(annotations.workspaceId, workspaceId)))
    .orderBy(desc(annotations.updatedAt));
  return rows.map((r) => ({
    // '' sentinel → trace-level: omit spanId so the DTO stays `.strict()` clean.
    ...(r.spanId !== "" ? { spanId: r.spanId } : {}),
    name: r.name,
    ...(r.label != null ? { label: r.label } : {}),
    ...(r.note != null ? { note: r.note } : {}),
    annotatorKind: r.annotatorKind,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function removeAnnotation(
  db: NodePgDatabase,
  traceId: string,
  key: { spanId?: string; name: string; annotatorKind?: string },
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<void> {
  // Idempotent (D2): a no-op when the annotation/trace is absent (in the workspace).
  await db
    .delete(annotations)
    .where(
      and(
        eq(annotations.traceId, traceId),
        eq(annotations.workspaceId, workspaceId),
        eq(annotations.spanId, key.spanId ?? ""),
        eq(annotations.name, key.name),
        eq(annotations.annotatorKind, key.annotatorKind ?? DEFAULT_ANNOTATOR_KIND),
      ),
    );
}
