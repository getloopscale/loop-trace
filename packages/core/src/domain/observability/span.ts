import { z } from "zod";

/**
 * A single OTLP-derived span. Field names mirror the OTLP/JSON span shape
 * (resourceSpans[].scopeSpans[].spans[]). Unix-nano timestamps are kept as
 * numeric strings to avoid precision loss above 2^53 (M1 may revisit the type).
 */
export const spanSchema = z.object({
  spanId: z.string().min(1),
  traceId: z.string().min(1),
  parentSpanId: z.string().optional(),
  name: z.string(),
  kind: z.string().optional(),
  startTimeUnixNano: z.string().regex(/^\d+$/),
  endTimeUnixNano: z.string().regex(/^\d+$/),
  statusCode: z.string().optional(),
  statusMessage: z.string().optional(),
  // GenAI typed fields extracted from attributes (M1)
  model: z.string().optional(),
  provider: z.string().optional(),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  toolName: z.string().optional(),
  sessionId: z.string().optional(),
  // M12: span input/output text + events (all optional → backward-compatible).
  inputValue: z.string().optional(),
  outputValue: z.string().optional(),
  // M34: Claude Code perf/cost signals (all optional → backward-compatible).
  ttftMs: z.number().int().optional(),
  cacheReadTokens: z.number().int().optional(),
  cacheCreationTokens: z.number().int().optional(),
  // M53 / theo-lens#73: the trace-detail TREE root carries the trace's stored `traces.cost_usd`
  // here so the detail header matches the list (both read the same authoritative number), instead
  // of re-summing per-span costs that are absent for interaction/tool spans. Optional + only set on
  // the root by `getTraceTree`; a trace with no computed cost leaves it undefined (→ em-dash).
  costUsd: z.number().optional(),
  events: z
    .array(
      z.object({
        name: z.string(),
        timeUnixNano: z.string().optional(),
        attributes: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  // M26: online evaluations extracted from `eval.<name>.*` attributes at ingest
  // (optional → backward-compatible). The text is the evaluator's, not a human's.
  evaluations: z
    .array(
      z.object({
        name: z.string().min(1),
        score: z.number().optional(),
        label: z.string().optional(),
        explanation: z.string().optional(),
      }),
    )
    .optional(),
});

export type Span = z.infer<typeof spanSchema>;
