import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import type pg from "pg";

import type { Span } from "../../../domain/observability/span.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";
import { aggregatePromptUsage } from "./aggregate-repository.js";

/**
 * M15 (theo-promptly) — uso por REVISÃO de prompt.
 *
 * O `theo-promptly` marca `prompt.id` (que carrega o **nome**) e `prompt.revision`
 * em cada span `prompt.resolve`. A atribuição de custo é **por trace**: o span de
 * resolução nasce filho do trace da aplicação, então ele e a chamada ao modelo
 * compartilham `traceId` sem ninguém combinar contrato algum.
 *
 * O custo NÃO é re-somado a partir dos spans: `traces.cost_usd` já é o valor
 * autoritativo (mesma razão do #73 — a soma por span dá $0.0000 quando o custo
 * está no pai). O agregado junta `spans` a `traces` pela PK de `traces`.
 */

const PG_URI = process.env["THEOLENS_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

const WS_A = "ws-alfa";
const WS_B = "ws-beta";

function resolucao(
  traceId: string,
  spanId: string,
  revision: number | string,
  nome = "saudacao",
): Span {
  return {
    spanId,
    traceId,
    name: "prompt.resolve",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000005000000",
    attributes: { "prompt.id": nome, "prompt.revision": revision },
  } as Span;
}

function chamadaDeModelo(traceId: string, spanId: string): Span {
  return {
    spanId,
    traceId,
    name: "llm_request",
    startTimeUnixNano: "1700000000010000000",
    endTimeUnixNano: "1700000000900000000",
    model: "gpt-4o-mini",
    inputTokens: 100,
    outputTokens: 50,
  } as Span;
}

suite("aggregatePromptUsage — uso por revisão (M15)", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;
  let repo: DrizzleSpanRepository;

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    repo = new DrizzleSpanRepository(db);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE spans, traces, sessions, replay_sessions");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("devolve uma linha por revisao, com contagem de resolucoes", async () => {
    await repo.save(
      [
        resolucao("t1", "s1", 3),
        resolucao("t2", "s2", 3),
        resolucao("t3", "s3", 4),
      ],
      WS_A,
    );

    const linhas = await aggregatePromptUsage(db, "saudacao", 7, WS_A);

    expect(linhas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ revision: 3, resolutions: 2 }),
        expect.objectContaining({ revision: 4, resolutions: 1 }),
      ]),
    );
    expect(linhas).toHaveLength(2);
  });

  it("soma tokens dos spans de LLM do MESMO trace da resolucao", async () => {
    await repo.save([resolucao("t1", "s1", 3), chamadaDeModelo("t1", "s2")], WS_A);

    const linhas = await aggregatePromptUsage(db, "saudacao", 7, WS_A);

    expect(linhas[0]?.revision).toBe(3);
    expect(linhas[0]?.totalTokens).toBe(150);
  });

  it("NAO soma spans de LLM de outro trace", async () => {
    // t1 tem a resolução; t2 tem uma chamada de modelo que nada tem a ver com ela.
    await repo.save([resolucao("t1", "s1", 3)], WS_A);
    await repo.save([chamadaDeModelo("t2", "s2")], WS_A);

    const linhas = await aggregatePromptUsage(db, "saudacao", 7, WS_A);

    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.totalTokens).toBe(0);
  });

  it("o inquilino A nunca ve span do inquilino B", async () => {
    await repo.save([resolucao("t1", "s1", 3)], WS_A);
    await repo.save([resolucao("t9", "s9", 8)], WS_B);

    const linhas = await aggregatePromptUsage(db, "saudacao", 7, WS_A);

    expect(linhas.map((l) => l.revision)).toEqual([3]);
  });

  it("mesmo trace_id em dois workspaces nao cruza custo (M22 / F-sec-3)", async () => {
    // O schema PREVÊ esta colisão: `traces` tem PK composta (workspace_id, trace_id)
    // exatamente porque um trace_id pode existir em dois inquilinos. Omitir
    // `workspace_id` num lado do join reintroduz um defeito já corrigido uma vez.
    await repo.save([resolucao("mesmo", "sa", 3), chamadaDeModelo("mesmo", "sb")], WS_A);
    await repo.save([resolucao("mesmo", "sc", 3), chamadaDeModelo("mesmo", "sd")], WS_B);

    const linhas = await aggregatePromptUsage(db, "saudacao", 7, WS_A);

    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.resolutions, "contou a resolução do outro inquilino").toBe(1);
    expect(linhas[0]?.totalTokens, "somou tokens do outro inquilino").toBe(150);
  });

  it("spans fora da janela nao entram no agregado", async () => {
    await repo.save([resolucao("t1", "s1", 3)], WS_A);
    await pool.query(
      "UPDATE spans SET ingested_at = now() - interval '30 days' WHERE span_id = 's1'",
    );

    const linhas = await aggregatePromptUsage(db, "saudacao", 7, WS_A);

    expect(linhas).toHaveLength(0);
  });

  it("span com prompt.revision = -1 nao aparece no agregado", async () => {
    // O decorator grava `p?.version ?? -1`: uma resolução que NÃO encontrou o prompt
    // exporta um span válido com revisão -1. Agrupar por ele produziria uma linha
    // "revisão -1" que não corresponde a revisão alguma — uso fantasma na tela.
    await repo.save([resolucao("t1", "s1", 3), resolucao("t2", "s2", -1)], WS_A);

    const linhas = await aggregatePromptUsage(db, "saudacao", 7, WS_A);

    expect(linhas.map((l) => l.revision)).toEqual([3]);
  });

  it("prompt com 10+ revisoes ordena v10 depois de v9, nao antes", async () => {
    // `attributes->>` devolve TEXTO. Sem cast, '10' < '9' e a tela ordena errado
    // a partir da décima revisão — o caso que só aparece depois de prometido.
    await repo.save([resolucao("t1", "s1", 9), resolucao("t2", "s2", 10)], WS_A);

    const linhas = await aggregatePromptUsage(db, "saudacao", 7, WS_A);

    expect(linhas.map((l) => l.revision)).toEqual([10, 9]);
  });

  it("devolve a latencia MEDIANA da resolucao por revisao", async () => {
    // O DoD-2 do M15 pede quatro números por revisão: chamadas, latência mediana, tokens e
    // custo. A mediana é da RESOLUÇÃO — o que o span `prompt.resolve` mede —, não do trace:
    // o trace inclui a chamada ao modelo, que é ordens de grandeza mais lenta e diria outra coisa.
    await repo.save(
      [
        { ...resolucao("t1", "s1", 3), endTimeUnixNano: "1700000000005000000" }, //  5 ms
        { ...resolucao("t2", "s2", 3), endTimeUnixNano: "1700000000015000000" }, // 15 ms
        { ...resolucao("t3", "s3", 3), endTimeUnixNano: "1700000000025000000" }, // 25 ms
      ] as Span[],
      WS_A,
    );

    const linhas = await aggregatePromptUsage(db, "saudacao", 7, WS_A);

    expect(linhas[0]?.p50LatencyMs).toBeCloseTo(15, 1);
  });

  it("a consulta usa o indice — EXPLAIN nao mostra Seq Scan em spans", { timeout: 120_000 }, async () => {
    // Dado sintético, porque o app-dev não reproduz volume (ADR-3). Sem o índice
    // parcial a consulta é varredura, e a tela ficaria utilizável aqui e
    // inutilizável no primeiro cliente com tráfego.
    const lote: Span[] = [];
    for (let i = 0; i < 20_000; i++) {
      lote.push(resolucao(`bulk${String(i)}`, `bs${String(i)}`, (i % 12) + 1, `outro-${String(i % 50)}`));
    }
    for (let i = 0; i < lote.length; i += 2000) await repo.save(lote.slice(i, i + 2000), WS_A);
    await repo.save([resolucao("alvo", "salvo", 3)], WS_A);
    await pool.query("ANALYZE spans");

    const plano = await db.execute(sql`
      EXPLAIN SELECT 1 FROM spans
       WHERE workspace_id = ${WS_A} AND name = 'prompt.resolve'
         AND attributes->>'prompt.id' = 'saudacao'
    `);
    const texto = plano.rows.map((r) => Object.values(r).join(" ")).join("\n");

    expect(texto, `plano:\n${texto}`).not.toMatch(/Seq Scan on spans/);
  });
});
