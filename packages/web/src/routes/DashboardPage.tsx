import { useState } from "react";
import { Tabs } from "@theokit/ui";
import { Activity, Clock, Coins, DollarSign, TrendingUp } from "lucide-react";
import { useObservability } from "../hooks/useObservability.js";
import { useNorthStar } from "../hooks/useNorthStar.js";
import { AutoRefreshControl } from "../components/AutoRefreshControl.js";
import { PinnedChartCard } from "../components/PinnedChartCard.js";
import { MetricChart, type ChartMode } from "../components/MetricChart.js";
import { Loading } from "../components/states.js";
import { formatDuration } from "../lib/duration.js";
import { formatUsd } from "../lib/money.js";
import type {
  ModelTokenBucket,
  ObservabilityRange,
  ObservabilityResponse,
} from "../api/types.js";

const RANGES: ObservabilityRange[] = ["1h", "24h", "7d", "30d"];
const CHART_MODES: { value: ChartMode; label: string }[] = [
  { value: "bar", label: "Stacked bar" },
  { value: "line", label: "Line" },
  { value: "distribution", label: "Distribution" },
];

/**
 * A themed segmented control built on the design-system Tabs (Radix — arrow-key
 * roving + roving tabindex for free, themed tokens, no raw hex). Used for both
 * the chart-type and the time-range toggles (DRY). Triggers expose role="tab"
 * with the label as the accessible name; the selected one carries aria-selected.
 */
function SegmentedToggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as T)}>
      <Tabs.List aria-label={label}>
        {options.map((o) => (
          <Tabs.Trigger key={o.value} value={o.value}>
            {o.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
    </Tabs>
  );
}

/** Sum tokens + cost per period across models (the per-period chart series). */
function aggregateByPeriod(
  buckets: ModelTokenBucket[],
): { period: string; tokens: number; cost: number }[] {
  const byPeriod = new Map<string, { tokens: number; cost: number }>();
  for (const b of buckets) {
    const acc = byPeriod.get(b.periodStart) ?? { tokens: 0, cost: 0 };
    acc.tokens += b.totalTokens;
    acc.cost += b.costUsd;
    byPeriod.set(b.periodStart, acc);
  }
  return [...byPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, v]) => ({ period, ...v }));
}

function ObservabilityCards({
  data,
  mode,
}: {
  data: ObservabilityResponse | undefined;
  mode: ChartMode;
}) {
  const traffic = data?.traffic ?? [];
  const latency = data?.latency ?? [];
  const tokensAgg = aggregateByPeriod(data?.tokensByModel ?? []);

  const totalTraces = traffic.reduce((s, b) => s + b.traceCount, 0);
  const totalErrors = traffic.reduce((s, b) => s + b.errorCount, 0);
  const lastLatency = latency[latency.length - 1];
  const totalTokens = tokensAgg.reduce((s, b) => s + b.tokens, 0);
  const totalCost = tokensAgg.reduce((s, b) => s + b.cost, 0);

  return (
    <>
      <PinnedChartCard
        title="Traffic"
        icon={Activity}
        stats={[
          { label: "Traces", value: totalTraces },
          { label: "Errors", value: totalErrors },
        ]}
        empty={traffic.length === 0}
      >
        <MetricChart
          mode={mode}
          ariaLabel="traffic over time"
          series={[
            { label: "traces", values: traffic.map((b) => b.traceCount) },
            { label: "errors", values: traffic.map((b) => b.errorCount) },
          ]}
        />
      </PinnedChartCard>

      <PinnedChartCard
        title="Span Latency"
        icon={Clock}
        stats={[
          { label: "P50", value: formatDuration(lastLatency?.p50Ms ?? 0) },
          { label: "P99", value: formatDuration(lastLatency?.p99Ms ?? 0) },
        ]}
        empty={latency.length === 0}
      >
        <MetricChart
          mode={mode}
          ariaLabel="latency percentiles"
          series={[
            { label: "p50", values: latency.map((b) => b.p50Ms) },
            { label: "p75", values: latency.map((b) => b.p75Ms) },
            { label: "p95", values: latency.map((b) => b.p95Ms) },
            { label: "p99", values: latency.map((b) => b.p99Ms) },
          ]}
        />
      </PinnedChartCard>

      <PinnedChartCard
        title="Tokens"
        icon={Coins}
        stats={[{ label: "Tokens", value: totalTokens }]}
        empty={tokensAgg.length === 0}
      >
        <MetricChart
          mode={mode}
          ariaLabel="tokens over time"
          series={[{ label: "tokens", values: tokensAgg.map((b) => b.tokens) }]}
        />
      </PinnedChartCard>

      <PinnedChartCard
        title="Cost"
        icon={DollarSign}
        stats={[{ label: "Cost", value: formatUsd(totalCost) }]}
        empty={tokensAgg.length === 0}
      >
        <MetricChart
          mode={mode}
          ariaLabel="cost over time"
          series={[{ label: "cost", values: tokensAgg.map((b) => b.cost) }]}
        />
      </PinnedChartCard>
    </>
  );
}

/**
 * Metrics dashboard (M20) — Arize "Pinned Charts": Traffic / Span Latency /
 * Tokens / Cost cards reusing the M11 observability series, plus the re-homed M8
 * north-star section (D4). One global chart-type toggle (Stacked bar / Line /
 * Distribution, D3/D5) drives every card; the M11 time-range toggle is preserved.
 * Fetch failures are fail-soft per source (the dashboard renders empty cards,
 * never crashes — M11 behavior).
 */
export function DashboardPage() {
  const [range, setRange] = useState<ObservabilityRange>("24h");
  const [chartMode, setChartMode] = useState<ChartMode>("line");
  const obs = useObservability(range);
  const ns = useNorthStar();

  const obsData = obs.isError ? undefined : obs.data;
  const nsData = ns.isError ? undefined : ns.data;
  const tracesPerDay = nsData?.tracesPerDay ?? [];
  const replayPerWeek = nsData?.replaySessionsPerWeek ?? [];

  return (
    <div className="dashboard-page flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-display-md font-display">Pinned Charts</h1>
        <SegmentedToggle
          label="chart type"
          value={chartMode}
          options={CHART_MODES}
          onChange={setChartMode}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <AutoRefreshControl dataUpdatedAt={obs.dataUpdatedAt} />
        <SegmentedToggle
          label="time range"
          value={range}
          options={RANGES.map((r) => ({ value: r, label: r }))}
          onChange={setRange}
        />
      </div>

      {obs.isLoading && !obs.data ? (
        <Loading label="Loading metrics…" />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ObservabilityCards data={obsData} mode={chartMode} />
        </div>
      )}

      <h2 className="text-title-md font-display">North-star</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PinnedChartCard
          title="Traces ingested / day"
          icon={TrendingUp}
          stats={[{ label: "Days", value: tracesPerDay.length }]}
          empty={tracesPerDay.length === 0}
        >
          <MetricChart
            mode={chartMode}
            ariaLabel="traces ingested per day"
            series={[{ label: "traces/day", values: tracesPerDay.map((b) => b.count) }]}
          />
        </PinnedChartCard>
        <PinnedChartCard
          title="Replay sessions / week"
          icon={TrendingUp}
          stats={[{ label: "Weeks", value: replayPerWeek.length }]}
          empty={replayPerWeek.length === 0}
        >
          <MetricChart
            mode={chartMode}
            ariaLabel="replay sessions per week"
            series={[
              { label: "replays/week", values: replayPerWeek.map((b) => b.count) },
            ]}
          />
        </PinnedChartCard>
      </div>
    </div>
  );
}
