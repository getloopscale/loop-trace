import { z } from "zod";

/**
 * M64 — Experiments. A regression dataset (M44) is run against a **variant** (a model/prompt override)
 * through the M33 provider path; each row records the replayed output + usage + cost + **evaluator
 * scores** (reused M36 `Verdict`), and two+ runs are compared side-by-side. This module is the PURE
 * domain leaf (no DB, no I/O, no provider): the run/item schemas + the aggregate + the run-to-run
 * compare (deltas). The run orchestration lives in `experiment-engine.ts` (DIP-injected deps).
 */

/** A per-row evaluator score — the M36 `Verdict` plus the evaluator name that produced it. */
export const runScoreSchema = z
  .object({
    name: z.string(),
    score: z.number().optional(),
    label: z.string().optional(),
    explanation: z.string().optional(),
  })
  .strict();
export type RunScore = z.infer<typeof runScoreSchema>;

/** The run config: an optional model override + optional system-prompt override applied per item. */
export const runVariantSchema = z
  .object({
    model: z.string().optional(),
    promptOverride: z.string().optional(),
  })
  .strict();
export type RunVariant = z.infer<typeof runVariantSchema>;

export const RUN_STATUSES = ["completed", "partial", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** One run row: the replayed output + usage/cost + the evaluator scores (or an error state — no output). */
export const experimentRunItemSchema = z
  .object({
    datasetItemTraceId: z.string(),
    inputSnapshot: z.string().optional(),
    output: z.string().optional(),
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number(),
    costUsd: z.number().optional(),
    latencyMs: z.number(),
    model: z.string(),
    scores: z.array(runScoreSchema),
    error: z.string().optional(),
  })
  .strict();
export type ExperimentRunItem = z.infer<typeof experimentRunItemSchema>;

/** One experiment run: dataset × variant, its rows, aggregates, and lifecycle. */
export const experimentRunSchema = z
  .object({
    id: z.string(),
    datasetId: z.string(),
    name: z.string(),
    variant: runVariantSchema,
    status: z.enum(RUN_STATUSES),
    truncated: z.boolean(),
    itemCount: z.number(),
    passCount: z.number(),
    avgScore: z.number().optional(),
    totalCostUsd: z.number(),
    createdBy: z.string(),
    createdAt: z.string(),
    items: z.array(experimentRunItemSchema).optional(),
  })
  .strict();
export type ExperimentRun = z.infer<typeof experimentRunSchema>;

/** A run's computed aggregate (over its items). */
export interface RunAggregate {
  itemCount: number;
  passCount: number;
  avgScore: number | undefined;
  totalCostUsd: number;
  avgLatencyMs: number | undefined;
}

/** Threshold at/above which a row's mean score counts as "passing". */
const PASS_THRESHOLD = 0.5;

/** Mean of a row's numeric scores, or undefined when the row has no numeric score. */
function rowMeanScore(item: ExperimentRunItem): number | undefined {
  const nums = item.scores.map((s) => s.score).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return undefined;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Aggregate a run's items (M64 D1). PURE + TOTAL — never NaN/Infinity. A row "passes" when its mean
 * numeric score ≥ 0.5; `avgScore`/`avgLatencyMs` are means over the rows that HAVE that value (undefined
 * when none); `totalCostUsd` sums present costs (absent cost contributes 0).
 */
export function aggregateRun(items: ExperimentRunItem[]): RunAggregate {
  const rowMeans = items.map(rowMeanScore).filter((v): v is number => v !== undefined);
  const latencies = items.map((i) => i.latencyMs).filter((v) => Number.isFinite(v));
  const totalCostUsd = items.reduce((sum, i) => sum + (typeof i.costUsd === "number" && Number.isFinite(i.costUsd) ? i.costUsd : 0), 0);
  return {
    itemCount: items.length,
    passCount: rowMeans.filter((m) => m >= PASS_THRESHOLD).length,
    avgScore: rowMeans.length ? rowMeans.reduce((a, b) => a + b, 0) / rowMeans.length : undefined,
    totalCostUsd,
    avgLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : undefined,
  };
}

/** The signed run-to-run deltas (A minus B); a metric absent on either side yields a `null` delta. */
export interface RunCompareDeltas {
  passCountDelta: number;
  /** Pass-*rate* delta (passCount/itemCount, A minus B) — the DoD3 aggregate delta; 0-item runs contribute 0. */
  passRateDelta: number;
  avgScoreDelta: number | null;
  totalCostDelta: number;
  avgLatencyDelta: number | null;
}

/** A minus B, per metric; when a metric is undefined on either side its delta is `null` (never fabricated). */
function signedDelta(a: number | undefined, b: number | undefined): number | null {
  return typeof a === "number" && typeof b === "number" ? a - b : null;
}

/** A run's pass-rate (passing rows / rows), or 0 when the run has no items — never NaN. */
function passRate(a: RunAggregate): number {
  return a.itemCount > 0 ? a.passCount / a.itemCount : 0;
}

/** Compare two run aggregates (M64 D5). PURE. Counts + rate + cost are always present; score/latency may be null. */
export function compareRuns(a: RunAggregate, b: RunAggregate): RunCompareDeltas {
  return {
    passCountDelta: a.passCount - b.passCount,
    passRateDelta: passRate(a) - passRate(b),
    avgScoreDelta: signedDelta(a.avgScore, b.avgScore),
    totalCostDelta: a.totalCostUsd - b.totalCostUsd,
    avgLatencyDelta: signedDelta(a.avgLatencyMs, b.avgLatencyMs),
  };
}
