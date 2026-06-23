import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MetricChart, type ChartSeries } from "./MetricChart.js";

const single: ChartSeries[] = [{ label: "traces", values: [1, 4, 2, 8, 5] }];
const latency: ChartSeries[] = [
  { label: "p50", values: [10, 12, 11, 14] },
  { label: "p75", values: [18, 20, 19, 22] },
  { label: "p95", values: [40, 44, 42, 50] },
  { label: "p99", values: [80, 90, 85, 95] },
];

describe("MetricChart (M20)", () => {
  it("metric_chart_renders_line_bar_distribution", () => {
    const line = render(
      <MetricChart series={single} mode="line" ariaLabel="traces" />,
    );
    expect(line.container.querySelector("polyline")).not.toBeNull();

    const bar = render(<MetricChart series={single} mode="bar" ariaLabel="traces" />);
    expect(bar.container.querySelector("rect")).not.toBeNull();

    // distribution with ≥2 series → bands (≥4 polylines for the 4 percentiles)
    const dist = render(
      <MetricChart series={latency} mode="distribution" ariaLabel="latency" />,
    );
    expect(dist.container.querySelectorAll("polyline").length).toBeGreaterThanOrEqual(4);

    // EC-2: distribution with a single series degrades to bar (no throw, renders rects)
    const distSingle = render(
      <MetricChart series={single} mode="distribution" ariaLabel="traces" />,
    );
    expect(distSingle.container.querySelector("rect")).not.toBeNull();
    expect(distSingle.container.querySelector("polyline")).toBeNull();
  });

  it("metric_chart_empty_series_no_nan", () => {
    const empty = render(
      <MetricChart series={[{ label: "x", values: [] }]} mode="line" ariaLabel="x" />,
    );
    // renders an SVG, no NaN anywhere in the geometry
    expect(empty.container.querySelector("svg")).not.toBeNull();
    expect(empty.container.innerHTML).not.toMatch(/NaN/);
    expect(empty.container.querySelector("polyline")).toBeNull();
  });

  it("metric_chart_single_point_series_no_nan", () => {
    // EC-5: a single-point series must not produce NaN (n-1 denominator guard)
    const one = render(
      <MetricChart series={[{ label: "x", values: [42] }]} mode="line" ariaLabel="x" />,
    );
    expect(one.container.innerHTML).not.toMatch(/NaN/);
  });
});
