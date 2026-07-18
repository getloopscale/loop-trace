import { pathToFileURL } from "node:url";

import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import {
  createSpanRepository,
  migrateLatest,
  parseRetentionConfig,
  evaluatorRepoFromPool,
  OpenAICompatibleJudge,
  parseJudgeConfig,
  parseBackfillMax,
  parseEvalSweepHours,
  parseCopilotRpm,
  parseEvaluatorRpm,
  parseIngestRpm,
  parseMaxIngestBytes,
  parseMaxDecompressedBytes,
  parseHttpRequestTimeoutMs,
  parseShutdownDrainMs,
  runSweep,
  OpenAICompatibleChat,
  OpenAICompatibleReplay,
  RateLimiter,
  DEFAULT_WORKSPACE_ID,
  type EngineDeps,
  type JudgeClient,
  type ChatClient,
  type ReplayClient,
} from "@usetheo/lens-core";
import type pg from "pg";

import { createApp } from "./app.js";
import { installGracefulShutdown } from "./shutdown.js";
import { parseRequireCredentialEnv } from "./auth/middleware.js";
import { ApiKeyAuthVerifier } from "./auth/api-key-verifier.js";
import { runPrune } from "./retention-run.js";
import { startRetentionScheduler } from "./retention-scheduler.js";

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
  const { repo, pool } = createSpanRepository(uri);
  await migrateLatest(pool);
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
    pool,
    requireCredential,
    ...(requireCredential ? { verifier: new ApiKeyAuthVerifier(pool) } : {}),
    ...(bootstrapToken !== undefined ? { bootstrapToken } : {}),
  };
  // M36: wire the online-evaluators surface. The evaluator repo shares the pool;
  // the LLM-judge is enabled only when configured (else null → fail-closed per span).
  const evaluatorRepo = evaluatorRepoFromPool(pool);
  const judgeConfig = parseJudgeConfig(process.env);
  const judge: JudgeClient | null =
    judgeConfig !== null ? new OpenAICompatibleJudge(judgeConfig) : null;
  const engine: EngineDeps = {
    evaluatorRepo,
    spanRepo: repo,
    judge,
    backfillMax: parseBackfillMax(process.env),
  };
  // M33: the "Ask about this step" copilot reuses the same provider config (D1); the
  // chat client is null when unconfigured → the endpoint fails closed (503). Per-
  // workspace rate limiter (D3).
  const chat: ChatClient | null =
    judgeConfig !== null ? new OpenAICompatibleChat(judgeConfig) : null;
  const copilotLimiter = new RateLimiter(parseCopilotRpm(process.env));
  // M55: span replay reuses the SAME provider config (D1) — usage-capturing client (or null →
  // fail-closed 503); its own per-workspace rate limiter (the billable-abuse guard, D3).
  const replayClient: ReplayClient | null =
    judgeConfig !== null ? new OpenAICompatibleReplay(judgeConfig) : null;
  const replayLimiter = new RateLimiter(parseCopilotRpm(process.env));
  // M64: the experiment-run route reuses the replay provider client + a dedicated limiter + the
  // evaluator repo (rule-evaluator scoring). null client → the run fails closed (503).
  const experimentLimiter = new RateLimiter(parseCopilotRpm(process.env));
  // M118: the billable POST /v1/evaluators/:id/run fans out up to backfillMax=500 judge calls per
  // request — its own low-RPM per-workspace limiter (its own env knob, decoupled from copilot — UQ3).
  const evaluatorRunLimiter = new RateLimiter(parseEvaluatorRpm(process.env));
  // M93: OTLP ingest backpressure — a dedicated, higher-rpm per-workspace limiter (ingest is the
  // high-volume write path) so a runaway producer sheds with 429 before the pool exhausts.
  const ingestLimiter = new RateLimiter(parseIngestRpm(process.env));
  const ingestDeps = {
    limiter: ingestLimiter,
    maxBodyBytes: parseMaxIngestBytes(process.env),
    maxDecompressedBytes: parseMaxDecompressedBytes(process.env),
  };
  const app = createApp(
    repo,
    webDistDir,
    authOptions,
    { repo: evaluatorRepo, engine, limiter: evaluatorRunLimiter },
    { spanRepo: repo, chat, limiter: copilotLimiter },
    { spanRepo: repo, chat: replayClient, limiter: replayLimiter },
    { spanRepo: repo, evaluatorRepo, chat: replayClient, limiter: experimentLimiter },
    ingestDeps,
    // M94: readiness probe — a bounded `SELECT 1` (the pool's connectionTimeoutMillis bounds it);
    // it throwing → /ready 503 so the edge drains a DB-unreachable node.
    {
      version: process.env["THEOLENS_VERSION"] ?? "dev",
      pingDb: async () => {
        await pool.query("SELECT 1");
      },
    },
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
  // Compose retention stop with the eval-sweep timer clear (graceful shutdown/tests).
  const retentionStop = stop;
  stop = (): void => {
    retentionStop();
    if (evalSweepTimer !== undefined) clearInterval(evalSweepTimer);
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
