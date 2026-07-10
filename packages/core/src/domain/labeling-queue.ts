import { z } from "zod";

/**
 * M63 — Labeling Queues (human-in-the-loop review). A span is **enqueued** for labeling (status
 * `pending`), a reviewer **resolves** it with a `label` (+ optional `score`/`note`), and resolved
 * items can be **exported** as a golden dataset (reuses the M44 dataset store). Distinct from M26b
 * annotations (direct feedback on a trace) — a queue item is a review task with a lifecycle.
 *
 * This module is the PURE domain leaf (no DB, no I/O): the item schema + a total normalization of a
 * resolution payload. The resolution payload is versioned (`RESOLUTION_SCHEMA_VERSION`) so a future
 * label-taxonomy change warn-and-migrates on load rather than breaking stored items (ADR D3).
 */

export const LABEL_MAX = 64;
export const NOTE_MAX = 2000;
/** Bumped when the resolution payload shape changes; stamped on every normalized resolution (D3). */
export const RESOLUTION_SCHEMA_VERSION = 1;

export const LABELING_QUEUE_STATUSES = ["pending", "resolved"] as const;
export type LabelingQueueStatus = (typeof LABELING_QUEUE_STATUSES)[number];

/** One labeling-queue item as returned by the API. `.strict()` so DB columns never leak. */
export const labelingQueueItemSchema = z
  .object({
    id: z.string(),
    traceId: z.string(),
    spanId: z.string(),
    status: z.enum(LABELING_QUEUE_STATUSES),
    label: z.string().optional(),
    score: z.number().optional(),
    note: z.string().optional(),
    createdBy: z.string(),
    resolvedBy: z.string().optional(),
    createdAt: z.string(),
    resolvedAt: z.string().optional(),
  })
  .strict();

export type LabelingQueueItem = z.infer<typeof labelingQueueItemSchema>;

/** Response DTO for the queue-list route (server-paginated). */
export const labelingQueuePageSchema = z
  .object({ items: z.array(labelingQueueItemSchema), total: z.number(), page: z.number(), pageSize: z.number() })
  .strict();

export type LabelingQueuePage = z.infer<typeof labelingQueuePageSchema>;

/** A validated resolution ready to write (the pure-domain shape the repo persists). */
export interface NormalizedResolution {
  label: string;
  score: number | undefined;
  note: string | undefined;
  schemaVersion: number;
}

function cleanStr(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t.length === 0) return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

/** Clamp a finite number to [0,1]; anything else → undefined (never NaN/Infinity). */
function cleanScore(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Normalize a raw resolution body for storage (M63 D3). PURE + TOTAL — never throws. Requires a
 * non-blank `label` (an empty resolution is not a review → returns null, the route turns null into a
 * 400); trims/caps label + note; clamps `score` to [0,1] or drops it; stamps the current schema
 * version. An unknown/legacy payload warn-and-migrates (extra fields ignored), never a throw.
 */
export function normalizeLabelResolution(input: unknown): NormalizedResolution | null {
  if (input == null || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const label = cleanStr(o["label"], LABEL_MAX);
  if (label === undefined) return null; // a resolution MUST carry a label
  return {
    label,
    score: cleanScore(o["score"]),
    note: cleanStr(o["note"], NOTE_MAX),
    schemaVersion: RESOLUTION_SCHEMA_VERSION,
  };
}
