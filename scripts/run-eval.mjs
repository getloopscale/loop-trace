#!/usr/bin/env node
/**
 * M139 — CLI do eval. A ÚNICA camada com I/O (ADR D3): lê o dataset do disco, delega ao domínio
 * puro (`@looptrace/core`) e escreve o relatório.
 *
 * A forma vem do Phoenix (`knowledge-base/references/phoenix/.github/workflows/pxi-evals.yml`):
 * uma tabela no `GITHUB_STEP_SUMMARY` e `--fail-on-regression` decidindo o exit code
 * (`harness/run_experiment.py:457`: `return 1 if has_regressions and config.fail_on_regression
 * else 0`).
 *
 * Uso:
 *   node scripts/run-eval.mjs [--dataset PATH] [--splits regression,dev] [--fail-on-regression]
 */

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";

import { parseEvalDataset, runEvalDataset, SHIPPED_DATASET_PATH } from "@looptrace/core";

// O caminho é declarado no domínio (SHIPPED_DATASET_PATH), não aqui — ver eval-dataset.ts.
const DEFAULT_DATASET = SHIPPED_DATASET_PATH;

function parseArgs(argv) {
  const args = { dataset: DEFAULT_DATASET, splits: undefined, failOnRegression: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fail-on-regression") args.failOnRegression = true;
    else if (arg === "--dataset") args.dataset = argv[++i];
    else if (arg === "--splits") args.splits = argv[++i]?.split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: run-eval.mjs [--dataset PATH] [--splits a,b] [--fail-on-regression]");
      process.exit(0);
    } else {
      // Fail-closed: um argumento desconhecido é quase sempre um typo (`--split` por `--splits`),
      // e ignorá-lo faria o eval rodar com escopo diferente do pretendido — silenciosamente.
      console.error(`run-eval: unknown argument "${arg}"`);
      process.exit(2);
    }
  }
  return args;
}

/** O summary é onde um SKIP ou um resultado fica VISÍVEL para quem lê o CI. Sem ele, verde é mudo. */
function report(lines) {
  const target = process.env["GITHUB_STEP_SUMMARY"];
  const text = `${lines.join("\n")}\n`;
  // Sem a env (uso local) escreve em stdout em vez de quebrar — rodar o eval na máquina é o
  // caminho normal de quem está adicionando um exemplo.
  if (target) appendFileSync(target, text, "utf8");
  process.stdout.write(text);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const path = resolve(process.cwd(), args.dataset);

  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // A mensagem NOMEIA o caminho. Um `ENOENT` cru manda o leitor procurar onde o processo estava.
    console.error(`run-eval: cannot read dataset at ${path}\n  ${err.message}`);
    process.exit(2);
  }

  let dataset;
  try {
    dataset = parseEvalDataset(parse(raw));
  } catch (err) {
    console.error(`run-eval: ${err.message}`);
    process.exit(2);
  }

  let result;
  try {
    result = runEvalDataset(dataset, args.splits ? { splits: args.splits } : {});
  } catch (err) {
    // `RegressionError` aqui é falha ESTRUTURAL (dataset vazio, kind não suportado) — nunca deve
    // ser confundida com "nada regrediu".
    console.error(`run-eval: ${err.message}`);
    process.exit(2);
  }

  const { counts, results, hasRegression } = result;
  const scope = args.splits ? args.splits.join(", ") : "all splits";

  // Contagem POR SPLIT, não só o agregado: o DoD pede "o runner reporta a contagem por split", e a
  // distinção é o que dá sentido aos splits — ver 10 em `regression` e 1 em `dev` diz o que gateia
  // e o que apenas informa. Um "11/11 passed" agregado esconde exatamente essa informação.
  const perSplit = new Map();
  for (const r of results) {
    for (const sp of r.splits) {
      const acc = perSplit.get(sp) ?? { total: 0, passed: 0 };
      perSplit.set(sp, { total: acc.total + 1, passed: acc.passed + (r.passed ? 1 : 0) });
    }
  }
  const splitLine = [...perSplit.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sp, c]) => `${sp} ${c.passed}/${c.total}`)
    .join(" · ");

  const lines = [
    `## Eval — ${dataset.dataset_name}`,
    "",
    `Scope: \`${scope}\` · ${counts.passed}/${counts.total} passed`,
    `Per split: ${splitLine}`,
    "",
    "| Example | Splits | Result |",
    "| --- | --- | --- |",
    ...results.map(
      (r) =>
        `| \`${r.id}\` | ${r.splits.join(", ")} | ${r.passed ? "✅" : `❌ ${r.mismatch ?? "mismatch"}`} |`,
    ),
  ];

  if (hasRegression) {
    lines.push("", "> **REGRESSION** — an example in the `regression` split failed.");
  }
  report(lines);

  if (hasRegression) {
    for (const r of results.filter((x) => !x.passed && x.splits.includes("regression"))) {
      console.error(`::error title=eval regression::${r.id}: ${r.mismatch ?? "mismatch"}`);
    }
  }

  // Sem a flag, uma regressão é reportada e não bloqueia — é o que permite rodar o eval
  // localmente para inspecionar sem que o processo saia diferente de zero.
  process.exit(hasRegression && args.failOnRegression ? 1 : 0);
}

main();
