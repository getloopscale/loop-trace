import { useState } from "react";
import { useCostByPeriod } from "../hooks/useCost.js";
import { CostByPeriod } from "../components/CostByPeriod.js";
import { AutoRefreshControl } from "../components/AutoRefreshControl.js";
import { Loading, ErrorState } from "../components/states.js";

/** Cost analytics view: day/week period buckets with a toggle (M5 DoD #2). */
export function AnalyticsPage() {
  const [period, setPeriod] = useState<"day" | "week">("day");
  const { data, isLoading, isError, dataUpdatedAt } = useCostByPeriod(period);
  return (
    <div className="analytics-page">
      <h1 className="text-display-md font-display">Cost analytics</h1>
      <AutoRefreshControl dataUpdatedAt={dataUpdatedAt} />
      <div className="period-toggle" role="radiogroup" aria-label="period">
        <button
          type="button"
          role="radio"
          aria-checked={period === "day"}
          onClick={() => setPeriod("day")}
        >
          Day
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={period === "week"}
          onClick={() => setPeriod("week")}
        >
          Week
        </button>
      </div>
      {isLoading ? (
        <Loading label="Loading cost…" />
      ) : isError || !data ? (
        <ErrorState message="Failed to load cost analytics" />
      ) : (
        <CostByPeriod buckets={data.buckets} />
      )}
    </div>
  );
}
