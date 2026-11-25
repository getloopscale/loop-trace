/**
 * O CONTRATO DE PROCESSO do `scripts/run-eval.mjs` — o que o GitHub Actions de fato observa.
 *
 * Encontrado pelo `/review` da M139 (F-test-1, BLOCKER) e é o achado mais importante do ciclo: a
 * prova por mutação original parava em `runEvalDataset()` devolver `hasRegression: true`. Entre
 * esse ponto e o que o CI observa — o **exit code** — havia código não testado: `parseArgs`, a
 * flag `--fail-on-regression`, três caminhos `exit(2)`, e a própria expressão de saída. Trocar
 * `process.exit(hasRegression && args.failOnRegression ? 1 : 0)` por `process.exit(0)` sobrevivia
 * a 1139 de 1139 testes.
 *
 * Um gate cuja prova para uma camada antes da que executa não é um gate provado. Estes testes
 * SPAWNAM o CLI de verdade e asseveram o código de saída.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SHIPPED_DATASET_PATH } from "./eval-dataset.js";

const REPO_ROOT = resolve(__dirname, "../../../../..");
const CLI = resolve(REPO_ROOT, "scripts/run-eval.mjs");

interface RunOut {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: string[], env: Record<string, string | undefined> = {}): RunOut {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Um dataset temporário com um exemplo que DIVERGE do veredito real — regressão de verdade. */
function seededRegressionDataset(): string {
  const dir = mkdtempSync(join(tmpdir(), "lens-eval-"));
  const path = join(dir, "seeded.yaml");
  writeFileSync(
    path,
    `dataset_name: seeded
examples:
  - id: this-must-fail
    splits: [regression]
    evaluator: { kind: rule, name: ev, config: { predicate: 'name:"llm.call"' } }
    span: { spanId: s1, traceId: t1, name: db.query, startTimeUnixNano: "1", endTimeUnixNano: "2" }
    expected: { label: pass }
`,
    "utf8",
  );
  return path;
}

describe("run-eval.mjs — the process contract the CI observes", () => {
  it("exits 0 on the shipped dataset (regression split)", () => {
    const r = runCli(["--splits", "regression", "--fail-on-regression"]);
    expect(r.status).toBe(0);
  });

  /**
   * O TESTE QUE FALTAVA. Sem ele, `process.exit(0)` desarma o gate e a suíte inteira fica verde.
   */
  it("exits 1 on a regression WITH --fail-on-regression", () => {
    const r = runCli(["--dataset", seededRegressionDataset(), "--fail-on-regression"]);
    expect(r.status).toBe(1);
  });

  /** A flag precisa IMPORTAR — sem ela, o mesmo dataset reporta e não bloqueia (uso local). */
  it("exits 0 on the same regression WITHOUT the flag", () => {
    const r = runCli(["--dataset", seededRegressionDataset()]);
    expect(r.status).toBe(0);
  });

  it("emits a ::error annotation naming the failing example", () => {
    const r = runCli(["--dataset", seededRegressionDataset(), "--fail-on-regression"]);
    expect(r.stderr).toMatch(/::error title=eval regression::this-must-fail/);
  });

  it("FAILURE: a missing dataset exits 2 and names the path", () => {
    const r = runCli(["--dataset", "/nao/existe/ali.yaml"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("/nao/existe/ali.yaml");
  });

  it("FAILURE: an unknown argument exits 2 instead of silently changing scope", () => {
    // `--split` por `--splits` é o typo provável, e ignorá-lo rodaria um escopo diferente do
    // pretendido — silenciosamente.
    const r = runCli(["--split", "regression"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown argument/i);
  });

  /**
   * O caminho vacuoso: um split que não casa nada NÃO pode ser lido como "nada regrediu". É o que
   * o CI faria com um typo em `--splits`.
   */
  it("FAILURE: a split matching zero examples exits 2, not 0", () => {
    const r = runCli(["--splits", "regresion", "--fail-on-regression"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no examples matched/i);
  });

  it("works without GITHUB_STEP_SUMMARY (local use) and still prints the table", () => {
    const r = runCli(["--splits", "regression"], { GITHUB_STEP_SUMMARY: undefined });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("| Example | Splits | Result |");
  });

  it("writes the summary table to GITHUB_STEP_SUMMARY when set", () => {
    const dir = mkdtempSync(join(tmpdir(), "lens-sum-"));
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "", "utf8");
    const r = runCli(["--splits", "regression"], { GITHUB_STEP_SUMMARY: summary });
    expect(r.status).toBe(0);
    const written = readFileSync(summary, "utf8");
    expect(written).toContain("## Eval — rule-evaluators");
    // A contagem por split é o que distingue o que gateia do que apenas informa (DoD item 1).
    expect(written).toMatch(/Per split:.*regression 10\/10/);
  });

  /**
   * F-test-12 — o CLI e o teste do dataset shipped derivavam o caminho de formas independentes.
   * Isto pina que apontam para o MESMO arquivo: uma reorganização que conserte um e não o outro
   * deixaria o teste verde sobre um arquivo que o gate já não roda.
   */
  it("the CLI default dataset is the same file the shipped-dataset test reads", () => {
    const fromCli = execFileSync(
      process.execPath,
      ["-e", "import('@looptrace/core').then(m => console.log(m.SHIPPED_DATASET_PATH))"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    ).trim();
    expect(fromCli).toBe(SHIPPED_DATASET_PATH);
    expect(resolve(REPO_ROOT, fromCli)).toBe(resolve(REPO_ROOT, SHIPPED_DATASET_PATH));
  });
});
