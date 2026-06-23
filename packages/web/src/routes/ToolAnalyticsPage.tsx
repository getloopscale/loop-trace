import { useToolStats } from "../hooks/useTools.js";
import { ToolRanking } from "../components/ToolRanking.js";
import { AutoRefreshControl } from "../components/AutoRefreshControl.js";
import { Loading, ErrorState } from "../components/states.js";

/** Tool analytics view: per-tool ranking over a recent window (M6 DoD #2). */
export function ToolAnalyticsPage() {
  const { data, isLoading, isError, dataUpdatedAt } = useToolStats();
  return (
    <div className="tool-analytics-page">
      <h1 className="text-display-md font-display">Tool analytics</h1>
      <AutoRefreshControl dataUpdatedAt={dataUpdatedAt} />
      {isLoading ? (
        <Loading label="Loading tools…" />
      ) : isError || !data ? (
        <ErrorState message="Failed to load tool analytics" />
      ) : (
        <ToolRanking tools={data.tools} />
      )}
    </div>
  );
}
