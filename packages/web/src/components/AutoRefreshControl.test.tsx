import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { AutoRefreshControl } from "./AutoRefreshControl.js";
import { AutoRefreshProvider } from "../hooks/useAutoRefresh.js";

const KEY = "theolens.autoRefreshMs";

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

  it("test_indicator_shows_seconds_since_dataUpdatedAt_when_active", () => {
    localStorage.setItem(KEY, "10000");
    render(withProvider(<AutoRefreshControl dataUpdatedAt={Date.now() - 3000} />));
    expect(screen.getByText(/updated 3s ago/)).toBeInTheDocument();
  });

  it("test_no_indicator_when_off", () => {
    // default Off → no indicator even if dataUpdatedAt is supplied
    render(withProvider(<AutoRefreshControl dataUpdatedAt={Date.now() - 3000} />));
    expect(screen.queryByText(/updated/)).not.toBeInTheDocument();
  });
});
