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
});

export type Span = z.infer<typeof spanSchema>;
