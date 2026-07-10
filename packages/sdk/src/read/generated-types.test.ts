import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import openapiTS, { astToString } from "openapi-typescript";
import { describe, expect, it } from "vitest";

/**
 * Second half of the drift gate (M103, closes the review's HIGH). The snapshot test proves
 * `snapshot.json` ↔ engine doc; THIS proves `snapshot.json` ↔ the committed generated
 * `__generated__/openapi.ts` — the file the client's aliases actually resolve to. Without it, a
 * regenerated snapshot with a stale (or hand-edited) `openapi.ts` would pass silently, the exact
 * failure ADR-1 exists to prevent one layer down. Input is the committed snapshot only (no engine
 * import), so it is independent of the generator's core src/dist resolution.
 */
const here = dirname(fileURLToPath(import.meta.url));
const snapshotPath = join(here, "..", "..", "openapi.snapshot.json");
const generatedPath = join(here, "..", "__generated__", "openapi.ts");

describe("generated types ↔ snapshot drift gate (M103)", () => {
  it("committed openapi.ts equals a fresh regeneration from the committed snapshot", async () => {
    // Mirror generate-types.ts: mutable clone (openapi-typescript's bundler mutates the doc).
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Parameters<
      typeof openapiTS
    >[0];
    const regeneratedBody = astToString(await openapiTS(snapshot)).trim();

    const committed = readFileSync(generatedPath, "utf8");
    // Strip the generator's banner block (everything up to and including the first `*/`).
    const committedBody = committed.slice(committed.indexOf("*/") + 2).trim();

    expect(committedBody).toBe(regeneratedBody);
  });
});
