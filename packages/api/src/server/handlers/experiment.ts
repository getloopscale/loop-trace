/**
 * M64 — experiment-run handler. Runs a regression dataset × a variant (model/prompt override) through
 * the reused M33 provider path (`ReplayClient`), scoring each row with the enabled rule evaluators
 * (the pure `runExperiment` engine), and persists the run. Reads the workspace from the Principal
 * (never the body); `observability:write` is enforced at the route (the CWE-441 second half). Fail-
 * closed (`error-handling.md`): no provider → 503; rate-limited → 429; invalid body → 400; the dataset
 * absent/foreign → 404 (no billable call). A per-item provider error is recorded by the engine (never a
 * fabricated output) → the run persists as `partial`.
 */
import type { Context } from "hono";

import {
  runExperiment,
  aggregateRun,
  compareRuns,
  MAX_RUN_ITEMS,
  experimentRunSchema,
  experimentRunsListResponseSchema,
  experimentCompareResponseSchema,
  errorBody,
  apiError,
  type RateLimiter,
  type RunVariant,
  type SpanRepository,
  type EvaluatorRepository,
  type JudgeClient,
} from "@looptrace/core";
import {
  ProviderBreakerOpenError,
  type ReplayClient,
} from "@looptrace/core/provider";

import { getPrincipal } from "../auth/middleware.js";
import { experimentRunsStarted, experimentRowsScored, experimentRunsUnavailable } from "../metrics.js";

/** Deps the experiment routes need (wired by the composition root — reuses the replay client + limiter). */
export interface ExperimentApiDeps {
  spanRepo: SpanRepository;
  /** Reuses the enabled evaluators for per-row scoring (the M36 repo). */
  evaluatorRepo: EvaluatorRepository;
  /** null = no provider configured → the run fails closed (503). */
  chat: ReplayClient | null;
  /**
   * The pinned LLM judge (or null when unconfigured). When present, `llm_judge` evaluators ALSO score the
   * replayed output — so the run shows a real quality A/B, not just rule verdicts. Reuses the SAME provider
   * config as chat/copilot (D1); null → the run scores rules only (no extra billable call).
   */
  judge: JudgeClient | null;
  /** Per-workspace billable-abuse guard (429) — one run = one acquire; the 25-item cap bounds per-run calls. */
  limiter: RateLimiter;
  /** Injected clock (ms) — defaults to Date.now. */
  now?: () => number;
}

const MAX_NAME_LEN = 120;
const MAX_PROMPT_LEN = 8192;
const MAX_MODEL_LEN = 256;

/** Validate the run body → {datasetId, name, variant}. Throws a code string on any violation. */
function parseRunBody(body: unknown): { datasetId: string; name: string; variant: RunVariant } {
  const b = body as { datasetId?: unknown; name?: unknown; variant?: unknown };
  if (typeof b.datasetId !== "string" || b.datasetId.length === 0) throw "INVALID_BODY";
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, MAX_NAME_LEN) : `run ${new Date().toISOString().slice(0, 19)}`;
  const variant: RunVariant = {};
  if (b.variant !== undefined) {
    if (typeof b.variant !== "object" || b.variant === null || Array.isArray(b.variant)) throw "INVALID_BODY";
    const v = b.variant as { model?: unknown; promptOverride?: unknown };
    if (v.model !== undefined) {
      if (typeof v.model !== "string" || v.model.length > MAX_MODEL_LEN) throw "INVALID_BODY";
      const t = v.model.trim();
      if (t) variant.model = t;
    }
    if (v.promptOverride !== undefined) {
      if (typeof v.promptOverride !== "string" || v.promptOverride.length > MAX_PROMPT_LEN) throw "INVALID_BODY";
      const t = v.promptOverride.trim();
      if (t) variant.promptOverride = t;
    }
  }
  return { datasetId: b.datasetId, name, variant };
}

