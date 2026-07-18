import { Hono } from "hono";
import {
  type SpanRepository,
  type AuthVerifier,
  sessionListResponseSchema,
  sessionDetailResponseSchema,
  apiError,
  errorBody,
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
import { registerTracesRoutes } from "./routes/traces-routes.js";
import { registerAnalyticsRoutes } from "./routes/analytics-routes.js";
import { registerMetricsRoutes } from "./routes/metrics-routes.js";
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
import { DEFAULT_MAX_INGEST_BYTES } from "@usetheo/lens-core";
import { parseResourceSpansPartial } from "../otlp/parse-resource-spans.js";
import { OtlpParseError, OtlpTooLargeError } from "../otlp/otlp-error.js";
import { decodeOtlpBody } from "../otlp/decode-protobuf.js";
import {
  spansIngested,
  tracesIngested,
  evaluationsExtracted,
  spansRejected,
  ingestRateLimited,
  logIngest,
} from "./metrics.js";
import { mountStatic } from "./static.js";
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
        c.json(errorBody("PAYLOAD_TOO_LARGE", "OTLP body exceeds the ingest size limit"), 413),
    }),
    requireScopeOnPrincipal("observability:write"),
    async (c) => {
      const contentType = (c.req.header("content-type") ?? "").toLowerCase();
      if (
        !contentType.includes("application/json") &&
        !contentType.includes("application/x-protobuf")
      ) {
        return c.json(errorBody("UNSUPPORTED_MEDIA_TYPE", "use application/json or application/x-protobuf"), 415);
      }

      // M93 — per-workspace ingest backpressure: shed a runaway producer with 429 (before the pool
      // saturates) rather than a whole-server stall. Workspace resolved from the Principal.
      const ws = getPrincipal(c).workspaceId;
      if (ingest?.limiter) {
        const nowMs = (ingest.now ?? Date.now)();
        if (!ingest.limiter.tryAcquire(ws, nowMs)) {
          ingestRateLimited.add(1);
          c.header("Retry-After", String(ingest.limiter.retryAfterSeconds(ws, nowMs))); // M94
          return c.json(errorBody("RATE_LIMITED", "ingest rate limit exceeded for this workspace"), 429);
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
          return c.json(errorBody("PAYLOAD_TOO_LARGE", err.message), 413);
        if (err instanceof OtlpParseError)
          return c.json(errorBody("INVALID_OTLP", err.message), 400);
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
      onError: (c) => c.json(errorBody("PAYLOAD_TOO_LARGE", "run body exceeds the ingest size limit"), 413),
    }),
    requireScopeOnPrincipal("observability:write"),
    async (c) => {
    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    if (contentType !== "application/json" && !contentType.startsWith("application/json;")) {
      return c.json(errorBody("UNSUPPORTED_MEDIA_TYPE", "use application/json"), 415);
    }
    const ws = getPrincipal(c).workspaceId;
    if (ingest?.limiter) {
      const nowMs = (ingest.now ?? Date.now)();
      if (!ingest.limiter.tryAcquire(ws, nowMs)) {
        ingestRateLimited.add(1);
        c.header("Retry-After", String(ingest.limiter.retryAfterSeconds(ws, nowMs)));
        return c.json(errorBody("RATE_LIMITED", "ingest rate limit exceeded for this workspace"), 429);
      }
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorBody("INVALID_BODY", "invalid JSON body"), 400);
    }
    const b = body as { messages?: unknown; result?: unknown; startTimeMs?: unknown };
    if (!Array.isArray(b.messages)) {
      return c.json(errorBody("INVALID_BODY", "`messages` must be an array of SDKMessage events"), 400);
    }

    // M117: honor an optional caller-supplied base timestamp so the native /v1/runs path and the OTLP
    // /v1/traces fallback (which the SDK maps client-side with the same seam) yield identical spans.
    // A non-number is tolerated (ignored → mapper default), but an in-band number outside a sane epoch-ms
    // window is rejected at the boundary (fail-fast, error-handling.md §2) rather than minting absurd
    // span timestamps from an untrusted body value.
    let startTimeMs: number | undefined;
    if (typeof b.startTimeMs === "number" && Number.isFinite(b.startTimeMs)) {
      if (b.startTimeMs < 0 || b.startTimeMs > Date.now() + 86_400_000) {
        return c.json(errorBody("INVALID_BODY", "`startTimeMs` must be an epoch-ms in [0, now + 1 day]"), 400);
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

  // M26d dataset routes + M36 evaluators + M33 copilot routes (extracted to keep
  // app.ts ≤ 500 — M33 D5). M121 (D1): traces/spans/cost/tree + tags + annotations.
  registerTracesRoutes(app, repo);
  registerAnalyticsRoutes(app, repo);
  registerMetricsRoutes(app, repo);
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
