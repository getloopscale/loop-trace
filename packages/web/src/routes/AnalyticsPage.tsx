import { useState } from "react";
import { Link } from "react-router-dom";
import { useCostByPeriod } from "../hooks/useCost.js";
import { CostByPeriod } from "../components/CostByPeriod.js";
import { Loading, ErrorState } from "../components/states.js";

/** Cost analytics view: day/week period buckets with a toggle (M5 DoD #2). */
export function AnalyticsPage() {
  const [period, setPeriod] = useState<"day" | "week">("day");
  const { data, isLoading, isError } = useCostByPeriod(period);
  return (
    <main className="analytics-page">
      <Link to="/">← Executions</Link>
      <h1>Cost analytics</h1>
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
    </main>
  );
}