export async function createExperimentRunHandler(c: Context, deps: ExperimentApiDeps): Promise<Response> {
  const p = getPrincipal(c);
  const ws = p.workspaceId;
  const clock = deps.now ?? Date.now;

  // Rate-limit first (protects the billable endpoint before any work — one run = one acquire).
  const rlNow = clock();
  if (!deps.limiter.tryAcquire(ws, rlNow)) {
    c.header("Retry-After", String(deps.limiter.retryAfterSeconds(ws, rlNow))); // M94
    return c.json(errorBody("RATE_LIMITED", "experiment-run rate limit exceeded"), 429);
  }
  if (deps.chat === null) {
    return c.json(errorBody("RUN_DISABLED", "experiment runs are not configured (no provider)"), 503);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(errorBody("INVALID_BODY", "invalid json body"), 400);
  }
  let parsed: { datasetId: string; name: string; variant: RunVariant };
  try {
    parsed = parseRunBody(body);
  } catch (code) {
    // `code` is the domain-thrown code string (INVALID_BODY) — surfaced via apiError (accepts a string).
    return c.json(apiError(typeof code === "string" ? code : "INVALID_BODY", "invalid run body"), 400);
  }

  // Authorize + load the dataset (workspace-scoped; a foreign/absent dataset → 404, NO billable call).
  const dataset = await deps.spanRepo.getDataset(parsed.datasetId, ws);
  if (dataset === null) {
    return c.json(errorBody("DATASET_NOT_FOUND", "dataset not found"), 404);
  }
  if (dataset.items.length === 0) {
    return c.json(errorBody("EMPTY_DATASET", "the dataset has no items to run"), 400);
  }

  const evaluators = await deps.evaluatorRepo.listEvaluators(ws);
  experimentRunsStarted.add(1);
  try {
    const result = await runExperiment(
      {
        items: dataset.items.map((it) => ({
          traceId: it.traceId,
          ...(it.inputSnapshot !== undefined ? { inputSnapshot: it.inputSnapshot } : {}),
          ...(it.outputSnapshot !== undefined ? { outputSnapshot: it.outputSnapshot } : {}),
        })),
        variant: parsed.variant,
        evaluators,
      },
      { replay: deps.chat, now: clock, judge: deps.judge },
    );
    experimentRowsScored.add(result.items.length);
    const run = await deps.spanRepo.createExperimentRun(
      {
        datasetId: parsed.datasetId,
        name: parsed.name,
        variant: parsed.variant,
        status: result.status,
        truncated: result.truncated,
        createdBy: p.userId ?? "unknown",
        items: result.items,
      },
      ws,
    );
    return c.json(experimentRunSchema.parse(run), 200);
  } catch (err) {
    // A total run failure (e.g. the store) fails closed — surface it, never a fabricated run.
    experimentRunsUnavailable.add(1);
    // Distinguish a circuit-open outage (503 — provider down, retry later) from a per-call provider/store
    // error (502), consistent with the copilot/replay handlers (M118 review LOW).
    if (err instanceof ProviderBreakerOpenError) {
      return c.json(errorBody("RUN_UNAVAILABLE", "provider circuit open — temporarily unavailable"), 503);
    }
    return c.json(errorBody("RUN_UNAVAILABLE", String(err)), 502);
  }
}

export async function listExperimentRunsHandler(c: Context, deps: ExperimentApiDeps): Promise<Response> {
  const ws = getPrincipal(c).workspaceId;
  const datasetId = c.req.query("datasetId");
  const runs = await deps.spanRepo.listExperimentRuns(datasetId && datasetId.length > 0 ? datasetId : undefined, ws);
  return c.json(experimentRunsListResponseSchema.parse({ runs }), 200);
}

export async function getExperimentRunHandler(c: Context, deps: ExperimentApiDeps): Promise<Response> {
  const ws = getPrincipal(c).workspaceId;
  const run = await deps.spanRepo.getExperimentRun(c.req.param("runId") ?? "", ws);
  return run ? c.json(experimentRunSchema.parse(run), 200) : c.json(errorBody("RUN_NOT_FOUND", "run not found"), 404);
}

/**
 * Compare 2+ runs by id: returns the runs (with items) for the client to align by source trace, plus the
 * signed aggregate `deltas` of the first two (pure `compareRuns` over the re-derived per-run aggregates —
 * the single source of truth `aggregateRun`). A foreign/absent id is silently dropped (workspace-scoped
 * get returns null) so existence never leaks; `deltas` is null when fewer than two runs resolve.
 */
export async function compareExperimentRunsHandler(c: Context, deps: ExperimentApiDeps): Promise<Response> {
  const ws = getPrincipal(c).workspaceId;
  const ids = (c.req.query("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 5);
  if (ids.length < 2) {
    return c.json(errorBody("INVALID_BODY", "compare needs at least 2 run ids (?ids=a,b)"), 400);
  }
  const runs = (await Promise.all(ids.map((id) => deps.spanRepo.getExperimentRun(id, ws)))).filter(
    (r): r is NonNullable<typeof r> => r !== null,
  );
  const [a, b] = runs;
  const deltas = a && b ? compareRuns(aggregateRun(a.items ?? []), aggregateRun(b.items ?? [])) : null;
  return c.json(experimentCompareResponseSchema.parse({ runs, deltas }), 200);
}

export { MAX_RUN_ITEMS };
