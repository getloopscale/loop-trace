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
      "TRUNCATE spans, traces, sessions, evaluators, monitors, span_evaluations",
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

  // ── The distinction the first draft of this endpoint could not express ─────────────────────────
  //
  // An unknown guard and a real guard with an empty window BOTH returned {hasData:false, 0, 0}.
  // theo-cloud then built two mechanisms on a 404 this endpoint never emits: create-time ownership
  // validation, and auto-disabling a rule whose guard was deleted. Both were dead code, and the
  // second produced exactly the state it claimed to prevent — an armed rule that can never fire.
  //
  // The fix is NOT a 404. A 404 would confirm the id exists to a caller in another workspace, which
  // is the anti-enumeration property deliberately pinned in evaluators-route.integration.test.ts.
  // `guardExists: false` covers BOTH "no such guard" and "belongs to another workspace", so it
  // leaks nothing while giving the consumer the definitive answer it needs.
  it("test_unknown_guard_is_distinguishable_from_a_real_guard_with_an_empty_window", async () => {
    const real = (await guardOver("ge", "lt", 0.5)).g.id;
    const unknown = "00000000-0000-0000-0000-0000000000ff";

    const emptyWindow = await evaluatorRepo.guardBreachWindow(real, 3600, WS);
    const noSuchGuard = await evaluatorRepo.guardBreachWindow(unknown, 3600, WS);

    // Both are hasData:false — neither has anything to evaluate. That is NOT the distinction.
    expect(emptyWindow.hasData).toBe(false);
    expect(noSuchGuard.hasData).toBe(false);

    // The distinction is whether the guard is there at all.
    expect(emptyWindow.guardExists).toBe(true);
    expect(noSuchGuard.guardExists).toBe(false);
  });

  it("test_a_guard_in_another_workspace_reads_as_absent_not_as_existing", async () => {
    // Cross-tenant: same collapse as "no such guard", deliberately. Distinguishing them would
    // confirm another workspace's id.
    const real = (await guardOver("ge", "lt", 0.5)).g.id;
    const fromOtherWs = await evaluatorRepo.guardBreachWindow(real, 3600, "ws-other");
    expect(fromOtherWs.guardExists).toBe(false);
  });

  it("test_a_non_uuid_id_reads_as_absent_rather_than_crashing", async () => {
    const res = await evaluatorRepo.guardBreachWindow("not-a-uuid", 3600, WS);
    expect(res.guardExists).toBe(false);
    expect(res.hasData).toBe(false);
  });
});
