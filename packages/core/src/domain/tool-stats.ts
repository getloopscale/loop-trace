import { z } from "zod";

/** One tool-call sample: its latency in ms and whether it errored. */
export interface ToolSample {
  durationMs: number;
  errored: boolean;
}

/**
 * Continuous percentile (linear interpolation) over an ASCENDING-sorted array.
 * Empty → 0; single element → that element; q clamped to [0, 1]. Mirrors Postgres
 * `percentile_cont` so the pure contract and the SQL aggregation agree (M6 D1).
 */
export function percentile(sortedAsc: number[], q: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0]!;
  const clamped = q < 0 ? 0 : q > 1 ? 1 : q;
  const rank = clamped * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * frac;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Per-tool operational metrics (M6). */
export const toolStatSchema = z
  .object({
    toolName: z.string(),
    callCount: z.number().int(),
    errorCount: z.number().int(),
    errorRate: z.number(),
    p50Ms: z.number(),
    p95Ms: z.number(),
  })
  .strict();

export const toolStatsResponseSchema = z
  .object({ tools: z.array(toolStatSchema) })
  .strict();

export type ToolStat = z.infer<typeof toolStatSchema>;
export type ToolStatsResponse = z.infer<typeof toolStatsResponseSchema>;

/**
 * Pure, deterministic per-tool stats from a sample set (M6 D1 — the unit-tested
 * calculation contract the SQL `percentile_cont` aggregation is cross-checked
 * against). No calls → zeros (errorRate 0). Latency rounded to 3 decimals.
 */
export function computeToolStats(
  toolName: string,
  samples: ToolSample[],
): ToolStat {
  const callCount = samples.length;
  const errorCount = samples.reduce((n, s) => n + (s.errored ? 1 : 0), 0);
  const durations = samples.map((s) => s.durationMs).sort((a, b) => a - b);
  return {
    toolName,
    callCount,
    errorCount,
    errorRate: callCount === 0 ? 0 : round3(errorCount / callCount),
    p50Ms: round3(percentile(durations, 0.5)),
    p95Ms: round3(percentile(durations, 0.95)),
  };
}
