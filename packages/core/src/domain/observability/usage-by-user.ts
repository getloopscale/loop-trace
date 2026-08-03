/**
 * M140 — token/cost consumption grouped by END USER (the person who used the agent), as opposed to
 * the workspace that owns the data. The identity is best-effort and client-chosen: whatever the SDK
 * put in `user.id` (falling back to the OTel semantic-convention `gen_ai.user.id`) — see
 * END_USER_ID_SQL in `infrastructure/db/repo-shared.ts` for the single definition.
 *
 * This is an OBSERVABILITY report, not a bill. theo-lens reports consumption it observed; theo-cloud
 * is what charges. The vocabulary here stays on the consumption side deliberately.
 */
import { z } from "zod";

/**
 * The bucket for spans carrying neither identity key. It is a regular row — ordered by consumption
 * alongside real users — because the case worth surfacing is the one where un-attributed traffic is
 * the LARGEST consumer, and a separate field would hide exactly that.
 *
 * A client that literally sends `user.id: "unattributed"` collides with this bucket. Accepted (ADR
 * D6): the two groups it merges are both "consumption we cannot attribute to a known person", and a
 * reserved prefix would cost more than the collision does.
 */
export const UNATTRIBUTED_USER_ID = "unattributed";

const nonNegativeInt = z.number().int().nonnegative();

export const usageByUserRowSchema = z.object({
  /** Client-chosen end-user id, or `unattributed`. MAY contain PII — see the milestone's risk R1. */
  userId: z.string().min(1),
  spans: nonNegativeInt,
  inputTokens: nonNegativeInt,
  outputTokens: nonNegativeInt,
  cacheReadTokens: nonNegativeInt,
  cacheCreationTokens: nonNegativeInt,
  /**
   * USD, derived from the PriceTable — an ESTIMATE over observed tokens, never an invoice. Reads low
   * whenever `unpricedSpans` is non-zero, which is why that field is mandatory rather than optional.
   */
  costUsd: z.number().nonnegative(),
});

export const usageByUserResponseSchema = z.object({
  users: z.array(usageByUserRowSchema),
  /**
   * Spans that HAD tokens but whose model resolved to no price — their tokens are counted and their
   * cost is not (computeTraceCost skips an unknown model in silence, `pricing.ts:61`).
   *
   * REQUIRED, never optional: an omitted field reads as "nothing missing", and the whole point of
   * this number is to stop a silently-low total from being read as the real spend.
   *
   * It counts only spans WITH tokens (ADR D4). Counting every span whose model resolves to no price
   * would have reported 36,901 on the workspace measured in discovery — spans with no model and no
   * tokens at all, nothing to price — where the real gap was zero.
   */
  unpricedSpans: nonNegativeInt,
  /** Distinct end-users in the window, before pagination — so a caller knows what it is paging. */
  totalUsers: nonNegativeInt,
  /** Window actually applied, in days. Echoed so a cached or shared response stays self-describing. */
  windowDays: z.number().int().positive(),
});

/**
 * Window ceiling, in days. Lives in the domain because BOTH the route (which rejects a larger
 * value) and the repository (which is the last line of defence) need the same number — two copies
 * would drift, and the drift would be silent.
 */
export const MAX_WINDOW_DAYS = 365;
/** Page-size ceiling. Same reason. */
export const MAX_LIMIT = 500;
/**
 * Deep-page ceiling. It was the ONE parameter with no server-side bound, and the omission had two
 * costs. Correctness: `Number.isInteger` accepts `1e21` and `99999999999999999999`, which pass
 * validation and then die in the driver as `invalid input syntax for type bigint` — a generic 500
 * where the route's own contract promises a typed 400. Cost: measured at 500k spans, `OFFSET
 * 190000` doubled latency (393 ms → 831 ms) and spilled ~10 MB of temp sort to disk, driven purely
 * by a caller-supplied integer.
 *
 * A caller genuinely needing rank 10,001+ by consumption narrows the window instead — a consumption
 * report past rank 10,000 is not a report anyone reads.
 */
export const MAX_OFFSET = 10_000;

/**
 * Query options for the report. Lives in the domain, not in the repository, so the port can be
 * declared without the domain importing infrastructure (`architecture.md` § 2).
 */
export interface UsageByUserOptions {
  /**
   * Window in days over `ingested_at`; defaults to 30.
   *
   * The ROUTE **rejects** a value above `MAX_WINDOW_DAYS` with a typed 400 — it does not clamp.
   * This doc used to say "clamped", which described the repository's last-line-of-defence and NOT
   * what the public API does; a consumer reading it would expect a silently reduced window and get
   * an error instead. The repository still clamps, for a caller that reaches it directly.
   */
  days?: number;
  /** Page size; defaults to 50. Rejected by the route above `MAX_LIMIT`, clamped here. */
  limit?: number;
  /** Page offset; defaults to 0. Rejected by the route above `MAX_OFFSET`, clamped here. */
  offset?: number;
}

export type UsageByUserRow = z.infer<typeof usageByUserRowSchema>;
export type UsageByUserResponse = z.infer<typeof usageByUserResponseSchema>;
