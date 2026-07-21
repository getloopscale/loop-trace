import type { ChatMessage, ReplayClient } from "../provider/chat.js";
import { ChatError } from "../provider/chat.js";
import { evaluateRule } from "./evaluator.js";
import type { JudgeClient } from "./llm-judge.js";
import type { EvaluatorRecord } from "./evaluator-repository.js";
import type { Span } from "../observability/span.js";
import type { ExperimentRunItem, RunScore, RunStatus, RunVariant } from "./experiment.js";
import { aggregateRun } from "./experiment.js";

/**
 * M64 — the experiment run engine (D3). PURE orchestration with DIP-injected deps (a ReplayClient, an
 * optional judge, and a clock): it loops the dataset items (bounded by {@link MAX_RUN_ITEMS}), applies
 * the variant (model/prompt override), calls the injected `replay.run` per item, and scores each output
 * with the enabled evaluators — `rule` via the pure `evaluateRule`, and `llm_judge` via the injected
 * judge when one is provided (each a billable call), so an experiment shows a real quality A/B. A
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
  /** The workspace's evaluators; the engine scores with the enabled rule + (when a judge is injected) llm_judge ones. */
  evaluators: EvaluatorRecord[];
}

export interface RunDeps {
  replay: ReplayClient;
  /**
   * Optional LLM judge. When provided, `llm_judge` evaluators ALSO score the replayed output (each is a
   * billable judge call) — so an experiment shows a real quality A/B. When null/absent the run stays
   * rule-only (backward compatible with the original M64 D2 slice).
   */
  judge?: JudgeClient | null;
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

/** input+output text a judge scores for a span (mirrors evaluator-engine's private spanIO). */
function spanIO(span: Span): string {
  return [span.inputValue ?? "", span.outputValue ?? ""].join("\n").trim();
}

/**
 * Score a replayed output with the enabled evaluators: `rule` evaluators via the pure `evaluateRule`,
 * and `llm_judge` evaluators via the injected `judge` (each a billable call) — so an experiment shows a
 * real quality A/B, not just rule verdicts. When no judge is injected, llm_judge evaluators are skipped
 * (rule-only, backward compatible). A judge error on one evaluator is swallowed per-evaluator
 * (fail-open — one provider hiccup never sinks the whole run; that item just carries fewer scores).
 */
async function scoreOutput(
  evaluators: EvaluatorRecord[],
  span: Span,
  judge: JudgeClient | null | undefined,
): Promise<RunScore[]> {
  const scores: RunScore[] = [];
  for (const ev of evaluators) {
    if (!ev.enabled) continue; // honor the M36 enabled flag — a disabled evaluator never scores
    if (ev.kind === "rule") {
      const verdict = evaluateRule(ev, span);
      scores.push({ name: ev.name, ...(verdict.score !== undefined ? { score: verdict.score } : {}), ...(verdict.label !== undefined ? { label: verdict.label } : {}) });
    } else if (ev.kind === "llm_judge" && judge != null) {
      const io = spanIO(span);
      if (io === "") continue; // nothing to judge
      try {
        const verdict = await judge.judge(ev.config.prompt, io);
        scores.push({ name: ev.name, ...(verdict.score !== undefined ? { score: verdict.score } : {}), ...(verdict.label !== undefined ? { label: verdict.label } : {}) });
      } catch {
        // fail-open per evaluator: a judge error drops this one score; the run continues.
      }
    }
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
      const scores = await scoreOutput(inp.evaluators, syntheticSpan(dsItem, result.content), deps.judge);
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
