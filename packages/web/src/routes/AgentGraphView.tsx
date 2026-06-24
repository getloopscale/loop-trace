import { AgentFlowView } from "../components/AgentFlowView.js";
import { buildAgentGraph } from "../lib/agent-graph.js";

/**
 * Agent Graph (M21) — the selected trace's agent topology: one node per operation
 * (agent), edges per parent→child handoff, kind-colored, with Start/End terminals.
 * Per-trace, client-side, rendered as a d3-sankey flow.
 */
export function AgentGraphView() {
  return (
    <AgentFlowView
      title="Agent Graph"
      ariaLabel="agent graph: handoffs between agents"
      build={buildAgentGraph}
      emptyHint="No traces yet — run an instrumented agent to see its agent graph."
    />
  );
}
