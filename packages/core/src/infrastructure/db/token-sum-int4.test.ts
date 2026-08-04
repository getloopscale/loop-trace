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
 * ## Por que a regra é sobre QUALQUER `sum()`, e não sobre uma lista de colunas
 *
 * A primeira versão desta guarda listava as cinco colunas de token conhecidas e exigia o nome
 * **colado** ao `sum(`. Ela ficou **verde com dois infratores vivos na árvore** — `sum(t.total_tokens)`
 * escapava pelo alias de tabela, e um deles tinha nascido dois commits antes. A guarda existia para
 * impedir exatamente aquilo e não impediu, porque a regra descrevia a *forma que eu tinha visto* em
 * vez do *risco que eu queria barrar*.
 *
 * Uma lista de colunas também envelhece: a próxima coluna de token (`reasoning_tokens`, o que vier)
 * nasce fora dela, em silêncio. Então a regra inverteu — **qualquer** soma espremida em `::int` é
 * suspeita até que alguém declare o contrário no próprio código.
 *
 * ## O escape, e por que ele é explícito
 *
 * Uma soma que alimenta um `INSERT` numa coluna `integer` tem o teto na COLUNA, não no cast: ali
 * remover o cast não corrige nada, e a correção real seria migrar o tipo. Esses casos carregam o
 * marcador abaixo na própria linha, para que a exceção seja legível em vez de tácita.
 */
const MARCADOR_DE_EXCECAO = "int4-alvo-ok";

/**
 * `sum(` … `)` … cast de 4 bytes: `::int`, `::int4` **e `::integer`** — os três são o mesmo tipo em
 * Postgres, e escrever por extenso não deixa o teto maior. `::int8` e `::bigint` ficam de fora
 * porque não capam. Espaço no cast e caixa alta contam. Varre o arquivo inteiro, não linha a linha,
 * porque uma quebra de linha entre a soma e o cast escapava da versão anterior.
 *
 * Entre a soma e o cast só pode haver `[\s\d,)+]` — o rabo de um `coalesce(sum(x), 0)`, de um
 * `(sum(a) + sum(b))`, ou nada. Isso é o que faz o cast pertencer ÀQUELA soma.
 *
 * A segunda versão usava `[^;]`, que atravessa o SQL inteiro e casava `sum(cost_usd)::double
 * precision` de uma linha com o `count(*)::int` de outra — **cinco falso-positivos**, todos corretos
 * no código. A terceira trocou por `[^:;]{0,40}`, que funcionava por **margem**: no próprio caso de
 * falso-positivo sobravam 7 caracteres, e um SQL formatado mais compacto teria reintroduzido o erro.
 * Um limite numérico arbitrário não é uma regra — é uma aposta na formatação alheia. O conjunto de
 * caracteres é a regra de verdade, e não tem teto de comprimento.
 */
const PADRAO = /sum\s*\((?:[^()]|\([^()]*\))*\)[\s\d,)+]*::\s*int(?:4|eger)?\b/gis;

const RAIZ_PACOTES = fileURLToPath(new URL("../../../..", import.meta.url)); // …/packages

function arquivosTs(dir: string, achados: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (["node_modules", "dist", "build", "__generated__", ".turbo"].includes(entrada)) continue;
    const caminho = join(dir, entrada);
    if (statSync(caminho).isDirectory()) arquivosTs(caminho, achados);
    else if (entrada.endsWith(".ts") && !entrada.includes(".test.")) achados.push(caminho);
  }
  return achados;
}

/** As linhas de `fonte` que casam o padrão e não carregam o marcador. */
function ofensoresEm(fonte: string): string[] {
  const linhas = fonte.split("\n");
  const fora: string[] = [];
  for (const m of fonte.matchAll(PADRAO)) {
    const inicio = fonte.slice(0, m.index).split("\n").length - 1;
    const fim = inicio + m[0].split("\n").length - 1;
    // O marcador vale em qualquer linha do trecho casado (o cast pode estar numa continuação).
    const trecho = linhas.slice(inicio, fim + 1);
    if (trecho.some((l) => l.includes(MARCADOR_DE_EXCECAO))) continue;
    fora.push(`${inicio + 1}: ${(linhas[inicio] ?? "").trim()}`);
  }
  return fora;
}

