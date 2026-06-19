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
  startTimeUnixNano: z.string().regex(/^\d+$/),
  endTimeUnixNano: z.string().regex(/^\d+$/),
  statusCode: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

export type Span = z.infer<typeof spanSchema>;
