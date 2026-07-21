/**
 * M118 (D4) — zod-at-the-boundary response schemas for the advanced WRITE routes that previously did a
 * bare `c.json(record)` with no server-side DTO. Each schema is lifted field-for-field from the M117 SDK
 * hand-types (the `// M117→M118` markers) so the wire shape is UNCHANGED — the M117 SDK contract tests
 * MUST stay green. `.parse()`-ing before `c.json` makes the OpenAPI (generated from these schemas) the
 * single source of truth, killing the silent hand-type drift class (the v14 `[object Object]` bug).
 *
 * Every conditionally-spread record field (passLabel/failLabel/threshold/labelValue/spanId/question/
 * costUsd) is `.optional()` (omitted from JSON when absent), never `.nullable()`. `.strict()` so an
 * extra field is caught at the boundary (a leaked persistence column → 500, not a silent leak).
 */
import { z } from "zod";

import { EVALUATOR_KINDS, MONITOR_OPERATORS, ruleConfigSchema, judgeConfigSchema } from "./evaluator.js";
import { experimentRunSchema } from "./experiment.js";

const NAME_RE = /^[a-z0-9_-]{1,64}$/;
const ISO = z.string();

/** The persisted-evaluator record (`EvaluatorRecord` = `Evaluator & { id, createdAt }`) — the create /
 *  get / list element shape the handler returns. Discriminated on `kind`; each variant carries the full
 *  record so `.strict()` rejects any extra field on either branch. */
export const evaluatorRecordSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.string(),
      createdAt: ISO,
      name: z.string().regex(NAME_RE),
      target: z.string(),
      enabled: z.boolean(),
      passLabel: z.string().optional(),
      failLabel: z.string().optional(),
      // M134 — auto-evaluation knobs. Optional on the response so a row written
      // before the migration (or a repo stub in a test) still parses.
      autoEnabled: z.boolean().optional(),
      sampling: z.number().min(0).max(1).optional(),
      filter: z.array(z.unknown()).optional(),
      kind: z.literal(EVALUATOR_KINDS[0]), // "rule"
      config: ruleConfigSchema,
    })
    .strict(),
  z
    .object({
      id: z.string(),
      createdAt: ISO,
      name: z.string().regex(NAME_RE),
      target: z.string(),
      enabled: z.boolean(),
      passLabel: z.string().optional(),
      failLabel: z.string().optional(),
      // M134 — auto-evaluation knobs. Optional on the response so a row written
      // before the migration (or a repo stub in a test) still parses.
      autoEnabled: z.boolean().optional(),
      sampling: z.number().min(0).max(1).optional(),
      filter: z.array(z.unknown()).optional(),
      kind: z.literal(EVALUATOR_KINDS[1]), // "llm_judge"
      config: judgeConfigSchema,
    })
    .strict(),
]);
export const evaluatorsListResponseSchema = z.object({ evaluators: z.array(evaluatorRecordSchema) }).strict();

/** The persisted-monitor record (`MonitorRecord` = `Monitor & { id, createdAt }`). */
export const monitorRecordSchema = z
  .object({
    id: z.string(),
    createdAt: ISO,
    evaluatorId: z.string(),
    operator: z.enum(MONITOR_OPERATORS),
    threshold: z.number().optional(),
    labelValue: z.string().optional(),
    enabled: z.boolean(),
  })
  .strict();
/**
 * M136 — the list envelope carries BOTH keys during the deprecation window.
 *
 * Renaming the key outright would break every consumer even on the /v1/guards alias, because the
 * alias mounts the same handler and would therefore return the new shape. An alias that preserves
 * the path but changes the payload is a silent break wearing a compatibility badge.
 *
 * `monitors` is canonical; `guards` is deprecated and removed in the release that removes the path
 * alias. Both always hold the same array — they are one list under two names, never two lists.
 */
export const monitorsListResponseSchema = z
  .object({ monitors: z.array(monitorRecordSchema), guards: z.array(monitorRecordSchema) })
  .strict();

/** `RunResult` — the evaluator-run outcome (the synchronous sweep + the async job's final tally). */
export const runResultResponseSchema = z
  .object({
    evaluator: z.string(),
    total: z.number(),
    written: z.number(),
    skipped: z.number(),
    truncated: z.boolean(),
    errors: z.array(z.object({ spanId: z.string(), reason: z.string() }).strict()),
  })
  .strict();

/**
 * `EvaluatorRunJobView` — an async evaluator-run job (M133). `POST /v1/evaluators/:id/run`
 * returns this (status `queued`) with HTTP 202; the client polls `GET /v1/evaluator-run-jobs/:id`
 * for `status` + `scored`/`total` progress until `completed`/`failed`.
 */
export const evaluatorRunJobResponseSchema = z
  .object({
    id: z.string(),
    evaluatorId: z.string(),
    evaluatorName: z.string(),
    status: z.enum(["queued", "running", "completed", "failed"]),
    total: z.number(),
    scored: z.number(),
    skipped: z.number(),
    errors: z.number(),
    // Per-span failures. `errors` above is only a count; without the detail the
    // async job is strictly less informative than the synchronous endpoint it
    // replaced, and the SDK cannot reconstruct a RunResult.
    errorDetails: z
      .array(z.object({ spanId: z.string(), reason: z.string() }))
      .default([]),
    truncated: z.boolean(),
    errorMessage: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

/** Experiment list + compare wrappers (the single-run create/get reuse `experimentRunSchema` directly). */
export const experimentRunsListResponseSchema = z.object({ runs: z.array(experimentRunSchema) }).strict();

/** `RunCompareDeltas` — avgScore/avgLatency deltas are genuinely nullable (metric absent on a side). */
export const runCompareDeltasSchema = z
  .object({
    passCountDelta: z.number(),
    passRateDelta: z.number(),
    avgScoreDelta: z.number().nullable(),
    totalCostDelta: z.number(),
    avgLatencyDelta: z.number().nullable(),
  })
  .strict();
export const experimentCompareResponseSchema = z
  .object({ runs: z.array(experimentRunSchema), deltas: runCompareDeltasSchema.nullable() })
  .strict();

/** `{ answer }` — the copilot ask response. */
export const askCopilotResponseSchema = z.object({ answer: z.string() }).strict();

/** `CopilotFeedbackRecord` — the ask-feedback record (spanId/question conditionally spread → optional). */
export const copilotFeedbackRecordSchema = z
  .object({
    id: z.string(),
    traceId: z.string(),
    turnId: z.string(),
    spanId: z.string().optional(),
    label: z.enum(["up", "down"]),
    question: z.string().optional(),
    updatedAt: ISO,
  })
  .strict();

/** The replay response (ephemeral provider result, `content` renamed → `output` at the boundary;
 *  `costUsd` omitted when the provider does not report it). */
export const replayResponseSchema = z
  .object({
    output: z.string(),
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number(),
    latencyMs: z.number(),
    model: z.string(),
    costUsd: z.number().optional(),
  })
  .strict();
