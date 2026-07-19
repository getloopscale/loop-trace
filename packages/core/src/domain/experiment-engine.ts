import type { ChatMessage, ReplayClient } from "./chat.js";
import { ChatError } from "./chat.js";
import { evaluateRule } from "./evaluator.js";
import type { EvaluatorRecord } from "./evaluator-repository.js";
import type { Span } from "./observability/span.js";
import type { ExperimentRunItem, RunScore, RunStatus, RunVariant } from "./experiment.js";
import { aggregateRun } from "./experiment.js";

/**
 * M64 — the experiment run engine (D2/D3). PURE orchestration with DIP-injected deps (a ReplayClient +
 * a clock): it loops the dataset items (bounded by {@link MAX_RUN_ITEMS}), applies the variant
 * (model/prompt override), calls the injected `replay.run` per item, and scores each output with the
 * enabled **rule** evaluators (the pure `evaluateRule`, D2 — no llm_judge / no extra billable call). A
 * provider error on one item is recorded per-item (never a fabricated output) and the run is `partial`;
 * items beyond the cap are dropped and the run is `truncated`. No DB, no HTTP — the handler persists.
 */

/** Bounded run size — N items = N billable provider calls; the cap keeps a sync run cheap + fast (D3). */
export const MAX_RUN_ITEMS = 25;

/** A dataset item as the engine consumes it (a subset of the M44 DatasetItem — the provenance + input). */
export interface RunDatasetItem {
  traceId: string;
  inputSnapshot?: string;
  outputSnapshot?: string;
}

export interface RunInput {
  items: RunDatasetItem[];
  variant: RunVariant;
  /** The workspace's evaluators; the engine scores with the enabled RULE ones only (D2). */
  evaluators: EvaluatorRecord[];
}

export interface RunDeps {
  replay: ReplayClient;
  /** Injected clock (ms) for per-item latency — defaults to Date.now (deterministic-friendly in tests). */
  now?: () => number;
}

export interface RunOutput {
  items: ExperimentRunItem[];
  status: RunStatus;
  truncated: boolean;
  aggregate: ReturnType<typeof aggregateRun>;
}

/** Parse a dataset item's input snapshot into chat messages; a non-chat snapshot → one user message. */
function messagesFromSnapshot(snapshot: string | undefined): ChatMessage[] {
  const raw = snapshot ?? "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((m) => {
        const mm = m as { role?: unknown; content?: unknown };
        const role = mm.role === "system" || mm.role === "assistant" ? mm.role : "user";
        const content = typeof mm.content === "string" ? mm.content : JSON.stringify(mm.content ?? "");
        return { role, content };
      });
    }
  } catch {
    // not a chat array — fall through to a single user message
  }
  return [{ role: "user", content: raw }];
}

/** Build a minimal synthetic span so the pure rule evaluators can score the replayed output. */
function syntheticSpan(item: RunDatasetItem, output: string): Span {
  return {
    spanId: `exp-${item.traceId}`,
    traceId: item.traceId,
    name: "experiment-run",
    startTimeUnixNano: "0",
    endTimeUnixNano: "0",
    inputValue: item.inputSnapshot,
    outputValue: output,
  } as Span;
}

/** Score an output with the enabled RULE evaluators only (D2 — llm_judge deferred, no billable call). */
function scoreOutput(evaluators: EvaluatorRecord[], span: Span): RunScore[] {
  const scores: RunScore[] = [];
  for (const ev of evaluators) {
    if (!ev.enabled) continue; // honor the M36 enabled flag (evaluator-engine.ts:136) — a disabled evaluator never scores
    if (ev.kind !== "rule") continue; // D2: only pure rule evaluators score in the M64 slice
    const verdict = evaluateRule(ev, span);
    scores.push({ name: ev.name, ...(verdict.score !== undefined ? { score: verdict.score } : {}), ...(verdict.label !== undefined ? { label: verdict.label } : {}) });
  }
  return scores;
}

export async function runExperiment(inp: RunInput, deps: RunDeps): Promise<RunOutput> {
  const clock = deps.now ?? Date.now;
  const capped = inp.items.slice(0, MAX_RUN_ITEMS);
  const truncated = inp.items.length > MAX_RUN_ITEMS;
  const system: ChatMessage[] = inp.variant.promptOverride?.trim()
    ? [{ role: "system", content: inp.variant.promptOverride.trim() }]
    : [];

  const items: ExperimentRunItem[] = [];
  let errored = 0;
  for (const dsItem of capped) {
    const messages = [...system, ...messagesFromSnapshot(dsItem.inputSnapshot)];
    const t0 = clock();
    try {
      const result = await deps.replay.run(messages, inp.variant.model);
      const latencyMs = Math.max(0, clock() - t0);
      const scores = scoreOutput(inp.evaluators, syntheticSpan(dsItem, result.content));
      items.push({
        datasetItemTraceId: dsItem.traceId,
        ...(dsItem.inputSnapshot !== undefined ? { inputSnapshot: dsItem.inputSnapshot } : {}),
        output: result.content,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        totalTokens: result.totalTokens,
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
        latencyMs,
        model: result.model,
        scores,
      });
    } catch (err) {
      // Fail-closed per item: record the error, NEVER a fabricated output; the run continues.
      errored += 1;
      const reason = err instanceof ChatError ? err.message : String(err);
      items.push({
        datasetItemTraceId: dsItem.traceId,
        ...(dsItem.inputSnapshot !== undefined ? { inputSnapshot: dsItem.inputSnapshot } : {}),
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: Math.max(0, clock() - t0),
        model: inp.variant.model ?? "",
        scores: [],
        error: reason,
      });
    }
  }

  const status: RunStatus = errored === 0 ? "completed" : errored === items.length ? "failed" : "partial";
  return { items, status, truncated, aggregate: aggregateRun(items) };
}
