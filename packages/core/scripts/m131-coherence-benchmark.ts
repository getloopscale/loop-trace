/**
 * M131 LIVE benchmark — exercises the Session Coherence evaluator end-to-end against a REAL judge
 * (OpenAI-compatible), on seeded coherent + incoherent sessions, measuring judge latency and proving
 * the cache (2nd run = 0 judge calls). Opt-in: requires LOOPTRACE_PG_URI + LOOPTRACE_JUDGE_* env.
 *
 * Run (key via env only — never committed):
 *   LOOPTRACE_PG_URI=... LOOPTRACE_JUDGE_BASE_URL=https://api.openai.com/v1 \
 *   LOOPTRACE_JUDGE_MODEL=gpt-4o-mini LOOPTRACE_JUDGE_API_KEY=sk-... \
 *   pnpm --filter @looptrace/core exec tsx scripts/m131-coherence-benchmark.ts
 */
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { Span } from "../src/domain/observability/span.js";
import { parseJudgeConfig } from "../src/domain/evaluation/evaluator-config.js";
import { createProviderClients } from "../src/domain/provider/provider-clients.js";
import { runSessionCoherence } from "../src/domain/evaluation/session-coherence-runner.js";
import { createPool, DrizzleSpanRepository } from "../src/infrastructure/db/observability/drizzle-span-repository.js";
import { getSessionVerdict, upsertSessionVerdict } from "../src/infrastructure/db/evaluation/session-evaluation-repository.js";

const PG_URI = process.env["LOOPTRACE_PG_URI"];
if (!PG_URI) throw new Error("set LOOPTRACE_PG_URI");
const judgeConfig = parseJudgeConfig(process.env);
if (!judgeConfig) throw new Error("set LOOPTRACE_JUDGE_BASE_URL + LOOPTRACE_JUDGE_MODEL (+ API_KEY)");
const { judge } = createProviderClients(judgeConfig);
if (!judge) throw new Error("judge not constructed");

const MIGRATIONS = fileURLToPath(new URL("../src/infrastructure/db/migrations", import.meta.url));

function span(o: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
  return { name: "interaction", startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000100000000", ...o };
}

/** turn n at t = base + n; each turn is a root span with user input + assistant output. */
function turn(session: string, n: number, user: string, asst: string): Span {
  const start = (1700000000000000000n + BigInt(n) * 1000000000n).toString();
  const end = (1700000000000000000n + BigInt(n) * 1000000000n + 500000000n).toString();
  return span({ spanId: `${session}-s${n}`, traceId: `${session}-t${n}`, sessionId: session, startTimeUnixNano: start, endTimeUnixNano: end, inputValue: user, outputValue: asst });
}

async function main(): Promise<void> {
  const pool = createPool(PG_URI as string);
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await pool.query("TRUNCATE spans, traces, sessions, replay_sessions, session_evaluations");
  const repo = new DrizzleSpanRepository(db);

  // A COHERENT session — every turn builds the same auth task.
  await repo.save([
    turn("COH", 0, "Add JWT auth to the API", "Added a JWT middleware and a login route."),
    turn("COH", 1, "Now add refresh tokens", "Added a /refresh endpoint that rotates the token."),
    turn("COH", 2, "Write tests for the auth flow", "Added unit tests for login, refresh, and expiry."),
  ]);
  // An INCOHERENT session — abrupt topic switches, no shared thread.
  await repo.save([
    turn("INC", 0, "Fix the null-pointer bug in checkout", "Fixed the null guard in the checkout handler."),
    turn("INC", 1, "What's the weather in Tokyo?", "It's sunny and 22°C in Tokyo today."),
    turn("INC", 2, "Give me a lasagna recipe", "Layer pasta, ragu, béchamel, and bake at 200°C."),
  ]);

  const deps = {
    judge,
    getTraces: async (sid: string) => {
      // listTraces populates input/output previews (getSessionDetail's member traces do not).
      const res = await repo.listTraces({ sessionId: sid });
      return res.traces.length > 0 ? res.traces : null;
    },
    getCached: async (sid: string, name: string) => {
      const v = await getSessionVerdict(db, sid, name);
      return v ? { sessionVersion: v.sessionVersion, verdict: v.verdict, score: v.score, reasoning: v.reasoning } : null;
    },
    saveVerdict: (rec: Parameters<typeof upsertSessionVerdict>[1]) => upsertSessionVerdict(db, rec),
    judgeModel: judgeConfig!.model,
  };

  const rows: string[] = [];
  for (const sid of ["COH", "INC"]) {
    const t0 = performance.now();
    const r1 = await runSessionCoherence(deps, sid);
    const ms1 = Math.round(performance.now() - t0);
    // 2nd run — should be a cache hit (no judge call), near-instant.
    const t1 = performance.now();
    const r2 = await runSessionCoherence(deps, sid);
    const ms2 = Math.round(performance.now() - t1);
    rows.push(
      `${sid}\tverdict=${r1?.verdict}\tscore=${r1?.score}\tjudge_ms=${ms1}\tcached2=${r2?.cached}\tcache_ms=${ms2}\treason="${(r1?.reasoning ?? "").slice(0, 80)}"`,
    );
  }

  console.log("\n=== M131 Session Coherence — LIVE benchmark (real judge:", judgeConfig!.model, ") ===");
  console.log(rows.join("\n"));
  console.log("\nExpected: COH → coherent (high score); INC → incoherent (low score, cites a turn); cached2=true, cache_ms≈0.");
  await pool.end();
}

void main();
