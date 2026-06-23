/**
 * MetricChart (M20) — one pure-SVG primitive driving the dashboard's global
 * chart-type toggle (D3). No chart library; extends the M11 `Sparkbar` SVG
 * approach. Three modes:
 *   - line:         one polyline per series.
 *   - bar:          single series → bars; multi-series → stacked bars.
 *   - distribution: ≥2 series → overlaid bands (latency p50/p75/p95/p99, Grafana
 *                   style); single series → degrades to bar (EC-2 — never assumes
 *                   4 bands so Traffic/Tokens/Cost cards don't throw).
 *
 * Series share one y-scale (global max) so bands are comparable. Empty / single-
 * point series render without NaN geometry (the Sparkbar guard, EC-5). The chart
 * is `role="img"` with an aria-label + a visually-hidden value summary so screen
 * readers get the numbers (the tables it replaces were the prior a11y source).
 */
export interface ChartSeries {
  label: string;
  values: number[];
}

export type ChartMode = "line" | "bar" | "distribution";

const W = 300;
const PAD = 4;

function maxOf(series: ChartSeries[]): number {
  let m = 0;
  for (const s of series) for (const v of s.values) if (v > m) m = v;
  return m;
}

function xAt(i: number, n: number): number {
  if (n <= 1) return W / 2;
  return PAD + (i * (W - 2 * PAD)) / (n - 1);
}

function yAt(v: number, max: number, h: number): number {
  if (max <= 0) return h - PAD;
  return h - PAD - (v / max) * (h - 2 * PAD);
}

function Lines({
  series,
  max,
  h,
  filled,
}: {
  series: ChartSeries[];
  max: number;
  h: number;
  filled: boolean;
}) {
  return (
    <>
      {series.map((s, si) => {
        const n = s.values.length;
        if (n === 0) return null;
        const opacity = 0.9 - si * 0.18;
        const pts = s.values.map((v, i) => `${xAt(i, n)},${yAt(v, max, h)}`).join(" ");
        return (
          <g key={s.label}>
            {filled ? (
              <polygon
                points={`${PAD},${h - PAD} ${pts} ${W - PAD},${h - PAD}`}
                fill="currentColor"
                opacity={Math.max(0.06, opacity * 0.18)}
              />
            ) : null}
            <polyline
              points={pts}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              opacity={Math.max(0.25, opacity)}
            />
          </g>
        );
      })}
    </>
  );
}

function Bars({ series, max, h }: { series: ChartSeries[]; max: number; h: number }) {
  // Single series → simple bars; multi-series → stacked. Bucket count = the
  // longest series; missing values count as 0 (sparse-safe).
  const n = Math.max(0, ...series.map((s) => s.values.length));
  if (n === 0) return null;
  const slot = (W - 2 * PAD) / n;
  const barW = slot > 1 ? slot * 0.8 : slot;
  // For stacking, scale by the per-bucket stacked total (or the global max,
  // whichever is larger) so a stack never overflows the viewBox.
  const stackMax = Array.from({ length: n }, (_, i) =>
    series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
  ).reduce((m, v) => (v > m ? v : m), 0);
  const scale = Math.max(max, stackMax);
  return (
    <>
      {Array.from({ length: n }, (_, i) => {
        let acc = 0;
        return series.map((s, si) => {
          const v = s.values[i] ?? 0;
          const barH = scale > 0 ? (v / scale) * (h - 2 * PAD) : 0;
          const y = h - PAD - acc - barH;
          acc += barH;
          return (
            <rect
              key={`${s.label}-${i}`}
              x={PAD + i * slot + (slot - barW) / 2}
              y={y}
              width={barW}
              height={barH}
              fill="currentColor"
              opacity={Math.max(0.3, 0.85 - si * 0.18)}
            />
          );
        });
      })}
    </>
  );
}

export function MetricChart({
  series,
  mode,
  height = 120,
  ariaLabel,
}: {
  series: ChartSeries[];
  mode: ChartMode;
  height?: number;
  ariaLabel: string;
}) {
  const nonEmpty = series.filter((s) => s.values.length > 0);
  const max = maxOf(nonEmpty);
  // EC-2: distribution needs ≥2 series (bands); a single series degrades to bar.
  const effectiveMode: ChartMode =
    mode === "distribution" && nonEmpty.length < 2 ? "bar" : mode;

  // Screen-reader summary: last + peak per series (the tables this replaced
  // exposed every bucket; last+peak is the meaningful floor for a trend chart).
  const summary = nonEmpty
    .map((s) => {
      const last = s.values[s.values.length - 1] ?? 0;
      const peak = s.values.reduce((m, v) => (v > m ? v : m), 0);
      return `${s.label}: ${last} (peak ${peak})`;
    })
    .join("; ");

  return (
    <div className="metric-chart text-primary">
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
      >
        {nonEmpty.length === 0 ? null : effectiveMode === "bar" ? (
          <Bars series={nonEmpty} max={max} h={height} />
        ) : effectiveMode === "distribution" ? (
          <Lines series={nonEmpty} max={max} h={height} filled />
        ) : (
          <Lines series={nonEmpty} max={max} h={height} filled={false} />
        )}
      </svg>
      <span className="sr-only">{summary || "no data"}</span>
    </div>
  );
}
