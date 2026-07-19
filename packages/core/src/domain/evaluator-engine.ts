/**
 * M36 — the run engine (D5): runs an evaluator over a bounded selection of traces,
 * OFF the ingest hot path, and writes one verdict per matched span into the existing
 * `span_evaluations` store (D2). Reads spans via {@link SpanRepository} (no new span
 * loading — reuses `getTraceTree`, which gives spans + children for kind derivation);
 * writes via {@link EvaluatorRepository}; calls the injected {@link JudgeClient} for
 * `llm_judge` evaluators (null → judge disabled → fail-closed error per span).
 */
import {
  evaluateRule,
  spanMatchesPredicate,
  type RunResult,
} from "./evaluator.js";
import type { EvaluatorRecord, EvaluatorRepository } from "./evaluator-repository.js";
import type { JudgeClient } from "./llm-judge.js";
import { JudgeError } from "./llm-judge.js";
import { DEFAULT_WORKSPACE_ID } from "./principal.js";
import type { Span } from "./observability/span.js";
import type { SpanRepository, TraceTreeNode } from "./observability/span-repository.js";

export interface EngineDeps {
  evaluatorRepo: EvaluatorRepository;
  spanRepo: SpanRepository;
  /** null = judge not configured → `llm_judge` evaluators fail closed (EC of Q3). */
  judge: JudgeClient | null;
  /** Per-backfill trace cap (D7). */
  backfillMax: number;
}

export interface RunOptions {
  traceIds?: string[];
  limit?: number;
}

interface FlatSpan {
  span: Span;
  hasChildren: boolean;
}

/** Flatten a trace tree into spans + a hasChildren flag (for kind derivation). */
function flatten(node: TraceTreeNode, out: FlatSpan[]): void {
  const { children, ...rest } = node;
  out.push({ span: rest as Span, hasChildren: children.length > 0 });
  for (const c of children) flatten(c, out);
}

/** The text a judge evaluates for a span (input + output, may be empty). */
function spanIO(span: Span): string {
  return [span.inputValue ?? "", span.outputValue ?? ""].join("\n").trim();
}

/**
 * Run one evaluator over the selected traces. Disabled evaluator → no-op. The trace
 * set is bounded by `backfillMax` (D7); `truncated` is set when the cap is hit.
 */
export async function runEvaluator(
  ev: EvaluatorRecord,
  opts: RunOptions,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
  deps: EngineDeps,
): Promise<RunResult> {
  const result: RunResult = {
    evaluator: ev.name,
    written: 0,
    skipped: 0,
    truncated: false,
    errors: [],
  };
  if (!ev.enabled) return result;

  // Resolve the trace id set (bounded by the cap, D7).
  const cap = Math.min(opts.limit ?? deps.backfillMax, deps.backfillMax);
  let traceIds: string[];
  if (opts.traceIds) {
    traceIds = opts.traceIds.slice(0, cap);
    result.truncated = opts.traceIds.length > cap;
  } else {
    // Fetch cap+1 so "exactly cap traces" is NOT a false-positive truncation (EC-10):
    // truncated iff strictly MORE than cap exist; then process only the first cap.
    const list = await deps.spanRepo.listTraces({ limit: cap + 1 }, workspaceId);
    const all = list.traces.map((t) => t.traceId);
    result.truncated = all.length > cap;
    traceIds = all.slice(0, cap);
  }

  for (const traceId of traceIds) {
    const tree = await deps.spanRepo.getTraceTree(traceId, workspaceId);
    if (tree == null) continue;
    const flat: FlatSpan[] = [];
    flatten(tree, flat);
    // Target selector (D3): empty target → the root span only; else span-query filter.
    const targets =
      ev.target.trim() === ""
        ? [flat[0]!] // root (tree root is first)
        : flat.filter((f) => spanMatchesPredicate(ev.target, f.span, f.hasChildren));

    for (const { span, hasChildren } of targets) {
      if (ev.kind === "rule") {
        const verdict = evaluateRule(ev, span, hasChildren);
        await deps.evaluatorRepo.writeVerdict(workspaceId, span, ev.name, verdict);
        result.written += 1;
        continue;
      }
      // llm_judge
      if (deps.judge == null) {
        result.errors.push({ spanId: span.spanId, reason: "judge not configured" });
        continue;
      }
      const io = spanIO(span);
      if (io === "") {
        result.skipped += 1; // EC-8: nothing to judge
        continue;
      }
      try {
        const verdict = await deps.judge.judge(ev.config.prompt, io);
        await deps.evaluatorRepo.writeVerdict(workspaceId, span, ev.name, verdict);
        result.written += 1;
      } catch (err) {
        // Fail-closed: record the error, write NO verdict, continue the run.
        const reason = err instanceof JudgeError ? err.message : String(err);
        result.errors.push({ spanId: span.spanId, reason });
      }
    }
  }
  return result;
}

/** Run every ENABLED evaluator over recent traces (the opt-in periodic sweep, D5). */
export async function runSweep(
  workspaceId: string = DEFAULT_WORKSPACE_ID,
  deps: EngineDeps,
): Promise<RunResult[]> {
  const evaluators = await deps.evaluatorRepo.listEvaluators(workspaceId);
  const results: RunResult[] = [];
  for (const ev of evaluators) {
    if (!ev.enabled) continue;
    results.push(await runEvaluator(ev, {}, workspaceId, deps));
  }
  return results;
}
