import { pathToFileURL } from "node:url";

import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import {
  parseRetentionConfig,
  parseJudgeConfig,
  parseBackfillMax,
  parseEvalSweepHours,
  parseCopilotRpm,
  parseEvaluatorRpm,
  sessionVerdictStoreFromPool,
  parseIngestRpm,
  parseMaxIngestBytes,
  parseMaxDecompressedBytes,
  parseHttpRequestTimeoutMs,
  parseShutdownDrainMs,
  runSweep,
  RateLimiter,
  EvaluatorRunJobRegistry,
  DEFAULT_WORKSPACE_ID,
  type EngineDeps,
} from "@usetheo/lens-core";
import { createProviderClients } from "@usetheo/lens-core/provider";
import {
  migrateLatest,
  evaluatorRepoFromPool,
  createPool,
  spanRepoFromPool,
  tenantScopedPool,
} from "@usetheo/lens-core/infra";
import type pg from "pg";

import { createApp } from "./app.js";
import { installGracefulShutdown } from "./shutdown.js";
import { parseRequireCredentialEnv } from "./auth/middleware.js";
import { ApiKeyAuthVerifier } from "./auth/api-key-verifier.js";
import { runPrune } from "./retention-run.js";
import { startRetentionScheduler } from "./retention-scheduler.js";
import { makeEnqueueAutoEval, startAutoEval } from "./auto-eval-wiring.js";

const HOUR_MS = 3_600_000;

/**
 * Default CWD-relative location of the built web bundle. The server is launched
 * from the app root (Docker `WORKDIR /app`, CMD `node packages/api/dist/server/index.js`),
 * so this resolves to `/app/packages/web/dist`. `serveStatic` rejects absolute
 * roots (EC-1), so this MUST stay CWD-relative.
 */
const DEFAULT_WEB_DIST = "packages/web/dist";

/**
 * Migrate-then-wire (D2): apply the committed migrations to the pool BEFORE the
 * app accepts traffic, then build the app serving the UI same-origin. Returns
 * the app + pool so the caller serves and (in tests) closes the pool. Rejects
 * loud on migration failure — a stack that cannot ingest must not come up.
 *
 * M23: when `THEOLENS_RETENTION_DAYS` is set, an opt-in retention sweep starts
 * (default OFF otherwise). `stop()` clears the sweep (a no-op when disabled) for
 * graceful shutdown + tests. The sweep timer is `unref()`'d so it never blocks exit.
 */
