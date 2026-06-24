import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpanTree } from "./SpanTree.js";
import { kindColor } from "../lib/kind-color.js";
import type { TraceTreeNode } from "../api/types.js";

const tree: TraceTreeNode = {
  spanId: "root",
  traceId: "t",
  name: "checkout",
  startTimeUnixNano: "0",
  endTimeUnixNano: "5000000",
  statusCode: "1",
  children: [
    {
      spanId: "c1",
      traceId: "t",
      name: "search-products",
      startTimeUnixNano: "1000000",
      endTimeUnixNano: "3000000",
      statusCode: "1",
      children: [],
    },
    {
      spanId: "c2",
      traceId: "t",
      name: "charge",
      startTimeUnixNano: "0",
      endTimeUnixNano: "0",
      statusCode: "2",
      children: [],
    },
  ],
};

describe("SpanTree", () => {
  it("renders_trace_tree_with_nesting_duration_and_status", () => {
    render(<SpanTree root={tree} onSelect={() => {}} />);
    // all span names present
    expect(screen.getByText("checkout")).toBeInTheDocument();
    expect(screen.getByText("search-products")).toBeInTheDocument();
    expect(screen.getByText("charge")).toBeInTheDocument();
    // nesting: a child renders deeper than the root
    const rootBtn = screen.getByText("checkout").closest("button")!;
    const childBtn = screen.getByText("search-products").closest("button")!;
    expect(Number(childBtn.getAttribute("data-depth"))).toBeGreaterThan(
      Number(rootBtn.getAttribute("data-depth")),
    );
    // duration shown (5_000_000 ns = 5 ms)
    expect(screen.getByText("5 ms")).toBeInTheDocument();
    // status: the failed span carries a stable data-status hook AND a non-color text badge
    expect(
      screen.getByText("charge").closest("button")!.getAttribute("data-status"),
    ).toBe("error");
    expect(screen.getByText("⚠ error")).toBeInTheDocument();
  });

  it("fires_onSelect_with_clicked_span", async () => {
    const onSelect = vi.fn();
    render(<SpanTree root={tree} onSelect={onSelect} />);
    await userEvent.click(screen.getByText("search-products"));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ spanId: "c1" }),
    );
  });

  it("test_span_tree_renders_proportional_waterfall_bars", () => {
    const { container } = render(<SpanTree root={tree} onSelect={() => {}} />);
    const bars = container.querySelectorAll("[data-waterfall-bar]");
    expect(bars.length).toBeGreaterThanOrEqual(3); // one per span
    // child c1 [1ms,3ms] of root [0,5ms] → left≈20%
    const childBar = screen
      .getByText("search-products")
      .closest("button")!
      .querySelector("[data-waterfall-bar]") as HTMLElement;
    expect(childBar.style.width).toMatch(/%$/);
    expect(parseFloat(childBar.style.left)).toBeCloseTo(20, 0);
  });

  it("test_span_tree_renders_span_kind_label", () => {
    const withKinds: TraceTreeNode = {
      ...tree,
      children: [
        { ...tree.children[0]!, attributes: { "gen_ai.tool.name": "search-products" } },
        tree.children[1]!,
      ],
    };
    render(<SpanTree root={withKinds} onSelect={() => {}} />);
    const toolGlyph = screen.getByLabelText("kind: tool");
    const chainGlyph = screen.getByLabelText("kind: chain"); // root has children, no signal
    expect(toolGlyph).toBeInTheDocument();
    expect(chainGlyph).toBeInTheDocument();
    // M29: the glyph carries the canonical kind colour (single source — same as the badge/graph)
    expect(toolGlyph.className).toContain(kindColor("tool").textClass);
    expect(chainGlyph.className).toContain(kindColor("chain").textClass);
  });

  it("test_span_tree_shows_propagated_error_at_root", () => {
    // root ok ("1"), child "charge" errored ("2") → root-level error summary.
    render(<SpanTree root={tree} onSelect={() => {}} />);
    expect(screen.getByText(/This trace contains an error/)).toBeInTheDocument();
  });

  it("test_span_tree_no_error_summary_when_all_ok", () => {
    const ok: TraceTreeNode = { ...tree, children: [{ ...tree.children[0]! }] };
    render(<SpanTree root={ok} onSelect={() => {}} />);
    expect(screen.queryByText(/This trace contains an error/)).not.toBeInTheDocument();
  });
});
