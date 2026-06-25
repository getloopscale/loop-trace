import { describe, it, expect } from "vitest";
import { parseResourceSpans } from "../otlp/parse-resource-spans.js";
import {
  buildTravelAgentEnvelope,
  DEMO_SERVICE_NAME,
} from "./travel-agent-fixture.js";

/** Index parsed spans by id + build a parent→children map. */
function indexSpans(envelopeTraces: number, sessions?: number) {
  const opts = sessions != null ? { traces: envelopeTraces, sessions } : { traces: envelopeTraces };
  const spans = parseResourceSpans(buildTravelAgentEnvelope(opts));
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const childrenOf = new Map<string, typeof spans>();
  for (const s of spans) {
    if (s.parentSpanId != null) {
      const arr = childrenOf.get(s.parentSpanId) ?? [];
      arr.push(s);
      childrenOf.set(s.parentSpanId, arr);
    }
  }
  return { spans, byId, childrenOf };
}

describe("travel-agent demo fixture", () => {
  it("test_builder_envelope_parses_to_domain_spans", () => {
    const { spans, childrenOf } = indexSpans(1);
    expect(spans.length).toBeGreaterThan(0);

    // Root TripAgentGraph — chain signals: has children, no model, no toolName.
    const root = spans.find((s) => s.name === "TripAgentGraph" && s.parentSpanId == null);
    expect(root).toBeDefined();
    expect(root!.model).toBeUndefined();
    expect(root!.toolName).toBeUndefined();
    const agents = childrenOf.get(root!.spanId) ?? [];
    const agentNames = agents.map((a) => a.name).sort();
    expect(agentNames).toEqual([
      "budget_agent",
      "itinerary_agent",
      "local_agent",
      "research_agent",
    ]);

    // Each agent is a chain (no model/toolName of its own) with an LLM child.
    for (const agent of agents) {
      expect(agent.model).toBeUndefined();
      expect(agent.toolName).toBeUndefined();
      const kids = childrenOf.get(agent.spanId) ?? [];
      const llm = kids.find((k) => k.name === "ChatOpenAI");
      expect(llm, `${agent.name} has an LLM child`).toBeDefined();
      expect(llm!.model).toBeTruthy(); // → classifies as LLM
    }

    // local_agent has a RETRIEVER child (operation.name=retrieve stays in attrs).
    const local = agents.find((a) => a.name === "local_agent")!;
    const localKids = childrenOf.get(local.spanId) ?? [];
    const retriever = localKids.find((k) => k.name === "VectorStoreRetriever");
    expect(retriever).toBeDefined();
    expect(retriever!.attributes?.["gen_ai.operation.name"]).toBe("retrieve");

    // TOOL spans carry a toolName (→ classify as TOOL).
    const toolSpans = spans.filter((s) => s.toolName != null);
    expect(toolSpans.map((t) => t.toolName).sort()).toContain("hidden_gems");
  });

  it("test_agent_spans_carry_agent_attributes_with_multi_version", () => {
    // M32: agent spans emit the explicit agent.* convention the catalog derives from;
    // research_agent emits ≥3 distinct versions across the 8 traces (→ high churn).
    const { spans } = indexSpans(8);
    const agentSpans = spans.filter((s) => s.attributes?.["agent.name"] != null);
    expect(agentSpans.length).toBeGreaterThan(0);
    // every agent span carries name + version + system prompt
    for (const s of agentSpans) {
      expect(typeof s.attributes?.["agent.name"]).toBe("string");
      expect(typeof s.attributes?.["agent.version"]).toBe("string");
      expect(typeof s.attributes?.["agent.system_prompt"]).toBe("string");
    }
    // research_agent → 3 distinct versions across traces (1.0.0 / 1.1.0 / 1.2.0)
    const researchVersions = new Set(
      agentSpans
        .filter((s) => s.attributes?.["agent.name"] === "research_agent")
        .map((s) => s.attributes?.["agent.version"]),
    );
    expect(researchVersions.size).toBe(3);
  });

  it("test_builder_groups_traces_into_sessions", () => {
    const { spans } = indexSpans(6, 3);
    const sessionIds = new Set(spans.map((s) => s.sessionId).filter(Boolean));
    expect(sessionIds.size).toBe(3);
  });

  it("test_builder_clamps_sessions_to_traces", () => {
    // EC-1: 2 traces cannot become 5 sessions.
    const { spans } = indexSpans(2, 5);
    const sessionIds = new Set(spans.map((s) => s.sessionId).filter(Boolean));
    expect(sessionIds.size).toBe(2);
  });

  it("test_builder_surfaces_error_rows", () => {
    // The fixture periodically emits an errored trace (matching the reference's
    // failed rows). At traces≥4 at least one span carries an ERROR status.
    const { spans } = indexSpans(4);
    const errored = spans.filter((s) => s.statusCode === "2");
    expect(errored.length).toBeGreaterThan(0);
    // the errored agent's name is budget_agent (deterministic) and it has a message
    expect(errored.some((s) => s.name === "budget_agent")).toBe(true);
    expect(errored.find((s) => s.name === "budget_agent")!.statusMessage).toBeTruthy();
  });

  it("test_builder_is_deterministic", () => {
    expect(JSON.stringify(buildTravelAgentEnvelope({ traces: 3 }))).toBe(
      JSON.stringify(buildTravelAgentEnvelope({ traces: 3 })),
    );
  });

  it("test_builder_zero_traces_is_valid_empty", () => {
    const env = buildTravelAgentEnvelope({ traces: 0 });
    expect(parseResourceSpans(env)).toEqual([]);
    expect(env.resourceSpans[0]!.resource.attributes[0]!.value).toEqual({
      stringValue: DEMO_SERVICE_NAME,
    });
  });
});
