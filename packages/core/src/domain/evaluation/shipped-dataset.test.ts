/**
 * T1.2 — o dataset SHIPPED, não uma fixture.
 *
 * EC-5 do edge-case review: um teste de schema que só valida fixtures passa alegremente enquanto o
 * arquivo que de fato roda no CI está quebrado. Estas asserções abrem `evals/rule-evaluators.yaml`
 * literalmente.
 *
 * Este é o único teste do domínio que toca disco, e é deliberado: o objeto do teste É o arquivo.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { parseEvalDataset, SHIPPED_DATASET_PATH } from "./eval-dataset.js";
import { runEvalDataset } from "./eval-runner.js";

// O caminho vem do domínio, não de um segundo encoding aqui (review F-arch-3). O climb de
// `__dirname` até a raiz do repo permanece, mas o NOME do arquivo é declarado uma vez só.
const REPO_ROOT = resolve(__dirname, "../../../../..");
const DATASET_PATH = resolve(REPO_ROOT, SHIPPED_DATASET_PATH);

function loadShipped(): ReturnType<typeof parseEvalDataset> {
  return parseEvalDataset(parse(readFileSync(DATASET_PATH, "utf8")));
}

describe("evals/rule-evaluators.yaml (shipped)", () => {
  it("parses against the real schema", () => {
    expect(() => loadShipped()).not.toThrow();
  });

  /**
   * GUARDA DA GUARDA (F-test-11). Três checagens abaixo têm forma `expect(lista).toEqual([])` e
   * passam se o predicado for enfraquecido a ponto de nunca casar — não distinguem "o dataset está
   * limpo" de "a checagem quebrou". O `publish-gate.test.ts` reconheceu essa vacuidade e a guardou;
   * aqui faltava. Estes dois controles fecham: o parse não pode devolver zero exemplos, e o regex
   * de id precisa REJEITAR um id sabidamente ruim.
   */
  it("the checks below cannot be vacuous", () => {
    expect(loadShipped().examples.length).toBeGreaterThanOrEqual(8);
    expect(/^[a-z0-9]+(-[a-z0-9]+)*$/.test("Bad_Id")).toBe(false);
  });

  it("has both splits — regression gates, dev does not", () => {
    const splits = new Set(loadShipped().examples.flatMap((e) => e.splits));
    expect(splits.has("regression")).toBe(true);
    expect(splits.has("dev")).toBe(true);
  });

  /**
   * Um suíte só com casos positivos não distingue "o predicado casa o que deve" de "o predicado
   * casa tudo" (`rules/testing.md` § 4.1).
   */
  it("has at least two negative cases IN THE GATING SPLIT", () => {
    // ESTRUTURAL, não por grafia (F-test-10). A versão anterior listava os labels de hoje
    // ("fail", "rejected"), então um negativo futuro com `failLabel: denied` seria invisível ao
    // contador. E não exigia `regression`: mover todos os negativos para `dev` deixaria o teste
    // certificando uma cobertura negativa que já não gateia nada.
    const negatives = loadShipped().examples.filter(
      (e) =>
        e.splits.includes("regression") &&
        (e.expected.label === (e.evaluator.failLabel ?? "fail") || e.expected.score === 0),
    );
    expect(negatives.length).toBeGreaterThanOrEqual(2);
  });

  it("every example declares why it exists", () => {
    const missing = loadShipped()
      .examples.filter((e) => typeof e.metadata?.["notes"] !== "string")
      .map((e) => e.id);
    expect(missing).toEqual([]);
  });

  /** Ids são o que aparece no relatório de falha; um uuid ali não ajuda ninguém. */
  it("every example id is human-readable kebab-case", () => {
    const bad = loadShipped()
      .examples.map((e) => e.id)
      .filter((id) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id));
    expect(bad).toEqual([]);
  });

  /**
   * O dataset shipped precisa PASSAR contra o código atual — senão o gate nasce vermelho e a
   * primeira ação de quem o encontra é desligá-lo.
   */
  it("passes cleanly against the current implementation", () => {
    const result = runEvalDataset(loadShipped());
    const failures = result.results.filter((r) => !r.passed).map((r) => `${r.id}: ${r.mismatch ?? "?"}`);
    expect(failures).toEqual([]);
    expect(result.hasRegression).toBe(false);
  });

  it("has enough regression-split examples to be worth gating on", () => {
    const regression = loadShipped().examples.filter((e) => e.splits.includes("regression"));
    expect(regression.length).toBeGreaterThanOrEqual(8);
  });
});
