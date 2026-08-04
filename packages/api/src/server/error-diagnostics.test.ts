import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";
import type { SpanRepository } from "@usetheo/lens-core";

/**
 * theo-lens#136 — a falha não pode ser anônima.
 *
 * Quando `range=30d` estourava, o operador via `{"code":"INTERNAL"}` no cliente e
 * `UPSTREAM_ERROR` no dashboard. Nenhum dos dois distingue "esta consulta tem um defeito de tipo" de
 * "o serviço está fora do ar" — e foi isso que transformou um bug de uma linha numa investigação.
 *
 * O corpo da resposta continua opaco DE PROPÓSITO (nunca vazar interno ao cliente). O que precisa
 * mudar é o LOG: ele tem de nomear a consulta que falhou e classificar o erro do Postgres.
 */

/** Um erro no formato que o driver do Postgres entrega (drizzle anexa `query`). */
function erroDoPostgres(): Error & { code: string; routine: string; query: string } {
  return Object.assign(new Error("integer out of range"), {
    code: "22003",
    routine: "int84",
    query: 'SELECT date_trunc($1, ingested_at) AS bucket, coalesce(sum(input_tokens), 0)::int',
    // `params` NÃO é logado: pode carregar conteúdo do usuário (termo de busca, span_query).
    params: ["day", "termo-secreto-do-usuario"],
  });
}

function repoQueExplode(): SpanRepository {
  return {
    aggregateObservability: () => Promise.reject(erroDoPostgres()),
  } as unknown as SpanRepository;
}

describe("diagnóstico de falha (theo-lens#136)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("test_log_de_erro_nomeia_a_consulta_e_classifica_o_codigo_do_postgres", async () => {
    const capturado: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      capturado.push(a.map(String).join(" "));
    });

    const app = createApp(repoQueExplode());
    const res = await app.request("/v1/metrics/observability?range=30d");

    // O cliente segue sem saber do interno — isso é postura, não omissão.
    expect(res.status).toBe(500);
    expect((await res.json()) as unknown).toEqual({ code: "INTERNAL", message: "internal error" });

    const log = capturado.join("\n");
    expect(log).toContain("request_failed");
    // …mas o LOG classifica e localiza:
    expect(log).toContain("22003"); // o código do Postgres — "numeric value out of range"
    expect(log).toContain("sum(input_tokens)"); // a consulta exata que falhou
    // E jamais os parâmetros, que podem conter conteúdo do usuário.
    expect(log).not.toContain("termo-secreto-do-usuario");
  });
});
