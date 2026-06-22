import { z } from "zod";

/**
 * M8 north-star metrics — the numbers the team watches in Lens itself:
 *  - `tracesPerDay`: traces ingested per day (real telemetry arriving).
 *  - `replaySessionsPerWeek`: replay sessions opened per week (active debugging).
 *
 * Each bucket is `{ period, count }` where `period` is the ISO date (or ISO week
 * start) of the date_trunc bucket. Strict (no extra keys) so a leaked column is
 * rejected at the route boundary (M3 precedent).
 */
export const northStarBucketSchema = z
  .object({
    period: z.string(),
    count: z.number().int().nonnegative(),
  })
  .strict();

export const northStarResponseSchema = z
  .object({
    tracesPerDay: z.array(northStarBucketSchema),
    replaySessionsPerWeek: z.array(northStarBucketSchema),
  })
  .strict();

export type NorthStarBucket = z.infer<typeof northStarBucketSchema>;
export type NorthStarResponse = z.infer<typeof northStarResponseSchema>;

/** A raw aggregation row from the DB: a date_trunc bucket + its count. */
export interface BucketRow {
  bucket: Date | string;
  count: number;
}

/**
 * Pure shaping of raw `date_trunc` rows into north-star buckets: the bucket
 * timestamp becomes an ISO date string and the count is coerced to a
 * non-negative integer. Deterministic + unit-testable; the SQL aggregation is
 * cross-checked against this in integration.
 */
export function shapeNorthStarBuckets(rows: BucketRow[]): NorthStarBucket[] {
  return rows.map((r) => {
    const date = r.bucket instanceof Date ? r.bucket : new Date(r.bucket);
    return {
      period: date.toISOString().slice(0, 10),
      count: Math.max(0, Math.trunc(Number(r.count))),
    };
  });
}
