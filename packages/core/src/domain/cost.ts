import { z } from "zod";

/** Per-trace cost summary DTO (M5). `.strict()` — no persistence column leaks. */
export const traceCostSchema = z
  .object({
    traceId: z.string().min(1),
    costUsd: z.number(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    totalTokens: z.number().int(),
  })
  .strict();

/** One day/week bucket of aggregated cost. */
export const costBucketSchema = z
  .object({
    periodStart: z.string(),
    costUsd: z.number(),
    totalTokens: z.number().int(),
    traceCount: z.number().int(),
  })
  .strict();

export const costByPeriodResponseSchema = z
  .object({
    period: z.enum(["day", "week"]),
    buckets: z.array(costBucketSchema),
  })
  .strict();

export type TraceCost = z.infer<typeof traceCostSchema>;
export type CostBucket = z.infer<typeof costBucketSchema>;
export type CostByPeriodResponse = z.infer<typeof costByPeriodResponseSchema>;
export type CostPeriod = CostByPeriodResponse["period"];
