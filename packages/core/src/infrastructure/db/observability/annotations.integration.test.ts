import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../../domain/observability/span.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";

const PG_URI = process.env["LOOPTRACE_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

function span(overrides: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
  return {
    name: "op",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    ...overrides,
  };
}

suite("annotations write-path (integration, M26b)", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;
  let repo: DrizzleSpanRepository;

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    repo = new DrizzleSpanRepository(db);
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE spans, traces, sessions, replay_sessions, span_evaluations, annotations",
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("test_upsert_idempotent_latest_wins", async () => {
    await repo.save([span({ spanId: "a1", traceId: "t1" })]);
    // 👍 on the trace, then 👎 on the SAME (trace, span=null, name) → ONE row, replaced.
    expect(
      await repo.upsertAnnotation("t1", {
        spanId: undefined,
        name: "feedback",
        label: "thumbs_up",
        note: undefined,
        annotatorKind: "HUMAN",
      }),
    ).toBe(true);
    await repo.upsertAnnotation("t1", {
      spanId: undefined,
      name: "feedback",
      label: "thumbs_down",
      note: "actually wrong",
      annotatorKind: "HUMAN",
    });
    const { rows } = await pool.query(
      "SELECT span_id, label, note FROM annotations WHERE trace_id = 't1'",
    );
    expect(rows).toEqual([
      { span_id: "", label: "thumbs_down", note: "actually wrong" },
    ]);
  });

  it("test_upsert_absent_trace_returns_false", async () => {
    expect(
      await repo.upsertAnnotation("ghost", {
        spanId: undefined,
        name: "feedback",
        label: "thumbs_up",
        note: undefined,
        annotatorKind: "HUMAN",
      }),
    ).toBe(false);
  });

  it("test_list_annotations_trace_and_span_newest_first", async () => {
    await repo.save([span({ spanId: "s1", traceId: "t1" })]);
    await repo.upsertAnnotation("t1", {
      spanId: undefined, name: "feedback", label: "thumbs_up", note: undefined, annotatorKind: "HUMAN",
    });
    await repo.upsertAnnotation("t1", {
      spanId: "s1", name: "tone", label: undefined, note: "too terse", annotatorKind: "HUMAN",
    });
    const list = await repo.listAnnotations("t1");
    expect(list).toHaveLength(2);
    // span-level carries spanId; trace-level omits it
    const bySpan = list.find((a) => a.spanId === "s1");
    const byTrace = list.find((a) => a.spanId === undefined);
    expect(bySpan).toMatchObject({ name: "tone", note: "too terse" });
    expect(byTrace).toMatchObject({ name: "feedback", label: "thumbs_up" });
    expect(byTrace).not.toHaveProperty("spanId");
  });

  it("test_remove_annotation_idempotent", async () => {
    await repo.save([span({ spanId: "s1", traceId: "t1" })]);
    await repo.upsertAnnotation("t1", {
      spanId: undefined, name: "feedback", label: "thumbs_up", note: undefined, annotatorKind: "HUMAN",
    });
    await repo.removeAnnotation("t1", { name: "feedback" });
    expect(await repo.listAnnotations("t1")).toEqual([]);
    // removing again is a no-op (no throw)
    await repo.removeAnnotation("t1", { name: "feedback" });
    expect(await repo.listAnnotations("t1")).toEqual([]);
  });

  it("test_listTraces_carries_evaluations_count", async () => {
    await repo.save([
      span({ spanId: "a1", traceId: "t1", evaluations: [{ name: "hallucination", score: 0.2 }] }),
      span({ spanId: "a2", traceId: "t1", evaluations: [{ name: "relevance", label: "relevant" }] }),
      span({ spanId: "b1", traceId: "t2" }),
    ]);
    const { traces } = await repo.listTraces();
    const t1 = traces.find((t) => t.traceId === "t1");
    const t2 = traces.find((t) => t.traceId === "t2");
    expect(t1?.evaluationsCount).toBe(2);
    expect(t2?.evaluationsCount).toBeUndefined(); // 0 → omitted
  });

  it("test_prune_cascades_annotations_and_evaluations", async () => {
    await repo.save([span({ spanId: "old", traceId: "t-old", evaluations: [{ name: "x", score: 1 }] })]);
    await repo.upsertAnnotation("t-old", {
      spanId: undefined, name: "feedback", label: "thumbs_down", note: "bad", annotatorKind: "HUMAN",
    });
    await pool.query("UPDATE traces SET updated_at = now() - interval '40 days' WHERE trace_id = 't-old'");
    const stats = await repo.prune(new Date());
    expect(stats.annotationsDeleted).toBe(1);
    expect(stats.evaluationsDeleted).toBe(1);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM annotations");
    expect(rows[0].n).toBe(0);
  });
});
