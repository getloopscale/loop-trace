/**
 * M121 (D1) — traces / spans / cost / tree + tags + annotations routes, extracted verbatim out of
 * `app.ts` to complete the Front-Controller extraction (drop `app.ts` under the 500-LoC budget). This
 * is a behavior-preserving move: every route keeps its exact path, middleware chain (bodyLimit413 →
 * per-verb scope guard → async handler), status codes, and response shape — only the file changes.
 * Mirrors `dataset-routes.ts`: per-verb scope + workspace-from-Principal (M22); the repo port is
 * injected by `createApp`.
 */
import type { Hono } from "hono";

import {
  type TraceReadRepository,
  type AnnotationRepository,
  traceListResponseSchema,
  listTracesOptionsSchema,
  traceCostSchema,
  traceTagsResponseSchema,
  normalizeTag,
  annotationsResponseSchema,
  normalizeAnnotation,
  DEFAULT_ANNOTATION_NAME,
  DEFAULT_ANNOTATOR_KIND,
  apiError,
  zodFieldErrors,
} from "@looptrace/core";

import { getPrincipal, requireScopeOnPrincipal } from "../auth/middleware.js";
import { bodyLimit413, DEFAULT_ADVANCED_MAX_BYTES } from "../body-caps.js"; // M118 (D1)
import { tagsAdded, tagsRemoved, annotationsWritten, annotationsRemoved } from "../metrics.js";
import { tracesToCsv } from "../csv.js";

