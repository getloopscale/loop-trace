import { Link, useParams } from "react-router-dom";
import { useTracesForTool } from "../hooks/useTools.js";
import { TraceList } from "../components/TraceList.js";
import { Loading, ErrorState } from "../components/states.js";

/** Drill-down: the executions that called a given tool (M6 DoD #3, reuses <TraceList>). */
export function ToolTracesPage() {
  const { toolName = "" } = useParams();
  const { data, isLoading, isError } = useTracesForTool(toolName);
  return (
    <main className="tool-traces-page">
      <Link to="/tools">← Tools</Link>
      <h1>Executions calling “{toolName}”</h1>
      {isLoading ? (
        <Loading label="Loading executions…" />
      ) : isError || !data ? (
        <ErrorState message="Failed to load executions" />
      ) : (
        <TraceList traces={data.traces} />
      )}
    </main>
  );
}
