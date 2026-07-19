import { useAgents } from "../hooks/useAgents.js";
import { AgentCatalogTable } from "../components/trace/AgentCatalogTable.js";
import { AutoRefreshControl } from "../components/filters/AutoRefreshControl.js";
import { Loading, ErrorState } from "../components/primitives/States.js";

/** Agents catalog page (M32): the versioned-lifecycle registry of agents. */
export function AgentsListPage() {
  const { data, isLoading, isError, dataUpdatedAt } = useAgents();
  return (
    <div className="agents-list-page">
      <h1 className="text-display-md font-display">Agents</h1>
      <AutoRefreshControl dataUpdatedAt={dataUpdatedAt} />
      {isLoading ? (
        <Loading label="Loading agents…" />
      ) : isError || !data ? (
        <ErrorState message="Failed to load agents" />
      ) : (
        <AgentCatalogTable agents={data.agents} />
      )}
    </div>
  );
}
