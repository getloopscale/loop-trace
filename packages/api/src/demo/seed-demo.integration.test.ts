import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type SpanRepository,
  type TraceTreeNode,
} from "@looptrace/core";
import { createSpanRepository, migrateLatest } from "@looptrace/core/infra";
import type pg from "pg";

import { parseResourceSpans } from "../otlp/parse-resource-spans.js";
import { buildTravelAgentEnvelope } from "./travel-agent-fixture.js";
import { main as seedMain } from "../bin/seed-demo.js";

const PG_URI = process.env["LOOPTRACE_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

function countSpans(node: TraceTreeNode): number {
  return 1 + node.children.reduce((n, c) => n + countSpans(c), 0);
}

suite("travel-agent demo seed (integration)", () => {
  let repo: SpanRepository;
  let pool: pg.Pool;

  beforeAll(async () => {
    ({ repo, pool } = createSpanRepository(PG_URI!));
    await migrateLatest(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  /** Seed the fixture once and return its parsed spans. */
  async function seed() {
    const spans = parseResourceSpans(
      buildTravelAgentEnvelope({ traces: 3, sessions: 2 }),
    );
    await repo.save(spans);
    return spans;
  }

  it("test_seed_reconstructs_travel_agent_tree", async () => {
    const spans = await seed();
    const root = spans.find(
      (s) => s.name === "TripAgentGraph" && s.parentSpanId == null,
    )!;
    const tree = await repo.getTraceTree(root.traceId);
    expect(tree).not.toBeNull();
    expect(tree!.name).toBe("TripAgentGraph");

    const agents = tree!.children.map((c) => c.name).sort();
    expect(agents).toEqual([
      "budget_agent",
      "itinerary_agent",
      "local_agent",
      "research_agent",
    ]);

    // each agent has a ChatOpenAI LLM child carrying a model
    for (const agent of tree!.children) {
      const llm = agent.children.find((k) => k.name === "ChatOpenAI");
      expect(llm, `${agent.name} → ChatOpenAI`).toBeDefined();
      expect(llm!.model).toBeTruthy();
    }
    // local_agent retrieves
    const local = tree!.children.find((c) => c.name === "local_agent")!;
    expect(
      local.children.some((k) => k.name === "VectorStoreRetriever"),
    ).toBe(true);
  });

  it("test_seed_groups_into_sessions", async () => {
    await seed();
    const { traces } = await repo.listTraces({ limit: 100 });
    const demoRoots = traces.filter((t) => t.name === "TripAgentGraph");
    const sessions = new Set(demoRoots.map((t) => t.sessionId).filter(Boolean));
    expect(sessions.size).toBeGreaterThanOrEqual(1);
    expect(sessions.size).toBeLessThanOrEqual(2);
  });

  it("test_main_seeds_end_to_end", async () => {
    // Exercise the real CLI happy-path (env → build → parse → save → log), not
    // just the inline seed(): proves the bin wiring works end-to-end.
    await seedMain(); // LOOPTRACE_PG_URI is set for the integration run
    const { traces } = await repo.listTraces({ limit: 100 });
    expect(traces.some((t) => t.name === "TripAgentGraph")).toBe(true);
  });

  it("test_seed_is_idempotent", async () => {
    const spans = await seed();
    const root = spans.find((s) => s.name === "TripAgentGraph")!;
    const treeBefore = await repo.getTraceTree(root.traceId);
    const before = countSpans(treeBefore!);

    await seed(); // re-seed — deterministic ids → onConflictDoNothing

    const treeAfter = await repo.getTraceTree(root.traceId);
    expect(countSpans(treeAfter!)).toBe(before);
  });
});
