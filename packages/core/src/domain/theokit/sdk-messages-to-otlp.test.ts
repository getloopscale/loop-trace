import { describe, it, expect } from "vitest";
import { sdkMessagesToOtlp as coreMapper } from "./sdk-messages-to-otlp.js";
// The SDK copy of the mapper (ADR-1 duplicate). Imported by RELATIVE SOURCE PATH — a TEST-time-only
// reach across the monorepo (no core→sdk package dependency, no runtime cycle); it lets this test
// assert `coreMapper(input) ≡ sdkMapper(input)` per vector as the belt-and-suspenders drift guard.
import { sdkMessagesToOtlp as sdkMapper } from "../../../../sdk/src/ingest/theokit.js";
import { MAPPER_VECTORS, flattenOtlp } from "./theokit-vectors.js";

/**
 * M119 (D1) — the core copy of the SDKMessage→OTLP mapper is pinned to the SHARED 18-behavior fixture
 * (`theokit-vectors.ts`, the SAME file the SDK test imports), upgrading the pre-M119 6-of-18 hand-mirror
 * to 18-of-18. It ALSO asserts `coreMapper(input) ≡ sdkMapper(input)` per DETERMINISTIC vector: the
 * fixture proves either copy is CORRECT (documented behaviors), the equality proves the two AGREE — a
 * duplicated implementation is only safe with BOTH guards (blueprint D1; a shared bug that passes the
 * fixture is caught by neither, but an unintended divergence is caught by the equality).
 *
 * The non-deterministic `timestamps_are_valid_ns_and_not_future` vector (default clock) is asserted per
 * copy but excluded from the equality loop (two Date.now() calls differ).
 */
describe("core sdkMessagesToOtlp (M116 — shared vectors + cross-copy equality)", () => {
  it("test_core_mapper_covers_all_18_shared_vectors_count", () => {
    expect(MAPPER_VECTORS).toHaveLength(18);
  });

  it.each(MAPPER_VECTORS.map((v) => [v.name, v] as const))("test_core_vector_%s", (_name, vector) => {
    const otlp = coreMapper(vector.input.messages, vector.input.result, vector.input.opts);
    vector.assert(flattenOtlp(otlp));
  });

  it.each(
    MAPPER_VECTORS.filter((v) => v.deterministic).map((v) => [v.name, v] as const),
  )("test_core_mapper_matches_sdk_mapper_%s", (_name, vector) => {
    const core = coreMapper(vector.input.messages, vector.input.result, vector.input.opts);
    const sdk = sdkMapper(vector.input.messages, vector.input.result, vector.input.opts);
    expect(core).toStrictEqual(sdk);
  });
});
