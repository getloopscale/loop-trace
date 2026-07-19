import { z } from "zod";

/**
 * Human-feedback annotations (M26b write-path). A human attaches a 👍/👎 `label`
 * and/or a free-text `note` to a **trace** (`spanId` omitted) or a **span**
 * (`spanId` set), on a `name` channel (default `"feedback"`), authored by an
 * `annotatorKind` (default `"HUMAN"` — room for LLM annotators in M26c).
 *
 * Distinct from `SpanEvaluation` (machine-emitted at ingest, read-only): annotations
 * are human-written via the API, upserted (latest wins) per target+channel+author.
 */
export const ANNOTATION_NOTE_MAX = 2000;
export const ANNOTATION_LABEL_MAX = 64;
export const DEFAULT_ANNOTATION_NAME = "feedback";
export const DEFAULT_ANNOTATOR_KIND = "HUMAN";

/** One annotation as returned by the API. `.strict()` so DB columns never leak. */
export const annotationSchema = z
  .object({
    /** Omitted for a trace-level annotation; present for a span-level one. */
    spanId: z.string().optional(),
    name: z.string(),
    label: z.string().optional(),
    note: z.string().optional(),
    annotatorKind: z.string(),
    /** ISO timestamp of the last write (newest-first ordering). */
    updatedAt: z.string(),
  })
  .strict();

export type Annotation = z.infer<typeof annotationSchema>;

/** Response DTO for the annotation routes (M26b). */
export const annotationsResponseSchema = z
  .object({ annotations: z.array(annotationSchema) })
  .strict();

export type AnnotationsResponse = z.infer<typeof annotationsResponseSchema>;

/** A validated annotation ready to upsert (the pure-domain shape the repo writes). */
export interface NormalizedAnnotation {
  spanId: string | undefined;
  name: string;
  label: string | undefined;
  note: string | undefined;
  annotatorKind: string;
}

function cleanStr(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t.length === 0) return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * Normalize a raw annotation body for storage (M26b D1). PURE + TOTAL — never
 * throws. Trims label/note (caps to bounds), defaults `name`/`annotatorKind`, and
 * **rejects** (returns null) when BOTH label and note are blank/absent — an empty
 * annotation is noise, not feedback. The route turns null into a 400. `spanId` is
 * carried through (undefined = trace-level); the repo maps undefined → `''` sentinel.
 */
export function normalizeAnnotation(input: unknown): NormalizedAnnotation | null {
  if (input == null || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const label = cleanStr(o["label"], ANNOTATION_LABEL_MAX);
  const note = cleanStr(o["note"], ANNOTATION_NOTE_MAX);
  // An annotation needs at least one of label / note — both blank is rejected (D1).
  if (label === undefined && note === undefined) return null;
  const spanId = cleanStr(o["spanId"], 256);
  const name = cleanStr(o["name"], 64) ?? DEFAULT_ANNOTATION_NAME;
  const annotatorKind = cleanStr(o["annotatorKind"], 32) ?? DEFAULT_ANNOTATOR_KIND;
  return { spanId, name, label, note, annotatorKind };
}
