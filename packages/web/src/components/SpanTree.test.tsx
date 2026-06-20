import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpanTree } from "./SpanTree.js";
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
    // status: the failed span carries the error class AND a non-color text badge
    expect(screen.getByText("charge").closest("button")!.className).toContain("error");
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
});
