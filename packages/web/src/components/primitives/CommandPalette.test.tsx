import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette.js";

const navigate = vi.fn();
vi.mock("react-router-dom", async (orig) => {
  const actual = await orig<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate };
});

function renderPalette() {
  return render(
    <>
      <CommandPalette />
    </>,
  );
}

beforeEach(() => navigate.mockReset());

describe("CommandPalette", () => {
  it("test_cmdk_opens_palette", async () => {
    renderPalette();
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.keyboard("{Control>}k{/Control}");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByLabelText("command search")).toBeInTheDocument();
    expect(screen.getByText("Go to Sessions")).toBeInTheDocument();
  });

  it("test_palette_filters_and_navigates", async () => {
    renderPalette();
    await userEvent.keyboard("{Control>}k{/Control}");
    const input = await screen.findByLabelText("command search");
    await userEvent.type(input, "sessions");
    // only the Sessions command remains; Enter runs the highlighted (first) match
    await userEvent.keyboard("{Enter}");
    expect(navigate).toHaveBeenCalledWith("/sessions");
  });

  it("test_palette_arrow_keys_move_highlight_then_enter", async () => {
    renderPalette();
    await userEvent.keyboard("{Control>}k{/Control}");
    const input = await screen.findByLabelText("command search");
    // "agent" → two matches: Agent Graph (0), Agent Path (1)
    await userEvent.type(input, "agent");
    // combobox wiring: activedescendant points at the highlighted option
    expect(input).toHaveAttribute("aria-activedescendant", "cmdk-opt-agent-graph");
    await userEvent.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", "cmdk-opt-agent-path");
    await userEvent.keyboard("{Enter}");
    expect(navigate).toHaveBeenCalledWith("/agent-path");
  });

  it("test_palette_escape_closes", async () => {
    renderPalette();
    await userEvent.keyboard("{Control>}k{/Control}");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("test_palette_open_trace_by_id", async () => {
    renderPalette();
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.click(await screen.findByText("Open trace by ID…"));
    const idInput = await screen.findByLabelText("trace id");
    await userEvent.type(idInput, "abc123");
    await userEvent.keyboard("{Enter}");
    expect(navigate).toHaveBeenCalledWith("/traces/abc123");
  });
});
