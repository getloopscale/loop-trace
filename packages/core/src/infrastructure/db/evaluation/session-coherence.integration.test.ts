import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../../domain/observability/span.js";
import type { JudgeClient } from "../../../domain/evaluation/llm-judge.js";
import {
  runSessionCoherence,
  type SessionCoherenceDeps,
} from "../../../domain/evaluation/session-coherence-runner.js";
import { SESSION_COHERENCE_NAME } from "../../../domain/evaluation/session-coherence.js";
import { createPool, DrizzleSpanRepository } from "../observability/drizzle-span-repository.js";
import { getSessionDetail } from "../observability/session-repository.js";
import { getSessionVerdict, upsertSessionVerdict } from "./session-evaluation-repository.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
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

suite("session-coherence persistence + runner (integration, M131 B1+B3)", () => {
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
    await pool.query("TRUNCATE spans, traces, sessions, replay_sessions, session_evaluations");
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Wire the real repo functions to the runner, with a spy judge (no real LLM). */
  function deps(judge: JudgeClient): SessionCoherenceDeps {
    return {
      judge,
      getTraces: async (sessionId) => {
        const detail = await getSessionDetail(db, sessionId);
        return detail ? detail.traces : null;
      },
      getCached: async (sessionId, name) => {
        const v = await getSessionVerdict(db, sessionId, name);
        return v ? { sessionVersion: v.sessionVersion, verdict: v.verdict, score: v.score, reasoning: v.reasoning } : null;
      },
      saveVerdict: (rec) => upsertSessionVerdict(db, rec),
      judgeModel: "gpt-4o-mini",
    };
  }

  it("upsert_and_get_round_trips_the_verdict", async () => {
    await upsertSessionVerdict(db, {
      sessionId: "S1",
      name: SESSION_COHERENCE_NAME,
      verdict: "incoherent",
      score: 0.3,
      reasoning: "topic switch at turn 2",
      model: "gpt-4o-mini",
      sessionVersion: "abc123",
    });
    const got = await getSessionVerdict(db, "S1", SESSION_COHERENCE_NAME);
    expect(got?.verdict).toBe("incoherent");
    expect(got?.score).toBe(0.3);
    expect(got?.sessionVersion).toBe("abc123");
    // UPSERT overwrites in place (one row per session+name)
    await upsertSessionVerdict(db, {
      sessionId: "S1", name: SESSION_COHERENCE_NAME, verdict: "coherent", score: 0.9,
      reasoning: null, model: "gpt-4o-mini", sessionVersion: "def456",
    });
    const got2 = await getSessionVerdict(db, "S1", SESSION_COHERENCE_NAME);
    expect(got2?.verdict).toBe("coherent");
    expect(got2?.sessionVersion).toBe("def456");
  });

  it("runner_persists_on_first_run_then_cache_hits_then_re_judges_on_new_trace", async () => {
    await repo.save([span({ spanId: "s1", traceId: "t1", sessionId: "S1", startTimeUnixNano: "1700000000000000000", inputValue: "add auth", outputValue: "done" })]);
    const judge: JudgeClient = { judge: vi.fn().mockResolvedValue({ score: 0.85, label: "coherent", explanation: "stays on task" }) };
    const d = deps(judge);

    // 1) first run → judge called, verdict persisted
    const r1 = await runSessionCoherence(d, "S1");
    expect(r1?.cached).toBe(false);
    expect(r1?.verdict).toBe("coherent");
    expect(judge.judge).toHaveBeenCalledTimes(1);
    const stored = await getSessionVerdict(db, "S1", SESSION_COHERENCE_NAME);
    expect(stored?.verdict).toBe("coherent");
    expect(stored?.model).toBe("gpt-4o-mini");

    // 2) second run, unchanged content → CACHE HIT, judge NOT called again
    const r2 = await runSessionCoherence(d, "S1");
    expect(r2?.cached).toBe(true);
    expect(judge.judge).toHaveBeenCalledTimes(1); // still 1 — no LLM spend on unchanged session

    // 3) a new trace lands → version changes → re-judged exactly once
    await repo.save([span({ spanId: "s2", traceId: "t2", sessionId: "S1", startTimeUnixNano: "1700000000900000000", inputValue: "now tests", outputValue: "added" })]);
    const r3 = await runSessionCoherence(d, "S1");
    expect(r3?.cached).toBe(false);
    expect(judge.judge).toHaveBeenCalledTimes(2);
  });

  it("absent_session_returns_null_no_verdict_written", async () => {
    const judge: JudgeClient = { judge: vi.fn() };
    const r = await runSessionCoherence(deps(judge), "missing");
    expect(r).toBeNull();
    expect(judge.judge).not.toHaveBeenCalled();
    expect(await getSessionVerdict(db, "missing", SESSION_COHERENCE_NAME)).toBeNull();
  });
});
