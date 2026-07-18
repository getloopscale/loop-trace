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
  scoresResponseSchema,
  spanFacetsResponseSchema,
  isValidAttrKey,
  sessionListResponseSchema,
  sessionDetailResponseSchema,
  traceTagsResponseSchema,
  normalizeTag,
  annotationsResponseSchema,
  normalizeAnnotation,
  DEFAULT_ANNOTATION_NAME,
  DEFAULT_ANNOTATOR_KIND,
  agentCatalogResponseSchema,
  apiError,
  zodFieldErrors,
  sdkMessagesToOtlp,
  type SDKMessage,
  type TheokitRunResult,
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
import { registerExperimentRoutes } from "./routes/experiment-routes.js";
import type { ExperimentApiDeps } from "./handlers/experiment.js";
import type { RateLimiter } from "@usetheo/lens-core";

/**
 * M93 — OTLP ingest hardening deps (all optional; a test app without them keeps the pre-M93 behavior
 * minus the size caps, which default). `limiter` sheds a runaway per-workspace producer with 429;
 * the byte caps bound the raw body (413 via bodyLimit) + the decompressed body (413, gzip-bomb).
 */
export interface IngestApiDeps {
  limiter?: RateLimiter;
  maxBodyBytes?: number;
  maxDecompressedBytes?: number;
  /** Injected clock for the limiter window (defaults to Date.now) — deterministic tests. */
  now?: () => number;
}

