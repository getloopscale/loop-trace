import { Pin, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * PinnedChartCard (M20) — one Arize "Pinned Charts" card: a pin glyph + title +
 * inline key stats (e.g. "P50 1.17s · P99 11.94s") above a chart. Presentation
 * only; the chart (a `MetricChart`) is passed as children so the card is agnostic
 * to the metric. Empty state shown when there is nothing to chart.
 */
export function PinnedChartCard({
  title,
  icon: Icon,
  stats,
  empty,
  emptyMessage = "No data in range",
  children,
}: {
  title: string;
  icon?: LucideIcon;
  stats?: { label: string; value: ReactNode }[];
  empty?: boolean;
  emptyMessage?: string;
  children?: ReactNode;
}) {
  return (
    <section
      className="pinned-chart-card flex flex-col gap-2 rounded-lg border border-border bg-card p-4"
      aria-label={title}
    >
      <header className="flex items-center gap-2">
        {Icon ? <Icon className="size-4 text-muted-foreground" aria-hidden /> : (
          <Pin className="size-4 text-muted-foreground" aria-hidden />
        )}
        <h2 className="text-label font-display">{title}</h2>
      </header>
      {stats && stats.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-body-sm text-muted-foreground">
          {stats.map((s) => (
            <span key={s.label}>
              {s.label}{" "}
              <span className="font-display tabular-nums text-foreground">
                {s.value}
              </span>
            </span>
          ))}
        </div>
      ) : null}
      {empty ? (
        <p className="text-body-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        children
      )}
    </section>
  );
}
