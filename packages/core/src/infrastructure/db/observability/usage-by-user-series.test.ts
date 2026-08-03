import { describe, expect, it } from "vitest";

import { serieOrdenada } from "./usage-by-user-repository.js";

/**
 * M143 — a ordenação da série, testada em ISOLAMENTO.
 *
 * Existe porque a mutação que removia o `sort` SOBREVIVIA ao teste de integração: o Postgres devolve
 * as linhas já ordenadas para os fixtures, então a ordem de inserção do `Map` calhava de bater, e não
 * há como forçar o banco a desordenar a partir de um teste. Aqui a desordem é o input.
 */
describe("serieOrdenada", () => {
  const acc = (i: number) => ({
    inputTokens: i,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  });

  it("ordena pelo eixo do tempo, mesmo recebendo desordenado", () => {
    const m = new Map([
      ["2026-08-03T00:00:00.000Z", acc(3)],
      ["2026-08-01T00:00:00.000Z", acc(1)],
      ["2026-08-02T00:00:00.000Z", acc(2)],
    ]);
    expect(serieOrdenada(m).map((p) => p.inputTokens)).toEqual([1, 2, 3]);
  });

  it("devolve lista vazia para usuário sem pontos", () => {
    expect(serieOrdenada(undefined)).toEqual([]);
  });

  // `roundUsd` impõe o piso de seis casas; o ponto o respeita tanto quanto a linha (#121).
  it("arredonda o custo do ponto", () => {
    const m = new Map([["2026-08-01T00:00:00.000Z", { ...acc(1), costUsd: 0.12345678901 }]]);
    expect(String(serieOrdenada(m)[0]?.costUsd).split(".")[1]?.length).toBeLessThanOrEqual(6);
  });
});
