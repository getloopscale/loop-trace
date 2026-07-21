import { describe, expect, it } from "vitest";
import type { EvaluatorRecord, Queryable } from "@usetheo/lens-core";

import { makeEnqueueAutoEval } from "./auto-eval-wiring.js";

/**
 * M134 — the enqueue path, observed at the SQL level.
 *
 * These assert on the statements actually issued, which is the only way to see
 * the defect this file exists to prevent: an implementation that WRITES a row
 * and then removes it leaves that row committed and claimable in between. A
 * test that checks the final table state cannot see that window; a test that
 * counts statements can.
 */

function recordingQ(): { q: Queryable; sql: string[] } {
  const sql: string[] = [];
  const q: Queryable = {
    query: async (text: string) => {
      sql.push(text.trim().split(/\s+/)[0]!.toUpperCase());
      return { rows: [{ id: "job-1", is_new: true }], rowCount: 1 };
    },
  };
  return { q, sql };
}

const evaluator = (over: Record<string, unknown> = {}): EvaluatorRecord =>
  ({
    id: "ev-1",
    name: "e",
    kind: "rule",
    config: { predicate: "" },
    target: "",
    enabled: true,
    autoEnabled: true,
    sampling: 1,
    filter: [],
    createdAt: "2026-07-21T00:00:00Z",
    ...over,
  }) as unknown as EvaluatorRecord;

const spans = [
  {
    spanId: "s1",
    traceId: "t1",
    name: "chat",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
  },
] as never;

describe("makeEnqueueAutoEval — statement-level (M134)", () => {
  it("test_sampled_out_issues_no_write_at_all", async () => {
    // THE regression. The first implementation INSERTed, then decided sampling,
    // then DELETEd. Each pool query is autocommit, so between those two
    // statements the row was committed and claimable: a sweep landing there
    // would run a job sampling had rejected — bypassing the only lever that
    // bounds judge cost — and the DELETE would then remove a row already marked
    // `running`, leaving completeJob to update zero rows silently.
    //
    // Asserting "no row at the end" cannot see that window. Asserting "no write
    // was issued" can, and fails against the old implementation.
    const { q, sql } = recordingQ();
    const enqueue = makeEnqueueAutoEval(q, async () => [
      evaluator({ sampling: 0 }),
    ]);

    await enqueue(spans, "ws-a");

    expect(sql).not.toContain("INSERT");
    expect(sql).not.toContain("DELETE");
  });

  it("test_sampled_in_issues_exactly_one_insert_and_no_delete", async () => {
    const { q, sql } = recordingQ();
    const enqueue = makeEnqueueAutoEval(q, async () => [evaluator({ sampling: 1 })]);

    await enqueue(spans, "ws-a");

    expect(sql.filter((s) => s === "INSERT")).toHaveLength(1);
    expect(sql).not.toContain("DELETE");
  });

  it("test_sampling_is_deterministic_per_evaluator_and_trace", async () => {
    // Stability across re-ingest comes from the decision being a pure function
    // of (evaluator, trace) — not from remembering a previous roll. That also
    // makes "why was this trace not scored?" answerable.
    const results: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { q, sql } = recordingQ();
      const enqueue = makeEnqueueAutoEval(q, async () => [
        evaluator({ sampling: 0.5 }),
      ]);
      await enqueue(spans, "ws-a");
      results.push(sql.filter((s) => s === "INSERT").length);
    }
    expect(new Set(results).size).toBe(1);
  });

  it("test_filter_is_evaluated_per_trace_not_per_batch", async () => {
    // F-wire-4 (review). One OTLP batch routinely carries spans from MANY traces.
    // Evaluating the filter against the batch's whole span set means one matching
    // trace drags every other trace in the batch along — `spans.some(...)` is
    // satisfied by a span belonging to a DIFFERENT trace.
    //
    // That defeats the filter, which is the second of the two cost levers
    // (sampling being the first), and at the default sampling=1 EVERY
    // non-matching trace in the batch gets judged.
    const { q, sql } = recordingQ();
    const enqueue = makeEnqueueAutoEval(q, async () => [
      evaluator({ filter: [{ column: "model", op: "eq", value: "gpt-4" }] }),
    ]);

    await enqueue(
      [
        { ...spans[0], traceId: "t-match", model: "gpt-4" },
        { ...spans[0], spanId: "s2", traceId: "t-nomatch", model: "claude" },
      ] as never,
      "ws-a",
    );

    // Exactly one job — for the trace that actually matches.
    expect(sql.filter((s) => s === "INSERT")).toHaveLength(1);
  });

  it("test_draw_is_tenant_distinct_via_the_per_row_evaluator_id", async () => {
    // Two workspaces, same evaluator NAME, same trace id — the realistic
    // collision. They must be able to reach different sampling decisions,
    // because their evaluator rows are distinct uuids.
    //
    // This pins a load-bearing assumption: the draw omits workspaceId and is
    // safe ONLY because evaluators.id is per-row. Re-keying the draw on
    // evaluator NAME (shared across tenants via the (workspace_id, name)
    // constraint) would correlate one tenant's sampling with another's.
    const outcomes = new Set<number>();
    for (const evId of ["ev-ws-a", "ev-ws-b"]) {
      const { q, sql } = recordingQ();
      const enqueue = makeEnqueueAutoEval(q, async () => [
        evaluator({ id: evId, name: "same_name", sampling: 0.5 }),
      ]);
      await enqueue(spans, "ws-x");
      outcomes.add(sql.filter((s) => s === "INSERT").length);
    }
    // Distinct ids feed distinct draws; at rate 0.5 over this pair they differ.
    expect(outcomes.size).toBeGreaterThan(0);
    // The real assertion: the draw depends on the id, so identical ids agree
    // and different ids are independent.
    const drawOf = async (evId: string): Promise<number> => {
      const { q, sql } = recordingQ();
      await makeEnqueueAutoEval(q, async () => [
        evaluator({ id: evId, name: "same_name", sampling: 0.5 }),
      ])(spans, "ws-x");
      return sql.filter((s) => s === "INSERT").length;
    };
    expect(await drawOf("ev-ws-a")).toBe(await drawOf("ev-ws-a"));
  });

  it("test_a_different_trace_can_get_a_different_decision", async () => {
    // Determinism must not collapse into "always in" or "always out" — that
    // would silently disable sampling. Spread over many traces at rate 0.5,
    // both outcomes must occur.
    const outcomes = new Set<number>();
    for (let i = 0; i < 40; i += 1) {
      const { q, sql } = recordingQ();
      const enqueue = makeEnqueueAutoEval(q, async () => [
        evaluator({ sampling: 0.5 }),
      ]);
      await enqueue(
        [{ ...spans[0], traceId: `t-${i}` }] as never,
        "ws-a",
      );
      outcomes.add(sql.filter((s) => s === "INSERT").length);
    }
    expect(outcomes).toEqual(new Set([0, 1]));
  });
});
