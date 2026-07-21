/**
 * M36 — persistence port for evaluators + guards (D1: a SEPARATE repository from
 * `SpanRepository`, which is already 1553 LoC — keeping cohesion + the ~500-LoC
 * budget). Every method is workspace-scoped (M22 invariant 2). The run engine
 * (`evaluator-engine.ts`) reads spans via `SpanRepository` and writes verdicts here.
 */
import type { Evaluator, Monitor, Verdict } from "./evaluator.js";

/** A persisted evaluator (definition + server-assigned id/createdAt). `Evaluator` is a
 * discriminated union, so this is an intersection type (an interface cannot `extends`
 * a union). */
export type EvaluatorRecord = Evaluator & { id: string; createdAt: string };

/** A persisted guard. */
export type MonitorRecord = Monitor & { id: string; createdAt: string };

export interface EvaluatorRepository {
  /** Create-or-update on `(workspace_id, name)` — idempotent (D2/D6). */
  createEvaluator(ev: Evaluator, workspaceId?: string): Promise<EvaluatorRecord>;
  listEvaluators(workspaceId?: string): Promise<EvaluatorRecord[]>;
  getEvaluator(id: string, workspaceId?: string): Promise<EvaluatorRecord | null>;
  /** M82: partial edit (rename/enable/config). Returns the updated record, null if absent; throws NameConflictError on a duplicate name. */
  updateEvaluator(id: string, updates: Partial<Evaluator>, workspaceId?: string): Promise<EvaluatorRecord | null>;
  /** Deletes the evaluator AND cascades its guards in one transaction (EC-4). */
  deleteEvaluator(id: string, workspaceId?: string): Promise<void>;

  createMonitor(guard: Monitor, workspaceId?: string): Promise<MonitorRecord>;
  listMonitors(workspaceId?: string): Promise<MonitorRecord[]>;
  deleteMonitor(id: string, workspaceId?: string): Promise<void>;

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
  listBreachingTraces(monitorId: string, workspaceId?: string): Promise<string[]>;
  /**
   * M135 — per-guard breach counts over a window, for the scheduled evaluator.
   *
   * `hasData` is the load-bearing field, not `breachCount`. A window where
   * traces were evaluated and none breached (`hasData: true, breachCount: 0`)
   * is a MEASUREMENT of zero; a window with nothing to evaluate
   * (`hasData: false`) is ABSENCE. Collapsing the two is precisely
   * theo-cloud#247, where an empty window read as a real zero and fired every
   * below-threshold rule permanently.
   */
  monitorBreachWindow(
    monitorId: string,
    windowSeconds: number,
    workspaceId?: string,
  ): Promise<MonitorBreachWindow>;
}

/** The windowed breach summary a scheduled guard evaluation reads. */
export interface MonitorBreachWindow {
  /** Distinct traces in the window that breached the guard. */
  breachCount: number;
  /** Distinct traces in the window carrying a verdict for the guard's evaluator. */
  evaluatedCount: number;
  /** False when the window held nothing to evaluate — absence, not a zero. */
  hasData: boolean;
  /**
   * False when no guard with this id exists IN THIS WORKSPACE — covering both "no such guard" and
   * "belongs to another workspace", deliberately collapsed so the answer cannot be used to confirm
   * another tenant's id.
   *
   * This is NOT hasData. A real guard whose window is empty is `{guardExists: true, hasData: false}`;
   * a deleted guard is `{guardExists: false, hasData: false}`. The consumer must be able to tell
   * "nothing happened" from "the thing you are monitoring is gone" — the first self-heals, the
   * second never does, and treating them alike leaves an armed rule that can never fire.
   */
  guardExists: boolean;
}
