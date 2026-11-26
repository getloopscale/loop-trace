import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The design tokens are light by default and switch on a `dark` class. Nothing in the app sets
 * that class at runtime, so the document has to carry it, or the whole UI renders light.
 */
describe("dark mode", () => {
  it("index_html_opts_the_document_into_dark_mode", () => {
    const html = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"),
      "utf8",
    );
    expect(html).toMatch(/<html[^>]*\bclass="[^"]*\bdark\b[^"]*"/u);
  });
});
