import { z } from "zod";

import { round3 } from "./tool-stats.js";
import { computeTraceCost, type PriceTable } from "./pricing.js";

/**
 * Time-range presets (M11). Each maps to a Postgres `interval` (the scan window)
 * + a `date_trunc` granularity. Fixed whitelist — NOT raw-interpolated (the
 * trunc literal is selected from this map, never from the request string).
 */
export const RANGE_BUCKETS = {
  "1h": { interval: "1 hour", trunc: "minute" },
  "24h": { interval: "24 hours", trunc: "hour" },
  "7d": { interval: "7 days", trunc: "day" },
  "30d": { interval: "30 days", trunc: "day" },
} as const;

export const observabilityRangeSchema = z.enum(["1h", "24h", "7d", "30d"]);
export type ObservabilityRange = z.infer<typeof observabilityRangeSchema>;

const trafficBucketSchema = z
  .object({
    periodStart: z.string(),
    traceCount: z.number().int().nonnegative(),
    errorCount: z.number().int().nonnegative(),
    errorRate: z.number().min(0).max(1),
  })
  .strict();

const latencyBucketSchema = z
  .object({
    periodStart: z.string(),
    p50Ms: z.number().nonnegative(),
    p75Ms: z.number().nonnegative(),
    p95Ms: z.number().nonnegative(),
    p99Ms: z.number().nonnegative(),
  })
  .strict();

const modelBucketSchema = z
  .object({
    periodStart: z.string(),
    model: z.string(),
    totalTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  })
  .strict();

export const observabilityResponseSchema = z
  .object({
    range: observabilityRangeSchema,
    traffic: z.array(trafficBucketSchema),
    latency: z.array(latencyBucketSchema),
    tokensByModel: z.array(modelBucketSchema),
  })
  .strict();

export type ObservabilityResponse = z.infer<typeof observabilityResponseSchema>;

/** Raw aggregation rows from the DB, before pure shaping. */
export interface RawObservability {
  traffic: { bucket: Date | string; traceCount: number; errorCount: number }[];
  latency: {
    bucket: Date | string;
    p50: number;
    p75: number;
    p95: number;
    p99: number;
  }[];
  tokensByModel: {
    bucket: Date | string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number | undefined;
    cacheCreationTokens?: number | undefined;
  }[];
}

/** Bucket timestamp → ISO date-time; an unparseable bucket falls back to its raw string. */
function isoBucket(bucket: Date | string): string {
  const d = bucket instanceof Date ? bucket : new Date(bucket);
  return Number.isNaN(d.getTime()) ? String(bucket) : d.toISOString();
}

/**
 * Pure shaping of raw observability rows into the response DTO (M11). error-rate
 * guards divide-by-zero; per-model cost is computed from tokens × the price table
 * (`computeTraceCost`, M5 — an unpriced model contributes $0, real tokens); all
 * floats are `round3`-ed for a clean DTO. Deterministic + unit-testable; the SQL
 * is cross-checked against it in integration.
 */
export function shapeObservability(
  raw: RawObservability,
  range: ObservabilityRange,
  priceTable: PriceTable,
): ObservabilityResponse {
  return {
    range,
    traffic: raw.traffic.map((r) => ({
      periodStart: isoBucket(r.bucket),
      traceCount: r.traceCount,
      errorCount: r.errorCount,
      errorRate: r.traceCount === 0 ? 0 : round3(r.errorCount / r.traceCount),
    })),
    latency: raw.latency.map((r) => ({
      periodStart: isoBucket(r.bucket),
      p50Ms: round3(r.p50),
      p75Ms: round3(r.p75),
      p95Ms: round3(r.p95),
      p99Ms: round3(r.p99),
    })),
    tokensByModel: raw.tokensByModel.map((r) => ({
      periodStart: isoBucket(r.bucket),
      model: r.model,
      totalTokens: (r.inputTokens || 0) + (r.outputTokens || 0),
      costUsd: round3(
        computeTraceCost(
          [
            {
              model: r.model,
              inputTokens: r.inputTokens || 0,
              outputTokens: r.outputTokens || 0,
              // M52 / theo-lens#71 Finding 1: cache tokens are billable — include them.
              cacheReadTokens: r.cacheReadTokens || 0,
              cacheCreationTokens: r.cacheCreationTokens || 0,
            },
          ],
          priceTable,
        ),
      ),
    })),
  };
}
