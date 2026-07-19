import { useSessions } from "../hooks/useSessions.js";
import { SessionTable } from "../components/trace/SessionTable.js";
import { AutoRefreshControl } from "../components/filters/AutoRefreshControl.js";
import { Loading, ErrorState } from "../components/primitives/States.js";

/** Sessions list view (M13; M20 Arize DataTable led by the first message). */
export function SessionsListPage() {
  const { data, isLoading, isError, dataUpdatedAt } = useSessions();
  return (
    <div className="sessions-list-page">
      <h1 className="text-display-md font-display">Sessions</h1>
      <AutoRefreshControl dataUpdatedAt={dataUpdatedAt} />
      {isLoading ? (
        <Loading label="Loading sessions…" />
      ) : isError || !data ? (
        <ErrorState message="Failed to load sessions" />
      ) : (
        <SessionTable sessions={data.sessions} />
      )}
    </div>
  );
}
