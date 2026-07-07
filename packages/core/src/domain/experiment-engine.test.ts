import { describe, it, expect } from "vitest";

import type { ChatMessage, ReplayClient, ReplayResult } from "./chat.js";
import { ChatError } from "./chat.js";
import type { EvaluatorRecord } from "./evaluator-repository.js";
import { runExperiment, MAX_RUN_ITEMS, type RunInput } from "./experiment-engine.js";

// A fake replay client: returns a canned output (or throws on a chosen item index).
function fakeReplay(opts: { output?: string; throwOnIndex?: number } = {}): ReplayClient & { calls: number } {
  let calls = 0;
  const client = {
    calls: 0,
    async run(_m: ChatMessage[], model?: string): Promise<ReplayResult> {
      const i = calls++;
      client.calls = calls;
      if (opts.throwOnIndex === i) throw new ChatError("provider 502");
      return {
        content: opts.output ?? `output-${i}`,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        costUsd: 0.001,
        model: model ?? "m",
      };
    },
  };
  return client;
}

// A rule evaluator that passes when the output contains "good".
const ruleEvaluator = {
  id: "e1",
  name: "has-good",
  kind: "rule",
  config: { predicate: "output:good" },
  passLabel: "pass",
  failLabel: "fail",
  target: "",
  enabled: true,
  createdAt: "2026-07-07T00:00:00Z",
} as unknown as EvaluatorRecord;

const llmJudgeEvaluator = {
  id: "e2",
  name: "quality-judge",
  kind: "llm_judge",
  config: { prompt: "rate it" },
  enabled: true,
  createdAt: "2026-07-07T00:00:00Z",
} as unknown as EvaluatorRecord;

// A DISABLED rule evaluator — must NEVER score (honors the M36 enabled flag).
const disabledRuleEvaluator = {
  id: "e3",
  name: "disabled-rule",
  kind: "rule",
  config: { predicate: "output:good" },
  passLabel: "pass",
  failLabel: "fail",
  target: "",
  enabled: false,
  createdAt: "2026-07-07T00:00:00Z",
} as unknown as EvaluatorRecord;

function input(items: RunInput["items"], over: Partial<RunInput> = {}): RunInput {
  return {
    items,
    variant: { model: "gpt-x" },
    evaluators: [ruleEvaluator],
    ...over,
  };
}

const DS_ITEM = { traceId: "t1", inputSnapshot: JSON.stringify([{ role: "user", content: "hi" }]), outputSnapshot: "orig" };

describe("M64 runExperiment (DIP engine)", () => {
  it("test_run_produces_output_and_scores_per_item", async () => {
    const replay = fakeReplay({ output: "a good answer" });
    const out = await runExperiment(input([DS_ITEM]), { replay });
    expect(out.items).toHaveLength(1);
    expect(out.items[0].output).toBe("a good answer");
    expect(out.items[0].totalTokens).toBe(15);
    expect(out.items[0].costUsd).toBe(0.001);
    // scored by the rule evaluator (output contains "good" → pass)
    expect(out.items[0].scores).toEqual([{ name: "has-good", score: 1, label: "pass" }]);
    expect(out.status).toBe("completed");
    expect(out.truncated).toBe(false);
  });

  it("test_run_caps_at_max_items_and_flags_truncated", async () => {
    const many = Array.from({ length: MAX_RUN_ITEMS + 5 }, (_, i) => ({ ...DS_ITEM, traceId: `t${i}` }));
    const out = await runExperiment(input(many), { replay: fakeReplay() });
    expect(out.items).toHaveLength(MAX_RUN_ITEMS);
    expect(out.truncated).toBe(true);
  });

  it("test_run_partial_on_provider_error (no fabricated output)", async () => {
    const replay = fakeReplay({ throwOnIndex: 1 });
    const out = await runExperiment(input([{ ...DS_ITEM, traceId: "t1" }, { ...DS_ITEM, traceId: "t2" }, { ...DS_ITEM, traceId: "t3" }]), { replay });
    expect(out.items).toHaveLength(3);
    expect(out.items[0].output).toBeDefined(); // item 0 ran
    expect(out.items[1].error).toBeDefined(); // item 1 errored — recorded, not fabricated
    expect(out.items[1].output).toBeUndefined(); // no fabricated output
    expect(out.items[2].output).toBeDefined(); // item 2 still ran (error is per-item, not fatal)
    expect(out.status).toBe("partial");
  });

  it("test_run_scores_with_enabled_rule_evaluators_only (llm_judge skipped — D2)", async () => {
    // an llm_judge in the evaluator set is NOT run (no extra billable call); only rule evaluators score.
    const replay = fakeReplay({ output: "a good answer" });
    const out = await runExperiment(input([DS_ITEM], { evaluators: [ruleEvaluator, llmJudgeEvaluator] }), { replay });
    expect(out.items[0].scores.map((s) => s.name)).toEqual(["has-good"]); // only the rule evaluator
  });

  it("test_run_skips_disabled_rule_evaluators (honors the M36 enabled flag)", async () => {
    // a DISABLED rule evaluator in the set must not score — else pass-counts corrupt.
    const replay = fakeReplay({ output: "a good answer" });
    const out = await runExperiment(input([DS_ITEM], { evaluators: [disabledRuleEvaluator, ruleEvaluator] }), { replay });
    expect(out.items[0].scores.map((s) => s.name)).toEqual(["has-good"]); // only the ENABLED rule
  });

  it("test_run_applies_prompt_override_as_a_system_message", async () => {
    // the variant promptOverride is prepended as a system message to each item's input.
    let captured: ChatMessage[] = [];
    const replay: ReplayClient = {
      async run(messages: ChatMessage[], model?: string): Promise<ReplayResult> {
        captured = messages;
        return { content: "ok", promptTokens: 1, completionTokens: 1, totalTokens: 2, model: model ?? "m" };
      },
    };
    await runExperiment(input([DS_ITEM], { variant: { model: "m", promptOverride: "Be terse." } }), { replay });
    expect(captured[0]).toEqual({ role: "system", content: "Be terse." });
    expect(captured[1]).toEqual({ role: "user", content: "hi" }); // the item's original message follows
  });
});
