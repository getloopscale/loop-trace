import { useState } from "react";
import { Link } from "react-router-dom";
import { useObservability } from "../hooks/useObservability.js";
import { Sparkbar } from "../components/Sparkbar.js";
import { Loading, ErrorState, EmptyState } from "../components/states.js";
import { formatDuration } from "../lib/duration.js";
import { formatUsd } from "../lib/money.js";
import { formatPercent } from "../lib/percent.js";
import type {
  LatencyBucket,
  ModelTokenBucket,
  ObservabilityRange,
  TrafficBucket,
} from "../api/types.js";

const RANGES: ObservabilityRange[] = ["1h", "24h", "7d", "30d"];

/** A metric section: an accessible data table + an aria-hidden sparkbar enhancement. */
function MetricSection({
  caption,
  empty,
  series,
  children,
}: {
  caption: string;
  empty: boolean;
  series: number[];
  children: React.ReactNode;
}) {
  if (empty) return <EmptyState message={`No ${caption.toLowerCase()} yet`} />;
  return (
    <section className="metric-section">
      <Sparkbar values={series} label={caption} />
      {children}
    </section>
  );
}

/**
 * Observability dashboard (M11 DoD): a time-range selector (1h/24h/7d/30d) and
 * three time-series metric families — traffic + error-rate, latency percentiles,
 * tokens/cost by model. Each family is an accessible data table (the a11y source
 * of truth, D3) with an aria-hidden inline-SVG sparkbar enhancement (no chart
 * library). Loading/error/empty states mirror the rest of the app.
 */
export function ObservabilityPage() {
  const [range, setRange] = useState<ObservabilityRange>("24h");
  const { data, isLoading, isError } = useObservability(range);
  return (
    <main className="observability-page">
      <Link to="/">← Executions</Link>
      <h1>Observability</h1>
      <div className="range-toggle" role="radiogroup" aria-label="time range">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={range === r}
            onClick={() => setRange(r)}
          >
            {r}
          </button>
        ))}
      </div>
      {isLoading ? (
        <Loading label="Loading observability…" />
      ) : isError || !data ? (
        <ErrorState message="Failed to load observability" />
      ) : (
        <>
          <TrafficTable buckets={data.traffic} />
          <LatencyTable buckets={data.latency} />
          <TokensByModelTable buckets={data.tokensByModel} />
        </>
      )}
    </main>
  );
}

function TrafficTable({ buckets }: { buckets: TrafficBucket[] }) {
  return (
    <MetricSection
      caption="Traffic & error rate"
      empty={buckets.length === 0}
      series={buckets.map((b) => b.traceCount)}
    >
      <table className="metric-table">
        <caption>Traffic &amp; error rate</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Traces</th>
            <th scope="col">Errors</th>
            <th scope="col">Error rate</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.periodStart}>
              <td>{b.periodStart}</td>
              <td>{b.traceCount}</td>
              <td>{b.errorCount}</td>
              <td>{formatPercent(b.errorRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </MetricSection>
  );
}

function LatencyTable({ buckets }: { buckets: LatencyBucket[] }) {
  return (
    <MetricSection
      caption="Latency percentiles"
      empty={buckets.length === 0}
      series={buckets.map((b) => b.p95Ms)}
    >
      <table className="metric-table">
        <caption>Latency percentiles</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">p50</th>
            <th scope="col">p75</th>
            <th scope="col">p95</th>
            <th scope="col">p99</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.periodStart}>
              <td>{b.periodStart}</td>
              <td>{formatDuration(b.p50Ms)}</td>
              <td>{formatDuration(b.p75Ms)}</td>
              <td>{formatDuration(b.p95Ms)}</td>
              <td>{formatDuration(b.p99Ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </MetricSection>
  );
}

function TokensByModelTable({ buckets }: { buckets: ModelTokenBucket[] }) {
  return (
    <MetricSection
      caption="Tokens & cost by model"
      empty={buckets.length === 0}
      series={buckets.map((b) => b.totalTokens)}
    >
      <table className="metric-table">
        <caption>Tokens &amp; cost by model</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Model</th>
            <th scope="col">Tokens</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={`${b.periodStart}-${b.model}`}>
              <td>{b.periodStart}</td>
              <td>{b.model}</td>
              <td>{b.totalTokens}</td>
              <td>{formatUsd(b.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </MetricSection>
  );
}
