import { describe, it, expect } from "vitest";

import { runEvaluator, type EngineDeps } from "./evaluator-engine.js";
import { evaluatorSchema } from "./evaluator.js";
import type { EvaluatorRecord } from "./evaluator-repository.js";
import type { JudgeClient } from "./llm-judge.js";
import type { SpanRepository, TraceTreeNode } from "./span-repository.js";

function rec(over: Record<string, unknown>): EvaluatorRecord {
  const ev = evaluatorSchema.parse({
    name: "quality",
    kind: "rule",
    config: { predicate: "" },
    ...over,
  });
  return { ...ev, id: "e1", createdAt: "2026-06-30T00:00:00Z" } as EvaluatorRecord;
}

/** A trace tree: root (no I/O) → one child with I/O. */
function tree(): TraceTreeNode {
  const child: TraceTreeNode = {
    spanId: "c", traceId: "t1", name: "child",
    startTimeUnixNano: "1", endTimeUnixNano: "2",
    inputValue: "hello", outputValue: "world",
    children: [],
  } as unknown as TraceTreeNode;
  return {
    spanId: "root", traceId: "t1", name: "root",
    startTimeUnixNano: "1", endTimeUnixNano: "2",
    children: [child],
  } as unknown as TraceTreeNode;
}

function deps(over: Partial<EngineDeps> = {}): { deps: EngineDeps; writes: { spanId: string; verdict: unknown }[] } {
  const writes: { spanId: string; verdict: unknown }[] = [];
  const evaluatorRepo = {
    writeVerdict: async (_ws: string, span: { spanId: string }, _n: string, verdict: unknown) => {
      writes.push({ spanId: span.spanId, verdict });
    },
    listEvaluators: async () => [],
  } as unknown as EngineDeps["evaluatorRepo"];
  const spanRepo = {
    listTraces: async () => ({ traces: [{ traceId: "t1" }] }),
    getTraceTree: async () => tree(),
  } as unknown as SpanRepository;
  return {
    writes,
    deps: { evaluatorRepo, spanRepo, judge: null, backfillMax: 500, ...over },
  };
}

describe("M36 run engine (T5.1)", () => {
  it("test_run_rule_evaluator_writes_pass_fail_verdicts", async () => {
    // default target = root span; empty predicate → pass
    const { deps: d, writes } = deps();
    const r = await runEvaluator(rec({}), {}, "ws", d);
    expect(r.written).toBe(1);
    expect(writes[0]!.spanId).toBe("root");
    expect(writes[0]!.verdict).toEqual({ score: 1, label: "pass" });
  });

  it("test_target_selector_picks_matching_spans", async () => {
    // target selects the child (name:child); rule predicate empty → pass on it
    const { deps: d, writes } = deps();
    const r = await runEvaluator(rec({ target: "name:child" }), {}, "ws", d);
    expect(r.written).toBe(1);
    expect(writes[0]!.spanId).toBe("c");
  });

  it("test_disabled_evaluator_is_noop", async () => {
    const { deps: d, writes } = deps();
    const r = await runEvaluator(rec({ enabled: false }), {}, "ws", d);
    expect(r.written).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it("test_judge_disabled_records_error_writes_nothing", async () => {
    const { deps: d, writes } = deps();
    const judgeEv = {
      ...evaluatorSchema.parse({ name: "j", kind: "llm_judge", config: { prompt: "rate", model: "m" }, target: "name:child" }),
      id: "e2", createdAt: "x",
    } as EvaluatorRecord;
    const r = await runEvaluator(judgeEv, {}, "ws", d); // judge: null
    expect(writes).toHaveLength(0);
    expect(r.errors[0]!.reason).toMatch(/judge not configured/);
  });

  it("test_judge_error_is_fail_closed_no_verdict", async () => {
    const throwingJudge: JudgeClient = {
      judge: async () => {
        throw new Error("503");
      },
    };
    const { deps: d, writes } = deps({ judge: throwingJudge });
    const judgeEv = {
      ...evaluatorSchema.parse({ name: "j", kind: "llm_judge", config: { prompt: "rate", model: "m" }, target: "name:child" }),
      id: "e2", createdAt: "x",
    } as EvaluatorRecord;
    const r = await runEvaluator(judgeEv, {}, "ws", d);
    expect(writes).toHaveLength(0); // no silent pass
    expect(r.errors).toHaveLength(1);
  });

  it("test_judge_skips_span_with_no_io", async () => {
    // target = root (no I/O) → judge skipped (EC-8)
    const okJudge: JudgeClient = { judge: async () => ({ score: 1 }) };
    const { deps: d, writes } = deps({ judge: okJudge });
    const judgeEv = {
      ...evaluatorSchema.parse({ name: "j", kind: "llm_judge", config: { prompt: "rate", model: "m" }, target: "" }),
      id: "e2", createdAt: "x",
    } as EvaluatorRecord;
    const r = await runEvaluator(judgeEv, {}, "ws", d);
    expect(r.skipped).toBe(1);
    expect(writes).toHaveLength(0);
  });

  it("test_backfill_respects_cap_truncated", async () => {
    const { deps: d } = deps();
    const r = await runEvaluator(rec({}), { traceIds: ["a", "b", "c"], limit: 2 }, "ws", d);
    expect(r.truncated).toBe(true); // 3 ids > cap 2
  });
});
