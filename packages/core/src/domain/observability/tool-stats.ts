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

/** Round to 3 decimals (shared by the pure fn + the SQL adapter mapping — DRY). */
export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Arredondamento de VALOR EM USD — 6 casas. Distinto de `round3` de propósito.
 *
 * `round3` serve grandezas cuja terceira casa já é ruído (latência em ms, taxa de erro).
 * Custo não é uma delas: uma chamada de agente com modelo barato custa na casa de 1e-4, e
 * três casas a zeram. Foi assim que o agregado de sessão passou a devolver `costUsd: 0`
 * enquanto os traces membros somavam 0.000384 na MESMA resposta (LT-063 / #121).
 *
 * As 6 casas não são número novo: é a precisão que `pricing.ts` já usa ao calcular o custo
 * de um trace. Um agregado não pode ser mais grosseiro que as parcelas que soma, senão não
 * fecha por construção — por isso o piso vive aqui, num lugar só, e não inline em cada
 * chamador.
 */
export function roundUsd(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * Canonical span status_code values meaning ERROR. OTLP/protobuf yields the numeric
 * enum ("2"); some producers/JSON paths yield the textual name. The tool-stats error
 * filter and the UI status mapping both key on this set (kept in sync by review F-st-1).
 */
export const ERROR_STATUS_CODES = ["2", "ERROR", "STATUS_CODE_ERROR"] as const;

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
  // Clamp negative durations (clock skew: end < start) to 0 — consistent with the
  // trace-list duration guard and the SQL `greatest(0, …)` (review F-st-2).
  const durations = samples
    .map((s) => Math.max(0, s.durationMs))
    .sort((a, b) => a - b);
  return {
    toolName,
    callCount,
    errorCount,
    errorRate: callCount === 0 ? 0 : round3(errorCount / callCount),
    p50Ms: round3(percentile(durations, 0.5)),
    p95Ms: round3(percentile(durations, 0.95)),
  };
}
