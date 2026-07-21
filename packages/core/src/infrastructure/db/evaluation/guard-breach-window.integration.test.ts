import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";

import { createPool, runMigrations, evaluatorRepoFromPool, spanRepoFromPool } from "../index.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

const WS = "ws-guard-window";

/**
 * M135 T2.1 — the carrier: per-guard breach counts over a window.
 *
 * The distinction this exists to carry is the one theo-cloud#247 was missing:
 * `breachCount: 0, hasData: true` is a real zero (traces were evaluated, none
 * breached) while `hasData: false` is absence (nothing to evaluate). Collapsing
 * them is what let a traffic-free workspace fire a below-threshold rule forever.
 *
 * Windowed on the TRACE's time rather than the verdict's, because
 * `span_evaluations` carries no timestamp — and because the window is
 * semantically about traces, matching both the observability series and how
 * retention prunes.
 */
suite("guard breach window (integration, M135 T2.1)", () => {
  let pool: pg.Pool;
  let evaluatorRepo: ReturnType<typeof evaluatorRepoFromPool>;
  let spanRepo: ReturnType<typeof spanRepoFromPool>;

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    await runMigrations(pool);
    evaluatorRepo = evaluatorRepoFromPool(pool);
    spanRepo = spanRepoFromPool(pool);
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE spans, traces, sessions, evaluators, guards, span_evaluations",
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  async function guardOver(name: string, operator: string, threshold: number) {
    const ev = await evaluatorRepo.createEvaluator(
      { name, kind: "rule", config: { predicate: "" }, target: "", enabled: true } as never,
      WS,
    );
    const g = await evaluatorRepo.createGuard(
      { evaluatorId: ev.id, operator, threshold, enabled: true } as never,
      WS,
    );
    return { ev, g };
  }

  async function traceWithVerdict(traceId: string, name: string, score: number, ageMinutes = 0) {
    await spanRepo.save(
      [
        {
          spanId: `s-${traceId}`,
          traceId,
          name: "chat",
          startTimeUnixNano: "1700000000000000000",
          endTimeUnixNano: "1700000000100000000",
        } as never,
      ],
      WS,
    );
    await pool.query(
      `INSERT INTO span_evaluations (workspace_id, span_id, trace_id, name, score)
       VALUES ($1, $2, $3, $4, $5)`,
      [WS, `s-${traceId}`, traceId, name, score],
    );
    if (ageMinutes > 0) {
      await pool.query(
        `UPDATE traces SET updated_at = now() - ($1 || ' minutes')::interval
         WHERE trace_id = $2 AND workspace_id = $3`,
        [String(ageMinutes), traceId, WS],
      );
    }
  }

  it("test_counts_only_breaching_traces_in_the_window", async () => {
    const { g } = await guardOver("toxicity", "gt", 0.5);
    await traceWithVerdict("t-breach", "toxicity", 0.9);
    await traceWithVerdict("t-clean", "toxicity", 0.1);

    const r = await evaluatorRepo.guardBreachWindow(g.id, 3600, WS);

    expect(r.hasData).toBe(true);
    expect(r.breachCount).toBe(1);
    expect(r.evaluatedCount).toBe(2);
  });

  it("test_a_real_zero_is_not_absence", async () => {
    // THE distinction the carrier exists for. Traces WERE evaluated and none
    // breached — that is a measurement of zero, and a below-threshold rule
    // should be free to act on it.
    const { g } = await guardOver("toxicity", "gt", 0.5);
    await traceWithVerdict("t-clean", "toxicity", 0.1);

    const r = await evaluatorRepo.guardBreachWindow(g.id, 3600, WS);

    expect(r.hasData).toBe(true);
    expect(r.breachCount).toBe(0);
  });

  it("test_an_empty_window_is_absence_not_zero", async () => {
    // Nothing to evaluate. Collapsing this into `0` is exactly theo-cloud#247.
    const { g } = await guardOver("toxicity", "gt", 0.5);

    const r = await evaluatorRepo.guardBreachWindow(g.id, 3600, WS);

    expect(r.hasData).toBe(false);
    expect(r.breachCount).toBe(0);
  });

  it("test_traces_outside_the_window_are_excluded", async () => {
    const { g } = await guardOver("toxicity", "gt", 0.5);
    await traceWithVerdict("t-old", "toxicity", 0.9, 120); // 2h old

    const r = await evaluatorRepo.guardBreachWindow(g.id, 3600, WS); // 1h window

    expect(r.hasData).toBe(false);
    expect(r.breachCount).toBe(0);
  });

  it("test_is_workspace_scoped", async () => {
    // A guard id from another workspace must resolve to absence, never to this
    // workspace's counts — and never to the other tenant's.
    const { g } = await guardOver("toxicity", "gt", 0.5);
    await traceWithVerdict("t-breach", "toxicity", 0.9);

    const r = await evaluatorRepo.guardBreachWindow(g.id, 3600, "ws-someone-else");

    expect(r.hasData).toBe(false);
    expect(r.breachCount).toBe(0);
  });

  it("test_a_non_uuid_guard_id_is_absence_not_a_crash", async () => {
    // Mirrors listBreachingTraces: a bad path param is empty, not a 500 (22P02).
    const r = await evaluatorRepo.guardBreachWindow("not-a-uuid", 3600, WS);

    expect(r.hasData).toBe(false);
  });
});
