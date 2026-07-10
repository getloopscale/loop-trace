import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * M96 contract guard: no engine route may emit the pre-M96 bare-string error shape
 * `c.json({ error: … })`. Every error is the canonical `{ code, message, details? }` envelope
 * (built via `apiError`). This is a source-level assertion — it fails the moment a new route
 * re-introduces the bare shape, which a runtime test over a subset of routes could miss.
 */
const ROUTE_FILES = [
  "./app.ts",
  "./routes/dataset-routes.ts",
  "./routes/labeling-queue-routes.ts",
  "./handlers/replay.ts",
  "./handlers/evaluators.ts",
];

describe("M96 error-envelope contract", () => {
  it.each(ROUTE_FILES)("%s emits no bare-string { error: … } response", (rel) => {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    // Whitespace/newline-tolerant after `c.json(` so a multi-line `c.json(\n  { error: … })`
    // cannot slip past the guard (the exact blind spot that let one site survive M96 phase 1).
    const bare = src.match(/c\.json\(\s*\{\s*error\s*:/g) ?? [];
    expect(bare).toEqual([]);
  });
});
