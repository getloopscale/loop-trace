import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { CommandPalette } from "./CommandPalette.js";

const navigate = vi.fn();
vi.mock("react-router-dom", async (orig) => {
  const actual = await orig<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate };
});

function renderPalette() {
  return render(
    <ThemeProvider defaultTheme="violet-forge" defaultMode="dark" themes={[violetForge]}>
      <CommandPalette />
    </ThemeProvider>,
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
