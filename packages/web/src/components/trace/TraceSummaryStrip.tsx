import { StatTile } from "@usetheo/ui";
import { Activity, Clock, Coins, DollarSign } from "lucide-react";
import { useObservability } from "../../hooks/useObservability.js";
import { useRange } from "../../hooks/useRange.js";
import { Sparkbar } from "../charts/Sparkbar.js";
import { formatDuration } from "../../lib/duration.js";
import { formatUsd } from "../../lib/money.js";

/**
 * Arize-style "Pinned Charts" summary strip (M18): Traffic / Latency / Tokens /
 * Cost stat tiles, each with an inline sparkbar trend. Reuses the M11 observability
 * series + the M11 Sparkbar (zero new dependency). The window follows the global
 * date-range picker (M29b) — one time control across the app.
 */
export function TraceSummaryStrip() {
  const { range } = useRange();
  const { data } = useObservability(range);

  const traffic = data?.traffic ?? [];
  const latency = data?.latency ?? [];
  const tokensByModel = data?.tokensByModel ?? [];

  const trafficSeries = traffic.map((b) => b.traceCount);
  const totalTraces = trafficSeries.reduce((a, b) => a + b, 0);

  const latencySeries = latency.map((b) => b.p95Ms);
  const lastP95 = latency.length > 0 ? latency[latency.length - 1]!.p95Ms : 0;

  // tokensByModel is per (period, model); aggregate per period for the trend + totals.
  const byPeriodTokens = new Map<string, number>();
  const byPeriodCost = new Map<string, number>();
  for (const b of tokensByModel) {
    byPeriodTokens.set(
      b.periodStart,
      (byPeriodTokens.get(b.periodStart) ?? 0) + b.totalTokens,
    );
    byPeriodCost.set(
      b.periodStart,
      (byPeriodCost.get(b.periodStart) ?? 0) + b.costUsd,
    );
  }
  const tokenSeries = [...byPeriodTokens.values()];
  const costSeries = [...byPeriodCost.values()];
  const totalTokens = tokenSeries.reduce((a, b) => a + b, 0);
  const totalCost = costSeries.reduce((a, b) => a + b, 0);

  return (
    <div
      className="grid grid-cols-2 gap-3 md:grid-cols-4"
      aria-label={`${range} summary`}
    >
      <div className="flex flex-col gap-1">
        <StatTile value={totalTraces} label={`Traces (${range})`} icon={Activity} />
        <Sparkbar values={trafficSeries} label="Traffic trend" />
      </div>
      <div className="flex flex-col gap-1">
        <StatTile value={formatDuration(lastP95)} label="Latency p95" icon={Clock} />
        <Sparkbar values={latencySeries} label="Latency p95 trend" />
      </div>
      <div className="flex flex-col gap-1">
        <StatTile value={totalTokens} label={`Tokens (${range})`} icon={Coins} />
        <Sparkbar values={tokenSeries} label="Tokens trend" />
      </div>
      <div className="flex flex-col gap-1">
        <StatTile value={formatUsd(totalCost)} label={`Cost (${range})`} icon={DollarSign} />
        <Sparkbar values={costSeries} label="Cost trend" />
      </div>
    </div>
  );
}
