import { z } from "zod";

/**
 * Datasets (M26d): a named, curated set of example traces. A `DatasetItem` snapshots
 * the source trace's root input/output AT ADD-TIME, so a curated example survives the
 * source trace being pruned (M23 retention). Distinct from evals/annotations — this is
 * curation, not scoring.
 */
export const DATASET_NAME_MAX = 120;

/** One dataset in the list (with its item count). `.strict()` so DB columns never leak. */
export const datasetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    itemCount: z.number().int().nonnegative(),
  })
  .strict();

export type Dataset = z.infer<typeof datasetSchema>;

/** One curated example. `traceId` is the source ref: a real trace, or a synthetic `replay-{uuid}`
 *  for a playground-replay item (M55) whose input/output live in the snapshots. */
export const datasetItemSchema = z
  .object({
    traceId: z.string(),
    inputSnapshot: z.string().optional(),
    outputSnapshot: z.string().optional(),
    createdAt: z.string(),
  })
  .strict();

export type DatasetItem = z.infer<typeof datasetItemSchema>;

export const datasetsResponseSchema = z
  .object({ datasets: z.array(datasetSchema) })
  .strict();

export type DatasetsResponse = z.infer<typeof datasetsResponseSchema>;

/** A dataset + its items (the detail view). */
export const datasetDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    items: z.array(datasetItemSchema),
  })
  .strict();

export type DatasetDetail = z.infer<typeof datasetDetailSchema>;

/**
 * Normalize a raw dataset name for storage (M26d D1). PURE + TOTAL — never throws.
 * Trims, caps to {@link DATASET_NAME_MAX}, and returns null when blank/absent (the
 * route turns null into a 400). Case-preserving (so "Travel" ≠ "travel" — like tags).
 */
export function normalizeDatasetName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > DATASET_NAME_MAX
    ? trimmed.slice(0, DATASET_NAME_MAX)
    : trimmed;
}
