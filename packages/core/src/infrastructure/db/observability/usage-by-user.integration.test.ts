/**
 * M140 T4.1/T4.2/T4.3 — the three properties that cannot be proven by inspection.
 *
 * All three share a failure shape: they produce a PLAUSIBLE NUMBER when broken, not an error.
 *   - cross-tenant leak → someone else's usage silently folded into your report;
 *   - dropped un-attributed spans → "nobody consumed this" reads the same as "we don't know who";
 *   - unreported price gap → a total that is quietly low.
 * A reviewer cannot spot any of them by reading the SQL, which is why they are integration tests
 * against a real Postgres rather than unit tests over a mocked driver.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import type pg from "pg";

import type { Span } from "../../../domain/observability/span.js";
import { DEFAULT_PRICES } from "../../../domain/observability/default-prices.js";
import {
  MAX_OFFSET,
  MAX_WINDOW_DAYS,
  usageByUserResponseSchema,
  UNATTRIBUTED_USER_ID,
} from "../../../domain/observability/usage-by-user.js";
import { resolveModelPrice } from "../../../domain/observability/pricing.js";
import { roundUsd } from "../../../domain/observability/tool-stats.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";
import { aggregateUsageByUser } from "./usage-by-user-repository.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

const WS_A = "ws-usage-a";
const WS_B = "ws-usage-b";

/** A model guaranteed to share NO prefix with any price key (EC-5) — prefix match would false-pass. */
const NO_PRICE_MODEL = "zzz-no-price-model";

/** The costUsd of one user in a response, or 0 when absent. */
const costOf = (r: { users: { userId: string; costUsd: number }[] }, userId: string): number =>
  r.users.find((u) => u.userId === userId)?.costUsd ?? 0;

function span(over: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
  return {
    name: "op",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    ...over,
  };
}

