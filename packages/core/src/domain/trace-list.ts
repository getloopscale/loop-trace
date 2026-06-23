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
    // M18 — enriched columns for the Arize-style dense table. costUsd +
    // endTimeUnixNano come from existing `traces` columns; model + the root span's
    // gen_ai operation/tool signals are derived from the trace's ROOT span (no
    // migration). The semantic span-kind (llm/tool/retriever/…) is derived CLIENT-SIDE
    // from {model, operationName, toolName} via the shared web taxonomy — we expose
    // the raw signals, NOT a pre-derived kind, to keep one source of truth (DRY).
    // All optional + omitted when absent so the `.strict()` contract stays additive.
    model: z.string().optional(),
    costUsd: z.number().optional(),
    rootOperationName: z.string().optional(),
    rootToolName: z.string().optional(),
    endTimeUnixNano: z.string().regex(/^\d+$/).optional(),
    inputPreview: z.string().optional(),
    outputPreview: z.string().optional(),
  })
  .strict();

export const traceListResponseSchema = z
  .object({ traces: z.array(traceListItemSchema) })
  .strict();

export type TraceListItem = z.infer<typeof traceListItemSchema>;
export type TraceListResponse = z.infer<typeof traceListResponseSchema>;

/** Hard cap on how many rows a single list/export request may return (bounds export — M9 D3). */
export const LIST_TRACES_LIMIT_CAP = 500;

/**
 * Whitelisted filter/sort options for the executions list (M9 ADR D1). Fixed
 * enums validated at the route boundary — NOT a query DSL (we deliberately defer
 * a DSL; both Phoenix and Braintrust have one). `limit` is coerced (query params
 * arrive as strings) and capped to bound the export. All optional → no opts means
 * the legacy "newest 50 by updated_at" behavior.
 */
export const listTracesOptionsSchema = z
  .object({
    status: z.enum(["ok", "error"]).optional(),
    model: z.string().min(1).optional(),
    // zod 3.25 ISO-datetime validator (NOT z.iso.datetime — EC-6).
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    orderBy: z.enum(["recent", "latency", "tokens", "cost"]).optional(),
    dir: z.enum(["asc", "desc"]).optional(),
    limit: z.coerce.number().int().min(1).max(LIST_TRACES_LIMIT_CAP).optional(),
    format: z.enum(["json", "csv"]).optional(),
    // M14: filter the list to executions carrying this tag (free-form string).
    tag: z.string().min(1).optional(),
  })
  .strict();

export type ListTracesOptions = z.infer<typeof listTracesOptionsSchema>;
