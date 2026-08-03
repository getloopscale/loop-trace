/**
 * M140 — consumption grouped by end user.
 *
 * Its own file rather than a fifth aggregate in `aggregate-repository.ts` (480 LoC, 500 budget),
 * following the M99 precedent that split the god-adapter by role.
 *
 * Shape: TWO round trips on the common path, not one wide join.
 *   1. the page of users with token totals AND `totalUsers` via `count(*) OVER ()` — ORDER BY +
 *      LIMIT/OFFSET applied in SQL. Runs CONCURRENTLY with the price-gap query, which depends on
 *      nothing.
 *   2. the per-model breakdown for THOSE users only — the input to the price table. Depends on
 *      query 1's ids, so it cannot overlap.
 * Plus one query that runs ONLY when the page comes back empty (see `totalUsers` below).
 *
 * `totalUsers` used to be a fourth statement, `count(DISTINCT <the jsonb expression>)`. Measured on
 * a probe with the same composite index: at 50k spans it cost 137 ms — 2.3x the page query — and at
 * 500k spans / 200k distinct users it cost **2.0 s on its own**, spilling to temp disk, because a
 * count-distinct over a computed expression cannot hash and must sort. That single statement pushed
 * the endpoint past the p95 > 1 s reopening trigger this milestone's ADR D2 declared, through an
 * avoidable query rather than through the aggregation the ADR worried about. Folding it into the
 * page as a window function measured 515 ms against 2412 ms for the pair it replaces (4.7x), with
 * no index, no schema change and no new dependency.
 *
 * The cost is computed in TypeScript over `computeTraceCost`, never re-derived in SQL: the price
 * table lives in the domain, and a second implementation in SQL would drift from it (Rule 9).
 * Query 2's `IN <page ids>` bounds the RESULT SET and the price-table pass — NOT the scan, which
 * still reads the window because the grouping expression is not sargable. That is the honest limit
 * of the cardinality mitigation for risk R3: memory is bounded by page size, time is not.
 *
 * The measured plan behind this design (discovery Q4/Q5, 2026-07-29, 49,376 spans): the existing
 * `spans_workspace_ingested_idx (workspace_id, ingested_at)` serves a selective window in 0.235 ms;
 * a window covering the whole table degrades to a Seq Scan at ~157 ms, which is the CORRECT plan for
 * reading every row. No new index is required, and none was added — a jsonb GIN was evaluated and
 * dropped in M95 (`schema.ts`) because it accelerates containment, not this predicate.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { DEFAULT_WORKSPACE_ID } from "../../../domain/principal.js";
import {
  MAX_LIMIT,
  MAX_OFFSET,
  MAX_WINDOW_DAYS,
  UNATTRIBUTED_USER_ID,
  type UsageByUserOptions,
  type UsageByUserResponse,
  type UsageByUserRow,
} from "../../../domain/observability/usage-by-user.js";
import { computeTraceCost, resolveModelPrice } from "../../../domain/observability/pricing.js";
import type { PriceTable } from "../../../domain/observability/pricing.js";
import { roundUsd } from "../../../domain/observability/tool-stats.js";
import { END_USER_ID_SQL } from "../repo-shared.js";

/** M143 — o acumulador de UM ponto da série, antes de virar resposta. */
interface SeriesAcc {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

/** `sum()` over integer returns `numeric`, which the driver hands back as a string. */
const int = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/**
 * M143 — os pontos de um usuário, ordenados pelo eixo do tempo.
 *
 * PURA e exportada de propósito. A ordenação estava inline, e a mutação que a REMOVIA sobrevivia a
 * todos os testes de integração: o Postgres devolve as linhas já ordenadas para os fixtures, então
 * a ordem de inserção do `Map` calhava de bater — e não há como forçar o banco a desordenar a partir
 * de um teste. Extraída, um teste unitário alimenta desordem diretamente e o mutante morre. É a
 * mesma lição do M142: lógica isolada é lógica que a mutação alcança.
 *
 * A ordem importa porque o eixo do tempo tem direção: uma série fora de ordem faz o gráfico desenhar
 * ziguezague sobre dado monotônico. E a ordem que o Postgres devolve é detalhe do plano de execução,
 * não contrato — um `HashAggregate` pode mudá-la sem aviso.
 */
export function serieOrdenada(
  porBucket: Map<string, SeriesAcc> | undefined,
): { periodStart: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number }[] {
  return [...(porBucket ?? new Map<string, SeriesAcc>()).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([periodStart, acc]) => ({ periodStart, ...acc, costUsd: roundUsd(acc.costUsd) }));
}

export async function aggregateUsageByUser(
  db: NodePgDatabase,
  priceTable: PriceTable,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
  opts: UsageByUserOptions = {},
): Promise<UsageByUserResponse> {
  // The ceilings live in the domain (both the route and this file enforce them). Kept here as a
  // last line of defence: a caller reaching the repository directly still cannot ask for everything.
  const windowDays = Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.floor(opts.days ?? 30)));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? 50)));
  const offset = Math.min(MAX_OFFSET, Math.max(0, Math.floor(opts.offset ?? 0)));

  // The window is over `ingested_at` (ADR D3): `start_time_unix_nano` is TEXT, so a range over it
  // compares lexicographically and silently mis-orders the moment the digit count changes.
  //
  // Bound ONCE as a value rather than emitted as `now() - make_interval(...)` into each statement.
  // The statements run outside a transaction, so a SQL-side `now()` gave each one its OWN clock:
  // the page, the price gap and the user count described three windows that differed by the
  // inter-query latency — seconds apart at the volume where it matters. A span ingested mid-request
  // was then counted by one query and not another, and `totalUsers` could exceed what the page saw.
  const since = new Date(Date.now() - windowDays * 86_400_000);
  // `nullif(btrim(…), '')` BEFORE the coalesce: the identity is client-chosen, and `coalesce` only
  // substitutes NULL — an empty or whitespace-only `user.id` would survive it and reach the response
  // schema, which requires `min(1)`. The route parses with `.parse()`, so one such span made the
  // endpoint answer 500 for the WHOLE workspace and window: a single malformed attribute from any
  // SDK client permanently broke that client's own report. Empty and blank are not identities —
  // they belong in the same bucket as a missing key.
  const userId = sql`coalesce(nullif(btrim(${END_USER_ID_SQL("spans")}), ''), ${UNATTRIBUTED_USER_ID})`;
  const scope = sql`workspace_id = ${workspaceId} AND ingested_at >= ${since}`;

  // 1 — the page, and the distinct-user total in the same pass. ORDER BY carries a total tiebreak
  // on "userId" (EC-3): without it, two users with equal totals have undefined relative order, and
  // one of them can appear on two pages or on none.
  //
  // `count(*) OVER ()` counts the rows of the CTE — every distinct user in the window — so it is
  // the same number the separate `count(DISTINCT …)` produced, at a fraction of the cost (see the
  // file header for the measurement).
  //
  // 3 — the price gap, over the WHOLE window rather than the page: it describes the report, and a
  // number that changed as you paged would be meaningless. Only spans that actually carry tokens
  // are candidates (ADR D4) — spans with no model and no tokens have nothing to price, and counting
  // them reported 36,901 "unpriced" on a workspace whose real gap was zero.
  //
  // The two run CONCURRENTLY: the gap depends on nothing the page produces. Trade-off stated
  // plainly — two statements hold two pool slots at once (pool max is 10), so effective concurrency
  // on THIS endpoint halves. Worth it because this is a report, not a hot path, and the serial
  // chain measured 2.6 s at 500k spans against 629 ms for the critical path once folded.
  const [page, gapRes] = await Promise.all([
    db.execute(sql`
      WITH grouped AS (
        SELECT ${userId} AS "userId",
               count(*)::int AS spans,
               coalesce(sum(input_tokens), 0) AS "inputTokens",
               coalesce(sum(output_tokens), 0) AS "outputTokens",
               coalesce(sum(cache_read_tokens), 0) AS "cacheReadTokens",
               coalesce(sum(cache_creation_tokens), 0) AS "cacheCreationTokens"
        FROM spans
        WHERE ${scope}
        GROUP BY 1
      )
      SELECT *, count(*) OVER ()::int AS "totalUsers"
      FROM grouped
      ORDER BY "inputTokens" + "outputTokens" DESC, "userId" ASC
      LIMIT ${limit} OFFSET ${offset}
    `),
    db.execute(sql`
      SELECT coalesce(model, '') AS model, count(*)::int AS n
      FROM spans
      WHERE ${scope}
        AND coalesce(input_tokens, 0) + coalesce(output_tokens, 0)
          + coalesce(cache_read_tokens, 0) + coalesce(cache_creation_tokens, 0) > 0
      GROUP BY 1
    `),
  ]);
  const rows = page.rows as Record<string, unknown>[];
  const ids = rows.map((r) => String(r["userId"]));

  // 2 — per-model usage for the page only, so cost can reuse the domain price table.
  //
  // M143 — `bucket` acrescenta UMA DIMENSÃO a esta query, e nenhuma query nova. O bucket não muda
  // QUEM entra na página; muda o que cada usuário carrega. Query 1 (a página + `totalUsers` via
  // window function) e a query da lacuna de preço ficam intocadas, o que preserva as três decisões
  // medidas da M140 sem tocá-las.
  //
  // MEDIDO (blueprint do M143, Postgres 17, mesmo índice composto, perfil denso de 50 usuários
  // ativos todos os 365 dias): 77,7 ms → 134,6 ms com a dimensão, e 250 → 91.250 linhas. O tempo
  // cresce 1,73×; o RESULTADO cresce 365×. Por isso o teto do ADR-1 age sobre o produto
  // `limit × days` e não sobre o tempo de query — o gargalo é o payload.
  const bucketExpr = sql`date_trunc('day', ingested_at)`;
  const perModel =
    ids.length === 0
      ? []
      : ((
          await db.execute(sql`
            SELECT ${userId} AS "userId",
                   ${opts.bucket === "day" ? sql`${bucketExpr} AS "bucket",` : sql``}
                   coalesce(model, '') AS model,
                   coalesce(sum(input_tokens), 0) AS "inputTokens",
                   coalesce(sum(output_tokens), 0) AS "outputTokens",
                   coalesce(sum(cache_read_tokens), 0) AS "cacheReadTokens",
                   coalesce(sum(cache_creation_tokens), 0) AS "cacheCreationTokens"
            FROM spans
            WHERE ${scope} AND ${userId} IN ${ids}
            GROUP BY 1, 2${opts.bucket === "day" ? sql`, 3` : sql``}
          `)
        ).rows as Record<string, unknown>[]);

  const costByUser = new Map<string, number>();
  // M143 — o mesmo laço alimenta a série, chaveado por (userId, bucket). Um segundo laço sobre as
  // mesmas linhas seria uma segunda passada e uma segunda chance de divergir do custo da linha.
  const seriesByUser = new Map<string, Map<string, SeriesAcc>>();

  for (const r of perModel) {
    const id = String(r["userId"]);
    const tokens = {
      inputTokens: int(r["inputTokens"]),
      outputTokens: int(r["outputTokens"]),
      cacheReadTokens: int(r["cacheReadTokens"]),
      cacheCreationTokens: int(r["cacheCreationTokens"]),
    };
    const model = String(r["model"] ?? "");
    // Um span sem modelo não tem o que precificar, mas TEM tokens — e eles pertencem à série tanto
    // quanto os precificados. Somar custo zero e contar os tokens é o que mantém a soma da série
    // igual à soma da linha; pular a linha inteira faria o gráfico mostrar menos que a tabela.
    const custo = model === "" ? 0 : computeTraceCost([{ model, ...tokens }], priceTable);

    costByUser.set(id, (costByUser.get(id) ?? 0) + custo);

    if (opts.bucket === "day") {
      const chave = new Date(String(r["bucket"])).toISOString();
      const porBucket = seriesByUser.get(id) ?? new Map<string, SeriesAcc>();
      const acc = porBucket.get(chave) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      };
      acc.inputTokens += tokens.inputTokens;
      acc.outputTokens += tokens.outputTokens;
      acc.cacheReadTokens += tokens.cacheReadTokens;
      acc.cacheCreationTokens += tokens.cacheCreationTokens;
      acc.costUsd += custo;
      porBucket.set(chave, acc);
      seriesByUser.set(id, porBucket);
    }
  }

  const gapRows = gapRes.rows as Record<string, unknown>[];

  let unpricedSpans = 0;
  for (const r of gapRows) {
    const model = String(r["model"] ?? "");
    if (model === "" || resolveModelPrice(model, priceTable) === undefined) {
      unpricedSpans += int(r["n"]);
    }
  }

  // `count(*) OVER ()` rides on the page rows, so an EMPTY page carries no row to read it from.
  // Two very different situations produce an empty page: a workspace with no traffic (total really
  // is 0) and an `offset` past the end (total is whatever it is, and reporting 0 would be a lie the
  // caller cannot detect). Only that second case needs the expensive count, so it is paid only
  // there — the common path never runs this statement.
  const totalUsers =
    rows.length > 0
      ? int(rows[0]?.["totalUsers"])
      : int(
          (
            await db.execute(sql`
              SELECT count(DISTINCT ${userId})::int AS n FROM spans WHERE ${scope}
            `)
          ).rows[0]?.["n"],
        );

  const users: UsageByUserRow[] = rows.map((r) => {
    const id = String(r["userId"]);
    return {
      userId: id,
      spans: int(r["spans"]),
      inputTokens: int(r["inputTokens"]),
      outputTokens: int(r["outputTokens"]),
      cacheReadTokens: int(r["cacheReadTokens"]),
      cacheCreationTokens: int(r["cacheCreationTokens"]),
      // `roundUsd` and not an inline `Math.round(x * 1e6) / 1e6`: the six-decimal floor is a
      // business rule with one owner (`tool-stats.ts`), and the last time it was duplicated the
      // session aggregate drifted to three decimals and reported real spend as zero (#121). This
      // milestone extracted END_USER_ID_SQL to kill exactly this class of second copy.
      costUsd: roundUsd(costByUser.get(id) ?? 0),
      // M143 — `undefined`, nunca `[]`, quando `bucket` não foi pedido: uma lista vazia afirma "não
      // houve consumo", que é diferente de "não foi pedido". A tela da M142 está em produção lendo
      // a resposta sem este campo, e um `[]` a faria desenhar um gráfico vazio onde não há gráfico.
      //
      // Ordenado por `periodStart`: o eixo do tempo tem direção, e uma série fora de ordem faz o
      // gráfico desenhar ziguezague sobre dados monotônicos. O `Map` preserva ordem de inserção, que
      // é a ordem em que o Postgres devolveu — não é ordem temporal, e confiar nela seria confiar
      // num detalhe do plano de execução.
      //
      // Um dia sem consumo NÃO produz ponto. Um zero inventado é indistinguível de consumo real
      // zero; a série vem com buraco, e quem plota decide o que fazer com ele.
      ...(opts.bucket === "day"
        ? { series: serieOrdenada(seriesByUser.get(id)) }
        : {}),
    };
  });

  return { users, unpricedSpans, totalUsers, windowDays };
}
