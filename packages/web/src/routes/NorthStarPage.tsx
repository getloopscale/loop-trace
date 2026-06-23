import { useNorthStar } from "../hooks/useNorthStar.js";
import { AutoRefreshControl } from "../components/AutoRefreshControl.js";
import { Loading, ErrorState, EmptyState } from "../components/states.js";
import type { NorthStarBucket } from "../api/types.js";

/** A labelled count table for one north-star metric. */
function MetricTable({
  caption,
  periodLabel,
  buckets,
}: {
  caption: string;
  periodLabel: string;
  buckets: NorthStarBucket[];
}) {
  if (buckets.length === 0) {
    return <EmptyState message={`No ${caption.toLowerCase()} yet`} />;
  }
  return (
    <table className="north-star-table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{periodLabel}</th>
          <th scope="col">Count</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map((b) => (
          <tr key={b.period}>
            <td>{b.period}</td>
            <td>{b.count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * North-star view (M8 DoD #3): the numbers the team watches in Lens itself —
 * traces ingested per day (real telemetry arriving) + replay sessions per week
 * (active debugging engagement).
 */
export function NorthStarPage() {
  const { data, isLoading, isError, dataUpdatedAt } = useNorthStar();
  return (
    <div className="north-star-page">
      <h1 className="text-display-md font-display">North-star metrics</h1>
      <AutoRefreshControl dataUpdatedAt={dataUpdatedAt} />
      {isLoading ? (
        <Loading label="Loading metrics…" />
      ) : isError || !data ? (
        <ErrorState message="Failed to load north-star metrics" />
      ) : (
        <>
          <MetricTable
            caption="Traces ingested per day"
            periodLabel="Day"
            buckets={data.tracesPerDay}
          />
          <MetricTable
            caption="Replay sessions per week"
            periodLabel="Week of"
            buckets={data.replaySessionsPerWeek}
          />
        </>
      )}
    </div>
  );
}
