import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * theo-lens#136 — guarda de CLASSE, não de instância.
 *
 * `sum()` sobre uma coluna `integer` devolve `bigint`. Espremê-la de volta em `::int` faz o Postgres
 * levantar `22003 integer out of range` assim que o grupo acumula mais de 2.147.483.647 — cada linha
 * cabe, a soma não. Foi assim que `range=30d` derrubou a tela de observabilidade inteira, com o
 * operador lendo "the lens service is not reachable".
 *
 * O defeito não estava num lugar: estava num PADRÃO, repetido em cinco consultas. Corrigir só a que
 * quebrou deixaria quatro bombas idênticas esperando volume. Esta guarda existe para que a próxima
 * consulta a somar tokens não nasça capada — o teste de integração prova a correção de hoje, este
 * impede a de amanhã.
 *
 * Escape declarado: uma soma que alimenta um INSERT numa coluna `integer` tem o teto na COLUNA, não
 * no cast — ali remover o cast não corrige nada, e a correção real seria migrar o tipo. Esses casos
 * carregam o marcador abaixo, para que a exceção seja visível em vez de tácita.
 */
const MARCADOR_DE_EXCECAO = "int4-alvo-ok";

const COLUNAS_DE_TOKEN = [
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
];

/** `sum(<coluna de token>)` … `::int` na mesma linha — sem casar `::int8`/`::integer`. */
const PADRAO = new RegExp(
  String.raw`sum\(\s*(?:${COLUNAS_DE_TOKEN.join("|")})\s*\)[^\n]*?::int\b(?!eger)`,
);

const RAIZ = fileURLToPath(new URL("../../..", import.meta.url)); // packages/core/src → packages/core

function arquivosTs(dir: string, achados: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (entrada === "node_modules" || entrada === "dist" || entrada === "__generated__") continue;
    const caminho = join(dir, entrada);
    if (statSync(caminho).isDirectory()) arquivosTs(caminho, achados);
    else if (entrada.endsWith(".ts") && !entrada.includes(".test.")) achados.push(caminho);
  }
  return achados;
}

describe("guarda #136 — nenhuma soma de token volta a ser capada em int4", () => {
  it("test_nenhuma_soma_de_token_e_espremida_em_int4_sem_marcador", () => {
    const ofensores: string[] = [];
    for (const arquivo of arquivosTs(join(RAIZ, "src"))) {
      const linhas = readFileSync(arquivo, "utf8").split("\n");
      linhas.forEach((linha, i) => {
        if (!PADRAO.test(linha)) return;
        if (linha.includes(MARCADOR_DE_EXCECAO)) return;
        ofensores.push(`${arquivo.replace(RAIZ, "")}:${i + 1} → ${linha.trim()}`);
      });
    }
    expect(ofensores).toEqual([]);
  });

  it("test_a_guarda_detecta_o_padrao_que_existe_para_pegar", () => {
    // Sem este caso, uma regex quebrada devolveria lista vazia e o teste acima ficaria verde para
    // sempre — a mesma cegueira de fixture que o M145 pagou para aprender.
    expect(PADRAO.test('coalesce(sum(cache_read_tokens), 0)::int AS "cacheReadTokens"')).toBe(true);
    expect(PADRAO.test("sum(input_tokens)::int,")).toBe(true);
    // …e NÃO dispara sobre a forma correta, nem sobre uma contagem de linhas.
    expect(PADRAO.test("coalesce(sum(input_tokens), 0)::double precision AS i")).toBe(false);
    expect(PADRAO.test("count(*)::int AS n")).toBe(false);
  });
});
