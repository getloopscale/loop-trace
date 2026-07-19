import { Gauge } from "lucide-react";
import { useRange } from "../hooks/useRange.js";
import { useEvaluators } from "../hooks/useEvaluators.js";
import { PinnedChartCard } from "../components/charts/PinnedChartCard.js";
import { Loading, ErrorState, EmptyState } from "../components/primitives/States.js";
import type { EvaluatorSummary } from "../api/types.js";

/** Average score rendered to 2 decimals, or "—" when the evaluator emits no numeric score. */
function fmtAvg(avg: number | undefined): string {
  return typeof avg === "number" ? avg.toFixed(2) : "—";
}

/** One Online Evaluator card: avg score + count + label distribution (M26). */
function EvaluatorCard({ ev }: { ev: EvaluatorSummary }) {
  const labels = Object.entries(ev.labels).sort((a, b) => b[1] - a[1]);
  return (
    <PinnedChartCard
      title={ev.name}
      icon={Gauge}
      stats={[
        { label: "Avg score", value: fmtAvg(ev.avgScore) },
        { label: "Evaluated", value: ev.count },
      ]}
    >
      {labels.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-body-sm">
          {labels.map(([label, n]) => (
            <li key={label} className="flex justify-between gap-4">
              <span className="text-muted-foreground">{label}</span>
              <span className="font-display tabular-nums">{n}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body-sm text-muted-foreground">No labels</p>
      )}
    </PinnedChartCard>
  );
}

/**
 * Evals & Metrics (M26): Online Evaluators cards — one per evaluator emitting
 * `eval.<name>.*` span attributes — with avg score + label distribution over the
 * shared date range. Mirrors the DashboardPage metrics-page shape.
 */
export function EvalsPage() {
  const { range } = useRange();
  const { data, isLoading, isError } = useEvaluators(range);
  const evaluators = data?.evaluators ?? [];

  return (
    <div className="evals-page flex flex-col gap-4">
      <h1 className="text-display-md font-display">Evals &amp; Metrics</h1>
      {isLoading ? (
        <Loading label="Loading evaluators…" />
      ) : isError ? (
        <ErrorState message="Failed to load evaluators" />
      ) : evaluators.length === 0 ? (
        <EmptyState message="No online evaluations in range. Emit eval.<name>.score / .label / .explanation span attributes to populate this view." />
      ) : (
        <section
          aria-label="Online Evaluators"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {evaluators.map((ev) => (
            <EvaluatorCard key={ev.name} ev={ev} />
          ))}
        </section>
      )}
    </div>
  );
}
