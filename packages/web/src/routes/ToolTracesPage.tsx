import { useParams } from "react-router-dom";
import { useTracesForTool } from "../hooks/useTools.js";
import { TraceTable } from "../components/TraceTable.js";
import { Loading, ErrorState } from "../components/states.js";

/** Drill-down: the executions that called a given tool (M6 DoD #3, dark DataTable). */
export function ToolTracesPage() {
  const { toolName = "" } = useParams();
  const { data, isLoading, isError } = useTracesForTool(toolName);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title-lg font-display">
        Executions calling “{toolName}”
      </h1>
      {isLoading ? (
        <Loading label="Loading executions…" />
      ) : isError || !data ? (
        <ErrorState message="Failed to load executions" />
      ) : (
        <TraceTable traces={data.traces} sort={null} onSortChange={() => {}} />
      )}
    </div>
  );
}
