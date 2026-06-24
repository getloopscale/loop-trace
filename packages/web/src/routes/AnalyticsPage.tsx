import { useState } from "react";
import { Tabs } from "@theokit/ui";
import { useCostByPeriod } from "../hooks/useCost.js";
import { CostByPeriod } from "../components/CostByPeriod.js";
import { AutoRefreshControl } from "../components/AutoRefreshControl.js";
import { Loading, ErrorState } from "../components/states.js";

/** Cost analytics view: day/week period buckets with a Tabs toggle (M5 DoD #2). */
export function AnalyticsPage() {
  const [period, setPeriod] = useState<"day" | "week">("day");
  const { data, isLoading, isError, dataUpdatedAt } = useCostByPeriod(period);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-display-md font-display">Cost analytics</h1>
        <AutoRefreshControl dataUpdatedAt={dataUpdatedAt} />
      </div>
      <Tabs
        value={period}
        onValueChange={(v) => setPeriod(v as "day" | "week")}
      >
        <Tabs.List aria-label="period">
          <Tabs.Trigger value="day">Day</Tabs.Trigger>
          <Tabs.Trigger value="week">Week</Tabs.Trigger>
        </Tabs.List>
      </Tabs>
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
