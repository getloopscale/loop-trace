import { Link } from "react-router-dom";
import { useToolStats } from "../hooks/useTools.js";
import { ToolRanking } from "../components/ToolRanking.js";
import { Loading, ErrorState } from "../components/states.js";

/** Tool analytics view: per-tool ranking over a recent window (M6 DoD #2). */
export function ToolAnalyticsPage() {
  const { data, isLoading, isError } = useToolStats();
  return (
    <main className="tool-analytics-page">
      <Link to="/">← Executions</Link>
      <h1>Tool analytics</h1>
      {isLoading ? (
        <Loading label="Loading tools…" />
      ) : isError || !data ? (
        <ErrorState message="Failed to load tool analytics" />
      ) : (
        <ToolRanking tools={data.tools} />
      )}
    </main>
  );
}
