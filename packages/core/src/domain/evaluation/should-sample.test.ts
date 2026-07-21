import { describe, expect, it } from "vitest";

import { shouldSample } from "./should-sample.js";

/**
 * M134 T2.1 — sampling predicate (ADR D2).
 *
 * The RNG is an injected default parameter rather than an inline `Math.random()`.
 * The blueprint recorded both outcomes of that choice empirically: where the
 * reference injected it, the boundary is tested exactly; where it constructed
 * the RNG internally, no intermediate rate was testable and the surviving test
 * degenerated into an assertion that would still pass if the feature were
 * deleted. These tests are the reason the seam exists.
 */
describe("shouldSample (M134 T2.1)", () => {
  describe("clamping", () => {
    it("test_rate_at_or_above_one_always_samples", () => {
      // randomValue is irrelevant at the ceiling — including the value that
      // would otherwise fail the strict `<` comparison.
      expect(shouldSample(1, 0.999999)).toBe(true);
      expect(shouldSample(1, 0)).toBe(true);
      expect(shouldSample(1.5, 0.999999)).toBe(true);
    });

    it("test_rate_at_or_below_zero_never_samples", () => {
      expect(shouldSample(0, 0)).toBe(false);
      expect(shouldSample(0, 0.000001)).toBe(false);
      expect(shouldSample(-0.5, 0)).toBe(false);
    });

    it("test_non_finite_rate_never_samples", () => {
      // A NaN rate must fail closed. `NaN >= 1` and `NaN <= 0` are both false,
      // so an unguarded implementation falls through to `x < NaN` — also false
      // — which happens to be safe. Asserting it pins that behaviour rather
      // than leaving it to luck.
      expect(shouldSample(Number.NaN, 0)).toBe(false);
      expect(shouldSample(Number.NaN, 0.5)).toBe(false);
    });
  });

  describe("boundary", () => {
    it("test_boundary_is_strictly_less_than_rate", () => {
      // The triplet that pins the comparison operator. An implementation using
      // `<=` passes the first two and fails the middle one.
      expect(shouldSample(0.5, 0.4999)).toBe(true);
      expect(shouldSample(0.5, 0.5)).toBe(false);
      expect(shouldSample(0.5, 0.5001)).toBe(false);
    });
  });

  describe("distribution", () => {
    it.each([0.1, 0.25, 0.5, 0.9])(
      "test_quantile_sweep_is_exact_at_rate_%s",
      (rate) => {
        // Sweep the quantile space instead of sampling it. This gives real
        // distribution coverage with ZERO flakiness — an exact equality, not a
        // tolerance band — and costs nothing. Copied from the reference's one
        // genuinely excellent test.
        const iterations = 1000;
        let sampled = 0;
        for (let i = 0; i < iterations; i += 1) {
          if (shouldSample(rate, i / iterations)) sampled += 1;
        }
        expect(sampled).toBe(Math.floor(iterations * rate));
      },
    );
  });

  describe("default RNG", () => {
    it("test_omitting_random_value_uses_the_default_rng", () => {
      // Production omits the second argument. Only the clamped rates are
      // asserted here — anything else would be a probabilistic assertion, i.e.
      // a flaky test. The interior of the range is covered by the sweep above.
      for (let i = 0; i < 20; i += 1) {
        expect(shouldSample(1)).toBe(true);
        expect(shouldSample(0)).toBe(false);
      }
    });
  });
});
