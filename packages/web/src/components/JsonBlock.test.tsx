import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JsonBlock } from "./JsonBlock.js";

beforeEach(() => vi.restoreAllMocks());

describe("JsonBlock (M12 D4)", () => {
  it("test_json_block_is_collapsible", () => {
    const { container } = render(<JsonBlock value={{ a: 1 }} summary="Attributes" />);
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(container.querySelector("summary")?.textContent).toBe("Attributes");
  });

  it("test_json_block_pretty_prints_value", () => {
    render(<JsonBlock value={{ role: "user" }} summary="evt" open />);
    expect(screen.getByText(/"role": "user"/)).toBeInTheDocument();
  });

  it("test_json_block_copies_to_clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<JsonBlock value={{ a: 1 }} summary="Attributes" open />);
    await userEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
    expect(writeText).toHaveBeenCalledWith(JSON.stringify({ a: 1 }, null, 2));
  });

  it("test_json_block_never_throws_on_non_serializable", () => {
    expect(() => render(<JsonBlock value={{ big: 10n }} summary="x" open />)).not.toThrow();
  });
});