export async function bootstrap(
  uri: string,
  webDistDir: string = DEFAULT_WEB_DIST,
): Promise<{ app: Hono; pool: pg.Pool; stop: () => void }> {
  // Two views of one database, and the split is the security boundary.
  //
  // `rawPool` runs the work that has no tenant and must not pretend to have
  // one: schema migrations, and credential resolution — which is what
  // DISCOVERS the workspace, so scoping it would be circular.
  //
  // `pool` is the workspace-scoped view every repository receives: each
  // connection carries `app.workspace_id` from the request scope, which the
  // fail-closed policies of migration 0033 read. Repository code is unchanged.
  const rawPool = createPool(uri);
  await migrateLatest(rawPool);
  const pool = tenantScopedPool(rawPool);
  const repo = spanRepoFromPool(pool);
  // M22: in multi-tenant mode (THEOLENS_REQUIRE_CREDENTIAL) resolve a Principal from
  // the per-tenant `theo_api_keys` table; single-tenant dev collapses to `default`.
  const requireCredential = parseRequireCredentialEnv(
    process.env["THEOLENS_REQUIRE_CREDENTIAL"],
  );
  const bootstrapRaw = process.env["THEOLENS_PLATFORM_ADMIN_BOOTSTRAP"];
  const bootstrapToken =
    bootstrapRaw !== undefined && bootstrapRaw.trim().length > 0
      ? bootstrapRaw
      : undefined;
  const authOptions: Parameters<typeof createApp>[2] = {
    // Raw: the API-key lookup runs before any scope is bound.
    pool: rawPool,
    requireCredential,
    ...(requireCredential ? { verifier: new ApiKeyAuthVerifier(rawPool) } : {}),
    ...(bootstrapToken !== undefined ? { bootstrapToken } : {}),
  };
  // M36: wire the online-evaluators surface. The evaluator repo shares the pool;
  // the LLM-judge is enabled only when configured (else null → fail-closed per span).
  const evaluatorRepo = evaluatorRepoFromPool(pool);
  const judgeConfig = parseJudgeConfig(process.env);
  // M120 (D3): the fail-closed judge/chat/replay construction (unconfigured provider → null client →
  // route 503s) is centralized in one core factory (was repeated 3× verbatim here). M33: the copilot,
  // M55: span replay, and the judge all reuse the SAME provider config (D1). Each surface keeps its own
  // per-workspace rate limiter (the billable-abuse guard, D3).
  const { judge, chat, replay: replayClient } = createProviderClients(judgeConfig);
  const engine: EngineDeps = {
    evaluatorRepo,
    spanRepo: repo,
    judge,
    backfillMax: parseBackfillMax(process.env),
  };
  const copilotLimiter = new RateLimiter(parseCopilotRpm(process.env));
  const replayLimiter = new RateLimiter(parseCopilotRpm(process.env));
  // M64: the experiment-run route reuses the replay provider client + a dedicated limiter + the
  // evaluator repo. Rule evaluators score via the pure engine; llm_judge evaluators score the replayed
  // output via the SAME judge (D1) so a run shows a real quality A/B. null client → run fails closed (503).
  const experimentLimiter = new RateLimiter(parseCopilotRpm(process.env));
  // M118: the billable POST /v1/evaluators/:id/run fans out up to backfillMax=500 judge calls per
  // request — its own low-RPM per-workspace limiter (its own env knob, decoupled from copilot — UQ3).
  const evaluatorRunLimiter = new RateLimiter(parseEvaluatorRpm(process.env));
  // M133 — the async evaluator-run job registry (in-memory; a manual run registers a job, scores in
  // the background with bounded concurrency, and the client polls for progress). Single-process v1.
  const evaluatorRunJobs = new EvaluatorRunJobRegistry();
  // M93: OTLP ingest backpressure — a dedicated, higher-rpm per-workspace limiter (ingest is the
  // high-volume write path) so a runaway producer sheds with 429 before the pool exhausts.
  const ingestLimiter = new RateLimiter(parseIngestRpm(process.env));
  const enqueueAutoEval = makeEnqueueAutoEval(pool, (ws) =>
    evaluatorRepo.listEvaluators(ws),
  );
  const ingestDeps = {
    // M134 — auto-eval enqueue (ADR D5: fire-and-forget, counted on failure).
    enqueueAutoEval,
    limiter: ingestLimiter,
    maxBodyBytes: parseMaxIngestBytes(process.env),
    maxDecompressedBytes: parseMaxDecompressedBytes(process.env),
  };
  // M131 B4 — session-coherence run/read. Reuses the SAME judge (D1, null → route 503) + a dedicated
  // per-workspace billable limiter; the verdict store is the session_evaluations repo over the pool.
  const coherenceStore = sessionVerdictStoreFromPool(pool);
  const sessionCoherenceLimiter = new RateLimiter(parseEvaluatorRpm(process.env));
  const sessionCoherenceDeps = {
    judge,
    // the preview-bearing trace source (listTraces populates input/output previews; getSessionDetail
    // does not). Empty → null so the route 404s "no traces to judge".
    getTraces: async (ws: string, sid: string) => {
      const res = await repo.listTraces({ sessionId: sid }, ws);
      return res.traces.length > 0 ? res.traces : null;
    },
    getCached: coherenceStore.getCached,
    saveVerdict: coherenceStore.saveVerdict,
    ...(judgeConfig?.model != null ? { judgeModel: judgeConfig.model } : {}),
    limiter: sessionCoherenceLimiter,
  };
  const app = createApp(
    repo,
    webDistDir,
    authOptions,
    { repo: evaluatorRepo, engine, runJobs: evaluatorRunJobs, limiter: evaluatorRunLimiter },
    { spanRepo: repo, chat, limiter: copilotLimiter },
    { spanRepo: repo, chat: replayClient, limiter: replayLimiter },
    { spanRepo: repo, evaluatorRepo, chat: replayClient, judge, limiter: experimentLimiter },
    ingestDeps,
    // M94: readiness probe — a bounded `SELECT 1` (the pool's connectionTimeoutMillis bounds it);
    // it throwing → /ready 503 so the edge drains a DB-unreachable node.
    {
      version: process.env["THEOLENS_VERSION"] ?? "dev",
      // Stamped by the deploy: THEOLENS_GIT_SHA is what a human compares against the commit
      // they pushed. The gate itself uses the image's OCI label, which is stronger — but only
      // a machine reads that, and "what is live?" is a question humans ask too.
      gitSha: process.env["THEOLENS_GIT_SHA"] ?? "unknown",
      builtAt: process.env["THEOLENS_BUILD_TIME"] ?? "unknown",
      pingDb: async () => {
        await pool.query("SELECT 1");
      },
    },
    sessionCoherenceDeps,
  );

  // M36: opt-in periodic evaluator sweep (default OFF, D5). v1 sweeps the `default`
  // workspace; per-workspace fan-out is a documented follow-on. Timer is unref'd.
  const evalSweepHours = parseEvalSweepHours(process.env);
  let evalSweepTimer: ReturnType<typeof setInterval> | undefined;
  if (evalSweepHours > 0) {
    evalSweepTimer = setInterval(() => {
      void runSweep(DEFAULT_WORKSPACE_ID, engine).catch((err: unknown) => {
        console.error(
          JSON.stringify({ level: "error", msg: "eval_sweep_failed", error: String(err) }),
        );
      });
    }, evalSweepHours * HOUR_MS);
    evalSweepTimer.unref();
  }

  // M134 — automatic evaluation of new traces. Opt-in per deployment:
  // THEOLENS_AUTO_EVAL=1 starts the claim daemon. The ingest hook is wired
  // regardless (it is a no-op for a workspace with no auto evaluators), so
  // enabling the daemon later still finds the work that arrived meanwhile —
  // the queue is a table, not an in-memory buffer (ADR D1).
  let stopAutoEval = (): void => {};
  if (process.env["THEOLENS_AUTO_EVAL"] === "1") {
    console.error(JSON.stringify({ level: "info", msg: "auto_eval enabled" }));
    stopAutoEval = startAutoEval(
      pool,
      engine,
      (id, ws) => evaluatorRepo.getEvaluator(id, ws),
    ).stop;
  }

  const retention = parseRetentionConfig(process.env);
  if (retention.warning) {
    console.error(JSON.stringify({ level: "warn", msg: retention.warning }));
  }
  let stop = (): void => {};
  if (retention.retentionDays != null) {
    console.error(
      JSON.stringify({
        level: "info",
        msg: "retention enabled",
        retentionDays: retention.retentionDays,
        sweepHours: retention.sweepHours,
      }),
    );
    const handle = startRetentionScheduler({
      intervalMs: retention.sweepHours * HOUR_MS,
      runOnce: async () => {
        const stats = await runPrune(repo, retention, new Date());
        if (stats) console.error(JSON.stringify({ level: "info", msg: "pruned", ...stats }));
      },
    });
    stop = handle.stop;
  }
  // Compose retention stop with the eval-sweep timer clear + the M134 auto-eval
  // daemon (graceful shutdown/tests). A background loop with no shutdown path
  // keeps sweeping after the server is torn down — in tests that means an open
  // handle against a closed pool.
  const retentionStop = stop;
  stop = (): void => {
    retentionStop();
    if (evalSweepTimer !== undefined) clearInterval(evalSweepTimer);
    stopAutoEval();
  };
  return { app, pool, stop };
}

