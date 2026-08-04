import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { SpanRepository } from "@usetheo/lens-core";

/**
 * theo-lens#136 — a falha não pode ser anônima, e o log não pode vazar.
 *
 * Quando `range=30d` estourava, o operador via `{"code":"INTERNAL"}` no cliente e `UPSTREAM_ERROR`
 * no dashboard. Nenhum dos dois distingue "esta consulta tem um defeito de tipo" de "o serviço está
 * fora do ar" — e foi isso que transformou um bug de uma linha numa investigação.
 *
 * ## Por que o erro é construído com a classe REAL
 *
 * A primeira versão deste teste fabricava `{code, routine, query}` planos no mesmo objeto. Nenhum
 * caminho de produção produz essa forma: `db.execute()` embrulha tudo em `DrizzleQueryError`, que
 * põe `code`/`routine` em **`.cause`** e concatena os parâmetros na própria `message`. O teste
 * passava, e as duas garantias que ele certificava eram **falsas em produção** — `dbErrorCode` nunca
 * seria emitido, e os parâmetros vazavam pela mensagem.
 *
 * Um teste que certifica um invariante inexistente é pior que nenhum teste: ele transforma uma
 * lacuna em confiança. Por isso o erro aqui é o de verdade.
 */
const SQL = "SELECT date_trunc($1, ingested_at), coalesce(sum(input_tokens), 0)::int FROM spans WHERE q = $2";
const PARAMS = ["day", "TERMO-SECRETO-DO-USUARIO"];

function erroRealDoDrizzle(): Error {
  const doPostgres = Object.assign(new Error("integer out of range"), {
    code: "22003",
    routine: "int84",
  });
  // Réplica FIEL do `DrizzleQueryError` — `drizzle-orm` é dependência de `packages/core`, e não
  // resolve aqui. Acrescentá-la só para um teste seria o contrário da parsimônia; em vez disso a
  // forma é travada contra a classe REAL em
  // `packages/core/src/infrastructure/db/drizzle-error-shape.test.ts`, que quebra se o drizzle
  // mudar onde põe o código ou como concatena os parâmetros.
  return Object.assign(new Error(`Failed query: ${SQL}\nparams: ${PARAMS.join(",")}`), {
    query: SQL,
    params: PARAMS,
    cause: doPostgres,
  });
}

function repoQueExplode(): SpanRepository {
  return {
    aggregateObservability: () => Promise.reject(erroRealDoDrizzle()),
  } as unknown as SpanRepository;
}

describe("diagnóstico de falha (theo-lens#136)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("test_a_replica_reproduz_a_forma_travada_no_teste_do_pacote_core", () => {
    // Trava a premissa do teste abaixo. Se o drizzle mudar onde põe `code` ou parar de concatenar os
    // parâmetros na mensagem, é AQUI que se descobre — e não numa produção que voltou a vazar.
    const e = erroRealDoDrizzle() as Error & { code?: string; query?: string; cause?: { code?: string } };
    expect(e.code).toBeUndefined(); // NÃO está no objeto…
    expect(e.cause?.code).toBe("22003"); // …está na causa
    expect(e.query).toContain("sum(input_tokens)");
    expect(e.message).toContain("TERMO-SECRETO-DO-USUARIO"); // a mensagem crua VAZA
  });

  it("test_log_de_erro_classifica_e_localiza_sem_vazar_parametros", async () => {
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
    // Classifica: o código do Postgres, que vem de `.cause`.
    expect(log).toContain("22003");
    expect(log).toContain("int84");
    // Localiza: a consulta exata que falhou.
    expect(log).toContain("sum(input_tokens)");
    // E JAMAIS os parâmetros — nem pela mensagem crua, que é por onde eles escapavam.
    expect(log).not.toContain("TERMO-SECRETO-DO-USUARIO");
    // E a mensagem legível do Postgres, que vive na causa e sem a qual o log classifica sem descrever.
    expect(log).toContain("integer out of range");
  });

  it("test_erro_que_nao_e_do_postgres_nao_e_rotulado_como_erro_de_banco", async () => {
    // Caminho ALCANÇÁVEL, não hipotético: o juiz de LLM relança o `TypeError: fetch failed` nativo
    // intacto, com `cause.code = "ECONNREFUSED"`. Sem discriminar, uma queda do provedor chegaria ao
    // operador rotulada como falha de banco — a mesma confusão que este log existe para acabar.
    const capturado: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      capturado.push(a.map(String).join(" "));
    });
    const doFetch = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const app = createApp({
      aggregateObservability: () => Promise.reject(doFetch),
    } as unknown as SpanRepository);

    expect((await app.request("/v1/metrics/observability?range=7d")).status).toBe(500);
    const log = capturado.join("\n");
    expect(log).toContain("request_failed");
    expect(log).toContain("fetch failed");
    // `ECONNREFUSED` não é SQLSTATE (cinco alfanuméricos) — não pode virar `dbErrorCode`.
    expect(log).not.toContain("dbErrorCode");
  });
});
