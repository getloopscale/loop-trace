import { useSessions } from "../hooks/useSessions.js";
import { SessionList } from "../components/SessionList.js";
import { AutoRefreshControl } from "../components/AutoRefreshControl.js";
import { Loading, ErrorState } from "../components/states.js";

/** Sessions list view (M13): grouped traces with per-session scoped metrics. */
export function SessionsListPage() {
  const { data, isLoading, isError, dataUpdatedAt } = useSessions();
  return (
    <main className="sessions-list-page">
      <h1 className="text-display-md font-display">Sessions</h1>
      <AutoRefreshControl dataUpdatedAt={dataUpdatedAt} />
      {isLoading ? (
        <Loading label="Loading sessions…" />
      ) : isError || !data ? (
        <ErrorState message="Failed to load sessions" />
      ) : (
        <SessionList sessions={data.sessions} />
      )}
    </main>
  );
}