/** M94 — liveness/readiness probe deps. `pingDb` runs a bounded `SELECT 1`; it throwing → /ready 503. */
export interface HealthApiDeps {
  version?: string;
  pingDb?: () => Promise<void>;
}
import { bodyLimit } from "hono/body-limit";
import { bodyLimit413, DEFAULT_ADVANCED_MAX_BYTES } from "./body-caps.js"; // M118 (D1) — advanced-route 413 caps
import { DEFAULT_MAX_INGEST_BYTES } from "@usetheo/lens-core";
import { parseResourceSpansPartial } from "../otlp/parse-resource-spans.js";
import { OtlpParseError, OtlpTooLargeError } from "../otlp/otlp-error.js";
import { decodeOtlpBody } from "../otlp/decode-protobuf.js";
import {
  spansIngested,
  tracesIngested,
  evaluationsExtracted,
  annotationsWritten,
  spansRejected,
  ingestRateLimited,
  logIngest,
  // M118 — runtime metrics on the app.ts mutating routes that emitted none (wiring-triad pillar c).
  tagsAdded,
  tagsRemoved,
  annotationsRemoved,
  replaySessionsRecorded,
} from "./metrics.js";
import { mountStatic } from "./static.js";
import { tracesToCsv } from "./csv.js";
import { buildOpenApiDocument } from "./openapi.js";

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
  experiment?: ExperimentApiDeps,
  ingest?: IngestApiDeps,
  health?: HealthApiDeps,
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
    return c.json(apiError("INTERNAL", "internal error"), 500);
  });

  // M94 — k8s/edge probes, UNAUTHENTICATED and mounted before the /v1 bearer. `/health` is pure
  // liveness (no dependency — a DB outage must NOT fail liveness, else a recoverable pod is killed);
  // `/ready` runs a DB probe (SELECT 1) and 503s when the DB is unreachable so the LB drains the node.
  app.get("/health", (c) => c.json({ status: "ok", version: health?.version ?? "unknown" }, 200));
  app.get("/ready", async (c) => {
    try {
      await health?.pingDb?.();
      return c.json({ status: "ready" }, 200);
    } catch {
      return c.json({ status: "unavailable" }, 503);
    }
  });

  // M96 — discovery surface, UNAUTHENTICATED and mounted before the /v1 bearer. `/openapi.json` is
  // generated from the Zod DTOs + the live router at request time (never drifts); `/v1` is the
  // capability index; `/version` is the build stamp. A customer generates a client from these.
  app.get("/openapi.json", (c) => c.json(buildOpenApiDocument(app.routes, health?.version)));
  app.get("/version", (c) => c.json({ version: health?.version ?? "unknown" }, 200));
  app.get("/v1", (c) =>
    c.json(
      {
        service: "theo-lens",
        version: health?.version ?? "unknown",
        capability: "observability",
        openapi: "/openapi.json",
        docs: "/openapi.json",
      },
      200,
    ),
  );

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

  app.post(
    "/v1/traces",
    // M93 — bound the RAW body BEFORE it is buffered (OOM guard): bodyLimit aborts the stream at the
    // cap and returns a typed 413. Runs before the scope guard so an oversized body is shed early.
    bodyLimit({
      maxSize: ingest?.maxBodyBytes ?? DEFAULT_MAX_INGEST_BYTES,
      onError: (c) =>
        c.json(
          { code: "PAYLOAD_TOO_LARGE", message: "OTLP body exceeds the ingest size limit" },
          413,
        ),
    }),
    requireScopeOnPrincipal("observability:write"),
    async (c) => {
      const contentType = (c.req.header("content-type") ?? "").toLowerCase();
      if (
        !contentType.includes("application/json") &&
        !contentType.includes("application/x-protobuf")
      ) {
        return c.json(
          { code: "UNSUPPORTED_MEDIA_TYPE", message: "use application/json or application/x-protobuf" },
          415,
        );
      }

      // M93 — per-workspace ingest backpressure: shed a runaway producer with 429 (before the pool
      // saturates) rather than a whole-server stall. Workspace resolved from the Principal.
      const ws = getPrincipal(c).workspaceId;
      if (ingest?.limiter) {
        const nowMs = (ingest.now ?? Date.now)();
        if (!ingest.limiter.tryAcquire(ws, nowMs)) {
          ingestRateLimited.add(1);
          c.header("Retry-After", String(ingest.limiter.retryAfterSeconds(ws, nowMs))); // M94
          return c.json({ code: "RATE_LIMITED", message: "ingest rate limit exceeded for this workspace" }, 429);
        }
      }

      const raw = Buffer.from(await c.req.arrayBuffer());

      let envelope: unknown;
      try {
        envelope = decodeOtlpBody(raw, contentType, c.req.header("content-encoding"), {
          ...(ingest?.maxDecompressedBytes !== undefined
            ? { maxDecompressedBytes: ingest.maxDecompressedBytes }
            : {}),
        });
      } catch (err) {
        // A gzip-bomb (decompresses past the bound) → 413; a corrupt/undecodable envelope → 400.
        if (err instanceof OtlpTooLargeError)
          return c.json({ code: "PAYLOAD_TOO_LARGE", message: err.message }, 413);
        if (err instanceof OtlpParseError)
          return c.json({ code: "INVALID_OTLP", message: err.message }, 400);
        throw err;
      }

      // M93 — total per span: valid spans are saved, malformed ones are dropped + counted (OTLP
      // partial-success). The undecodable-envelope 400 is already enforced above (decodeOtlpBody).
      const { spans: toSave, rejected, firstError } = parseResourceSpansPartial(envelope);

      if (toSave.length > 0) {
        await repo.save(toSave, ws);
        spansIngested.add(toSave.length);
        tracesIngested.add(new Set(toSave.map((s) => s.traceId)).size);
        const evals = toSave.reduce((n, s) => n + (s.evaluations?.length ?? 0), 0);
        evaluationsExtracted.add(evals);
        logIngest(toSave.length, evals);
      }
      if (rejected > 0) {
        spansRejected.add(rejected);
        // OTLP ExportTracePartialSuccess: rejected_spans + a human-facing error_message.
        return c.json({ partialSuccess: { rejectedSpans: rejected, errorMessage: firstError } }, 200);
      }
      // Full success — an empty partial_success is equivalent to "not present" per the OTLP contract.
      return c.json({ partialSuccess: {} }, 200);
    },
  );

  // M116 — native `POST /v1/runs`: ingest a Claude Code / @theokit/sdk run directly (no client OTLP
  // knowledge). The SDKMessage batch is mapped to spans by the core mapper (the M115 logic), then goes
  // through the SAME persist tail as /v1/traces (ADR-2). Scope-gated (observability:write) + per-tenant
  // + the shared ingest limiter. Fail-fast typed 400 on a malformed body (Rule 8).
  app.post(
    "/v1/runs",
    // Bound the RAW body BEFORE it is buffered (OOM guard, mirrors /v1/traces) — 413 on an oversized body.
    bodyLimit({
      maxSize: ingest?.maxBodyBytes ?? DEFAULT_MAX_INGEST_BYTES,
      onError: (c) => c.json({ code: "PAYLOAD_TOO_LARGE", message: "run body exceeds the ingest size limit" }, 413),
    }),
    requireScopeOnPrincipal("observability:write"),
    async (c) => {
    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    if (contentType !== "application/json" && !contentType.startsWith("application/json;")) {
      return c.json({ code: "UNSUPPORTED_MEDIA_TYPE", message: "use application/json" }, 415);
    }
    const ws = getPrincipal(c).workspaceId;
    if (ingest?.limiter) {
      const nowMs = (ingest.now ?? Date.now)();
      if (!ingest.limiter.tryAcquire(ws, nowMs)) {
        ingestRateLimited.add(1);
        c.header("Retry-After", String(ingest.limiter.retryAfterSeconds(ws, nowMs)));
        return c.json({ code: "RATE_LIMITED", message: "ingest rate limit exceeded for this workspace" }, 429);
      }
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "INVALID_BODY", message: "invalid JSON body" }, 400);
    }
    const b = body as { messages?: unknown; result?: unknown; startTimeMs?: unknown };
    if (!Array.isArray(b.messages)) {
      return c.json({ code: "INVALID_BODY", message: "`messages` must be an array of SDKMessage events" }, 400);
    }

    // M117: honor an optional caller-supplied base timestamp so the native /v1/runs path and the OTLP
    // /v1/traces fallback (which the SDK maps client-side with the same seam) yield identical spans.
    // A non-number is tolerated (ignored → mapper default), but an in-band number outside a sane epoch-ms
    // window is rejected at the boundary (fail-fast, error-handling.md §2) rather than minting absurd
    // span timestamps from an untrusted body value.
    let startTimeMs: number | undefined;
    if (typeof b.startTimeMs === "number" && Number.isFinite(b.startTimeMs)) {
      if (b.startTimeMs < 0 || b.startTimeMs > Date.now() + 86_400_000) {
        return c.json(
          { code: "INVALID_BODY", message: "`startTimeMs` must be an epoch-ms in [0, now + 1 day]" },
          400,
        );
      }
      startTimeMs = b.startTimeMs;
    }
    const envelope = sdkMessagesToOtlp(
      b.messages as SDKMessage[],
      b.result as TheokitRunResult | undefined,
      startTimeMs !== undefined ? { startTimeMs } : {},
    );
    const { spans: toSave, rejected, firstError } = parseResourceSpansPartial(envelope);
    if (toSave.length > 0) {
      await repo.save(toSave, ws);
      spansIngested.add(toSave.length);
      tracesIngested.add(new Set(toSave.map((s) => s.traceId)).size);
      // Same metrics as /v1/traces — count any extracted online-evals (future-proof; 0 today).
      const evals = toSave.reduce((n, s) => n + (s.evaluations?.length ?? 0), 0);
      evaluationsExtracted.add(evals);
      logIngest(toSave.length, evals);
    }
    if (rejected > 0) {
      spansRejected.add(rejected);
      return c.json({ partialSuccess: { rejectedSpans: rejected, errorMessage: firstError } }, 200);
    }
    return c.json({ partialSuccess: {} }, 200);
    },
  );

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
      return c.json(apiError("INVALID_QUERY", "invalid period (use day or week)"), 400);
    }
    const result = await repo.aggregateCostByPeriod(
      raw === "week" ? "week" : "day",
      getPrincipal(c).workspaceId,
    );
    return c.json(costByPeriodResponseSchema.parse(result), 200);
  });

  app.post("/v1/replay-sessions", bodyLimit413(DEFAULT_ADVANCED_MAX_BYTES), requireScopeOnPrincipal("observability:write"), async (c) => {
    // Record a replay-open event (M8 north-star). Fail-fast 400 on a missing
    // traceId (Rule 8); the UI calls this fire-and-forget so a 5xx never
    // degrades the replay UX (D3).
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(apiError("INVALID_BODY", "invalid json body"), 400);
    }
    const traceId = (body as { traceId?: unknown })?.traceId;
    if (typeof traceId !== "string" || traceId.length === 0) {
      return c.json(apiError("INVALID_BODY", "traceId is required"), 400);
    }
    await repo.recordReplaySession(traceId, getPrincipal(c).workspaceId);
    replaySessionsRecorded.add(1); // observable: replay-session north-star write volume (pillar c)
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
      return c.json(apiError("INVALID_QUERY", "invalid range (use 1h|24h|7d|30d)"), 400);
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
      return c.json(apiError("INVALID_QUERY", "invalid range (use 1h|24h|7d|30d)"), 400);
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

  app.get("/v1/metrics/scores", requireScopeOnPrincipal("observability:read"), async (c) => {
    // M90: per-evaluator score aggregation over time. Range validated at the boundary
    // (Rule 8), same whitelist as observability; default 24h. Parsed through the strict
    // DTO so the no-column-leak invariant holds at runtime (F-api-1).
    const parsed = observabilityRangeSchema.safeParse(c.req.query("range") ?? "24h");
    if (!parsed.success) {
      return c.json(apiError("INVALID_QUERY", "invalid range (use 1h|24h|7d|30d)"), 400);
    }
    const summary = scoresResponseSchema.parse({
      range: parsed.data,
      scores: await repo.aggregateScoresOverTime(
        parsed.data,
        getPrincipal(c).workspaceId,
      ),
    });
    return c.json(summary, 200);
  });

  app.get("/v1/metrics/span-attributes", requireScopeOnPrincipal("observability:read"), async (c) => {
    // M92 — facet discovery. No `key` → the workspace's top attribute keys; `?key=<k>` → the top
    // distinct values for that key. The key is bound as a jsonb path (injection-safe). Strict DTO.
    const ws = getPrincipal(c).workspaceId;
    const key = c.req.query("key");
    // Shape-validate the key at the boundary (fail-fast 400, Rule 8) — reject an oversized/hostile key
    // before it reaches SQL (it is bound regardless, but this caps abuse; same shape as the DSL clause).
    if (key !== undefined && key.length > 0 && !isValidAttrKey(key)) {
      return c.json(apiError("INVALID_QUERY", "invalid attribute key"), 400);
    }
    const body =
      key !== undefined && key.length > 0
        ? { mode: "values" as const, key, values: await repo.discoverSpanAttributeValues(key, ws) }
        : { mode: "keys" as const, keys: await repo.discoverSpanAttributeKeys(ws) };
    return c.json(spanFacetsResponseSchema.parse(body), 200);
  });

  app.get("/v1/sessions", requireScopeOnPrincipal("observability:read"), async (c) => {
    // M81: server-side pagination — parse the (coerced) limit/offset the BFF forwards; the repo clamps
    // and returns a workspace-scoped total. Invalid/absent params fall back to the repo defaults.
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "", 10);
    const offsetRaw = Number.parseInt(c.req.query("offset") ?? "", 10);
    const list = await repo.listSessions(getPrincipal(c).workspaceId, {
      ...(Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
      ...(Number.isFinite(offsetRaw) ? { offset: offsetRaw } : {}),
    });
    return c.json(sessionListResponseSchema.parse(list), 200);
  });

  app.get("/v1/sessions/:sessionId", requireScopeOnPrincipal("observability:read"), async (c) => {
    const detail = await repo.getSessionDetail(
      c.req.param("sessionId"),
      getPrincipal(c).workspaceId,
    );
    return detail
      ? c.json(sessionDetailResponseSchema.parse(detail), 200)
      : c.json(apiError("NOT_FOUND", "not found"), 404);
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

  // M26d dataset routes + M36 evaluators + M33 copilot routes (extracted to keep
  // app.ts ≤ 500 — M33 D5).
  registerDatasetRoutes(app, repo);
  registerLabelingQueueRoutes(app, repo);
  registerExtraRoutes(app, { evaluators, copilot, replay });
  // M64 experiments — the run route reuses the replay provider client + limiter + the evaluator repo.
  if (experiment !== undefined) registerExperimentRoutes(app, experiment);

  // Mount static UI serving LAST so the catch-all never shadows /v1/* (M7, D1).
  if (webDistDir !== undefined) {
    mountStatic(app, webDistDir);
  }

  return app;
}
