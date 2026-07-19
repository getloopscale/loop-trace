import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownText } from "./MarkdownText.js";

describe("MarkdownText (M12 D4 / risk #2)", () => {
  it("test_markdown_text_renders_markdown_not_raw", () => {
    const { container } = render(<MarkdownText text={"# Title\n\nsome **bold** text"} />);
    // M19/FE-01: markdown headings are demoted to non-heading paragraphs so embedded
    // content never hijacks the page outline — no <h1>, but the text + emphasis render.
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("p[data-md-heading]")?.textContent).toBe(
      "Title",
    );
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
    // the anchor survives (markdown link syntax) but its javascript: href is
    // dropped by sanitization — asserted unconditionally (a security check must
    // never silently skip, F-test-2). A sanitized <a> has no href at all.
    const a = container.querySelector("a");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href") ?? "").not.toMatch(/^(javascript|data):/i);
    // the payload never executed.
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
