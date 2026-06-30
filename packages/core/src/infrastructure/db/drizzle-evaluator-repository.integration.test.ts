import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import { createPool } from "./drizzle-span-repository.js";
import { DrizzleEvaluatorRepository } from "./drizzle-evaluator-repository.js";
import { evaluatorSchema, guardSchema } from "../../domain/evaluator.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("./migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

const WS_A = "ws-alice";
const WS_B = "ws-bob";

const ruleEv = (name: string, predicate = "status:error") =>
  evaluatorSchema.parse({ name, kind: "rule", config: { predicate } });

suite("M36 EvaluatorRepository (integration)", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;
  let repo: DrizzleEvaluatorRepository;

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    repo = new DrizzleEvaluatorRepository(db);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE evaluators, guards, span_evaluations");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("test_create_and_list_evaluators_scoped_by_workspace", async () => {
    await repo.createEvaluator(ruleEv("quality"), WS_A);
    expect((await repo.listEvaluators(WS_A)).map((e) => e.name)).toEqual(["quality"]);
    expect(await repo.listEvaluators(WS_B)).toHaveLength(0);
  });

  it("test_create_evaluator_is_create_or_update_on_name", async () => {
    const a = await repo.createEvaluator(ruleEv("q", "status:error"), WS_A);
    const b = await repo.createEvaluator(ruleEv("q", "status:ok"), WS_A);
    expect(b.id).toBe(a.id); // same row (upsert on (ws,name))
    expect((await repo.listEvaluators(WS_A))).toHaveLength(1);
    const got = await repo.getEvaluator(a.id, WS_A);
    expect((got?.config as { predicate: string }).predicate).toBe("status:ok");
  });

  it("test_cross_tenant_evaluator_isolation", async () => {
    const a = await repo.createEvaluator(ruleEv("shared"), WS_A);
    await repo.createEvaluator(ruleEv("shared"), WS_B); // same name, different ws
    expect(await repo.getEvaluator(a.id, WS_B)).toBeNull(); // A's id invisible to B
    expect(await repo.getEvaluator(a.id, WS_A)).not.toBeNull();
  });

  it("test_delete_evaluator_cascades_guards", async () => {
    // EC-4: deleting an evaluator removes its guards in the same tx (no orphan).
    const ev = await repo.createEvaluator(ruleEv("q"), WS_A);
    await repo.createGuard(
      guardSchema.parse({ evaluatorId: ev.id, operator: "lt", threshold: 0.5 }),
      WS_A,
    );
    expect(await repo.listGuards(WS_A)).toHaveLength(1);
    await repo.deleteEvaluator(ev.id, WS_A);
    expect(await repo.listEvaluators(WS_A)).toHaveLength(0);
    expect(await repo.listGuards(WS_A)).toHaveLength(0); // cascaded
  });

  it("test_write_verdict_is_idempotent_latest_wins", async () => {
    await repo.writeVerdict(WS_A, { spanId: "s1", traceId: "t1" }, "quality", { score: 0.9, label: "good" });
    await repo.writeVerdict(WS_A, { spanId: "s1", traceId: "t1" }, "quality", { score: 0.2, label: "bad" });
    const { rows } = await pool.query<{ score: number; label: string }>(
      "SELECT score, label FROM span_evaluations WHERE workspace_id=$1 AND span_id=$2 AND name=$3",
      [WS_A, "s1", "quality"],
    );
    expect(rows).toHaveLength(1); // idempotent — no duplicate
    expect(rows[0]!.score).toBe(0.2); // latest wins
  });

  it("test_create_guard_is_idempotent_no_duplicate_rows", async () => {
    // M36-EVAL-1: re-POSTing an identical numeric guard (label_value NULL) must NOT
    // create a duplicate — the NULLS NOT DISTINCT unique makes the upsert dedupe.
    const ev = await repo.createEvaluator(ruleEv("q"), WS_A);
    const g1 = await repo.createGuard(
      guardSchema.parse({ evaluatorId: ev.id, operator: "lt", threshold: 0.5 }),
      WS_A,
    );
    const g2 = await repo.createGuard(
      guardSchema.parse({ evaluatorId: ev.id, operator: "lt", threshold: 0.5 }),
      WS_A,
    );
    expect(g2.id).toBe(g1.id); // same row (upsert)
    expect(await repo.listGuards(WS_A)).toHaveLength(1);
    // a label_eq guard (threshold NULL) also dedupes
    await repo.createGuard(guardSchema.parse({ evaluatorId: ev.id, operator: "label_eq", labelValue: "bad" }), WS_A);
    await repo.createGuard(guardSchema.parse({ evaluatorId: ev.id, operator: "label_eq", labelValue: "bad" }), WS_A);
    expect(await repo.listGuards(WS_A)).toHaveLength(2); // lt + label_eq, no dupes
  });

  it("test_breaches_operator_matrix_sql_path", async () => {
    // F2: exercise the production SQL breach path for EVERY operator + null-score,
    // not just `lt` (the SQL CASE mirrors the canonical evaluateGuard).
    const ev = await repo.createEvaluator(ruleEv("quality"), WS_A);
    await repo.writeVerdict(WS_A, { spanId: "s1", traceId: "t-low" }, "quality", { score: 0.2 });
    await repo.writeVerdict(WS_A, { spanId: "s2", traceId: "t-high" }, "quality", { score: 0.8 });
    await repo.writeVerdict(WS_A, { spanId: "s3", traceId: "t-label" }, "quality", { label: "bad" });
    const breach = async (operator: string, over: Record<string, unknown>) => {
      const g = await repo.createGuard(guardSchema.parse({ evaluatorId: ev.id, operator, ...over }), WS_A);
      const r = (await repo.listBreachingTraces(g.id, WS_A)).sort();
      await repo.deleteGuard(g.id, WS_A);
      return r;
    };
    expect(await breach("lt", { threshold: 0.5 })).toEqual(["t-low"]);
    expect(await breach("lte", { threshold: 0.2 })).toEqual(["t-low"]);
    expect(await breach("gt", { threshold: 0.5 })).toEqual(["t-high"]);
    expect(await breach("gte", { threshold: 0.8 })).toEqual(["t-high"]);
    expect(await breach("eq", { threshold: 0.2 })).toEqual(["t-low"]);
    expect(await breach("label_eq", { labelValue: "bad" })).toEqual(["t-label"]);
    // null-score row never breaches a score operator
    expect(await breach("lt", { threshold: 1 })).toEqual(["t-high", "t-low"]); // t-label (no score) excluded
  });

  it("test_list_breaching_traces_scoped_and_correct", async () => {
    const ev = await repo.createEvaluator(ruleEv("quality"), WS_A);
    const guard = await repo.createGuard(
      guardSchema.parse({ evaluatorId: ev.id, operator: "lt", threshold: 0.5 }),
      WS_A,
    );
    // t1 breaches (0.2 < 0.5), t2 does not (0.8)
    await repo.writeVerdict(WS_A, { spanId: "s1", traceId: "t1" }, "quality", { score: 0.2 });
    await repo.writeVerdict(WS_A, { spanId: "s2", traceId: "t2" }, "quality", { score: 0.8 });
    expect(await repo.listBreachingTraces(guard.id, WS_A)).toEqual(["t1"]);
    // a same-named verdict in WS_B must NOT leak into A's breaches
    await repo.writeVerdict(WS_B, { spanId: "s3", traceId: "t3" }, "quality", { score: 0.1 });
    expect(await repo.listBreachingTraces(guard.id, WS_A)).toEqual(["t1"]);
  });
});
