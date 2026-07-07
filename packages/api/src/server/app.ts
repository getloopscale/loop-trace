import { Hono } from "hono";
import {
  type SpanRepository,
  type AuthVerifier,
  traceListResponseSchema,
  listTracesOptionsSchema,
  traceCostSchema,
  costByPeriodResponseSchema,
  toolStatsResponseSchema,
  northStarResponseSchema,
  observabilityRangeSchema,
  observabilityResponseSchema,
  evaluatorsResponseSchema,
  sessionListResponseSchema,
  sessionDetailResponseSchema,
  traceTagsResponseSchema,
  normalizeTag,
  annotationsResponseSchema,
  normalizeAnnotation,
  DEFAULT_ANNOTATION_NAME,
  DEFAULT_ANNOTATOR_KIND,
  agentCatalogResponseSchema,
} from "@usetheo/lens-core";

import {
  bearerAuth,
  getPrincipal,
  requireScopeOnPrincipal,
} from "./auth/middleware.js";
import { requireScope } from "./auth/scope-verifier.js";
import type { AuthPool } from "./auth/api-key-verifier.js";
import {
  createKeyHandler,
  listKeysHandler,
  revokeKeyHandler,
} from "./handlers/admin-keys.js";
import type { EvaluatorApiDeps } from "./handlers/evaluators.js";
import type { CopilotApiDeps } from "./handlers/copilot.js";
import type { ReplayApiDeps } from "./handlers/replay.js";
import { registerExtraRoutes } from "./routes/register-extra-routes.js";
import { registerDatasetRoutes } from "./routes/dataset-routes.js";
import { registerLabelingQueueRoutes } from "./routes/labeling-queue-routes.js";
import { parseResourceSpans } from "../otlp/parse-resource-spans.js";
import { OtlpParseError } from "../otlp/otlp-error.js";
import { decodeOtlpBody } from "../otlp/decode-protobuf.js";
import {
  spansIngested,
  tracesIngested,
  evaluationsExtracted,
  annotationsWritten,
  logIngest,
} from "./metrics.js";
import { mountStatic } from "./static.js";
import { tracesToCsv } from "./csv.js";

/**
 * Build the Hono app. Depends only on the {@link SpanRepository} port (DIP) — the
 * concrete Drizzle adapter is injected by the composition root.
 *
 *  - POST /v1/traces        : OTLP ingest, JSON + protobuf (+ gzip); 415 on other
 *  - GET  /v1/traces         : list executions newest-first (stable list DTO, M3)
 *  - GET  /v1/spans/:id      : read one span back (404 when absent)
 *  - GET  /v1/traces/:id     : reconstructed trace tree (404 when absent)
 *  - GET  /v1/traces/:id/cost: per-trace cost summary (404 when absent, M5)
 *  - GET  /v1/analytics/cost : day/week cost aggregation (?period=day|week, M5)
 *  - GET  /v1/analytics/tools: per-tool stats ranking (M6)
 *  - GET  /v1/analytics/tools/:name/traces : executions that called a tool (M6 drill-down)
 *  - POST /v1/replay-sessions: record a replay-open event (M8 north-star)
 *  - GET  /v1/metrics/north-star: traces/day + replay-sessions/week (M8)
 *  - GET  /v1/metrics/observability: time-series traffic/error-rate, latency percentiles, tokens/cost by model (M11)
 *  - GET  /v1/sessions          : sessions list newest-first + scoped aggregates (M13)
 *  - GET  /v1/sessions/:id       : session detail (scoped aggregates + member traces; 404 when absent) (M13)
 *  - GET/POST/DELETE /v1/traces/:id/tags : list / add (404 absent) / remove (idempotent) tags; GET /v1/traces?tag= filters (M14)
 *
 * When `webDistDir` (CWD-relative) is provided AND exists, the built web bundle
 * is served same-origin at `/` with an SPA fallback, mounted AFTER all /v1/*
 * routes so the API is never shadowed (M7, D1). Omitting it keeps API-only
 * behavior (backward compatible).
 */
/** M22: auth wiring injected by the composition root (verifier + fail-closed mode). */
export interface AuthOptions {
  readonly verifier?: AuthVerifier;
  readonly requireCredential?: boolean;
  /** The pg pool for the admin key-lifecycle routes (`/v1/admin/keys`). */
  readonly pool?: AuthPool;
  /** Env-sourced bootstrap admin token (mints the first admin key). */
  readonly bootstrapToken?: string;
}

