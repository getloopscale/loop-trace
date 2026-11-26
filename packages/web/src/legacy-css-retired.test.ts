import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

/**
 * The locked set of CSS classes that the retired `legacy.css` used to define.
 * The whole UI is now on `@getloopscale/ui` + design tokens — none of these may
 * reappear in a production `className`. This is the Goal's observable metric
 * (`legacy_class_refs == 0`) and a regression guard for future PRs.
 */
const LEGACY_CLASSES = new Set([
  "auto-refresh-control", "auto-refresh-updated", "copy-button", "cost-table",
  "cost-table-caption", "detail-attributes", "detail-error", "detail-events",
  "json-block", "json-block-body", "json-block-pre", "markdown-text", "md-heading",
  "period-toggle", "replay-btn", "replay-controls", "replay-counter", "session-list",
  "session-metrics", "span-detail", "span-duration", "span-kind", "span-name",
  "span-row", "span-status-badge", "span-status-error", "span-status-ok", "span-tree",
  "span-tree-wrap", "span-waterfall", "span-waterfall-bar", "sparkbar", "state-empty",
  "state-error", "state-loading", "tag-add", "tag-chip", "tag-chips", "tag-empty",
  "tool-sort", "tool-table", "trace-cost", "trace-duration", "trace-error-summary",
  "trace-export", "trace-filter-controls", "trace-filters", "trace-list", "trace-name",
  "trace-row", "trace-session-link", "trace-status", "trace-tokens", "trace-tags",
]);

const srcDir = join(dirname(fileURLToPath(import.meta.url)));

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx"))
      out.push(full);
  }
  return out;
}

/** Every string/template literal token, whitespace-split (so "a b" → [a, b]). */
function literalTokens(src: string): string[] {
  const tokens: string[] = [];
  for (const m of src.matchAll(/"([^"]*)"|`([^`]*)`|'([^']*)'/g)) {
    const body = m[1] ?? m[2] ?? m[3] ?? "";
    for (const t of body.split(/\s+/)) if (t) tokens.push(t);
  }
  return tokens;
}

describe("legacy.css retirement", () => {
  it("legacy_css_file_is_deleted", () => {
    expect(existsSync(join(srcDir, "legacy.css"))).toBe(false);
  });

  it("no_production_className_references_a_legacy_class", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(srcDir)) {
      for (const tok of literalTokens(readFileSync(file, "utf8"))) {
        if (LEGACY_CLASSES.has(tok)) offenders.push(`${file}: ${tok}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
