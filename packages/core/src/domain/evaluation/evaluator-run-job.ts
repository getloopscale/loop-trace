/**
 * M133 — async evaluator-run jobs. A manual evaluator run (`POST /v1/evaluators/:id/run`) used
 * to score every selected span synchronously inside the HTTP request; an `llm_judge` fan-out
 * over N spans exceeded the edge timeout (the run returned 502 with NO verdict written — a
 * silent failure). The run is now async: the route registers a job, returns 202 immediately,
 * and a background task scores with bounded concurrency (see {@link runEvaluator}), updating
 * the job's `scored/total` progress. The client polls `GET /v1/evaluator-run-jobs/:id`.
 *
 * Scalability: the two bottlenecks are removed — the POST no longer blocks on the fan-out
 * (no timeout, scales with N), and the fan-out is bounded-concurrent (no serial stall, no
 * provider flood). v1 keeps the registry IN-MEMORY (looptrace is single-process), so job
 * state is lost on restart; a durable, multi-instance store (Postgres / a queue) is the
 * documented follow-up.
 */
import { randomUUID } from "node:crypto";

import type { EvaluatorRecord } from "./evaluator-repository.js";
import type { RunResult } from "./evaluator.js";
import { runEvaluator, type EngineDeps, type RunOptions } from "./evaluator-engine.js";

export type RunJobStatus = "queued" | "running" | "completed" | "failed";

export interface EvaluatorRunJob {
  id: string;
  workspaceId: string;
  evaluatorId: string;
  evaluatorName: string;
  status: RunJobStatus;
  /** Total target spans selected (the denominator for progress). */
  total: number;
  /** Spans with a verdict written so far. */
  scored: number;
  skipped: number;
  errors: number;
  truncated: boolean;
  errorMessage?: string;
  /**
   * Per-span failures, same shape the synchronous `RunResult` carried.
   *
   * `errors` above is only a COUNT. Keeping the count alone made the async job
   * strictly less informative than the endpoint it replaced, which is what let
   * the SDK's `runEvaluator` (still typed `Promise<RunResult>`) silently return
   * a job view with `written: undefined`. An async contract that drops
   * information the sync one provided is a regression, not a refactor.
   */
  errorDetails: { spanId: string; reason: string }[];
  createdAt: string;
  updatedAt: string;
}

/** Public view of a job — no `workspaceId` (the API scopes by the caller's principal). */
export type EvaluatorRunJobView = Omit<EvaluatorRunJob, "workspaceId">;

export function toRunJobView(job: EvaluatorRunJob): EvaluatorRunJobView {
  const { workspaceId: _ws, ...view } = job;
  return view;
}

export interface RunJobRegistryOptions {
  /** Injected clock (ISO) for deterministic tests; defaults to `new Date().toISOString()`. */
  now?: () => string;
  /** Injected id generator; defaults to `crypto.randomUUID`. */
  newId?: () => string;
  /** Max jobs retained before the oldest is evicted (bounds memory). */
  maxJobs?: number;
}

/**
 * In-memory, workspace-scoped registry of evaluator-run jobs. Insertion-ordered so eviction
 * drops the oldest; reads are workspace-scoped so a foreign job id resolves to `null` (never a
 * cross-tenant leak). Single-process only — see the module header for the durability follow-up.
 */
export class EvaluatorRunJobRegistry {
  private readonly jobs = new Map<string, EvaluatorRunJob>();
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly maxJobs: number;

  constructor(opts: RunJobRegistryOptions = {}) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.newId = opts.newId ?? (() => randomUUID());
    this.maxJobs = opts.maxJobs ?? 500;
  }

  create(workspaceId: string, evaluatorId: string, evaluatorName: string): EvaluatorRunJob {
    const ts = this.now();
    const job: EvaluatorRunJob = {
      id: this.newId(),
      workspaceId,
      evaluatorId,
      evaluatorName,
      status: "queued",
      total: 0,
      scored: 0,
      skipped: 0,
      errors: 0,
      errorDetails: [],
      truncated: false,
      createdAt: ts,
      updatedAt: ts,
    };
    this.jobs.set(job.id, job);
    this.evictIfNeeded();
    return job;
  }

  /** Workspace-scoped read: a foreign/absent job id → null. */
  get(workspaceId: string, id: string): EvaluatorRunJob | null {
    const job = this.jobs.get(id);
    return job && job.workspaceId === workspaceId ? job : null;
  }

  update(id: string, patch: Partial<Omit<EvaluatorRunJob, "id" | "workspaceId" | "createdAt">>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    Object.assign(job, patch, { updatedAt: this.now() });
  }

  private evictIfNeeded(): void {
    while (this.jobs.size > this.maxJobs) {
      const oldest = this.jobs.keys().next().value; // Map preserves insertion order
      if (oldest === undefined) break;
      this.jobs.delete(oldest);
    }
  }
}

/** Project a run result onto the job's progress counters. */
function progressOf(
  r: RunResult,
): Pick<EvaluatorRunJob, "total" | "scored" | "skipped" | "errors" | "errorDetails" | "truncated"> {
  return {
    total: r.total,
    scored: r.written,
    skipped: r.skipped,
    errors: r.errors.length,
    // Carry the detail, not just the count — see `errorDetails` on the interface.
    errorDetails: r.errors,
    truncated: r.truncated,
  };
}

/**
 * The background task for a registered job: mark it running, score with bounded concurrency
 * (progress streamed into the registry per span), then mark it completed — or failed (fail-
 * closed: the error is recorded on the job, never swallowed). Fire-and-forget from the route;
 * this never throws (a thrown scoring error is caught and recorded as `failed`).
 */
export async function runEvaluatorRunJob(
  registry: EvaluatorRunJobRegistry,
  jobId: string,
  ev: EvaluatorRecord,
  opts: RunOptions,
  workspaceId: string,
  deps: EngineDeps,
): Promise<void> {
  registry.update(jobId, { status: "running" });
  try {
    const result = await runEvaluator(ev, opts, workspaceId, deps, {
      onProgress: (r) => registry.update(jobId, progressOf(r)),
    });
    registry.update(jobId, { status: "completed", ...progressOf(result) });
  } catch (err) {
    registry.update(jobId, {
      status: "failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}
