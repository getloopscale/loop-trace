import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CostByPeriod } from "./CostByPeriod.js";
import type { CostBucket } from "../../api/types.js";

describe("CostByPeriod", () => {
  it("cost_by_period_renders_buckets_and_empty_state", () => {
    const buckets: CostBucket[] = [
      { periodStart: "2026-06-20T00:00:00.000Z", costUsd: 0.0125, totalTokens: 1500, traceCount: 3 },
    ];
    const { rerender } = render(<CostByPeriod buckets={buckets} />);
    expect(screen.getByText("2026-06-20")).toBeInTheDocument();
    expect(screen.getByText("$0.0125")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();

    rerender(<CostByPeriod buckets={[]} />);
    expect(screen.getByText("No cost data yet")).toBeInTheDocument();
  });
});
