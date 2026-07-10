/**
 * M36 — persistence port for evaluators + guards (D1: a SEPARATE repository from
 * `SpanRepository`, which is already 1553 LoC — keeping cohesion + the ~500-LoC
 * budget). Every method is workspace-scoped (M22 invariant 2). The run engine
 * (`evaluator-engine.ts`) reads spans via `SpanRepository` and writes verdicts here.
 */
import type { Evaluator, Guard, Verdict } from "./evaluator.js";

/** A persisted evaluator (definition + server-assigned id/createdAt). `Evaluator` is a
 * discriminated union, so this is an intersection type (an interface cannot `extends`
 * a union). */
export type EvaluatorRecord = Evaluator & { id: string; createdAt: string };

/** A persisted guard. */
export type GuardRecord = Guard & { id: string; createdAt: string };

export interface EvaluatorRepository {
  /** Create-or-update on `(workspace_id, name)` — idempotent (D2/D6). */
  createEvaluator(ev: Evaluator, workspaceId?: string): Promise<EvaluatorRecord>;
  listEvaluators(workspaceId?: string): Promise<EvaluatorRecord[]>;
  getEvaluator(id: string, workspaceId?: string): Promise<EvaluatorRecord | null>;
  /** M82: partial edit (rename/enable/config). Returns the updated record, null if absent; throws NameConflictError on a duplicate name. */
  updateEvaluator(id: string, updates: Partial<Evaluator>, workspaceId?: string): Promise<EvaluatorRecord | null>;
  /** Deletes the evaluator AND cascades its guards in one transaction (EC-4). */
  deleteEvaluator(id: string, workspaceId?: string): Promise<void>;

  createGuard(guard: Guard, workspaceId?: string): Promise<GuardRecord>;
  listGuards(workspaceId?: string): Promise<GuardRecord[]>;
  deleteGuard(id: string, workspaceId?: string): Promise<void>;

  /**
   * Idempotent verdict write into `span_evaluations` (upsert on the workspace-leading
   * `(workspace_id, span_id, name)` — re-running an evaluator never duplicates, D2).
   */
  writeVerdict(
    workspaceId: string,
    span: { spanId: string; traceId: string },
    name: string,
    verdict: Verdict,
  ): Promise<void>;

  /**
   * Trace ids whose verdict for the guard's evaluator breaches its threshold,
   * scoped to the workspace (flag-only surfacing, D6). Empty when the guard or its
   * evaluator is absent.
   */
  listBreachingTraces(guardId: string, workspaceId?: string): Promise<string[]>;
}
