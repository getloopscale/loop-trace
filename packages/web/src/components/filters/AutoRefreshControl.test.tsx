import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { AutoRefreshControl } from "./AutoRefreshControl.js";
import { AutoRefreshProvider } from "../../hooks/useAutoRefresh.js";

const KEY = "looptrace.autoRefreshMs";

function withProvider(ui: ReactNode) {
  return <AutoRefreshProvider>{ui}</AutoRefreshProvider>;
}

describe("AutoRefreshControl", () => {
  beforeEach(() => localStorage.clear());

  it("test_control_renders_all_interval_options", () => {
    render(withProvider(<AutoRefreshControl />));
    for (const label of ["Off", "5s", "10s", "30s", "1m"]) {
      expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
    }
  });

  it("test_changing_select_updates_shared_state", async () => {
    const user = userEvent.setup();
    render(withProvider(<AutoRefreshControl />));
    await user.selectOptions(screen.getByLabelText("Auto-refresh"), "10s");
    expect(localStorage.getItem(KEY)).toBe("10000");
  });

  it("test_no_indicator_when_off", () => {
    // default Off → no indicator even if dataUpdatedAt is supplied
    render(
      withProvider(<AutoRefreshControl dataUpdatedAt={Date.now() - 3000} />),
    );
    expect(screen.queryByText(/updated/)).not.toBeInTheDocument();
  });
});

describe("AutoRefreshControl indicator + display tick (fake timers)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("test_indicator_shows_seconds_since_dataUpdatedAt_when_active", () => {
    localStorage.setItem(KEY, "10000");
    render(
      withProvider(<AutoRefreshControl dataUpdatedAt={Date.now() - 3000} />),
    );
    expect(screen.getByText(/updated 3s ago/)).toBeInTheDocument();
  });

  it("test_tick_increments_while_active_then_cleans_up_on_unmount", () => {
    // EC-3: the 1s display tick advances the label while active and the interval
    // is cleared on unmount (no setState-after-unmount / dangling timer).
    localStorage.setItem(KEY, "10000");
    const updatedAt = Date.now();
    const { unmount } = render(
      withProvider(<AutoRefreshControl dataUpdatedAt={updatedAt} />),
    );
    expect(screen.getByText(/updated 0s ago/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText(/updated 2s ago/)).toBeInTheDocument();
    unmount();
    // after unmount the tick must not fire again — advancing timers is a no-op, no throw
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(5000);
      }),
    ).not.toThrow();
  });
});
