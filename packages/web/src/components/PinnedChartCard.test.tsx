import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PinnedChartCard } from "./PinnedChartCard.js";
import { MetricChart } from "./MetricChart.js";

describe("PinnedChartCard (M20)", () => {
  it("pinned_chart_card_shows_title_stats_and_chart", () => {
    const { container } = render(
      <PinnedChartCard
        title="Span Latency"
        stats={[
          { label: "P50", value: "1.17s" },
          { label: "P99", value: "11.94s" },
        ]}
      >
        <MetricChart
          series={[{ label: "p95", values: [40, 44, 42] }]}
          mode="line"
          ariaLabel="latency"
        />
      </PinnedChartCard>,
    );
    expect(screen.getByRole("heading", { name: "Span Latency" })).toBeInTheDocument();
    expect(screen.getByText("P50")).toBeInTheDocument();
    expect(screen.getByText("1.17s")).toBeInTheDocument();
    expect(container.querySelector("polyline")).not.toBeNull();
  });

  it("pinned_chart_card_empty_state", () => {
    render(<PinnedChartCard title="Cost" empty emptyMessage="No cost data" />);
    expect(screen.getByText("No cost data")).toBeInTheDocument();
  });
});
