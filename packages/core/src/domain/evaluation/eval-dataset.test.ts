/**
 * T1.1 — schema do dataset de eval. Valida na CARGA, não no meio da execução.
 *
 * O Phoenix valida com pydantic no ponto de entrada
 * (`knowledge-base/references/phoenix/evals/pxi/harness/datasets.py:7-38`), com mensagens que
 * nomeiam o campo. A razão é a mesma que vale aqui: um dataset que parseia PARCIALMENTE produz um
 * eval que mede menos do que diz medir e ainda reporta verde — a mesma classe de falha silenciosa
 * que o M139 existe para eliminar.
 */

import { describe, expect, it } from "vitest";

import { parseEvalDataset } from "./eval-dataset.js";

/** Um span mínimo válido — os 5 campos que `spanSchema` exige. */
const SPAN = {
  spanId: "s1",
  traceId: "t1",
  name: "llm.call",
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
};

function dataset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dataset_name: "rule-evaluators",
    description: "d",
    examples: [
      {
        id: "matches-name",
        splits: ["regression"],
        evaluator: { kind: "rule", name: "ev", config: { predicate: "name:llm.call" } },
        span: SPAN,
        expected: { label: "pass" },
      },
    ],
    ...overrides,
  };
}

describe("parseEvalDataset", () => {
  it("accepts a minimal valid dataset", () => {
    const parsed = parseEvalDataset(dataset());
    expect(parsed.examples).toHaveLength(1);
    expect(parsed.examples[0]?.id).toBe("matches-name");
  });

  it("rejects a dataset without a name, naming the field", () => {
    expect(() => parseEvalDataset(dataset({ dataset_name: "" }))).toThrow(/dataset_name/);
  });

  it("rejects an example without `expected`, naming the example id", () => {
    const d = dataset();
    delete (d["examples"] as Record<string, unknown>[])[0]!["expected"];
    expect(() => parseEvalDataset(d)).toThrow(/matches-name/);
  });

  /**
   * F-test-5 do review — a lente NEGATIVA da arity de `splits`, que faltava. O enum tinha teste
   * ("rejects an unknown split"); a cardinalidade não. Remover o `.min(1)` sobrevivia a 1139
   * testes, e o efeito é o pior tipo de relatório: um exemplo com `splits: []` FALHA, imprime ❌
   * no summary do CI, e o processo sai 0. Uma linha vermelha num run verde.
   */
  it("rejects an example with an empty splits array", () => {
    const d = dataset();
    (d["examples"] as Record<string, unknown>[])[0]!["splits"] = [];
    expect(() => parseEvalDataset(d)).toThrow(/at least one split/i);
  });

  /**
   * F-test-6 — os quatro `.strict()` carregam peso real e nenhum estava pinado. O caso que
   * importa: `expected: { label: "pass", scoer: 0 }` seria SILENCIOSAMENTE reduzido a
   * `{ label: "pass" }`, e o autor acreditaria estar afirmando dois eixos quando afirma um.
   * Sub-medição reportada como verde — a mesma classe do EC-1/EC-3, que têm teste.
   */
  it.each([
    ["expected", (d: Record<string, unknown>) => { ((d["examples"] as Record<string, unknown>[])[0]!["expected"] as Record<string, unknown>)["scoer"] = 0; }],
    ["example", (d: Record<string, unknown>) => { (d["examples"] as Record<string, unknown>[])[0]!["haschildren"] = true; }],
    ["evaluator", (d: Record<string, unknown>) => { ((d["examples"] as Record<string, unknown>[])[0]!["evaluator"] as Record<string, unknown>)["kindd"] = "rule"; }],
    ["dataset", (d: Record<string, unknown>) => { d["datasetName"] = "x"; }],
  ])("rejects an unrecognised key on the %s schema", (_where, mutate) => {
    const d = dataset();
    mutate(d);
    expect(() => parseEvalDataset(d)).toThrow(/unrecognized|unrecognised/i);
  });

  it("rejects an unknown split", () => {
    const d = dataset();
    (d["examples"] as Record<string, unknown>[])[0]!["splits"] = ["staging"];
    expect(() => parseEvalDataset(d)).toThrow(/split/i);
  });

  /**
   * Ids duplicados fazem dois exemplos colidirem e a contagem por split mentir — o relatório diria
   * "8 exemplos em regression" com 7 distintos.
   */
  it("rejects duplicate example ids", () => {
    const d = dataset();
    const first = (d["examples"] as Record<string, unknown>[])[0]!;
    (d["examples"] as Record<string, unknown>[]).push({ ...first });
    expect(() => parseEvalDataset(d)).toThrow(/duplicate|matches-name/i);
  });

  /**
   * EC-1 do edge-case review. `validatePredicate("")` retorna `null` — string vazia é match-all
   * EXPLÍCITO no produto (`evaluator.ts:42`: "empty string = match-all, see EC-1"). Num dataset
   * isso é veneno: o exemplo casa TODO span e passa por acidente, e o gate reporta cobertura de um
   * predicado que nunca foi exercido. O match-all segue legítimo na API; o dataset é que o recusa.
   */
  it("rejects an empty predicate, explaining that it would match every span", () => {
    const d = dataset();
    const ex = (d["examples"] as Record<string, unknown>[])[0]!;
    (ex["evaluator"] as Record<string, unknown>)["config"] = { predicate: "" };
    expect(() => parseEvalDataset(d)).toThrow(/every span|match-all|vazio/i);
  });

  /**
   * EC-3 — irmão do EC-1 com gatilho diferente: predicado NÃO-vazio que parseia para zero
   * cláusulas também casa todo span. `validatePredicate` já devolve a mensagem certa
   * (`evaluator.ts:158-160`); o dataset precisa propagá-la em vez de um erro genérico.
   */
  it("rejects a non-empty predicate that parses to zero clauses", () => {
    const d = dataset();
    const ex = (d["examples"] as Record<string, unknown>[])[0]!;
    (ex["evaluator"] as Record<string, unknown>)["config"] = { predicate: "%%%" };
    expect(() => parseEvalDataset(d)).toThrow(/zero valid clauses|every span/i);
  });

  /** EC-2 / ADR D5 — um exemplo precisa afirmar ao menos uma coisa. */
  it("rejects `expected` with no keys", () => {
    const d = dataset();
    (d["examples"] as Record<string, unknown>[])[0]!["expected"] = {};
    expect(() => parseEvalDataset(d)).toThrow(/expected/i);
  });

  /**
   * EC-4 — `deriveKind` só classifica `chain` quando `hasChildren` é true (`evaluator.ts:106,118`).
   * Sem poder declará-lo, um predicado sobre `kind:"chain"` é INEXPRIMÍVEL no dataset.
   */
  it("accepts an optional hasChildren flag on an example", () => {
    const d = dataset();
    (d["examples"] as Record<string, unknown>[])[0]!["hasChildren"] = true;
    expect(parseEvalDataset(d).examples[0]?.hasChildren).toBe(true);
  });

  it("defaults hasChildren to false when absent", () => {
    expect(parseEvalDataset(dataset()).examples[0]?.hasChildren).toBe(false);
  });

  /** Um dataset sem exemplo algum não pode ser lido como "nada regrediu". */
  it("rejects a dataset with zero examples", () => {
    expect(() => parseEvalDataset(dataset({ examples: [] }))).toThrow(/at least one|examples/i);
  });
});
