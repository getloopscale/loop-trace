import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopyButton } from "./CopyButton.js";

const originalClipboard = navigator.clipboard;
beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  Object.assign(navigator, { clipboard: originalClipboard });
});

describe("CopyButton (M12 / EC-5)", () => {
  it("test_copy_button_writes_to_clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton text="payload" />);
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("payload");
  });

  it("test_copy_button_no_ops_when_clipboard_unavailable", async () => {
    // EC-5: clipboard undefined (non-secure context) — click must not throw.
    Object.assign(navigator, { clipboard: undefined });
    render(<CopyButton text="payload" />);
    const btn = screen.getByRole("button", { name: "Copy" });
    expect(btn).toBeDisabled();
    await expect(userEvent.click(btn)).resolves.not.toThrow();
  });
});