describe("guarda #136 — nenhuma soma volta a ser espremida em int4", () => {
  it("test_nenhuma_soma_espremida_em_int4_sem_marcador_em_packages", () => {
    const ofensores: string[] = [];
    for (const arquivo of arquivosTs(RAIZ_PACOTES)) {
      for (const o of ofensoresEm(readFileSync(arquivo, "utf8"))) {
        ofensores.push(`${arquivo.replace(RAIZ_PACOTES, "")}:${o}`);
      }
    }
    expect(ofensores).toEqual([]);
  });

  it("test_a_guarda_pega_as_formas_que_ja_escaparam_dela", () => {
    // Cada caso abaixo é uma forma que a PRIMEIRA versão desta guarda deixou passar. Sem eles, uma
    // regex quebrada devolve lista vazia e o teste acima fica verde para sempre — que foi
    // exatamente o que aconteceu. Um teste de controle que só exercita a forma já corrigida prova
    // que a regex casa o passado, nunca que ela cobre o presente.
    const deveriaPegar = [
      'coalesce(sum(cache_read_tokens), 0)::int AS "cacheReadTokens"', // a que quebrou
      "sum(input_tokens)::int,", // forma nua
      'coalesce(sum(t.total_tokens), 0)::int AS "totalTokens"', // ALIAS de tabela — escapava
      "coalesce(sum(x.qualquer_coisa), 0)::int4 AS n", // ::int4 — escapava
      "coalesce(sum(total_tokens), 0):: int AS t", // espaço no cast — escapava
      "COALESCE(SUM(total_tokens), 0)::INT AS t", // caixa alta — escapava
      "coalesce(sum(reasoning_tokens), 0)::int AS r", // coluna FUTURA, fora de qualquer lista
      "coalesce(sum(total_tokens), 0)::integer AS t", // por extenso — MESMO tipo, mesmo teto
      "coalesce(sum(total_tokens), 0)\n             ::int AS t", // quebra de linha — escapava
    ];
    for (const caso of deveriaPegar) {
      expect(ofensoresEm(caso), `deveria pegar: ${caso}`).toHaveLength(1);
    }
  });

  it("test_a_guarda_nao_dispara_sobre_a_forma_correta_nem_sobre_contagem", () => {
    const naoDeveriaPegar = [
      "coalesce(sum(input_tokens), 0)::double precision AS i",
      "count(*)::int AS n", // contagem de linhas não estoura
      "coalesce(sum(total_tokens), 0)::bigint AS t",
      "sum(input_tokens)::int, -- int4-alvo-ok", // exceção declarada
      // Falso-positivos REAIS que a segunda versão produziu: o cast correto de uma soma, com um
      // `count(*)::int` legítimo mais adiante na mesma consulta.
      'coalesce(sum(cost_usd), 0)::double precision AS cost,\n           count(*)::int AS n',
      "ORDER BY sum(coalesce(s.input_tokens, 0)) DESC, s.model ASC\n  LIMIT $1\n) SELECT count(*)::int",
      // O mesmo falso-positivo COMPACTO. A versão anterior passava por margem (7 caracteres de
      // folga sobre um teto de 40); comprimida, ela teria voltado a acusar código correto.
      "coalesce(sum(cost_usd),0)::double precision c,count(*)::int n",
      "sum(x) DESC,count(*)::int",
    ];
    for (const caso of naoDeveriaPegar) {
      expect(ofensoresEm(caso), `NÃO deveria pegar: ${caso}`).toHaveLength(0);
    }
  });
});
