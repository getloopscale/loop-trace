import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SessionTable, sessionDuration } from "./SessionTable.js";
import type { SessionListItem } from "../api/types.js";

function row(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    sessionId: "S1",
    firstSeenAt: "2026-06-22T00:00:00.000Z",
    lastSeenAt: "2026-06-22T01:00:00.000Z",
    traceCount: 3,
    costUsd: 0.0125,
    totalTokens: 1500,
    errorRate: 0.25,
    firstMessagePreview: "Plan a 3-day trip to Lisbon",
    ...over,
  };
}

function renderTable(sessions: SessionListItem[]) {
  return render(
    <MemoryRouter>
      <SessionTable sessions={sessions} />
    </MemoryRouter>,
  );
}

describe("SessionTable (M20)", () => {
  it("sessions_table_renders_first_message_and_duration", () => {
    renderTable([row()]);
    // first message is the lead column + links to the session
    const link = screen.getByRole("link", { name: /Plan a 3-day trip to Lisbon/ });
    expect(link).toHaveAttribute("href", "/sessions/S1");
    // messages (=traceCount), duration (1h), cost present
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("1h 0m")).toBeInTheDocument();
    expect(screen.getByText("$0.0125")).toBeInTheDocument();
    expect(screen.getByText("1500")).toBeInTheDocument();
  });

  it("sessions_table_first_message_dash_when_absent", () => {
    // no firstMessagePreview → the link falls back to the sessionId (no crash, no "—" link gap)
    renderTable([row({ firstMessagePreview: undefined })]);
    expect(screen.getByRole("link", { name: "S1" })).toHaveAttribute(
      "href",
      "/sessions/S1",
    );
  });

  it("sessions_table_empty_state", () => {
    renderTable([]);
    expect(screen.getByText(/session\.id/i)).toBeInTheDocument();
  });

  it("session_duration_clamps_non_negative", () => {
    // EC-4: equal timestamps → "0s"; skewed (end<start) → clamped to 0, never negative.
    expect(sessionDuration("2026-06-22T00:00:00Z", "2026-06-22T00:00:00Z")).toBe("0s");
    expect(sessionDuration("2026-06-22T01:00:00Z", "2026-06-22T00:00:00Z")).toBe("0s");
    expect(sessionDuration("2026-06-22T00:00:00Z", "2026-06-22T00:00:45Z")).toBe("45s");
    expect(sessionDuration("2026-06-22T00:00:00Z", "2026-06-22T00:02:05Z")).toBe("2m 5s");
  });
});
