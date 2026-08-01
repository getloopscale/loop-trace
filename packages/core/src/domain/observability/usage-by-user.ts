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
 * Query options for the report. Lives in the domain, not in the repository, so the port can be
 * declared without the domain importing infrastructure (`architecture.md` § 2).
 */
export interface UsageByUserOptions {
  /** Window in days over `ingested_at`. Clamped to [1, 365]; defaults to 30. */
  days?: number;
  limit?: number;
  offset?: number;
}

export type UsageByUserRow = z.infer<typeof usageByUserRowSchema>;
export type UsageByUserResponse = z.infer<typeof usageByUserResponseSchema>;
