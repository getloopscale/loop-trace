import { z } from "zod";

/**
 * Stable list DTO the Trace Explorer UI consumes (M3 ADR D2). Hand-authored and
 * `.strict()` so Drizzle row columns can NEVER leak into the API contract — the
 * UI depends on this shape, not on the persistence schema (ROADMAP M3 risk #2).
 */
export const traceListItemSchema = z
  .object({
    traceId: z.string().min(1),
    sessionId: z.string().optional(),
    name: z.string().optional(),
    startTimeUnixNano: z.string().regex(/^\d+$/).optional(),
    durationMs: z.number().nonnegative().optional(),
    statusCode: z.string().optional(),
    totalTokens: z.number().int().optional(),
  })
  .strict();

export const traceListResponseSchema = z
  .object({ traces: z.array(traceListItemSchema) })
  .strict();

export type TraceListItem = z.infer<typeof traceListItemSchema>;
export type TraceListResponse = z.infer<typeof traceListResponseSchema>;
