/**
 * M139 — executa o dataset de eval e decide se houve regressão.
 *
 * Domínio PURO (`rules/architecture.md` § 1): recebe o dataset já parseado, não toca disco. Isso é
 * o que o torna testável sem fixture em arquivo — e o que permite ao CLI ser a única camada com I/O.
 *
 * SEM ESTADO (ADR D1). A semântica vem do Phoenix
 * (`knowledge-base/references/phoenix/evals/pxi/harness/run_experiment.py:238-259`): um evaluator
 * que falha num exemplo cujo split contém `regression` é uma regressão; `dev` roda e não gateia.
 * Não há baseline porque não é preciso: o `expected` mora no dataset e `evaluateRule` é
 * determinístico. O theo-memory precisa de baseline com banda de tolerância porque as métricas dele
 * são contínuas e vêm de um LLM (`theo-memory/packages/eval/src/regression.ts:3-4`) — propriedade
 * que não temos aqui.
 */

import type { EvalDataset, EvalExample, EvalSplit } from "./eval-dataset.js";
import { evaluateRule, evaluatorSchema, type Verdict } from "./evaluator.js";

/** Falha estrutural do harness — distinta de "um exemplo não passou", que é um resultado. */
export class RegressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegressionError";
  }
}

/** O que o dataset declara — subconjunto de `Verdict`, comparado por chave presente (ADR D5). */
export type ExpectedVerdict = { score?: number | undefined; label?: string | undefined };

export interface ExampleResult {
  readonly id: string;
  readonly splits: readonly EvalSplit[];
  readonly passed: boolean;
  readonly expected: ExpectedVerdict;
  readonly actual: Verdict;
  /** Presente só quando `passed` é false — o que exatamente divergiu. */
  readonly mismatch?: string;
}

export interface EvalRunResult {
  readonly results: readonly ExampleResult[];
  readonly hasRegression: boolean;
  readonly counts: { readonly total: number; readonly passed: number; readonly failed: number };
}

export interface EvalRunOptions {
  /** Quando dado, só exemplos que carreguem ao menos um destes splits rodam. */
  readonly splits?: readonly EvalSplit[];
}

/**
 * Compara APENAS as chaves declaradas em `expected` (ADR D5). `evaluateRule` sempre devolve `score`
 * e `label`; exigir os dois em todo exemplo transformaria o dataset num formulário, e formulário
 * longo é preenchido por copy-paste. Devolve `null` quando bate, ou a descrição da divergência.
 */
function diff(expected: ExpectedVerdict, actual: Verdict): string | null {
  const problems: string[] = [];
  if (expected.score !== undefined && actual.score !== expected.score) {
    problems.push(`score: expected ${expected.score}, got ${String(actual.score)}`);
  }
  if (expected.label !== undefined && actual.label !== expected.label) {
    problems.push(`label: expected "${expected.label}", got "${String(actual.label)}"`);
  }
  return problems.length > 0 ? problems.join("; ") : null;
}

function runOne(example: EvalExample): ExampleResult {
  // Fail-closed: um kind não suportado NÃO pode ser pulado em silêncio — seria um exemplo que não
  // roda e ainda assim conta como coberto. O schema já barra na carga; aqui vale para quem chame
  // o runner direto.
  const kind = example.evaluator.kind;
  if (kind !== "rule") {
    throw new RegressionError(
      `unsupported evaluator kind "${String(kind)}" in example "${example.id}" — the free tier only gates deterministic \`rule\` evaluators`,
    );
  }

  // `evaluateRule` recebe o tipo COMPLETO de `Evaluator`, que carrega campos do motor de execução
  // (`filter`, `target`, `enabled`, `autoEnabled`, `sampling`) que ele próprio não lê. Exigi-los no
  // dataset seria pedir ao autor do exemplo cinco campos irrelevantes para o que está sendo testado.
  //
  // Os defaults vêm de `evaluatorSchema`, NÃO escritos à mão aqui. A primeira versão os duplicava e
  // já havia DIVERGIDO num deles — `target: "span"` contra o `default("")` de `evaluator.ts:56`.
  // Quatro dos cinco eram cópia fiel; o quinto, não. Uma segunda fonte de verdade sobre "como é um
  // evaluator por default" é exatamente o que um harness de fidelidade não pode ter: o gate existe
  // para reproduzir a produção, e reproduzi-la de memória derrota o propósito. Reusar o schema é
  // à prova de drift por construção — e menos código.
  const evaluator = evaluatorSchema.parse(example.evaluator);
  if (evaluator.kind !== "rule") {
    throw new RegressionError(`example "${example.id}" is not a rule evaluator after parsing`);
  }

  // F-test-4 do review. O schema já recusa `expected: {}` (eval-dataset.ts), mas o runner é
  // chamável direto — e das três falhas estruturais ele guardava duas (dataset vazio, kind
  // desconhecido) e deixava a terceira passar. A assimetria importa porque esta é a única cujo
  // modo de falha é um VERDE silencioso: `diff()` sobre um expected sem chaves não encontra
  // problema algum, o exemplo é contado como `passed`, e um exemplo que não afirma nada entra na
  // contagem de cobertura.
  if (Object.keys(example.expected).length === 0) {
    throw new RegressionError(
      `example "${example.id}" declares an empty \`expected\` — it asserts nothing and would count as passed`,
    );
  }

  const actual = evaluateRule(evaluator, example.span, example.hasChildren);
  const mismatch = diff(example.expected, actual);
  return {
    id: example.id,
    splits: example.splits,
    passed: mismatch === null,
    expected: example.expected,
    actual,
    ...(mismatch !== null ? { mismatch } : {}),
  };
}

/**
 * Roda o dataset. Lança `RegressionError` em falha ESTRUTURAL (dataset vazio, kind não suportado);
 * um exemplo que não passa é um `ExampleResult` com `passed: false`, não uma exceção.
 */
export function runEvalDataset(dataset: EvalDataset, options: EvalRunOptions = {}): EvalRunResult {
  const wanted = options.splits;
  const selected = wanted
    ? dataset.examples.filter((ex) => ex.splits.some((s) => wanted.includes(s)))
    : dataset.examples;

  // Um dataset vazio lido como "nada regrediu" é a leitura mais perigosa possível: indistinguível
  // de sucesso. Falha fechado.
  if (selected.length === 0) {
    throw new RegressionError(
      wanted
        ? `no examples matched splits [${wanted.join(", ")}] — refusing to report success over an empty run`
        : "dataset has no examples — refusing to report success over an empty run",
    );
  }

  const results = selected.map(runOne);
  const failed = results.filter((r) => !r.passed);

  // A regressão é decidida SÓ pelo split `regression` (Phoenix `run_experiment.py:256`). Uma falha
  // em `dev` é informação, não bloqueio — sem isso o split seria decorativo.
  const hasRegression = failed.some((r) => r.splits.includes("regression"));

  return {
    results,
    hasRegression,
    counts: { total: results.length, passed: results.length - failed.length, failed: failed.length },
  };
}
