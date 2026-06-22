import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Sparkbar } from "./Sparkbar.js";

describe("Sparkbar", () => {
  it("test_sparkbar_is_aria_hidden", () => {
    // The SVG is a decorative enhancement — the data table is the a11y value (D3).
    const { container } = render(<Sparkbar values={[1, 4, 2]} label="traffic" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    // one <rect> per data point.
    expect(container.querySelectorAll("rect")).toHaveLength(3);
  });

  it("test_sparkbar_handles_sparse_and_empty_series", () => {
    // Sparse (non-contiguous) series: bars scale by the MAX value, no NaN, no
    // assumption of evenly-spaced/contiguous buckets (EC-2).
    const sparse = render(<Sparkbar values={[0, 0, 7, 0]} label="sparse" />);
    const rects = sparse.container.querySelectorAll("rect");
    expect(rects).toHaveLength(4);
    for (const r of rects) {
      const h = Number(r.getAttribute("height"));
      expect(Number.isNaN(h)).toBe(false);
      expect(h).toBeGreaterThanOrEqual(0);
    }
    // tallest bar is the max value (7); zero-value bars have height 0.
    const heights = [...rects].map((r) => Number(r.getAttribute("height")));
    expect(Math.max(...heights)).toBeGreaterThan(0);
    expect(heights.filter((h) => h === 0)).toHaveLength(3);

    // Empty series renders nothing (not NaN), not a broken SVG.
    const empty = render(<Sparkbar values={[]} label="empty" />);
    expect(empty.container.querySelector("rect")).toBeNull();
  });
});
