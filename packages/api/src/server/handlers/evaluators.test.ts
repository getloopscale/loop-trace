import { describe, it, expect } from "vitest";
import type { Context } from "hono";
import { RateLimiter, EvaluatorRunJobRegistry, type EvaluatorRecord, type RunResult } from "@looptrace/core";

import { createEvaluatorHandler, updateEvaluatorHandler, runEvaluatorHandler, getEvaluatorRunJobHandler, type EvaluatorApiDeps } from "./evaluators.js";
import { evaluatorRunRateLimited } from "../metrics.js";

/**
 * M118 (T2.1) — the billable `POST /v1/evaluators/:id/run` (fans out up to backfillMax=500 LLM-judge
 * calls) MUST be per-workspace rate-limited: an exhausted workspace gets `429 { code: "RATE_LIMITED" }`
 * + a `Retry-After` header BEFORE any billable engine work, while OTHER workspaces are unaffected
 * (per-workspace isolation, `rate-limiter.ts`). Mirrors the replay 429 handler test.
 */

const EVAL: EvaluatorRecord = {
  id: "e1",
  name: "has-good",
  kind: "rule",
  config: { predicate: "" },
  target: "",
  enabled: true,
  createdAt: "2026-07-07T00:00:00Z",
} as unknown as EvaluatorRecord;

const RUN_RESULT: RunResult = { evaluator: "has-good", total: 1, written: 1, skipped: 0, truncated: false, errors: [] };

function ctx(opts: { ws?: string; body?: unknown; headers?: Record<string, string>; id?: string } = {}): Context {
  const principal = { workspaceId: opts.ws ?? "ws-x", userId: "u", role: "member", scopes: ["observability:write"] };
  const headers = opts.headers ?? {};
  return {
    get: (k: string) => (k === "principal" ? principal : undefined),
    req: {
      param: (n: string) => (n === "id" ? opts.id ?? "e1" : undefined),
      json: async () => opts.body ?? {},
    },
    header: (k: string, v: string) => { headers[k] = v; },
    body: (b: unknown, status = 200) => new Response(b as BodyInit, { status }),
    json: (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }),
  } as unknown as Context;
}

// A repo/engine that always returns the same evaluator + a canned run result, and counts run calls so a
// test can prove the 429 path never reached the billable engine.
function deps(over: Partial<EvaluatorApiDeps> = {}): EvaluatorApiDeps {
  const repo = { getEvaluator: async () => EVAL, writeVerdict: async () => {} } as unknown as EvaluatorApiDeps["repo"];
  const engine = {
    evaluatorRepo: repo,
    // A no-trace repo: runEvaluator resolves an empty selection → a valid RunResult (so a non-rate-
    // limited call returns 200, letting the isolation test assert `!== 429`).
    spanRepo: { listTraces: async () => ({ traces: [] }), getTraceTree: async () => null },
    judge: null,
    backfillMax: 500,
  } as unknown as EvaluatorApiDeps["engine"];
  void RUN_RESULT;
  return {
    repo,
    engine,
    runJobs: new EvaluatorRunJobRegistry(),
    limiter: new RateLimiter(1000),
    now: () => 1_000_000,
    ...over,
  };
}

describe("M118 runEvaluatorHandler rate limiting", () => {
  it("test_post_evaluator_run_flood_returns_429", async () => {
    evaluatorRunRateLimited.reset();
    const limiter = new RateLimiter(1); // 1 per window
    const headers: Record<string, string> = {};
    const d = deps({ limiter, now: () => 2_000_000 });
    // First call consumes the single token (may 200 or 5xx depending on the fake engine — not asserted).
    await runEvaluatorHandler(ctx({ ws: "ws-A" }), d);
    // Second call in the same window → shed with 429 BEFORE the engine runs.
    const second = await runEvaluatorHandler(ctx({ ws: "ws-A", headers }), d);
    expect(second.status).toBe(429);
    expect(((await second.json()) as { code: string }).code).toBe("RATE_LIMITED");
    expect(Number(headers["Retry-After"])).toBeGreaterThanOrEqual(1);
    expect(evaluatorRunRateLimited.value).toBeGreaterThanOrEqual(1);
  });

  it("test_evaluator_run_limiter_is_per_workspace", async () => {
    const limiter = new RateLimiter(1);
    const d = deps({ limiter, now: () => 3_000_000 });
    // Workspace B floods to exhaustion.
    await runEvaluatorHandler(ctx({ ws: "ws-B" }), d);
    const bSecond = await runEvaluatorHandler(ctx({ ws: "ws-B" }), d);
    expect(bSecond.status).toBe(429); // B is now rate-limited
    // Workspace A's first call in the same window must NOT be rate-limited (isolation).
    const aFirst = await runEvaluatorHandler(ctx({ ws: "ws-A" }), d);
    expect(aFirst.status).not.toBe(429);
  });
});

