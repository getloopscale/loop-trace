import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Loading, ErrorState, EmptyState } from "./states.js";

describe("async-state components", () => {
  it("states_render_loading_error_and_empty", () => {
    const { rerender } = render(<Loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");

    rerender(<ErrorState message="boom" />);
    expect(screen.getByRole("alert")).toHaveTextContent("boom");

    rerender(<EmptyState message="nothing here" />);
    expect(screen.getByText("nothing here")).toBeInTheDocument();
  });
});
