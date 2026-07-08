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

  it("test_aggregate_tools_are_the_agents_direct_children", async () => {
    // tools = tool spans whose PARENT is one of the agent's spans (the tools this
    // agent calls) — NOT every tool in the trace (a sibling agent's tool is excluded).
    await repo.save([
      agentSpan("a1", "t1", "local_agent", "1.0.0"),
      agentSpan("b1", "t1", "budget_agent", "1.0.0"),
      span({ spanId: "tool1", traceId: "t1", parentSpanId: "a1", name: "hidden_gems", toolName: "hidden_gems", attributes: { "gen_ai.tool.name": "hidden_gems" } }),
      span({ spanId: "tool2", traceId: "t1", parentSpanId: "b1", name: "budget_basics", toolName: "budget_basics", attributes: { "gen_ai.tool.name": "budget_basics" } }),
    ]);
    const agents = await repo.aggregateAgents();
    expect(agents.find((a) => a.name === "local_agent")?.tools).toEqual(["hidden_gems"]);
    expect(agents.find((a) => a.name === "budget_agent")?.tools).toEqual(["budget_basics"]);
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

  it("test_aggregate_system_prompt_picks_latest_by_ingested_at", async () => {
    // F-tq-4: two same-name spans with different prompts → the NEWEST-ingested wins.
    await repo.save([
      span({ spanId: "old", traceId: "t1", name: "research_agent", attributes: { "agent.name": "research_agent", "agent.system_prompt": "OLD prompt" } }),
      span({ spanId: "new", traceId: "t2", name: "research_agent", attributes: { "agent.name": "research_agent", "agent.system_prompt": "NEW prompt" } }),
    ]);
    await pool.query("UPDATE spans SET ingested_at = now() - interval '1 hour' WHERE span_id = 'old'");
    const a = (await repo.aggregateAgents()).find((x) => x.name === "research_agent");
    expect(a?.systemPrompt).toBe("NEW prompt"); // latest ingested_at wins
  });

  it("test_aggregate_agent_without_version", async () => {
    // F-tq-5: an agent span carrying agent.name but NO agent.version → versionCount 0.
    await repo.save([
      span({ spanId: "a1", traceId: "t1", name: "x_agent", attributes: { "agent.name": "x_agent" } }),
    ]);
    const a = (await repo.aggregateAgents()).find((x) => x.name === "x_agent");
    expect(a?.versions).toEqual([]);
    expect(a?.versionCount).toBe(0);
    expect(a?.highChurn).toBe(false);
  });

  // ── M85 (ADR 0002) — broadened structural derivation ────────────────────────

  it("M85 — a claude_code.* span WITHOUT agent.name now surfaces the 'claude_code' structural agent", async () => {
    await repo.save([
      span({ spanId: "cc1", traceId: "t1", name: "claude_code.tool_use" }), // NO agent.name — structural
      span({ spanId: "cc2", traceId: "t2", name: "claude_code.assistant" }),
    ]);
    const agents = await repo.aggregateAgents();
    const cc = agents.find((a) => a.name === "claude_code");
    expect(cc).toBeDefined();
    expect(cc?.runCount).toBe(2); // 2 distinct traces collapse into ONE structural agent
  });

  it("M85 — a plain LLM span (no agent.name, not claude_code.*) is still EXCLUDED (no false positive)", async () => {
    await repo.save([
      span({ spanId: "cc1", traceId: "t1", name: "claude_code.turn" }),
      span({ spanId: "plain", traceId: "t1", name: "ChatOpenAI", model: "gpt-4o" }), // plain LLM
      span({ spanId: "chainish", traceId: "t1", name: "RunnableSequence" }), // a chain-ish name — NOT catalogued
    ]);
    const names = (await repo.aggregateAgents()).map((a) => a.name);
    expect(names).toContain("claude_code");
    expect(names).not.toContain("ChatOpenAI");
    expect(names).not.toContain("RunnableSequence"); // chain-kind deliberately excluded (ADR 0002)
  });

  it("M85 — explicit agent.name BEATS the structural rule (a named claude_code.* span keeps its name)", async () => {
    await repo.save([
      span({ spanId: "n1", traceId: "t1", name: "claude_code.plan", attributes: { "agent.name": "planner" } }),
    ]);
    const names = (await repo.aggregateAgents()).map((a) => a.name);
    expect(names).toContain("planner"); // the explicit name wins
    expect(names).not.toContain("claude_code"); // not double-counted under the structural bucket
  });

  it("M85 — the structural agent aggregates the tools its claude_code.* spans call", async () => {
    await repo.save([
      span({ spanId: "cc1", traceId: "t1", name: "claude_code.turn" }),
      span({ spanId: "tool1", traceId: "t1", parentSpanId: "cc1", name: "grep", toolName: "grep", attributes: { "gen_ai.tool.name": "grep" } }),
    ]);
    const cc = (await repo.aggregateAgents()).find((a) => a.name === "claude_code");
    expect(cc?.tools).toEqual(["grep"]);
  });

  it("M85 — the agent.name path is unchanged when no structural spans exist (regression)", async () => {
    await repo.save([
      agentSpan("a1", "t1", "research_agent", "1.0.0"),
      span({ spanId: "plain", traceId: "t1", name: "ChatOpenAI", model: "gpt-4o" }),
    ]);
    expect((await repo.aggregateAgents()).map((a) => a.name)).toEqual(["research_agent"]);
  });
});
