/**
 * T2.1 + T2.2 — o runner e a prova de que o gate REPROVA.
 *
 * A semântica de regressão é a do Phoenix
 * (`knowledge-base/references/phoenix/evals/pxi/harness/run_experiment.py:238-259`): falha num
 * exemplo cujo split contém `regression` → regressão; `dev` roda e não gateia. Sem estado, sem
 * baseline (ADR D1) — o `expected` mora no dataset.
 *
 * T2.2 é a parte que importa mais, e vem do loopmem
 * (`loopmem/packages/eval/src/run.test.ts:15-35`): a mutação é SEMEADA DENTRO DO TESTE, então a
 * prova de que o gate reprova roda em toda execução da suíte — para sempre. Uma prova executada uma
 * vez à mão decai para folclore, e o defeito que este milestone existe para impedir (o
 * `dev-version-drift` da M138, verde em todo run sem medir nada) era exatamente um gate que ninguém
 * re-verificava.
 */

import { describe, expect, it } from "vitest";

import { parseEvalDataset, type EvalDataset } from "./eval-dataset.js";
import { RegressionError, runEvalDataset } from "./eval-runner.js";

const SPAN = {
  spanId: "s1",
  traceId: "t1",
  name: "llm.call",
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
};

/** Um exemplo que PASSA: o predicado casa o span, e o expected diz `pass`. */
function passingExample(id: string, splits: string[] = ["regression"]): Record<string, unknown> {
  return {
    id,
    splits,
    evaluator: { kind: "rule", name: "ev", config: { predicate: "name:llm.call" } },
    span: SPAN,
    expected: { label: "pass" },
  };
}

/** Um exemplo que FALHA: o predicado casa, mas o dataset afirma `fail`. */
function failingExample(id: string, splits: string[] = ["regression"]): Record<string, unknown> {
  return { ...passingExample(id, splits), expected: { label: "fail" } };
}

function build(examples: Record<string, unknown>[]): EvalDataset {
  return parseEvalDataset({ dataset_name: "d", examples });
}

describe("runEvalDataset", () => {
  it("reports no regression when every example matches", () => {
    const r = runEvalDataset(build([passingExample("a"), passingExample("b")]));
    expect(r.hasRegression).toBe(false);
    expect(r.results).toHaveLength(2);
  });

  it("reports a regression when a `regression`-split example fails", () => {
    const r = runEvalDataset(build([passingExample("a"), failingExample("bad")]));
    expect(r.hasRegression).toBe(true);
  });

  /**
   * A distinção que dá sentido ao split. Sem ela, `dev` seria decorativo — e um exemplo
   * exploratório derrubaria o publish.
   */
  it("does NOT report a regression when only a `dev`-split example fails", () => {
    const r = runEvalDataset(build([passingExample("a"), failingExample("exploratory", ["dev"])]));
    expect(r.hasRegression).toBe(false);
    expect(r.results.find((x) => x.id === "exploratory")?.passed).toBe(false);
  });

  /** Um gate que diz apenas "falhou" custa uma hora de diagnóstico. */
  it("names the failing example id in the result", () => {
    const r = runEvalDataset(build([passingExample("ok"), failingExample("the-culprit")]));
    const failed = r.results.filter((x) => !x.passed).map((x) => x.id);
    expect(failed).toEqual(["the-culprit"]);
  });

  /** EC-2 / ADR D5 — `expected: { label }` ignora o score que `evaluateRule` também devolve. */
  it("compares only the keys declared in `expected`", () => {
    const onlyLabel = build([passingExample("only-label")]);
    expect(runEvalDataset(onlyLabel).hasRegression).toBe(false);

    const wrongScore = build([
      { ...passingExample("with-score"), expected: { label: "pass", score: 0 } },
    ]);
    expect(runEvalDataset(wrongScore).hasRegression).toBe(true);
  });

  /** EC-4 — `deriveKind` só produz `chain` com `hasChildren` (`evaluator.ts:106,118`). */
  it("forwards hasChildren to evaluateRule", () => {
    const chain = build([
      {
        id: "chain-span",
        splits: ["regression"],
        evaluator: { kind: "rule", name: "ev", config: { predicate: "kind:chain" } },
        span: SPAN,
        hasChildren: true,
        expected: { label: "pass" },
      },
    ]);
    expect(runEvalDataset(chain).hasRegression).toBe(false);
  });

  /**
   * F-test-3 do review — `some` → `every` no filtro SOBREVIVIA a 1139 testes, porque todo exemplo
   * era single-split e para eles os dois operadores são idênticos. Com `every`, um exemplo
   * multi-split é silenciosamente EXCLUÍDO do run gateado, e como os outros exemplos mantêm o run
   * não-vazio, a guarda de run-vazio não dispara. É "um eval que mede menos do que afirma e ainda
   * reporta verde" — exatamente o que este milestone existe para eliminar.
   */
  it("selects a multi-split example under EITHER of its splits (some, not every)", () => {
    const multi = build([
      { ...passingExample("in-both"), splits: ["regression", "dev"] },
      passingExample("only-regression"),
    ]);
    expect(runEvalDataset(multi, { splits: ["regression"] }).results.map((r) => r.id)).toEqual([
      "in-both",
      "only-regression",
    ]);
    expect(runEvalDataset(multi, { splits: ["dev"] }).results.map((r) => r.id)).toEqual(["in-both"]);
  });

  /** O diagnóstico que o operador lê — não só o booleano (F-test-8). */
  it("reports counts and a mismatch string that names field, expected and got", () => {
    const r = runEvalDataset(build([passingExample("ok"), failingExample("bad")]));
    expect(r.counts).toEqual({ total: 2, passed: 1, failed: 1 });
    expect(r.results.find((x) => x.id === "bad")?.mismatch).toMatch(
      /label: expected "fail", got "pass"/,
    );
  });

  it("filters by split when `splits` is given", () => {
    const d = build([failingExample("dev-only", ["dev"]), passingExample("reg")]);
    const r = runEvalDataset(d, { splits: ["regression"] });
    expect(r.results).toHaveLength(1);
    expect(r.results[0]?.id).toBe("reg");
  });
});