describe("M133 async evaluator-run job", () => {
  it("test_run_returns_202_with_a_queued_job_then_poll_reports_completed", async () => {
    const d = deps();
    // POST /run registers a job and returns 202 immediately (no synchronous fan-out).
    const res = await runEvaluatorHandler(ctx({ ws: "ws-A" }), d);
    expect(res.status).toBe(202);
    const job = (await res.json()) as { id: string; status: string; evaluatorName: string };
    expect(job.status).toBe("queued");
    expect(job.evaluatorName).toBe("has-good");
    // The fire-and-forget background task settles on the microtask queue (empty fake selection → fast).
    await new Promise((r) => setImmediate(r));
    // GET /evaluator-run-jobs/:id reports the terminal state (workspace-scoped).
    const poll = await getEvaluatorRunJobHandler(ctx({ ws: "ws-A", id: job.id }), d);
    expect(poll.status).toBe(200);
    const polled = (await poll.json()) as { status: string; total: number };
    expect(polled.status).toBe("completed");
    expect(polled.total).toBe(0); // no traces in the fake engine → empty selection
  });

  it("test_poll_foreign_or_absent_job_is_404", async () => {
    const d = deps();
    const res = await runEvaluatorHandler(ctx({ ws: "ws-A" }), d);
    const job = (await res.json()) as { id: string };
    // A different workspace must NOT see ws-A's job (no cross-tenant leak) → 404.
    const foreign = await getEvaluatorRunJobHandler(ctx({ ws: "ws-B", id: job.id }), d);
    expect(foreign.status).toBe(404);
    // An absent id → 404.
    const absent = await getEvaluatorRunJobHandler(ctx({ ws: "ws-A", id: "nope" }), d);
    expect(absent.status).toBe(404);
  });
});

/**
 * M134 T2.3 (EC-7) — filter validity is enforced at WRITE time.
 *
 * The blueprint's filter ADR rejects validating only at evaluation time: an
 * unrecognised column throws inside the job, so a single typo becomes a job
 * that fails on every claim, is reclaimed by the orphan scan, and fails again —
 * forever (compounding with EC-8). Rejecting at the boundary keeps a config
 * mistake a 400.
 *
 * v1.0 of the plan mapped this requirement to the read-time predicate and
 * called the coverage matrix complete; it was not.
 */
describe("M134 write-time filter validation (T2.3)", () => {
  function writeDeps(): {
    deps: EvaluatorApiDeps;
    created: Record<string, unknown>[];
    updated: Record<string, unknown>[];
  } {
    const created: Record<string, unknown>[] = [];
    const updated: Record<string, unknown>[] = [];
    const repo = {
      createEvaluator: async (ev: Record<string, unknown>) => {
        created.push(ev);
        return { ...EVAL, ...ev };
      },
      updateEvaluator: async (_id: string, u: Record<string, unknown>) => {
        updated.push(u);
        return { ...EVAL, ...u };
      },
    } as unknown as EvaluatorApiDeps["repo"];
    return { deps: { repo } as unknown as EvaluatorApiDeps, created, updated };
  }

  const VALID = { column: "model", op: "eq", value: "claude" };
  const BAD_COLUMN = { column: "definitely_not_a_column", op: "eq", value: "x" };

  it("test_create_rejects_a_filter_naming_an_unknown_column", async () => {
    const { deps: d, created } = writeDeps();
    const res = await createEvaluatorHandler(
      ctx({ body: { name: "e", kind: "rule", config: { predicate: "" }, filter: [BAD_COLUMN] } }),
      d,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("INVALID_FILTER");
    // The message must name the offending column — an operator has to be able
    // to fix it without reading source.
    expect(body.message).toMatch(/definitely_not_a_column/);
    // And nothing was persisted.
    expect(created).toHaveLength(0);
  });

  it("test_create_accepts_a_valid_filter", async () => {
    const { deps: d, created } = writeDeps();
    const res = await createEvaluatorHandler(
      ctx({ body: { name: "e", kind: "rule", config: { predicate: "" }, filter: [VALID] } }),
      d,
    );
    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
    expect(created[0]!["filter"]).toEqual([VALID]);
  });

  it("test_update_rejects_an_unknown_column_and_leaves_the_row_untouched", async () => {
    const { deps: d, updated } = writeDeps();
    const res = await updateEvaluatorHandler(
      ctx({ body: { filter: [BAD_COLUMN] } }),
      d,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_FILTER");
    expect(updated).toHaveLength(0);
  });

  it("test_update_persists_the_auto_eval_knobs", async () => {
    // F-wire-1 (review). PATCH {autoEnabled:true} was accepted and validated by
    // the handler, built an EMPTY update set in the repository, hit the
    // "nothing to change" early return, and answered 200 with the OLD record.
    //
    // The consequence is not cosmetic: enabling auto-evaluation on an existing
    // evaluator was impossible through the API — delete-and-recreate was the
    // only path. The milestone's own goal is unreachable for any evaluator a
    // user already has.
    const { deps: d, updated } = writeDeps();

    const res = await updateEvaluatorHandler(
      ctx({ body: { autoEnabled: true, sampling: 0.25, filter: [VALID] } }),
      d,
    );

    expect(res.status).toBe(200);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      autoEnabled: true,
      sampling: 0.25,
      filter: [VALID],
    });
  });

  it("test_sampling_out_of_range_is_rejected", async () => {
    // The rate is the cost lever; a nonsense value must not reach the row.
    const { deps: d } = writeDeps();
    const res = await createEvaluatorHandler(
      ctx({ body: { name: "e", kind: "rule", config: { predicate: "" }, sampling: 1.5 } }),
      d,
    );
    expect(res.status).toBe(400);
  });

  it("test_auto_defaults_to_off_when_absent", async () => {
    // Upgrading must start no judge spend (plan Drawbacks #2).
    const { deps: d, created } = writeDeps();
    await createEvaluatorHandler(
      ctx({ body: { name: "e", kind: "rule", config: { predicate: "" } } }),
      d,
    );
    expect(created[0]!["autoEnabled"]).toBe(false);
  });
});
