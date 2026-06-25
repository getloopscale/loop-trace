import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

/** A row WITHOUT firstMessagePreview (omits the optional key — exactOptionalPropertyTypes-safe). */
function rowWithoutFirstMessage(over: Partial<SessionListItem> = {}): SessionListItem {
  const r = row(over);
  delete (r as { firstMessagePreview?: string }).firstMessagePreview;
  return r;
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
    // all 7 columns render (headers prove the column set)
    for (const h of ["First message", "Messages", "Duration", "Tokens", "Cost", "Start", "End"]) {
      expect(screen.getByRole("columnheader", { name: h })).toBeInTheDocument();
    }
    // first message is the lead column + links to the session
    const link = screen.getByRole("link", { name: /Plan a 3-day trip to Lisbon/ });
    expect(link).toHaveAttribute("href", "/sessions/S1");
    // cell values scoped to the data row (row[0] is the header)
    const dataRow = screen.getAllByRole("row")[1]!;
    expect(within(dataRow).getByText("3")).toBeInTheDocument(); // messages
    expect(within(dataRow).getByText("1h 0m")).toBeInTheDocument(); // duration
    expect(within(dataRow).getByText("1500")).toBeInTheDocument(); // tokens
    expect(within(dataRow).getByText("$0.0125")).toBeInTheDocument(); // cost
  });

  it("test_session_table_renders_evals_column", () => {
    // M26d: per-session online-eval count column; DASH when omitted (0).
    renderTable([row({ evaluationsCount: 4 })]);
    expect(screen.getByRole("columnheader", { name: "Evals" })).toBeInTheDocument();
    expect(screen.getByLabelText("4 evaluations")).toHaveTextContent("4");
  });

  it("sessions_table_first_message_falls_back_to_session_id_when_absent", () => {
    // No firstMessagePreview → the lead column links by the sessionId (a clickable
    // identifier, not a dead "—" link). Documented divergence from the literal plan AC.
    renderTable([rowWithoutFirstMessage()]);
    expect(screen.getByRole("link", { name: "S1" })).toHaveAttribute(
      "href",
      "/sessions/S1",
    );
  });

  it("sessions_table_zero_trace_session_renders_zero_and_short_duration", () => {
    // EC-3: a session with no member traces (traceCount 0) and equal start/end →
    // Messages "0", Duration "0s" (computed, never NaN); still a valid row.
    renderTable([
      rowWithoutFirstMessage({
        traceCount: 0,
        totalTokens: 0,
        firstSeenAt: "2026-06-22T00:00:00.000Z",
        lastSeenAt: "2026-06-22T00:00:00.000Z",
      }),
    ]);
    const dataRow = screen.getAllByRole("row")[1]!;
    expect(within(dataRow).getByText("0s")).toBeInTheDocument(); // duration, not NaN
    expect(within(dataRow).getAllByText("0").length).toBeGreaterThan(0); // messages/tokens
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
