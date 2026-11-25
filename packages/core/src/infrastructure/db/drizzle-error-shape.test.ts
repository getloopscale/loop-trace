import { describe, expect, it } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";

/**
 * looptrace#136 — trava a PREMISSA de que o tratamento de erro da API depende.
 *
 * O `onError` do serviço precisa (a) ler o código do Postgres para classificar a falha e (b) NÃO
 * vazar os parâmetros ligados, que podem carregar conteúdo do usuário (o termo de busca livre de
 * `listTraces`, por exemplo).
 *
 * Ambas dependem de onde o `drizzle` põe cada coisa — e a intuição erra: `db.execute()` embrulha
 * qualquer erro num `DrizzleQueryError`, que deixa `code`/`routine` na **`.cause`** e concatena os
 * parâmetros na própria `message`. A primeira versão do teste do handler fabricou a forma errada
 * (campos planos no objeto), passou, e certificou duas garantias **falsas em produção**.
 *
 * Este teste existe porque o handler vive em `packages/api`, onde o `drizzle` não resolve. Em vez de
 * acrescentar a dependência lá só para um teste, a premissa é verificada AQUI, contra a biblioteca
 * de verdade. Se uma versão futura do drizzle mudar onde põe o código, ou parar de concatenar os
 * parâmetros, é este teste que quebra — e não uma produção que voltou a vazar em silêncio.
 */
describe("forma do DrizzleQueryError (premissa do onError da API)", () => {
  const erro = () => {
    const doPostgres = Object.assign(new Error("integer out of range"), {
      code: "22003",
      routine: "int84",
    });
    return new DrizzleQueryError("SELECT sum(x)::int FROM t WHERE q = $2", ["day", "SEGREDO"], doPostgres);
  };

  it("test_o_codigo_do_postgres_vive_na_causa_e_nao_no_objeto", () => {
    const e = erro() as Error & { code?: string; routine?: string; cause?: { code?: string; routine?: string } };
    expect(e.code).toBeUndefined();
    expect(e.routine).toBeUndefined();
    expect(e.cause?.code).toBe("22003");
    expect(e.cause?.routine).toBe("int84");
  });

  it("test_a_mensagem_crua_concatena_os_parametros_e_por_isso_nao_pode_ser_logada_inteira", () => {
    const e = erro();
    expect(e.message).toContain("SEGREDO");
    // O separador que o saneamento do handler usa para cortar. Se o drizzle mudar este formato, o
    // corte para de funcionar — e é aqui que se descobre.
    expect(e.message).toContain("\nparams:");
    expect(e.message.split("\nparams:")[0]).not.toContain("SEGREDO");
  });

  it("test_o_sql_fica_acessivel_em_query_para_localizar_a_consulta", () => {
    const e = erro() as Error & { query?: string };
    expect(e.query).toContain("sum(x)::int");
    expect(e.query).not.toContain("SEGREDO"); // parâmetros são $n, nunca interpolados
  });
});
