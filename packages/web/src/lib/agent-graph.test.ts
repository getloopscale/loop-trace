import { describe, it, expect } from "vitest";
import { buildAgentPath, buildAgentGraph } from "./agent-graph.js";
import type { TraceTreeNode } from "../api/types.js";

let sid = 0;
function node(over: Partial<TraceTreeNode> & { name: string }): TraceTreeNode {
  sid += 1;
  return {
    spanId: `s${sid}`,
    traceId: "t1",
    name: over.name,
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    children: [],
    ...over,
  };
}

function linkValue(
  links: { source: string; target: string; value: number }[],
  s: string,
  t: string,
): number {
  return links.find((l) => l.source === s && l.target === t)?.value ?? 0;
}

describe("agent-graph derivation (M21)", () => {
  it("build_agent_path_groups_spans_by_kind", () => {
    // chain root → llm child → tool grandchild
    const tree = node({
      name: "TripAgent",
      children: [
        node({
          name: "ChatOpenAI",
          model: "gpt-4o",
          children: [node({ name: "search", attributes: { "gen_ai.tool.name": "web" } })],
        }),
      ],
    });
    const m = buildAgentPath(tree);
    const ids = m.nodes.map((n) => n.id);
    expect(ids).toContain("chain"); // root has children → chain
    expect(ids).toContain("llm"); // model → llm
    expect(ids).toContain("tool"); // tool.name → tool
    expect(ids).toContain("Start");
    expect(ids).toContain("End");
    expect(linkValue(m.links, "Start", "chain")).toBe(1);
    expect(linkValue(m.links, "chain", "llm")).toBe(1);
    expect(linkValue(m.links, "llm", "tool")).toBe(1);
    expect(linkValue(m.links, "tool", "End")).toBe(1);
  });

  it("build_agent_path_sums_parallel_sibling_links", () => {
    // EC-1: a chain root with 3 llm children → chain→llm value === 3 (summed)
    const tree = node({
      name: "root",
      children: [
        node({ name: "a", model: "gpt-4o" }),
        node({ name: "b", model: "gpt-4o" }),
        node({ name: "c", model: "gpt-4o" }),
      ],
    });
    const m = buildAgentPath(tree);
    expect(linkValue(m.links, "chain", "llm")).toBe(3);
    // EC-2: every link endpoint exists in nodes
    const ids = new Set(m.nodes.map((n) => n.id));
    for (const l of m.links) {
      expect(ids.has(l.source)).toBe(true);
      expect(ids.has(l.target)).toBe(true);
    }
  });

  it("build_agent_graph_uses_span_names_with_kind_and_terminals", () => {
    const tree = node({
      name: "Orchestrator",
      children: [node({ name: "Worker", model: "gpt-4o" })],
    });
    const m = buildAgentGraph(tree);
    const byId = new Map(m.nodes.map((n) => [n.id, n]));
    expect(byId.has("Orchestrator")).toBe(true);
    expect(byId.has("Worker")).toBe(true);
    expect(byId.get("Worker")!.kind).toBe("llm"); // carries derived kind for color
    expect(linkValue(m.links, "Start", "Orchestrator")).toBe(1);
    expect(linkValue(m.links, "Orchestrator", "Worker")).toBe(1);
    expect(linkValue(m.links, "Worker", "End")).toBe(1);
  });

  it("build_agent_path_single_node_trace", () => {
    const m = buildAgentPath(node({ name: "solo" }));
    const ids = m.nodes.map((n) => n.id);
    // single span (no children) → unknown kind; Start → unknown → End
    expect(ids).toContain("Start");
    expect(ids).toContain("End");
    expect(linkValue(m.links, "Start", "unknown")).toBe(1);
    expect(linkValue(m.links, "unknown", "End")).toBe(1);
    // no NaN / empty
    expect(m.nodes.every((n) => Number.isFinite(n.count))).toBe(true);
  });

  it("build_agent_graph_includes_error_spans", () => {
    // EC-3: an errored span node is still present (a failed handoff is interesting)
    const tree = node({
      name: "root",
      children: [node({ name: "FailingTool", statusCode: "2", attributes: { "gen_ai.tool.name": "x" } })],
    });
    const m = buildAgentGraph(tree);
    expect(m.nodes.some((n) => n.id === "FailingTool")).toBe(true);
  });

  it("build_agent_graph_caps_nodes", () => {
    // EC-4: a wide tree beyond the cap folds the tail into "other", total count preserved
    const children = Array.from({ length: 30 }, (_, i) => node({ name: `child-${i}` }));
    const tree = node({ name: "root", children });
    const m = buildAgentGraph(tree, 20);
    expect(m.nodes.length).toBeLessThanOrEqual(20 + 3); // cap + Start + End + other
    expect(m.nodes.some((n) => n.id === "other")).toBe(true);
    // every link endpoint still exists in nodes (EC-2 after folding)
    const ids = new Set(m.nodes.map((n) => n.id));
    for (const l of m.links) {
      expect(ids.has(l.source)).toBe(true);
      expect(ids.has(l.target)).toBe(true);
    }
  });
});
