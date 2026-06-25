import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../domain/span.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("./migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

function span(overrides: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
  return {
    name: "op",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    ...overrides,
  };
}

/** An agent span carrying the M32 `agent.*` convention. */
function agentSpan(
  spanId: string,
  traceId: string,
  name: string,
  version: string,
  extra: Record<string, unknown> = {},
): Span {
  return span({
    spanId,
    traceId,
    name,
    attributes: { "agent.name": name, "agent.version": version, "agent.system_prompt": `You are ${name}.`, ...extra },
  });
}

suite("agents catalog (integration, M32)", () => {
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
    await pool.query("TRUNCATE spans, traces, sessions, replay_sessions, span_evaluations, annotations");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("test_aggregate_groups_by_agent_name_with_run_count", async () => {
    await repo.save([
      agentSpan("a1", "t1", "research_agent", "1.0.0"),
      agentSpan("a2", "t2", "research_agent", "1.1.0"),
      agentSpan("b1", "t1", "budget_agent", "2.0.0"),
    ]);
    const agents = await repo.aggregateAgents();
    const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
    expect(byName["research_agent"]?.runCount).toBe(2); // 2 distinct traces
    expect(byName["research_agent"]?.versions).toEqual(["1.0.0", "1.1.0"]);
    expect(byName["budget_agent"]?.runCount).toBe(1);
  });

  it("test_aggregate_tools_across_agents_traces", async () => {
    // a tool span in the same trace as the agent → surfaced under the agent's tools
    await repo.save([
      agentSpan("a1", "t1", "local_agent", "1.0.0"),
      span({ spanId: "tool1", traceId: "t1", name: "hidden_gems", toolName: "hidden_gems", attributes: { "gen_ai.tool.name": "hidden_gems" } }),
    ]);
    const agents = await repo.aggregateAgents();
    expect(agents.find((a) => a.name === "local_agent")?.tools).toEqual(["hidden_gems"]);
  });

  it("test_aggregate_excludes_spans_without_agent_name", async () => {
    await repo.save([
      agentSpan("a1", "t1", "research_agent", "1.0.0"),
      span({ spanId: "plain", traceId: "t1", name: "ChatOpenAI", model: "gpt-4o" }), // no agent.name
    ]);
    const agents = await repo.aggregateAgents();
    expect(agents.map((a) => a.name)).toEqual(["research_agent"]); // plain span excluded
  });

  it("test_aggregate_high_churn_three_versions", async () => {
    await repo.save([
      agentSpan("a1", "t1", "research_agent", "1.0.0"),
      agentSpan("a2", "t2", "research_agent", "1.1.0"),
      agentSpan("a3", "t3", "research_agent", "1.2.0"),
    ]);
    const a = (await repo.aggregateAgents()).find((x) => x.name === "research_agent");
    expect(a?.versionCount).toBe(3);
    expect(a?.highChurn).toBe(true); // ≥ default threshold 3
  });

  it("test_aggregate_stale_via_backdate", async () => {
    await repo.save([agentSpan("old", "t-old", "legacy_agent", "1.0.0")]);
    // backdate the agent span's ingested_at beyond the 30-day stale window
    await pool.query("UPDATE spans SET ingested_at = now() - interval '60 days' WHERE span_id = 'old'");
    const a = (await repo.aggregateAgents()).find((x) => x.name === "legacy_agent");
    expect(a?.stale).toBe(true);
  });

  it("test_aggregate_latest_system_prompt_and_empty_catalog", async () => {
    expect(await repo.aggregateAgents()).toEqual([]); // no agents → empty
    await repo.save([agentSpan("a1", "t1", "research_agent", "1.0.0")]);
    const a = (await repo.aggregateAgents()).find((x) => x.name === "research_agent");
    expect(a?.systemPrompt).toBe("You are research_agent.");
  });
});
