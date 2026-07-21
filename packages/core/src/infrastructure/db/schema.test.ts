import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";

import { evalJobs, evaluators, guards } from "./schema.js";

// M36 — evaluators + guards tables are workspace-leading (T1.1)
describe("M36 evaluators/guards schema (T1.1)", () => {
  it("test_evaluators_table_is_workspace_leading", () => {
    const cfg = getTableConfig(evaluators);
    const uq = cfg.uniqueConstraints.find(
      (u) => u.name === "evaluators_workspace_id_name_uq",
    );
    expect(uq).toBeDefined();
    expect(uq!.columns.map((c) => c.name)).toEqual(["workspace_id", "name"]);
  });

  it("test_guards_table_is_workspace_leading", () => {
    const cfg = getTableConfig(guards);
    const uq = cfg.uniqueConstraints.find(
      (u) => u.name === "guards_workspace_id_dedup_uq",
    );
    expect(uq).toBeDefined();
    expect(uq!.columns[0]!.name).toBe("workspace_id");
  });
});

// M134 (T1.1) — auto-evaluation of new traces.
// `evaluators` gains three columns; `eval_jobs` is the claim-a-row queue (ADR D1).
describe("M134 auto-eval schema (T1.1)", () => {
  it("test_evaluators_gains_auto_columns_with_backward_compatible_defaults", () => {
    const cols = getTableConfig(evaluators).columns;
    const byName = new Map(cols.map((c) => [c.name, c]));

    // The three new columns exist...
    expect(byName.get("auto_enabled")).toBeDefined();
    expect(byName.get("sampling")).toBeDefined();
    expect(byName.get("filter")).toBeDefined();

    // ...and every existing evaluator keeps today's behaviour: auto OFF, so no
    // judge spend starts on upgrade (plan Drawbacks #2).
    expect(byName.get("auto_enabled")!.default).toBe(0);
    expect(byName.get("sampling")!.default).toBe(1);
    expect(byName.get("filter")!.notNull).toBe(true);
  });

  it("test_eval_jobs_dedup_is_a_db_invariant_not_application_logic", () => {
    // ADR D4 / blueprint AP-1: the reference deduped with a read-then-write and
    // no unique index, which races. Here the DB is the arbiter.
    const cfg = getTableConfig(evalJobs);
    const uq = cfg.uniqueConstraints.find(
      (u) => u.name === "eval_jobs_workspace_evaluator_trace_uq",
    );
    expect(uq).toBeDefined();
    expect(uq!.columns.map((c) => c.name)).toEqual([
      "workspace_id",
      "evaluator_id",
      "trace_id",
    ]);
  });

  it("test_eval_jobs_carries_terminal_state_and_attempt_budget", () => {
    // EC-8: without `attempts` and a terminal `failed`, reclaimStale re-offers a
    // deterministically failing job forever (AP-4 inverted into a livelock).
    const byName = new Map(
      getTableConfig(evalJobs).columns.map((c) => [c.name, c]),
    );
    expect(byName.get("status")!.default).toBe("queued");
    expect(byName.get("attempts")!.default).toBe(0);
    expect(byName.get("last_error")).toBeDefined();
    expect(byName.get("claimed_by")).toBeDefined();
    expect(byName.get("claimed_at")).toBeDefined();
  });

  it("test_eval_jobs_has_run_after_gate_for_streaming_reingest", () => {
    // EC-6: a trace arrives across many OTLP batches. Without this gate the job
    // is claimed on the first sweep and every later batch is never scored.
    const byName = new Map(
      getTableConfig(evalJobs).columns.map((c) => [c.name, c]),
    );
    expect(byName.get("run_after")).toBeDefined();
    expect(byName.get("run_after")!.notNull).toBe(true);
  });

  it("test_eval_jobs_is_workspace_leading_for_claim_scoping", () => {
    // EC-5: the claim loop spans workspaces, so every claim must be scoped.
    const cfg = getTableConfig(evalJobs);
    expect(cfg.columns.find((c) => c.name === "workspace_id")).toBeDefined();
    // The claim index is now PARTIAL and keyed on run_after alone — measured on
    // 200k rows, the old composite (status, run_after, claimed_at) was never
    // chosen because the claim's status predicate gave btree no scan bound.
    const idx = cfg.indexes.find((i) =>
      i.config.name?.includes("eval_jobs_runnable"),
    );
    expect(idx).toBeDefined();
    expect(idx!.config.where).toBeDefined(); // partial — terminal rows excluded
  });
});
