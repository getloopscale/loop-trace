import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpanQueryToolbar } from "./SpanQueryToolbar.js";
import { SpanQueryProvider, useSpanQuery } from "../../hooks/useSpanQuery.js";

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

/** Surfaces the provider's value so the test can assert the shared string. */
function QueryProbe() {
  const { spanQuery } = useSpanQuery();
  return <span data-testid="shared-query">{spanQuery}</span>;
}

function renderToolbar() {
  return render(
    <SpanQueryProvider>
      <SpanQueryToolbar />
      <QueryProbe />
    </SpanQueryProvider>,
  );
}

describe("SpanQueryToolbar (M30b)", () => {
  it("test_toolbar_renders_bar_and_builder", () => {
    renderToolbar();
    expect(screen.getByLabelText("filter spans")).toBeInTheDocument();
    expect(screen.getByLabelText("filter field")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add filter" })).toBeInTheDocument();
  });

  it("test_toolbar_builder_and_bar_share_one_query", async () => {
    renderToolbar();
    // add a clause via the builder → the shared query string updates, and the free-text
    // bar reflects the same value (one source of truth, D3)
    await userEvent.selectOptions(screen.getByLabelText("filter value"), "tool");
    await userEvent.click(screen.getByRole("button", { name: "Add filter" }));
    await waitFor(() =>
      expect(screen.getByTestId("shared-query").textContent).toBe("kind:tool"),
    );
    expect(screen.getByLabelText("filter spans")).toHaveValue("kind:tool");
  });
});