/**
 * Composition root: read config, migrate on boot, wire the UI-serving app, and
 * serve. Fails loud (structured log + non-zero exit, Rule 8) on missing config
 * or migration failure.
 */
export async function main(): Promise<void> {
  const uri = process.env["THEOLENS_PG_URI"];
  if (!uri) {
    console.error(
      JSON.stringify({ level: "error", msg: "THEOLENS_PG_URI is required" }),
    );
    process.exit(1);
    return;
  }

  const webDistDir = process.env["THEOLENS_WEB_DIST"] ?? DEFAULT_WEB_DIST;

  let app: Hono;
  let pool: pg.Pool;
  let stop: () => void;
  try {
    console.error(JSON.stringify({ level: "info", msg: "migrating" }));
    ({ app, pool, stop } = await bootstrap(uri, webDistDir));
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "boot migration failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(1);
    return;
  }

  const port = Number(process.env["THEOLENS_PORT"] ?? 4318);
  const server = serve({ fetch: app.fetch, port });
  // M94: a DB-blocked route 503s at this ceiling instead of hanging a socket (env-tunable). The
  // default `serve` yields an HTTP/1 `http.Server` which carries `requestTimeout` (Http2Server does
  // not, hence the guarded assignment).
  const requestTimeout = parseHttpRequestTimeoutMs(process.env);
  if ("requestTimeout" in server) {
    (server as { requestTimeout: number }).requestTimeout = requestTimeout;
  }
  // M94: on SIGTERM/SIGINT (rolling deploy) drain in-flight requests then close the pool.
  installGracefulShutdown({
    server,
    pool,
    stop,
    drainMs: parseShutdownDrainMs(process.env),
  });
  console.error(JSON.stringify({ level: "info", msg: "listening", port }));
}

// Run only when executed as the entry point — importing this module (tests)
// must NOT trigger main().
const invokedAsEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsEntry) {
  void main();
}
