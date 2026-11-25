import { Hono , type Context } from "hono";
import {
  type SpanRepository,
  type AuthVerifier,
  apiError,
  errorBody,
  sdkMessagesToOtlp,
  type SDKMessage,
  type TheokitRunResult,
} from "@looptrace/core";

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
import { registerEvaluatorRoutes } from "./routes/register-evaluator-routes.js";
import { registerCopilotRoutes } from "./routes/register-copilot-routes.js";
import { registerReplayRoutes } from "./routes/register-replay-routes.js";
import { registerTracesRoutes } from "./routes/traces-routes.js";
import { registerAnalyticsRoutes } from "./routes/analytics-routes.js";
import { registerMetricsRoutes } from "./routes/metrics-routes.js";
import { registerSessionsRoutes } from "./routes/sessions-routes.js";
import {
  registerSessionCoherenceRoutes,
  type SessionCoherenceApiDeps,
} from "./routes/session-coherence-routes.js";
import { registerDatasetRoutes } from "./routes/dataset-routes.js";
import { registerLabelingQueueRoutes } from "./routes/labeling-queue-routes.js";
import { registerExperimentRoutes } from "./routes/experiment-routes.js";
import type { ExperimentApiDeps } from "./handlers/experiment.js";
import type { RateLimiter, Span } from "@looptrace/core";

/**
 * M93 — OTLP ingest hardening deps (all optional; a test app without them keeps the pre-M93 behavior
 * minus the size caps, which default). `limiter` sheds a runaway per-workspace producer with 429;
 * the byte caps bound the raw body (413 via bodyLimit) + the decompressed body (413, gzip-bomb).
 */
export interface IngestApiDeps {
  /**
   * M134 — enqueue auto-evaluation for the spans just saved.
   *
   * Called AFTER the save succeeds and never awaited into the response path:
   * per ADR D5 a failure here is counted and swallowed at the call site, so an
   * eval-side problem can never fail an ingest. Absent → auto-eval is off.
   */
  enqueueAutoEval?: (spans: Span[], workspaceId: string) => Promise<void>;
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
  /** Commit the running image was built from — the answer to "what code is live". */
  gitSha?: string;
  /** ISO timestamp stamped at build. */
  builtAt?: string;
}
import { workspaceScope } from "./middleware/workspace-scope.js";
import { bodyLimit } from "hono/body-limit";
import { DEFAULT_MAX_INGEST_BYTES } from "@looptrace/core";
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
  autoEvalEnqueueFailures,
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
 *  - GET  /v1/analytics/usage-by-user : token/cost consumption per end user (?days=&limit=&offset=, M140)
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

/**
 * Fire-and-forget auto-eval enqueue (ADR D5).
 *
 * NOT awaited: the ingest response must not wait on it, and must not fail
 * because of it. But a swallowed failure with no signal is blueprint AP-3 — the
 * reference logs and returns, and the trace is never evaluated with nothing to
 * show for it. The counter is what turns an invisible drop into an observable one.
 */
