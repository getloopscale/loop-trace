/**
 * M140 — consumption grouped by end user.
 *
 * Its own file rather than a fifth aggregate in `aggregate-repository.ts` (480 LoC, 500 budget),
 * following the M99 precedent that split the god-adapter by role.
 *
 * Shape: three small queries instead of one wide join.
 *   1. the page of users, with token totals — ORDER BY + LIMIT/OFFSET applied in SQL;
 *   2. the per-model breakdown for THOSE users only — the input to the price table;
 *   3. the window-wide price gap and distinct-user count.
 *
 * The cost is computed in TypeScript over `computeTraceCost`, never re-derived in SQL: the price
 * table lives in the domain, and a second implementation in SQL would drift from it (Rule 9).
 * Query 2 is restricted to the page so that memory stays bounded by page size rather than by the
 * number of distinct users — the cardinality risk R3 the plan registered.
 *
 * The measured plan behind this design (discovery Q4/Q5, 2026-07-29, 49,376 spans): the existing
 * `spans_workspace_ingested_idx (workspace_id, ingested_at)` serves a selective window in 0.235 ms;
 * a window covering the whole table degrades to a Seq Scan at ~157 ms, which is the CORRECT plan for
 * reading every row. No new index is required, and none was added.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { DEFAULT_WORKSPACE_ID } from "../../../domain/principal.js";
import {
  UNATTRIBUTED_USER_ID,
  type UsageByUserOptions,
  type UsageByUserResponse,
  type UsageByUserRow,
} from "../../../domain/observability/usage-by-user.js";
import { computeTraceCost, resolveModelPrice } from "../../../domain/observability/pricing.js";
import type { PriceTable } from "../../../domain/observability/pricing.js";
import { END_USER_ID_SQL } from "../repo-shared.js";

/** Window ceiling. Without one, `?days=999999` passes "is a positive integer" and scans everything. */
export const MAX_WINDOW_DAYS = 365;
const MAX_LIMIT = 500;

/** `sum()` over integer returns `numeric`, which the driver hands back as a string. */
const int = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

export async function aggregateUsageByUser(
  db: NodePgDatabase,
  priceTable: PriceTable,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
  opts: UsageByUserOptions = {},
): Promise<UsageByUserResponse> {
  const windowDays = Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.floor(opts.days ?? 30)));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? 50)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));

  // The window is over `ingested_at` (ADR D3): `start_time_unix_nano` is TEXT, so a range over it
  // compares lexicographically and silently mis-orders the moment the digit count changes.
  const since = sql`now() - make_interval(days => ${windowDays})`;
  const userId = sql`coalesce(${END_USER_ID_SQL("spans")}, ${UNATTRIBUTED_USER_ID})`;
  const scope = sql`workspace_id = ${workspaceId} AND ingested_at >= ${since}`;

  // 1 — the page. ORDER BY carries a total tiebreak on "userId" (EC-3): without it, two users with
  // equal totals have undefined relative order, and one of them can appear on two pages or on none.
  const page = await db.execute(sql`
    SELECT ${userId} AS "userId",
           count(*)::int AS spans,
           coalesce(sum(input_tokens), 0) AS "inputTokens",
           coalesce(sum(output_tokens), 0) AS "outputTokens",
           coalesce(sum(cache_read_tokens), 0) AS "cacheReadTokens",
           coalesce(sum(cache_creation_tokens), 0) AS "cacheCreationTokens"
    FROM spans
    WHERE ${scope}
    GROUP BY 1
    ORDER BY coalesce(sum(input_tokens), 0) + coalesce(sum(output_tokens), 0) DESC, 1 ASC
    LIMIT ${limit} OFFSET ${offset}
  `);
  const rows = page.rows as Record<string, unknown>[];
  const ids = rows.map((r) => String(r["userId"]));

  // 2 — per-model usage for the page only, so cost can reuse the domain price table.
  const perModel =
    ids.length === 0
      ? []
      : ((
          await db.execute(sql`
            SELECT ${userId} AS "userId",
                   coalesce(model, '') AS model,
                   coalesce(sum(input_tokens), 0) AS "inputTokens",
                   coalesce(sum(output_tokens), 0) AS "outputTokens",
                   coalesce(sum(cache_read_tokens), 0) AS "cacheReadTokens",
                   coalesce(sum(cache_creation_tokens), 0) AS "cacheCreationTokens"
            FROM spans
            WHERE ${scope} AND ${userId} IN ${ids}
            GROUP BY 1, 2
          `)
        ).rows as Record<string, unknown>[]);

  const costByUser = new Map<string, number>();
  for (const r of perModel) {
    const model = String(r["model"] ?? "");
    if (model === "") continue; // no model → nothing priceable
    const usage = [
      {
        model,
        inputTokens: int(r["inputTokens"]),
        outputTokens: int(r["outputTokens"]),
        cacheReadTokens: int(r["cacheReadTokens"]),
        cacheCreationTokens: int(r["cacheCreationTokens"]),
      },
    ];
    const id = String(r["userId"]);
    costByUser.set(id, (costByUser.get(id) ?? 0) + computeTraceCost(usage, priceTable));
  }

  // 3 — the price gap, over the WHOLE window rather than the page: it describes the report, and a
  // number that changed as you paged would be meaningless. Only spans that actually carry tokens
  // are candidates (ADR D4) — spans with no model and no tokens have nothing to price, and counting
  // them reported 36,901 "unpriced" on a workspace whose real gap was zero.
  const gapRows = (
    await db.execute(sql`
      SELECT coalesce(model, '') AS model, count(*)::int AS n
      FROM spans
      WHERE ${scope}
        AND coalesce(input_tokens, 0) + coalesce(output_tokens, 0)
          + coalesce(cache_read_tokens, 0) + coalesce(cache_creation_tokens, 0) > 0
      GROUP BY 1
    `)
  ).rows as Record<string, unknown>[];

  let unpricedSpans = 0;
  for (const r of gapRows) {
    const model = String(r["model"] ?? "");
    if (model === "" || resolveModelPrice(model, priceTable) === undefined) {
      unpricedSpans += int(r["n"]);
    }
  }

  const totalRes = await db.execute(sql`
    SELECT count(DISTINCT ${userId})::int AS n FROM spans WHERE ${scope}
  `);
  const totalUsers = int((totalRes.rows[0] as Record<string, unknown> | undefined)?.["n"]);

  const users: UsageByUserRow[] = rows.map((r) => {
    const id = String(r["userId"]);
    return {
      userId: id,
      spans: int(r["spans"]),
      inputTokens: int(r["inputTokens"]),
      outputTokens: int(r["outputTokens"]),
      cacheReadTokens: int(r["cacheReadTokens"]),
      cacheCreationTokens: int(r["cacheCreationTokens"]),
      costUsd: Math.round((costByUser.get(id) ?? 0) * 1e6) / 1e6,
    };
  });

  return { users, unpricedSpans, totalUsers, windowDays };
}