describe("the gate actually fails — seeded mutation and fail-closed (T2.2)", () => {
  /**
   * A MUTAÇÃO SEMEADA. Degrada um evaluator do dataset — inverte o `passLabel`, exatamente o tipo de
   * regressão que uma refatoração descuidada introduz — e exige que o gate reprove. Se alguém
   * enfraquecer `runEvalDataset` no futuro, ESTE teste fica vermelho.
   */
  it("a seeded regression makes the gate fail", () => {
    const clean = build([passingExample("seed-me")]);
    expect(runEvalDataset(clean).hasRegression).toBe(false);

    const seeded = structuredClone(clean) as EvalDataset;
    seeded.examples[0]!.evaluator.passLabel = "REGRESSED";

    expect(runEvalDataset(seeded).hasRegression).toBe(true);
  });

  /**
   * Um dataset vazio NÃO pode ser lido como "nada regrediu" — é a leitura mais perigosa possível,
   * porque é indistinguível de sucesso. O schema já barra na carga; o runner barra de novo, porque
   * ele é chamável direto e não deve confiar que alguém validou antes.
   */
  it("FAILURE: an empty dataset fails closed instead of passing vacuously", () => {
    expect(() => runEvalDataset({ dataset_name: "d", examples: [] } as unknown as EvalDataset)).toThrow(
      RegressionError,
    );
  });

  /**
   * Um `kind` fora de `EVALUATOR_KINDS` não pode ser ignorado em silêncio — seria um exemplo que
   * não roda e ainda assim conta como coberto.
   */
  /** F-test-4 — a terceira falha estrutural, a única cujo modo é um verde silencioso. */
  it("FAILURE: an empty `expected` fails closed instead of counting as passed", () => {
    const vacuous = {
      dataset_name: "d",
      examples: [{ ...passingExample("asserts-nothing"), expected: {} }],
    } as unknown as EvalDataset;
    expect(() => runEvalDataset(vacuous)).toThrow(RegressionError);
    expect(() => runEvalDataset(vacuous)).toThrow(/asserts nothing/i);
  });

  /** F-test-5 — o branch que o CI atinge com um typo em `--splits`. */
  it("FAILURE: a split matching zero examples fails closed", () => {
    const d = build([passingExample("reg")]);
    expect(() => runEvalDataset(d, { splits: ["dev"] })).toThrow(/no examples matched/i);
  });

  it("FAILURE: an unknown evaluator kind fails closed instead of being skipped", () => {
    const alien = {
      dataset_name: "d",
      examples: [{ ...passingExample("alien"), evaluator: { kind: "llm_judge", name: "j", config: {} } }],
    } as unknown as EvalDataset;
    // Conjuntivo, não alternado (F-test-9): o `|llm_judge` original era satisfeito por QUALQUER
    // erro cuja mensagem contivesse a string — inclusive um erro de zod — então o teste passaria
    // com a guarda fail-closed deletada.
    expect(() => runEvalDataset(alien)).toThrow(RegressionError);
    expect(() => runEvalDataset(alien)).toThrow(/unsupported evaluator kind/i);
  });
});
