/**
 * M134 (ADR D2) — the auto-evaluation sampling predicate.
 *
 * Sampling is the only lever that decouples judge spend from traffic volume: a
 * workspace ingesting a million traces cannot afford a million judge calls, and
 * without a rate the only throttle is disabling the evaluator outright.
 *
 * The RNG is an **injected default parameter**, not an inline `Math.random()`.
 * That single choice is what makes the whole rate range testable — the
 * reference implementation that constructed its RNG internally could only test
 * the degenerate rates 0 and 1, and its "rate = 1" test decayed into an
 * assertion that would still pass with the feature deleted. Production omits
 * the argument; tests pass it explicitly and sweep the quantile space.
 *
 * One implementation, one comparison operator. The reference carried two
 * divergent copies of this rule (`<` on one path, `>` on the other) with
 * different boundary semantics — a discrepancy nobody could observe because
 * only one of them was reachable from a test.
 */
export function shouldSample(
  rate: number,
  randomValue: number = Math.random(),
): boolean {
  // Clamp first: rates outside [0,1] are configuration errors, and answering
  // them deterministically is safer than letting them reach the comparison.
  // A non-finite rate falls through both guards, so it is rejected explicitly
  // rather than relying on NaN comparison semantics happening to be safe.
  if (!Number.isFinite(rate)) return false;
  if (rate >= 1) return true;
  if (rate <= 0) return false;

  return randomValue < rate;
}