suite("M140 — usage by end user (integration)", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;
  let repo: DrizzleSpanRepository;

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    repo = new DrizzleSpanRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM spans WHERE workspace_id IN (${WS_A}, ${WS_B})`);
  });

  /*
   * M143 — a SÉRIE TEMPORAL.
   *
   * `ingested_at` não é controlável pelo `repo.save` (ele usa o default `now()`), então cada caso
   * abaixo retrodata explicitamente. Isso é fixture, não gambiarra: a janela do relatório é sobre
   * `ingested_at` por decisão medida da M140 (`start_time_unix_nano` é TEXT e ordena
   * lexicograficamente), então é ESSA coluna que o bucket tem de fatiar.
   */
  const retrodatar = async (spanId: string, diasAtras: number): Promise<void> => {
    await db.execute(
      sql`UPDATE spans SET ingested_at = now() - (${diasAtras} || ' days')::interval WHERE span_id = ${spanId}`,
    );
  };

  it("M143 — dois dias do MESMO usuário produzem duas entradas na série", async () => {
    await repo.save(
      [
        span({ spanId: "s-d1", traceId: "t-d1", model: "claude-opus-4-8", inputTokens: 100, outputTokens: 50, attributes: { "user.id": "alice" } }),
        span({ spanId: "s-d2", traceId: "t-d2", model: "claude-opus-4-8", inputTokens: 300, outputTokens: 70, attributes: { "user.id": "alice" } }),
      ],
      WS_A,
    );
    await retrodatar("s-d1", 3);
    await retrodatar("s-d2", 1);

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { bucket: "day" });
    const alice = r.users.find((u) => u.userId === "alice");
    expect(alice?.series).toHaveLength(2);
    // a série soma o mesmo que a linha — senão o gráfico e a tabela contam histórias diferentes
    expect(alice?.series?.reduce((a, p) => a + p.inputTokens + p.outputTokens, 0)).toBe(
      (alice?.inputTokens ?? 0) + (alice?.outputTokens ?? 0),
    );
    // e os rótulos do eixo são dias distintos, não o mesmo timestamp repetido
    const dias = new Set(alice?.series?.map((p) => p.periodStart.slice(0, 10)));
    expect(dias.size).toBe(2);
    // O rótulo é meia-noite: `date_trunc('day')` zera hora, minuto e segundo. Sem esta asserção,
    // trocar o bucket para `hour` deixaria o teste verde — os spans estão em dias distintos, então
    // a CONTAGEM de buckets não muda, e só o rótulo denuncia a granularidade.
    for (const ponto of alice?.series ?? []) {
      expect(ponto.periodStart).toMatch(/T00:00:00/);
    }
  });

  // O par que separa dia de hora pela CONTAGEM: mesmo dia, horas diferentes. Com `day` é UM ponto.
  it("M143 — dois spans no mesmo dia colapsam num único ponto", async () => {
    await repo.save(
      [
        span({ spanId: "s-h1", traceId: "t-h1", model: "claude-opus-4-8", inputTokens: 10, outputTokens: 5, attributes: { "user.id": "erin" } }),
        span({ spanId: "s-h2", traceId: "t-h2", model: "claude-opus-4-8", inputTokens: 20, outputTokens: 7, attributes: { "user.id": "erin" } }),
      ],
      WS_A,
    );
    // mesmo dia (2 dias atrás), separados por 5 horas
    await db.execute(sql`UPDATE spans SET ingested_at = date_trunc('day', now() - interval '2 days') + interval '3 hours' WHERE span_id = 's-h1'`);
    await db.execute(sql`UPDATE spans SET ingested_at = date_trunc('day', now() - interval '2 days') + interval '8 hours' WHERE span_id = 's-h2'`);

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { bucket: "day" });
    const erin = r.users.find((u) => u.userId === "erin");
    expect(erin?.series).toHaveLength(1);
    expect(erin?.series?.[0]?.inputTokens).toBe(30);
  });

  // Um span SEM modelo não tem o que precificar, mas TEM tokens — e eles pertencem à série tanto
  // quanto os precificados. Pular a linha inteira faria o gráfico mostrar menos que a tabela.
  it("M143 — span sem modelo entra na série com custo zero, não é descartado", async () => {
    await repo.save(
      [
        span({ spanId: "s-nm1", traceId: "t-nm1", model: "claude-opus-4-8", inputTokens: 100, outputTokens: 50, attributes: { "user.id": "frank" } }),
        span({ spanId: "s-nm2", traceId: "t-nm2", inputTokens: 777, outputTokens: 333, attributes: { "user.id": "frank" } }),
      ],
      WS_A,
    );
    await retrodatar("s-nm1", 3);
    await retrodatar("s-nm2", 1);

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { bucket: "day" });
    const frank = r.users.find((u) => u.userId === "frank");
    expect(frank?.series).toHaveLength(2);
    // a soma da série é a soma da LINHA — o span sem preço conta tokens em ambas
    const tokensSerie = frank?.series?.reduce((a, x) => a + x.inputTokens + x.outputTokens, 0) ?? 0;
    expect(tokensSerie).toBe((frank?.inputTokens ?? 0) + (frank?.outputTokens ?? 0));
    expect(tokensSerie).toBe(100 + 50 + 777 + 333);
  });

  // O eixo do tempo tem direção. Uma série fora de ordem faz o gráfico desenhar ziguezague sobre
  // dado monotônico, e a ordem do Postgres é detalhe do plano de execução, não contrato.
  it("M143 — a série vem ordenada por periodStart, crescente", async () => {
    await repo.save(
      [
        span({ spanId: "s-o1", traceId: "t-o1", model: "claude-opus-4-8", inputTokens: 10, outputTokens: 1, attributes: { "user.id": "gina" } }),
        span({ spanId: "s-o2", traceId: "t-o2", model: "claude-opus-4-8", inputTokens: 20, outputTokens: 2, attributes: { "user.id": "gina" } }),
        span({ spanId: "s-o3", traceId: "t-o3", model: "claude-opus-4-8", inputTokens: 30, outputTokens: 3, attributes: { "user.id": "gina" } }),
      ],
      WS_A,
    );
    await retrodatar("s-o1", 2);
    await retrodatar("s-o2", 9);
    await retrodatar("s-o3", 5);

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { bucket: "day" });
    const rotulos = r.users.find((u) => u.userId === "gina")?.series?.map((p) => p.periodStart) ?? [];
    expect(rotulos).toHaveLength(3);
    expect(rotulos).toEqual([...rotulos].sort());
  });

  // `roundUsd` impõe o piso de seis casas, e o custo do PONTO tem de respeitá-lo tanto quanto o da
  // linha. O #121 deste repositório é o precedente: duplicar essa regra fez o agregado reportar
  // gasto real como zero.
  it("M143 — o custo de cada ponto respeita o piso de seis casas", async () => {
    // TRÊS modelos no MESMO bucket: o custo do ponto é a SOMA de três `computeTraceCost`, e é a
    // acumulação em ponto flutuante que produz a cauda de dígitos. Um span só, de um modelo só,
    // costuma cair num valor já curto — e o teste passaria sem `roundUsd`, medindo nada.
    await repo.save(
      [
        span({ spanId: "s-r1", traceId: "t-r1", model: "gpt-4o", inputTokens: 7, outputTokens: 3, attributes: { "user.id": "hank" } }),
        span({ spanId: "s-r2", traceId: "t-r2", model: "gpt-4o-mini", inputTokens: 11, outputTokens: 13, attributes: { "user.id": "hank" } }),
        span({ spanId: "s-r3", traceId: "t-r3", model: "claude-opus-4-8", inputTokens: 17, outputTokens: 19, attributes: { "user.id": "hank" } }),
      ],
      WS_A,
    );
    for (const id of ["s-r1", "s-r2", "s-r3"]) await retrodatar(id, 1);

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { bucket: "day" });
    const serie = r.users.find((u) => u.userId === "hank")?.series ?? [];
    expect(serie).toHaveLength(1);
    for (const ponto of serie) {
      const casas = (String(ponto.costUsd).split(".")[1] ?? "").length;
      expect(casas).toBeLessThanOrEqual(6);
    }
  });

  // ADR-3 — a M142 está em produção lendo o formato sem `series`. Um campo novo obrigatório, ou uma
  // lista vazia onde não foi pedida, derruba uma tela implantada.
  it("M143 — SEM bucket a resposta é idêntica à de hoje, e `series` é undefined", async () => {
    await repo.save(
      [span({ spanId: "s-nb", traceId: "t-nb", model: "claude-opus-4-8", inputTokens: 10, outputTokens: 5, attributes: { "user.id": "alice" } })],
      WS_A,
    );
    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A);
    expect(r.users[0]?.series).toBeUndefined();
    expect(Object.keys(r).sort()).toEqual(["totalUsers", "unpricedSpans", "users", "windowDays"]);
  });

  // A decisão de ordenação da M140 pôs o balde junto das demais linhas justamente para o caso em que
  // o tráfego não atribuído é o MAIOR consumidor. Sumir com ele no eixo do tempo desfaria isso.
  it("M143 — o balde unattributed tem série como qualquer outro usuário", async () => {
    await repo.save(
      [
        span({ spanId: "s-u1", traceId: "t-u1", model: "claude-opus-4-8", inputTokens: 80, outputTokens: 20 }),
        span({ spanId: "s-u2", traceId: "t-u2", model: "claude-opus-4-8", inputTokens: 40, outputTokens: 10 }),
      ],
      WS_A,
    );
    await retrodatar("s-u1", 5);
    await retrodatar("s-u2", 2);

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { bucket: "day" });
    const balde = r.users.find((u) => u.userId === UNATTRIBUTED_USER_ID);
    expect(balde?.series).toHaveLength(2);
  });

  it("M143 — a soma dos custos da série é o custo do usuário", async () => {
    await repo.save(
      [
        span({ spanId: "s-c1", traceId: "t-c1", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 500, attributes: { "user.id": "carol" } }),
        span({ spanId: "s-c2", traceId: "t-c2", model: "claude-opus-4-8", inputTokens: 2000, outputTokens: 900, attributes: { "user.id": "carol" } }),
      ],
      WS_A,
    );
    await retrodatar("s-c1", 4);
    await retrodatar("s-c2", 1);

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { bucket: "day" });
    const carol = r.users.find((u) => u.userId === "carol");
    const somaDaSerie = carol?.series?.reduce((a, p) => a + p.costUsd, 0) ?? 0;
    // tolerância de um centésimo de centavo: `roundUsd` arredonda cada ponto E o total
    expect(Math.abs(somaDaSerie - (carol?.costUsd ?? 0))).toBeLessThan(0.0001);
  });

  // Um zero inventado num dia sem consumo é indistinguível de consumo real zero. A série vem com
  // BURACO, e quem plota decide o que fazer com ele — decisão da milestone da tela, não desta.
  it("M143 — um dia sem consumo NÃO vira um ponto zero", async () => {
    await repo.save(
      [
        span({ spanId: "s-g1", traceId: "t-g1", model: "claude-opus-4-8", inputTokens: 10, outputTokens: 5, attributes: { "user.id": "dave" } }),
        span({ spanId: "s-g3", traceId: "t-g3", model: "claude-opus-4-8", inputTokens: 10, outputTokens: 5, attributes: { "user.id": "dave" } }),
      ],
      WS_A,
    );
    await retrodatar("s-g1", 1);
    await retrodatar("s-g3", 3); // nada no dia 2

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { bucket: "day" });
    expect(r.users.find((u) => u.userId === "dave")?.series).toHaveLength(2);
  });

  it("EC-5 guard: the fixture model really has no price", () => {
    // If this ever resolves, the price-gap test below would pass while measuring nothing.
    expect(resolveModelPrice(NO_PRICE_MODEL, DEFAULT_PRICES)).toBeUndefined();
  });

  it("T4.1 — a workspace never sees another workspace's end user", async () => {
    await repo.save(
      [
        span({ spanId: "a1", traceId: "ta", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 500, attributes: { "user.id": "alice" } }),
        // An UNPRICED span with tokens, in A only. The endpoint runs several queries and each one
        // carries its own `WHERE workspace_id`; a leak confined to the price-gap query alone used
        // to survive every test here, because the only two-workspace fixture seeded priced spans
        // exclusively. MEASURED: unscoping that one query left the suite 22/22 green.
        span({ spanId: "a2", traceId: "ta2", model: NO_PRICE_MODEL, inputTokens: 40, outputTokens: 10, attributes: { "user.id": "alice" } }),
        // The SAME identity as B's user, in A. The per-model query (the input to the price table)
        // filters by the page's ids — if IT leaked, A's spend would fold into B's "bob" row while
        // the token sums, which come from the page query, stayed correct. Only costUsd would move.
        span({ spanId: "a3", traceId: "ta3", model: "claude-opus-4-8", inputTokens: 900_000, outputTokens: 900_000, attributes: { "user.id": "bob" } }),
      ],
      WS_A,
    );
    await repo.save(
      [span({ spanId: "b1", traceId: "tb", model: "claude-opus-4-8", inputTokens: 7, outputTokens: 3, attributes: { "user.id": "bob" } })],
      WS_B,
    );

    const asB = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_B);

    // (a) alice's identity must not appear …
    expect(asB.users.map((u) => u.userId)).not.toContain("alice");
    // (b) … and her tokens must not be folded into B's totals either. Asserting only (a) would
    // pass on a bug that filtered the label out of the SELECT but not out of the SUM.
    expect(asB.users.reduce((n, u) => n + u.inputTokens, 0)).toBe(7);
    expect(asB.totalUsers).toBe(1);
    // (c) the price-gap query — A's unpriced span must not be counted against B. Without this, a
    // report can announce a price gap that belongs to another tenant: a plausible number, not an
    // error, which is the failure mode this whole milestone was built against.
    expect(asB.unpricedSpans).toBe(0);
    // (d) the per-model query — B's "bob" must be priced from B's 7/3 tokens alone. A shared
    // identity is the only fixture shape that can expose this, and the assertion is on cost because
    // that is the single field the per-model query owns.
    const price = resolveModelPrice("claude-opus-4-8", DEFAULT_PRICES);
    const bobOnlyInB = 7 * (price?.inputPerToken ?? 0) + 3 * (price?.outputPerToken ?? 0);
    expect(costOf(asB, "bob")).toBeCloseTo(roundUsd(bobOnlyInB), 6);
  });

  it("T4.2 — a span with no identity lands in the unattributed bucket, never dropped", async () => {
    await repo.save(
      [
        span({ spanId: "c1", traceId: "tc", model: "claude-opus-4-8", inputTokens: 10, outputTokens: 1, attributes: { "user.id": "carol" } }),
        span({ spanId: "c2", traceId: "tc", model: "claude-opus-4-8", inputTokens: 20, outputTokens: 2, attributes: { "gen_ai.user.id": "dave" } }),
        span({ spanId: "c3", traceId: "tc", model: "claude-opus-4-8", inputTokens: 30, outputTokens: 3, attributes: { other: "x" } }),
      ],
      WS_A,
    );

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A);
    const ids = r.users.map((u) => u.userId).sort();

    expect(ids).toEqual(["carol", "dave", "unattributed"]);
    // Guard-the-guard: a bug collapsing EVERY user into the bucket would satisfy "unattributed is
    // present". The fallback to gen_ai.user.id must also be exercised — `dave` proves it.
    expect(r.users.find((u) => u.userId === "unattributed")?.inputTokens).toBe(30);
    expect(r.users.find((u) => u.userId === "dave")?.inputTokens).toBe(20);
  });

  it("T4.3a — a priced model produces cost; an unpriced one is reported, not silently free", async () => {
    await repo.save(
      [
        span({ spanId: "d1", traceId: "td", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 100, attributes: { "user.id": "erin" } }),
        span({ spanId: "d2", traceId: "td", model: NO_PRICE_MODEL, inputTokens: 5000, outputTokens: 500, attributes: { "user.id": "erin" } }),
      ],
      WS_A,
    );

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A);
    const erin = r.users.find((u) => u.userId === "erin");

    expect(r.unpricedSpans).toBe(1);
    // Tokens are counted in full — the gap is in the COST, and the response says so.
    expect(erin?.inputTokens).toBe(6000);
    // Cost reflects only the priced span. Without `unpricedSpans` this reads as the real spend.
    expect(erin?.costUsd).toBeGreaterThan(0);
    const pricedOnly =
      1000 * (resolveModelPrice("claude-opus-4-8", DEFAULT_PRICES)?.inputPerToken ?? 0) +
      100 * (resolveModelPrice("claude-opus-4-8", DEFAULT_PRICES)?.outputPerToken ?? 0);
    expect(erin?.costUsd).toBeCloseTo(Math.round(pricedOnly * 1e6) / 1e6, 6);
  });

  it("T4.3b — a span with no model AND no tokens is not counted as unpriced", async () => {
    // The case measured in discovery: 36,901 such spans on a real workspace. Counting them would
    // report a gap 36,900× larger than the real one and read as "most of your cost is missing".
    await repo.save(
      [
        span({ spanId: "e1", traceId: "te", attributes: { "user.id": "frank" } }),
        span({ spanId: "e2", traceId: "te", model: "claude-opus-4-8", inputTokens: 10, outputTokens: 1, attributes: { "user.id": "frank" } }),
      ],
      WS_A,
    );

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A);

    expect(r.unpricedSpans).toBe(0);
    expect(r.users.find((u) => u.userId === "frank")?.spans).toBe(2);
  });


  it("F-test-1 — an empty or blank user.id lands in the bucket, never 500s the report", async () => {
    // The identity is CLIENT-CHOSEN. `coalesce` only substitutes NULL, so an empty string used to
    // survive into a response the route validates with `.parse()` (userId min(1)) — one malformed
    // attribute from any SDK client answered 500 for that client's whole workspace and window.
    await repo.save(
      [
        span({ spanId: "g1", traceId: "tg", model: "claude-opus-4-8", inputTokens: 11, outputTokens: 0, attributes: { "user.id": "" } }),
        span({ spanId: "g2", traceId: "tg", model: "claude-opus-4-8", inputTokens: 22, outputTokens: 0, attributes: { "user.id": "   " } }),
        span({ spanId: "g3", traceId: "tg", model: "claude-opus-4-8", inputTokens: 33, outputTokens: 0, attributes: { "user.id": "real" } }),
      ],
      WS_A,
    );

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A);

    expect(r.users.map((u) => u.userId).sort()).toEqual(["real", "unattributed"]);
    expect(r.users.find((u) => u.userId === "unattributed")?.inputTokens).toBe(33);
    // The whole point: the response must satisfy the contract the route enforces on the way out.
    expect(() => usageByUserResponseSchema.parse(r)).not.toThrow();
  });

  it("F-test-4 — totalUsers counts distinct users, not spans", async () => {
    // Every earlier fixture gave each user exactly one span, so count() and count(DISTINCT) agreed
    // and the mutation survived. One user with two spans is all it takes to tell them apart.
    await repo.save(
      [
        span({ spanId: "h1", traceId: "th", model: "claude-opus-4-8", inputTokens: 1, outputTokens: 0, attributes: { "user.id": "multi" } }),
        span({ spanId: "h2", traceId: "th", model: "claude-opus-4-8", inputTokens: 1, outputTokens: 0, attributes: { "user.id": "multi" } }),
        span({ spanId: "h3", traceId: "th", model: "claude-opus-4-8", inputTokens: 1, outputTokens: 0, attributes: { "user.id": "solo" } }),
      ],
      WS_A,
    );

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A);

    expect(r.totalUsers).toBe(2);
    expect(r.users.find((u) => u.userId === "multi")?.spans).toBe(2);
  });

  it("F-test-5a — the biggest consumer comes first (behaviour, not source text)", async () => {
    await repo.save(
      [
        span({ spanId: "i1", traceId: "ti", model: "claude-opus-4-8", inputTokens: 10, outputTokens: 0, attributes: { "user.id": "small" } }),
        span({ spanId: "i2", traceId: "ti", model: "claude-opus-4-8", inputTokens: 9000, outputTokens: 0, attributes: { "user.id": "big" } }),
      ],
      WS_A,
    );

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A);
    expect(r.users[0]?.userId).toBe("big");
  });

  it("F-test-5b — user.id wins over gen_ai.user.id when a span carries both", async () => {
    // The fallback ORDER is the rule (M131). No earlier fixture sent both keys, so inverting the
    // coalesce was invisible to behaviour and only the source-string assertion noticed.
    await repo.save(
      [span({ spanId: "j1", traceId: "tj", model: "claude-opus-4-8", inputTokens: 5, outputTokens: 0,
              attributes: { "user.id": "primary", "gen_ai.user.id": "secondary" } })],
      WS_A,
    );

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A);
    expect(r.users.map((u) => u.userId)).toEqual(["primary"]);
  });

  it("F-test-6 — limit is APPLIED, and offset floors at zero", async () => {
    // Rewritten 2026-08-01 after asking "is there a wrong implementation that would pass this?".
    // The previous version seeded ONE user and asserted `users.length <= MAX_LIMIT`. With one row
    // that is true whether the clamp exists or not — measured: deleting `Math.min(MAX_LIMIT, …)`
    // left all 14 tests green. A fixture with no discriminating power protects the appearance of
    // the behaviour, not the behaviour.
    //
    // Three users and `limit: 2` tells the two implementations apart: applied → 2 rows,
    // ignored → 3.
    await repo.save(
      [
        span({ spanId: "l1", traceId: "tl", model: "claude-opus-4-8", inputTokens: 300, outputTokens: 0, attributes: { "user.id": "lim-a" } }),
        span({ spanId: "l2", traceId: "tl", model: "claude-opus-4-8", inputTokens: 200, outputTokens: 0, attributes: { "user.id": "lim-b" } }),
        span({ spanId: "l3", traceId: "tl", model: "claude-opus-4-8", inputTokens: 100, outputTokens: 0, attributes: { "user.id": "lim-c" } }),
      ],
      WS_A,
    );

    const page = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { limit: 2 });
    expect(page.users.map((u) => u.userId)).toEqual(["lim-a", "lim-b"]);
    expect(page.totalUsers).toBe(3);

    // A negative offset must behave as 0 — not error, and not silently skip the first page.
    const negative = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { offset: -5 });
    expect(negative.users.map((u) => u.userId)).toEqual(["lim-a", "lim-b", "lim-c"]);

    // HONEST LIMIT: the 500 ceiling itself is NOT exercised — discriminating it needs 501+ seeded
    // users, which is disproportionate here. Since `8e77635` the route rejects `limit > 500` with
    // 400 before the repository is reached (`usage-by-user-route.integration.test.ts` covers that),
    // so the clamp below is defence in depth for a direct caller, and it is asserted structurally.
    const src = readFileSync(new URL("./usage-by-user-repository.ts", import.meta.url), "utf8");
    expect(src).toMatch(/Math\.min\(MAX_LIMIT,/);
  });

  it("F-test-8 — query 2 stays restricted to the page (cardinality risk R3)", () => {
    // Behaviourally equivalent by construction — costByUser is keyed by page id, so extra rows are
    // ignored and no output assertion can ever see it. But without the restriction, query 2 fans out
    // to every distinct user in the window: an unbounded-memory regression that ships green.
    // Structural guard, same precedent as the ORDER BY tiebreak below.
    const src = readFileSync(new URL("./usage-by-user-repository.ts", import.meta.url), "utf8");
    expect(src).toMatch(/AND \$\{userId\} IN \$\{ids\}/);
  });

  it("EC-3 — the ORDER BY carries a total tiebreak", () => {
    // MEASURED (mutation M4, 2026-07-29): the behavioural test below SURVIVES removing the
    // tiebreak. With three rows Postgres happens to return a stable order — same heap page, same
    // plan — so the assertion that the pages do not overlap passes on a query that is not actually
    // deterministic. Seeding hundreds of tied users would raise the odds without ever making the
    // proof deterministic, because the guarantee being tested is one Postgres explicitly does NOT
    // give: with no total ORDER BY, LIMIT/OFFSET may return the same row on two pages.
    //
    // So the determinism is pinned STRUCTURALLY, on the property itself, and the behavioural test
    // is kept for what it does prove (the pagination arithmetic). Same shape as T1.1's
    // single-definition test: assert the source property when the runtime cannot expose it.
    const src = readFileSync(new URL("./usage-by-user-repository.ts", import.meta.url), "utf8");
    // Anchor on the SQL line itself (leading whitespace, no `//`) — a loose match would hit the
    // comment above the query that merely mentions ORDER BY, and pass while measuring nothing.
    const orderByLines = src.split("\n").filter((l) => /^\s+ORDER BY /.test(l));
    expect(orderByLines).toHaveLength(1);
    // Anchored on the PROPERTY (a descending total, then an ascending tiebreak on the grouping
    // key), not on one spelling of it. It previously demanded the literal `1 ASC`; rewriting the
    // page as a CTE that names its columns turned it red while the tiebreak was still total and
    // still correct. A guard that breaks on a behaviour-preserving rename teaches the next person
    // to weaken it, which is worse than the gap it covers.
    expect(orderByLines[0]).toMatch(/DESC,\s*(1|"userId")\s+ASC\s*$/);
  });

  it("EC-3 — pagination returns every user exactly once when totals tie", async () => {
    // Equal totals: without the `userId` tiebreak the two pages may return the same user twice.
    await repo.save(
      [
        span({ spanId: "f1", traceId: "tf", model: "claude-opus-4-8", inputTokens: 100, outputTokens: 0, attributes: { "user.id": "tie-a" } }),
        span({ spanId: "f2", traceId: "tf", model: "claude-opus-4-8", inputTokens: 100, outputTokens: 0, attributes: { "user.id": "tie-b" } }),
        span({ spanId: "f3", traceId: "tf", model: "claude-opus-4-8", inputTokens: 100, outputTokens: 0, attributes: { "user.id": "tie-c" } }),
      ],
      WS_A,
    );

    const p1 = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { limit: 2, offset: 0 });
    const p2 = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { limit: 2, offset: 2 });
    const seen = [...p1.users, ...p2.users].map((u) => u.userId);

    expect(new Set(seen).size).toBe(3);
    expect(seen.sort()).toEqual(["tie-a", "tie-b", "tie-c"]);
    expect(p1.totalUsers).toBe(3);
  });

  it("clamps an absurd window instead of scanning without bound (EC-4)", async () => {
    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { days: 999_999 });
    expect(r.windowDays).toBe(MAX_WINDOW_DAYS);
  });

  it("clamps an absurd offset as a last line of defence (the route rejects it first)", async () => {
    // Nothing in the response echoes the offset, so the observable is that it did NOT blow up: an
    // unbounded value reached `OFFSET` as a bigint and errored in the driver. Parsing proves the
    // response is well-formed rather than a thrown 500.
    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { offset: 999_999_999 });
    expect(() => usageByUserResponseSchema.parse(r)).not.toThrow();
    expect(MAX_OFFSET).toBeLessThan(999_999_999);
  });

  it("an EMPTY workspace answers a well-formed zero report, never an absent one", async () => {
    // The edge that `count(*) OVER ()` introduces: the total rides on the page rows, so an empty
    // page has no row to read it from. This pins the whole shape, not one field — and the branch
    // that skips the per-model query (`ids.length === 0`) is only reachable here.
    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, "ws-usage-empty");
    expect(() => usageByUserResponseSchema.parse(r)).not.toThrow();
    expect(r).toEqual({ users: [], unpricedSpans: 0, totalUsers: 0, windowDays: 30 });
  });

  it("an offset PAST THE END still reports the true totalUsers, not zero", async () => {
    // The dangerous half of the same edge. Reading the window count off row 0 works only while
    // there IS a row; paging past the end must NOT report "0 users" for a workspace that has three
    // — the caller cannot tell that lie from the truth, and it is what a naive fold produces.
    await repo.save(
      [
        span({ spanId: "o1", traceId: "to", model: "claude-opus-4-8", inputTokens: 3, attributes: { "user.id": "u1" } }),
        span({ spanId: "o2", traceId: "to", model: "claude-opus-4-8", inputTokens: 2, attributes: { "user.id": "u2" } }),
        span({ spanId: "o3", traceId: "to", model: "claude-opus-4-8", inputTokens: 1, attributes: { "user.id": "u3" } }),
      ],
      WS_A,
    );

    const past = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { limit: 2, offset: 50 });
    expect(past.users).toEqual([]);
    expect(past.totalUsers).toBe(3);
  });

  it("the aggregates describe ONE window, not one clock each", async () => {
    // Before the window was bound once as a value, each statement re-evaluated `now()` and measured
    // a slightly different range. The observable consequence is an inconsistent report: a total
    // counting a user whose rows the page never saw. Asserting the invariant is stronger than
    // asserting the implementation — with the page not truncated by `limit`, row count and reported
    // total must agree.
    await repo.save(
      [
        span({ spanId: "w1", traceId: "tw", model: "claude-opus-4-8", inputTokens: 5, attributes: { "user.id": "w-a" } }),
        span({ spanId: "w2", traceId: "tw", model: "claude-opus-4-8", inputTokens: 4, attributes: { "user.id": "w-b" } }),
      ],
      WS_A,
    );

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { limit: 100 });
    expect(r.users.length).toBe(r.totalUsers);
  });

  it("T4.3c — a span with NO model but WITH tokens counts as unpriced", async () => {
    // The `model === ""` disjunct of the price-gap classifier had no fixture: one corner seeded a
    // priceless model WITH tokens, the other a NULL model with ZERO tokens. Nothing seeded the
    // input that actually reaches this branch.
    await repo.save(
      [
        span({ spanId: "n1", traceId: "tn", model: NO_PRICE_MODEL, inputTokens: 10, attributes: { "user.id": "nm" } }),
        span({ spanId: "n2", traceId: "tn", inputTokens: 10, attributes: { "user.id": "nm" } }),
      ],
      WS_A,
    );

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A);
    expect(r.unpricedSpans).toBe(2);
    // …and neither contributes cost: an unpriced span raises the gap, never the total.
    expect(costOf(r, "nm")).toBe(0);
  });

  it("pins the six-decimal cost floor itself, not just the value", async () => {
    // `toBeCloseTo(x, 6)` tolerates exactly the rounding step, so a rounded and an unrounded
    // implementation are indistinguishable under it — the assertion could not see whether the floor
    // was applied at all. The property under test is IDEMPOTENCE: a value already at the floor is
    // unchanged by rounding again. Per-user cost is a SUM over models, and summing rounded floats
    // reintroduces trailing digits, so dropping the final `roundUsd` makes this red.
    //
    // The floor is a deliberate contract: three-decimal rounding once reported real spend as zero.
    await repo.save(
      [
        span({ spanId: "p1", traceId: "tp", model: "claude-opus-4-8", inputTokens: 7, outputTokens: 3, attributes: { "user.id": "prec" } }),
        span({ spanId: "p2", traceId: "tp", model: "claude-sonnet-4-5", inputTokens: 11, outputTokens: 13, attributes: { "user.id": "prec" } }),
      ],
      WS_A,
    );

    const cost = costOf(await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A), "prec");
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBe(roundUsd(cost));
  });
});