export function createApp(
  repo: SpanRepository,
  webDistDir?: string,
  auth: AuthOptions = {},
  evaluators?: EvaluatorApiDeps,
  copilot?: CopilotApiDeps,
  replay?: ReplayApiDeps,
): Hono {
  const app = new Hono();

  // Fail-loud, fail-clear (Rule 8): any unhandled error (e.g. Postgres
  // unavailable during repo.save) is logged with context and surfaced as 500.
  app.onError((err, c) => {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "request_failed",
        method: c.req.method,
        path: c.req.path,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return c.json({ error: "internal error" }, 500);
  });

  // M22 admin surface (the Model B broker mints per-tenant keys here). Gated by
  // `requireScope('observability:admin')` — a `observability:platform-admin` key satisfies it via the
  // scope hierarchy; an env bootstrap token bypasses (mints the first admin key).
  // Mounted BEFORE the data-plane bearer so the admin path uses its own gate.
  if (auth.pool !== undefined) {
    const pool = auth.pool;
    const adminGate = auth.bootstrapToken !== undefined
      ? { pool, requiredScope: "observability:admin", bootstrapToken: auth.bootstrapToken }
      : { pool, requiredScope: "observability:admin" };
    app.use("/v1/admin/*", requireScope(adminGate));
    app.post("/v1/admin/keys", (c) => createKeyHandler(c, pool, auth.bootstrapToken));
    app.get("/v1/admin/keys", (c) => listKeysHandler(c, pool, auth.bootstrapToken));
    app.delete("/v1/admin/keys/:id", (c) => revokeKeyHandler(c, pool, auth.bootstrapToken));
  }

  // M22: resolve a Principal for every /v1/* DATA request and set it on context. With
  // no verifier (single-tenant dev) this collapses to the `default` workspace; in
  // multi-tenant mode a missing/bad credential fails closed. The `/v1/admin/*` routes
  // have their own `requireScope` gate above, so the data bearer skips them.
  const dataBearer = bearerAuth(auth.verifier, {
    requireCredential: auth.requireCredential === true,
  });
  app.use("/v1/*", async (c, next) => {
    // Segment-boundary match (not a bare prefix) so a future `/v1/administrators`
    // style DATA route is NOT inadvertently skipped past the data bearer.
    const p = c.req.path;
    if (p === "/v1/admin" || p.startsWith("/v1/admin/")) return next();
    return dataBearer(c, next);
  });

  app.post("/v1/traces", requireScopeOnPrincipal("observability:write"), async (c) => {
    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    if (
      !contentType.includes("application/json") &&
      !contentType.includes("application/x-protobuf")
    ) {
      return c.json(
        { error: "unsupported content-type (use application/json or application/x-protobuf)" },
        415,
      );
    }

    const raw = Buffer.from(await c.req.arrayBuffer());

    let envelope: unknown;
    try {
      envelope = decodeOtlpBody(raw, contentType, c.req.header("content-encoding"));
    } catch (err) {
      if (err instanceof OtlpParseError) return c.json({ error: err.message }, 400);
      throw err;
    }

    let toSave;
    try {
      toSave = parseResourceSpans(envelope);
    } catch (err) {
      if (err instanceof OtlpParseError) return c.json({ error: err.message }, 400);
      throw err;
    }

    if (toSave.length === 0) {
      return c.json({}, 200);
    }

    await repo.save(toSave, getPrincipal(c).workspaceId);
    spansIngested.add(toSave.length);
    tracesIngested.add(new Set(toSave.map((s) => s.traceId)).size);
    const evals = toSave.reduce((n, s) => n + (s.evaluations?.length ?? 0), 0);
    evaluationsExtracted.add(evals);
    logIngest(toSave.length, evals);
    return c.json({ partialSuccess: {} }, 200);
  });

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
      return c.json({ error: "invalid query parameters" }, 400);
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
        "content-disposition": 'attachment; filename="theo-lens-traces.csv"',
      });
    }
    return c.json(list, 200);
  });

  app.get("/v1/spans/:spanId", requireScopeOnPrincipal("observability:read"), async (c) => {
    const span = await repo.getBySpanId(
      c.req.param("spanId"),
      getPrincipal(c).workspaceId,
    );
    return span ? c.json(span, 200) : c.json({ error: "not found" }, 404);
  });

  app.get("/v1/traces/:traceId/cost", requireScopeOnPrincipal("observability:read"), async (c) => {
    const cost = await repo.getTraceCost(
      c.req.param("traceId"),
      getPrincipal(c).workspaceId,
    );
    return cost
      ? c.json(traceCostSchema.parse(cost), 200)
      : c.json({ error: "not found" }, 404);
  });

  app.get("/v1/traces/:traceId", requireScopeOnPrincipal("observability:read"), async (c) => {
    const tree = await repo.getTraceTree(
      c.req.param("traceId"),
      getPrincipal(c).workspaceId,
    );
    return tree ? c.json(tree, 200) : c.json({ error: "not found" }, 404);
  });

  app.get("/v1/agents", requireScopeOnPrincipal("observability:read"), async (c) => {
    // M32: the agents catalog (derived from `agent.*` span attributes), with health.
    const agents = await repo.aggregateAgents(getPrincipal(c).workspaceId);
    return c.json(agentCatalogResponseSchema.parse({ agents }), 200);
  });

  app.get("/v1/analytics/tools", requireScopeOnPrincipal("observability:read"), async (c) => {
    const stats = await repo.aggregateToolStats(getPrincipal(c).workspaceId);
    return c.json(toolStatsResponseSchema.parse(stats), 200);
  });

  app.get("/v1/analytics/tools/:toolName/traces", requireScopeOnPrincipal("observability:read"), async (c) => {
    const list = await repo.listTracesForTool(
      c.req.param("toolName"),
      undefined,
      getPrincipal(c).workspaceId,
    );
    return c.json(traceListResponseSchema.parse(list), 200);
  });

  app.get("/v1/analytics/cost", requireScopeOnPrincipal("observability:read"), async (c) => {
    // Whitelist the period (fail-fast on anything but day/week, Rule 8); default day.
    const raw = c.req.query("period");
    if (raw !== undefined && raw !== "day" && raw !== "week") {
      return c.json({ error: "invalid period (use day or week)" }, 400);
    }
    const result = await repo.aggregateCostByPeriod(
      raw === "week" ? "week" : "day",
      getPrincipal(c).workspaceId,
    );
    return c.json(costByPeriodResponseSchema.parse(result), 200);
  });

  app.post("/v1/replay-sessions", requireScopeOnPrincipal("observability:write"), async (c) => {
    // Record a replay-open event (M8 north-star). Fail-fast 400 on a missing
    // traceId (Rule 8); the UI calls this fire-and-forget so a 5xx never
    // degrades the replay UX (D3).
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const traceId = (body as { traceId?: unknown })?.traceId;
    if (typeof traceId !== "string" || traceId.length === 0) {
      return c.json({ error: "traceId is required" }, 400);
    }
    await repo.recordReplaySession(traceId, getPrincipal(c).workspaceId);
    return c.json({ recorded: true }, 200);
  });

  app.get("/v1/metrics/north-star", requireScopeOnPrincipal("observability:read"), async (c) => {
    const ns = await repo.aggregateNorthStar(getPrincipal(c).workspaceId);
    return c.json(northStarResponseSchema.parse(ns), 200);
  });

  app.get("/v1/metrics/observability", requireScopeOnPrincipal("observability:read"), async (c) => {
    // Validate the range at the boundary (fail-fast 400, Rule 8); default 24h.
    const raw = c.req.query("range");
    const parsed = observabilityRangeSchema.safeParse(raw ?? "24h");
    if (!parsed.success) {
      return c.json({ error: "invalid range (use 1h|24h|7d|30d)" }, 400);
    }
    const obs = await repo.aggregateObservability(
      parsed.data,
      getPrincipal(c).workspaceId,
    );
    return c.json(observabilityResponseSchema.parse(obs), 200);
  });

  app.get("/v1/metrics/evaluators", requireScopeOnPrincipal("observability:read"), async (c) => {
    // M26: per-evaluator aggregate (Online Evaluators cards). Range validated at the
    // boundary (Rule 8), same whitelist as observability; default 24h.
    const parsed = observabilityRangeSchema.safeParse(c.req.query("range") ?? "24h");
    if (!parsed.success) {
      return c.json({ error: "invalid range (use 1h|24h|7d|30d)" }, 400);
    }
    // Parse through the strict DTO at the boundary so the no-column-leak invariant
    // is enforced at runtime, uniform with every other read route (F-api-1).
    const summary = evaluatorsResponseSchema.parse({
      evaluators: await repo.aggregateEvaluators(
        parsed.data,
        getPrincipal(c).workspaceId,
      ),
    });
    return c.json(summary, 200);
  });

  app.get("/v1/sessions", requireScopeOnPrincipal("observability:read"), async (c) => {
    const list = await repo.listSessions(getPrincipal(c).workspaceId);
    return c.json(sessionListResponseSchema.parse(list), 200);
  });

  app.get("/v1/sessions/:sessionId", requireScopeOnPrincipal("observability:read"), async (c) => {
    const detail = await repo.getSessionDetail(
      c.req.param("sessionId"),
      getPrincipal(c).workspaceId,
    );
    return detail
      ? c.json(sessionDetailResponseSchema.parse(detail), 200)
      : c.json({ error: "not found" }, 404);
  });

  app.get("/v1/traces/:traceId/tags", requireScopeOnPrincipal("observability:read"), async (c) => {
    const tags = await repo.listTags(
      c.req.param("traceId"),
      getPrincipal(c).workspaceId,
    );
    return c.json(traceTagsResponseSchema.parse({ tags }), 200);
  });

  app.post("/v1/traces/:traceId/tags", requireScopeOnPrincipal("observability:write"), async (c) => {
    // Add a tag (M14). 400 on an invalid tag (Rule 8), 404 when the trace is
    // absent (D2 — you cannot tag what is not there); idempotent otherwise.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const tag = normalizeTag((body as { tag?: unknown })?.tag);
    if (tag === null) {
      return c.json({ error: "tag is required (1-64 chars after trim)" }, 400);
    }
    const traceId = c.req.param("traceId");
    const ws = getPrincipal(c).workspaceId;
    const ok = await repo.addTag(traceId, tag, ws);
    if (!ok) return c.json({ error: "not found" }, 404);
    const tags = await repo.listTags(traceId, ws);
    return c.json(traceTagsResponseSchema.parse({ tags }), 200);
  });

  app.delete("/v1/traces/:traceId/tags", requireScopeOnPrincipal("observability:delete"), async (c) => {
    // Remove a tag (M14). The tag travels in a QUERY param (NOT a path segment)
    // so a slash-bearing free-form tag routes safely (EC-1). Idempotent (D2).
    const tag = normalizeTag(c.req.query("tag"));
    if (tag === null) {
      return c.json({ error: "tag query param is required (1-64 chars)" }, 400);
    }
    const traceId = c.req.param("traceId");
    const ws = getPrincipal(c).workspaceId;
    await repo.removeTag(traceId, tag, ws);
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

  app.post("/v1/traces/:traceId/annotations", requireScopeOnPrincipal("observability:write"), async (c) => {
    // M26b: upsert a human annotation (👍/👎 + note) on a trace or span. 400 on an
    // empty annotation (no label AND no note, Rule 8), 404 when the trace is absent
    // (D2); idempotent upsert otherwise (latest wins). Returns the trace's annotations.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const ann = normalizeAnnotation(body);
    if (ann === null) {
      return c.json(
        { error: "annotation requires a label or a note" },
        400,
      );
    }
    const traceId = c.req.param("traceId");
    const ws = getPrincipal(c).workspaceId;
    const ok = await repo.upsertAnnotation(traceId, ann, ws);
    if (!ok) return c.json({ error: "not found" }, 404);
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
    const annotations = await repo.listAnnotations(traceId, ws);
    return c.json(annotationsResponseSchema.parse({ annotations }), 200);
  });

  // M26d dataset routes + M36 evaluators + M33 copilot routes (extracted to keep
  // app.ts ≤ 500 — M33 D5).
  registerDatasetRoutes(app, repo);
  registerLabelingQueueRoutes(app, repo);
  registerExtraRoutes(app, { evaluators, copilot, replay });

  // Mount static UI serving LAST so the catch-all never shadows /v1/* (M7, D1).
  if (webDistDir !== undefined) {
    mountStatic(app, webDistDir);
  }

  return app;
}