function enqueueAutoEval(
  ingest: IngestApiDeps | undefined,
  spans: Span[],
  workspaceId: string,
): void {
  if (ingest?.enqueueAutoEval === undefined) return;
  void ingest.enqueueAutoEval(spans, workspaceId).catch((err: unknown) => {
    autoEvalEnqueueFailures.add(1);
    console.error(
      JSON.stringify({
        level: "error",
        msg: "auto_eval_enqueue_failed",
        workspaceId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  });
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
  sessionCoherence?: SessionCoherenceApiDeps,
): Hono {
  const app = new Hono();

  // Fail-loud, fail-clear (Rule 8): any unhandled error (e.g. Postgres
  // unavailable during repo.save) is logged with context and surfaced as 500.
  app.onError((err, c) => {
    // looptrace#136 — a resposta é opaca de propósito (nunca vazar interno ao cliente), mas o LOG
    // precisa deixar de ser. Antes, um defeito de TIPO numa consulta (`22003 integer out of range`,
    // que derrubava `range=30d`) chegava ao operador como `INTERNAL` aqui e `UPSTREAM_ERROR` no
    // dashboard — indistinguível de "o serviço caiu". `code`/`routine` classificam, `query` localiza.
    //
    // `params` é deliberadamente OMITIDO: os valores ligados podem carregar conteúdo do usuário
    // (termo de busca, span_query), e um log de erro não é lugar para isso.
    type ErroDeConsulta = Partial<{ code: string; routine: string; query: string; cause: unknown }>;
    const alvo = err as ErroDeConsulta;
    // O `drizzle` embrulha todo erro de `db.execute()` num `DrizzleQueryError`, que deixa o código do
    // Postgres na CAUSA, não no objeto. Ler só a superfície devolvia `undefined` sempre — o campo
    // existia no log e nunca era emitido. Forma travada em
    // `packages/core/src/infrastructure/db/drizzle-error-shape.test.ts`.
    const causa = (alvo.cause ?? {}) as ErroDeConsulta & { message?: string };
    const bruto = alvo.code ?? causa.code;
    // SQLSTATE do Postgres é SEMPRE cinco alfanuméricos maiúsculos. Sem esta checagem, um
    // `ECONNREFUSED` de um `fetch` — alcançável de verdade: o juiz de LLM relança o erro nativo
    // intacto — sairia rotulado como `dbErrorCode`, e o operador leria queda do provedor como falha
    // de banco. Seria a mesma confusão que este log existe para acabar, na direção oposta.
    const code = /^[0-9A-Z]{5}$/.test(bruto ?? "") ? bruto : undefined;
    const routine = code ? (alvo.routine ?? causa.routine) : undefined;
    const query = alvo.query ?? causa.query;
    // A mensagem legível do Postgres ("integer out of range") vive na CAUSA. Sem ela sobram código,
    // rotina e SQL — que classificam e localizam, mas não descrevem.
    const detalhe = typeof causa.message === "string" ? causa.message : undefined;

    // A `message` do `DrizzleQueryError` é `Failed query: <sql>\nparams: <valores ligados>` — e os
    // valores ligados podem ser conteúdo do usuário (o `q` da busca livre de `listTraces` chega ali).
    // Logar a mensagem crua vazava exatamente o que este handler diz não vazar.
    const semParametros = (m: string): string => m.split("\nparams:")[0] ?? m;

    console.error(
      JSON.stringify({
        level: "error",
        msg: "request_failed",
        method: c.req.method,
        path: c.req.path,
        // Truncado como o `dbQuery`: a mensagem do drizzle embute o SQL inteiro, então sem teto o
        // mesmo texto ia duplicado e sem limite no mesmo registro.
        error: (err instanceof Error ? semParametros(err.message) : String(err)).slice(0, 500),
        ...(detalhe ? { dbMessage: detalhe } : {}),
        ...(typeof code === "string" ? { dbErrorCode: code } : {}),
        ...(typeof routine === "string" ? { dbRoutine: routine } : {}),
        ...(typeof query === "string" ? { dbQuery: query.replace(/\s+/g, " ").slice(0, 500) } : {}),
      }),
    );
    return c.json(apiError("INTERNAL", "internal error"), 500);
  });

  // M94 probes, moved to the CD playbook's canonical paths so every LoopZero capability answers the
  // same three questions at the same URLs — a deploy gate that has to learn per-service paths is
  // a deploy gate nobody reuses. UNAUTHENTICATED and mounted before the /v1 bearer: the gate runs
  // before any credential exists on the box.
  //
  // Liveness is DB-INDEPENDENT on purpose. A DB blip that fails liveness gets a recoverable
  // process killed; readiness is the probe that exists to say "alive but cannot serve" so a load
  // balancer drains instead of erroring.
  //
  // B-117 — `/v1/health` and `/v1/health/ready` are the ECOSYSTEM's names for the same three
  // questions (loopzero-contracts/httpsurface, D5). The argument above is the contract's argument,
  // reached here independently; only the spelling differed. Measured across nine services the
  // split was four `healthz` to three `health`, and the `z` suffix is a Kubernetes-era convention
  // that means nothing to someone calling a `/v1` API.
  //
  // The healthz pair stays: the deploy gate described above points at it today, and the
  // contract's migration is additive — removal is its own item after a deprecation deadline.
  const liveness = (c: Context) =>
    c.json({ status: "ok", version: health?.version ?? "unknown" }, 200);
  const readiness = async (c: Context) => {
    try {
      // The timeout wraps the probe so a HUNG database cannot hang the readiness check itself —
      // a probe that never answers is worse than one that answers "not ready".
      await Promise.race([
        health?.pingDb?.() ?? Promise.resolve(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("db probe timeout")), 2000),
        ),
      ]);
      return c.json({ status: "ready", checks: { db: health?.pingDb ? "ok" : "skipped" } }, 200);
    } catch {
      return c.json({ status: "not_ready", checks: { db: "fail" } }, 503);
    }
  };

  app.get("/v1/health", liveness);
  app.get("/v1/health/ready", readiness);
  app.get("/v1/healthz", liveness);
  app.get("/v1/healthz/ready", readiness);

  // M96 — discovery surface, UNAUTHENTICATED and mounted before the /v1 bearer. `/openapi.json` is
  // generated from the Zod DTOs + the live router at request time (never drifts); `/v1` is the
  // capability index; `/version` is the build stamp. A customer generates a client from these.
  app.get("/openapi.json", (c) => c.json(buildOpenApiDocument(app.routes, health?.version)));
  // The build stamp a human reads to answer "what is running right now". The deploy gate itself
  // compares the image's OCI revision label — that proves WHICH IMAGE runs, where this endpoint
  // would only prove the container restarted with the right .env.
  app.get("/v1/version", (c) =>
    c.json(
      {
        name: "looptrace",
        version: health?.version ?? "unknown",
        git_sha: health?.gitSha ?? "unknown",
        built_at: health?.builtAt ?? "unknown",
        node: process.version,
      },
      200,
    ),
  );
  app.get("/v1", (c) =>
    c.json(
      {
        service: "looptrace",
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

  // Immediately after the Principal is resolved, and before any route can reach
  // the database: bind the workspace so PostgreSQL enforces the boundary itself
  // (migration 0033). Admin routes are skipped for the same reason they skip the
  // data bearer — they cross workspaces by design and carry their own gate.
  const scopeBinder = workspaceScope();
  app.use("/v1/*", async (c, next) => {
    const p = c.req.path;
    if (p === "/v1/admin" || p.startsWith("/v1/admin/")) return next();
    return scopeBinder(c, next);
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
        enqueueAutoEval(ingest, toSave, ws);
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
      enqueueAutoEval(ingest, toSave, ws);
    }
    if (rejected > 0) {
      spansRejected.add(rejected);
      return c.json({ partialSuccess: { rejectedSpans: rejected, errorMessage: firstError } }, 200);
    }
    return c.json({ partialSuccess: {} }, 200);
    },
  );

  // M26d dataset routes + M36 evaluators + M33 copilot routes (extracted to keep
  // app.ts ≤ 500 — M33 D5). M121 (D1): traces/spans/cost/tree + tags + annotations.
  registerTracesRoutes(app, repo);
  registerAnalyticsRoutes(app, repo);
  registerMetricsRoutes(app, repo);
  registerSessionsRoutes(app, repo);
  // M131 B4 — Session Coherence run/read routes (opt-in; only mounted when the composition root wires
  // the judge + verdict store). Absent in a bare test app (keeps the pre-M131 surface).
  if (sessionCoherence) registerSessionCoherenceRoutes(app, sessionCoherence);
  registerDatasetRoutes(app, repo);
  registerLabelingQueueRoutes(app, repo);
  // M121 (D3) — the former extra-routes registrar, split per domain (evaluator/copilot/replay). Each
  // mounts only when its deps are wired by the composition root; per-verb scope unchanged.
  registerEvaluatorRoutes(app, evaluators);
  registerCopilotRoutes(app, copilot);
  registerReplayRoutes(app, replay);
  // M64 experiments — the run route reuses the replay provider client + limiter + the evaluator repo.
  if (experiment !== undefined) registerExperimentRoutes(app, experiment);

  // Mount static UI serving LAST so the catch-all never shadows /v1/* (M7, D1).
  if (webDistDir !== undefined) {
    mountStatic(app, webDistDir);
  }

  return app;
}
