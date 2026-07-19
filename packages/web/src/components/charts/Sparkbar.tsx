/**
 * A tiny inline-SVG bar series (M11, D3 — no chart library). Purely decorative:
 * `aria-hidden` so screen readers use the accompanying data table (the a11y
 * source of truth), never the SVG. Bars scale by the series MAX, so a sparse
 * (mostly-zero) series still renders without assuming contiguous buckets; an
 * empty series renders an empty (rect-less) SVG rather than NaN geometry (EC-2).
 */
export function Sparkbar({
  values,
  label,
  width = 120,
  height = 24,
}: {
  values: number[];
  label: string;
  width?: number;
  height?: number;
}) {
  const max = values.reduce((m, v) => (v > m ? v : m), 0);
  const slot = values.length > 0 ? width / values.length : 0;
  const barWidth = slot > 1 ? slot - 1 : slot;
  return (
    <svg
      className="block text-primary"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      role="presentation"
      data-label={label}
    >
      {values.map((v, i) => {
        // max === 0 → every bar is height 0 (never a divide-by-zero NaN).
        const h = max > 0 ? (v / max) * height : 0;
        return (
          <rect
            key={i}
            x={i * slot}
            y={height - h}
            width={barWidth}
            height={h}
            fill="currentColor"
          />
        );
      })}
    </svg>
  );
}
