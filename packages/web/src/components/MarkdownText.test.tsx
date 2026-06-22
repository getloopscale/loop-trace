import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownText } from "./MarkdownText.js";

describe("MarkdownText (M12 D4 / risk #2)", () => {
  it("test_markdown_text_renders_markdown_not_raw", () => {
    const { container } = render(<MarkdownText text={"# Title\n\nsome **bold** text"} />);
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    // not the literal markdown source
    expect(screen.queryByText("# Title")).toBeNull();
  });

  it("test_markdown_text_is_xss_safe", () => {
    const { container } = render(
      <MarkdownText
        text={
          "<script>window.__pwned=1</script>\n\n" +
          "<img src=x onerror=\"window.__pwned=1\" />\n\n" +
          "[click](javascript:window.__pwned=1)"
        }
      />,
    );
    // rehype-sanitize strips the script element entirely.
    expect(container.querySelector("script")).toBeNull();
    // no element carries an onerror handler.
    expect(container.querySelector("[onerror]")).toBeNull();
    // a javascript: link href is dropped/sanitized (never executable).
    const a = container.querySelector("a");
    if (a) expect(a.getAttribute("href")?.startsWith("javascript:")).not.toBe(true);
    // the payload never executed.
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
