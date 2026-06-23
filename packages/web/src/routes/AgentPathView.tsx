import { AgentFlowView } from "../components/AgentFlowView.js";
import { buildAgentPath } from "../lib/agent-graph.js";

/**
 * Agent Path (M21) — a Sankey of the selected trace's span flow grouped by
 * semantic kind (chain → llm → tool …), with a kind legend. Per-trace, client-side.
 */
export function AgentPathView() {
  return (
    <AgentFlowView
      title="Agent Path"
      ariaLabel="agent path: span flow by kind"
      build={buildAgentPath}
      showLegend
      emptyHint="No traces yet — run an instrumented agent to see its span flow by kind."
    />
  );
}