// M130 (ISP) — narrowed from the composite `SpanRepository` to the exact roles used:
// trace-read (list/getBySpanId/cost/tree) + annotations (tags + human annotations).
export function registerTracesRoutes(app: Hono, repo: TraceReadRepository & AnnotationRepository): void {
  app.get("/v1/traces", requireScopeOnPrincipal("observability:read"), async (c) => {
    // M9: whitelisted filter/sort/export. Validate query params at the boundary
    // (fail-fast 400, Rule 8) — a fixed enum whitelist, NOT a DSL (D1).
    const parsed = listTracesOptionsSchema.safeParse({
      status: c.req.query("status"),
      model: c.req.query("model"),
      from: c.req.query("from"),
      to: c.req.query("to"),
      orderBy: c.req.query("order_by"),
      dir: c.req.query("dir"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset"), // M56 — export pagination
      format: c.req.query("format"),
      tag: c.req.query("tag"),
      // M24: full-text search. Empty `?q=` → undefined (a cleared box is "no
      // filter", not a 400 on min(1)). Flows to BOTH the JSON list AND the CSV
      // export below (same filtered query, EC-1).
      q: c.req.query("q") || undefined,
      // M30: span-query DSL. Empty `?span_query=` → undefined (a cleared bar is "no
      // filter", not a 400). Parsed server-side by `parseSpanQuery` in the repo; flows
      // to BOTH the JSON list AND the CSV export (same filtered query).
      spanQuery: c.req.query("span_query") || undefined,
      // M52: advanced filters — cost/token ranges + session (snake_case query keys →
      // camelCase schema keys, mirroring order_by → orderBy). A bad numeric → z.coerce
      // NaN → the strict schema fails → the 400 below (fail-fast at the boundary). An
      // EMPTY value (`?min_cost_usd=`) → undefined → "no filter" (not `z.coerce("")===0`,
      // which would add a spurious `>= 0` bound that drops NULL-cost traces).
      minCostUsd: c.req.query("min_cost_usd") || undefined,
      maxCostUsd: c.req.query("max_cost_usd") || undefined,
      minTokens: c.req.query("min_tokens") || undefined,
      maxTokens: c.req.query("max_tokens") || undefined,
      sessionId: c.req.query("session_id") || undefined,
    });
    if (!parsed.success) {
      return c.json(apiError("INVALID_QUERY", "invalid query parameters", zodFieldErrors(parsed.error)), 400);
    }
    // Parse through the strict DTO at the boundary so the no-column-leak invariant
    // (risk #2) is enforced at runtime, not just by adapter discipline (F-arch-1).
    const list = traceListResponseSchema.parse(
      await repo.listTraces(parsed.data, getPrincipal(c).workspaceId),
    );
    if (parsed.data.format === "csv") {
      // Export reuses the SAME filtered query (D3) → the CSV always honors the
      // current filter; bounded by the validated limit (never a full-table dump).
      return c.body(tracesToCsv(list.traces), 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="looptrace-traces.csv"',
      });
    }
    return c.json(list, 200);
  });

  app.get("/v1/spans/:spanId", requireScopeOnPrincipal("observability:read"), async (c) => {
    const span = await repo.getBySpanId(
      c.req.param("spanId"),
      getPrincipal(c).workspaceId,
    );
    return span ? c.json(span, 200) : c.json(apiError("NOT_FOUND", "not found"), 404);
  });

  app.get("/v1/traces/:traceId/cost", requireScopeOnPrincipal("observability:read"), async (c) => {
    const cost = await repo.getTraceCost(
      c.req.param("traceId"),
      getPrincipal(c).workspaceId,
    );
    return cost
      ? c.json(traceCostSchema.parse(cost), 200)
      : c.json(apiError("NOT_FOUND", "not found"), 404);
  });

  app.get("/v1/traces/:traceId", requireScopeOnPrincipal("observability:read"), async (c) => {
    const tree = await repo.getTraceTree(
      c.req.param("traceId"),
      getPrincipal(c).workspaceId,
    );
    return tree ? c.json(tree, 200) : c.json(apiError("NOT_FOUND", "not found"), 404);
  });

  app.get("/v1/traces/:traceId/tags", requireScopeOnPrincipal("observability:read"), async (c) => {
    const tags = await repo.listTags(
      c.req.param("traceId"),
      getPrincipal(c).workspaceId,
    );
    return c.json(traceTagsResponseSchema.parse({ tags }), 200);
  });

  app.post("/v1/traces/:traceId/tags", bodyLimit413(DEFAULT_ADVANCED_MAX_BYTES), requireScopeOnPrincipal("observability:write"), async (c) => {
    // Add a tag (M14). 400 on an invalid tag (Rule 8), 404 when the trace is
    // absent (D2 — you cannot tag what is not there); idempotent otherwise.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(apiError("INVALID_BODY", "invalid json body"), 400);
    }
    const tag = normalizeTag((body as { tag?: unknown })?.tag);
    if (tag === null) {
      return c.json(apiError("INVALID_BODY", "tag is required (1-64 chars after trim)"), 400);
    }
    const traceId = c.req.param("traceId");
    const ws = getPrincipal(c).workspaceId;
    const ok = await repo.addTag(traceId, tag, ws);
    if (!ok) return c.json(apiError("NOT_FOUND", "not found"), 404);
    tagsAdded.add(1); // observable: tag-add volume (pillar c)
    const tags = await repo.listTags(traceId, ws);
    return c.json(traceTagsResponseSchema.parse({ tags }), 200);
  });

  app.delete("/v1/traces/:traceId/tags", requireScopeOnPrincipal("observability:delete"), async (c) => {
    // Remove a tag (M14). The tag travels in a QUERY param (NOT a path segment)
    // so a slash-bearing free-form tag routes safely (EC-1). Idempotent (D2).
    const tag = normalizeTag(c.req.query("tag"));
    if (tag === null) {
      return c.json(apiError("INVALID_QUERY", "tag query param is required (1-64 chars)"), 400);
    }
    const traceId = c.req.param("traceId");
    const ws = getPrincipal(c).workspaceId;
    await repo.removeTag(traceId, tag, ws);
    tagsRemoved.add(1); // observable: tag-remove volume (pillar c)
    const tags = await repo.listTags(traceId, ws);
    return c.json(traceTagsResponseSchema.parse({ tags }), 200);
  });

  app.get("/v1/traces/:traceId/annotations", requireScopeOnPrincipal("observability:read"), async (c) => {
    // M26b: a trace's annotations (trace-level + all spans'), newest-first.
    const annotations = await repo.listAnnotations(
      c.req.param("traceId"),
      getPrincipal(c).workspaceId,
    );
    return c.json(annotationsResponseSchema.parse({ annotations }), 200);
  });

  app.post("/v1/traces/:traceId/annotations", bodyLimit413(DEFAULT_ADVANCED_MAX_BYTES), requireScopeOnPrincipal("observability:write"), async (c) => {
    // M26b: upsert a human annotation (👍/👎 + note) on a trace or span. 400 on an
    // empty annotation (no label AND no note, Rule 8), 404 when the trace is absent
    // (D2); idempotent upsert otherwise (latest wins). Returns the trace's annotations.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(apiError("INVALID_BODY", "invalid json body"), 400);
    }
    const ann = normalizeAnnotation(body);
    if (ann === null) {
      return c.json(
        apiError("INVALID_BODY", "annotation requires a label or a note"),
        400,
      );
    }
    const traceId = c.req.param("traceId");
    const ws = getPrincipal(c).workspaceId;
    const ok = await repo.upsertAnnotation(traceId, ann, ws);
    if (!ok) return c.json(apiError("NOT_FOUND", "not found"), 404);
    annotationsWritten.add(1);
    const annotations = await repo.listAnnotations(traceId, ws);
    return c.json(annotationsResponseSchema.parse({ annotations }), 200);
  });

  app.delete("/v1/traces/:traceId/annotations", requireScopeOnPrincipal("observability:delete"), async (c) => {
    // M26b: clear an annotation by its target+channel key. `spanId`/`name`/`kind`
    // travel in QUERY params (slash-safe, like the tag DELETE). Idempotent.
    const name = c.req.query("name") ?? DEFAULT_ANNOTATION_NAME;
    const traceId = c.req.param("traceId");
    const spanId = c.req.query("spanId");
    const annotatorKind = c.req.query("annotatorKind") ?? DEFAULT_ANNOTATOR_KIND;
    const ws = getPrincipal(c).workspaceId;
    await repo.removeAnnotation(
      traceId,
      {
        ...(spanId != null && spanId.length > 0 ? { spanId } : {}),
        name,
        annotatorKind,
      },
      ws,
    );
    annotationsRemoved.add(1); // observable: annotation-remove volume (pillar c)
    const annotations = await repo.listAnnotations(traceId, ws);
    return c.json(annotationsResponseSchema.parse({ annotations }), 200);
  });
}
