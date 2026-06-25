import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SpanQueryProvider,
  useSpanQuery,
  readStoredSpanQuery,
} from "./useSpanQuery.js";

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

function Probe() {
  const { spanQuery, setSpanQuery } = useSpanQuery();
  return (
    <div>
      <span data-testid="q">{spanQuery}</span>
      <button onClick={() => setSpanQuery("kind:llm")}>set</button>
    </div>
  );
}

describe("SpanQueryProvider (M30b)", () => {
  it("test_span_query_provider_defaults_empty", () => {
    render(
      <SpanQueryProvider>
        <Probe />
      </SpanQueryProvider>,
    );
    expect(screen.getByTestId("q").textContent).toBe("");
    expect(readStoredSpanQuery()).toBe("");
  });

  it("test_span_query_provider_persists_and_restores", async () => {
    const { unmount } = render(
      <SpanQueryProvider>
        <Probe />
      </SpanQueryProvider>,
    );
    await userEvent.click(screen.getByText("set"));
    expect(screen.getByTestId("q").textContent).toBe("kind:llm");
    expect(readStoredSpanQuery()).toBe("kind:llm");
    unmount();
    render(
      <SpanQueryProvider>
        <Probe />
      </SpanQueryProvider>,
    );
    expect(screen.getByTestId("q").textContent).toBe("kind:llm");
  });

  it("test_span_query_provider_disabled_storage_falls_back", () => {
    // Negative case: throwing getItem (private mode/disabled) → "" default, never crash.
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("disabled", "SecurityError");
    });
    try {
      expect(readStoredSpanQuery()).toBe("");
    } finally {
      spy.mockRestore();
    }
  });
});
