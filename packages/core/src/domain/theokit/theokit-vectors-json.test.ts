/**
 * M124 (D3) — drift guard for the committed cross-language fixture `theokit-vectors.json`.
 *
 * The JSON is a projection of the single TS source of truth `MAPPER_VECTORS`. A committed file
 * rots the moment `MAPPER_VECTORS` changes without regeneration, so this test re-derives the
 * projection in-memory and asserts it is byte-for-byte the committed artifact — making any
 * divergence a red build (blueprint D3). The Python (M124) / Go (M125) suites load the committed
 * JSON, so this guard is what lets them trust it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectVectors } from "../../../scripts/export-theokit-vectors.js";

const COMMITTED_PATH = fileURLToPath(new URL("./theokit-vectors.json", import.meta.url));
const REGEN_HINT =
  "theokit-vectors.json is stale — run `pnpm --filter @looptrace/core exec tsx scripts/export-theokit-vectors.ts` to regenerate.";

describe("theokit-vectors.json cross-language contract (M124 D3)", () => {
  it("test_committed_vectors_json_matches_mapper_vectors", () => {
    const committed: unknown = JSON.parse(readFileSync(COMMITTED_PATH, "utf8"));
    expect(committed, REGEN_HINT).toHaveLength(18);
    expect(committed, REGEN_HINT).toStrictEqual(projectVectors());
  });
});
