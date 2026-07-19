import { describe, it, expect } from "vitest";
// M128 — the shared drift-guard fixture is now behind the dedicated `@usetheo/lens-core/testing` subpath
// (it was moved off the production root barrel; the prod API no longer ships test-only exports).
import { MAPPER_VECTORS, flattenOtlp } from "@usetheo/lens-core/testing";
import { sdkMessagesToOtlp } from "./theokit.js";

/**
 * M119 (D1) — the SDK copy of the SDKMessage→OTLP mapper is guarded by the SHARED 18-behavior vector
 * fixture (`@usetheo/lens-core` `MAPPER_VECTORS`) that the core copy's test imports too. Feeding both
 * copies through the ONE fixture pins the two ADR-1 duplicates to identical documented behavior; adding
 * a behavior edits the fixture once and both copies re-pin (blueprint D1). This file drives the SDK
 * copy; the core test additionally asserts `coreMapper ≡ sdkMapper` per deterministic vector.
 *
 * Pre-M119 these were 18 inline `it(...)` cases hand-mirrored across the two files (the core copy only
 * mirrored 6 of them — the drift gap this milestone closes).
 */
describe("sdkMessagesToOtlp (M115 mapper — shared vectors)", () => {
  it("test_sdk_mapper_satisfies_all_18_shared_vectors_count", () => {
    expect(MAPPER_VECTORS).toHaveLength(18);
  });

  it.each(MAPPER_VECTORS.map((v) => [v.name, v] as const))("test_sdk_vector_%s", (_name, vector) => {
    const otlp = sdkMessagesToOtlp(vector.input.messages, vector.input.result, vector.input.opts);
    vector.assert(flattenOtlp(otlp));
  });
});
