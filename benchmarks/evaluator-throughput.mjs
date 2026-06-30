#!/usr/bin/env node
/**
 * M36 evaluator-throughput benchmark — measures evals/sec for a rule evaluator and a
 * mocked-judge evaluator (deterministic stub, no live LLM) over N traces, against a
 * real Postgres. Requires THEOLENS_PG_URI. Reports mean ± std over RUNS runs. NO
 * fabricated numbers — every figure is a real timed run.
 *
 *   THEOLENS_PG_URI=… node benchmarks/evaluator-throughput.mjs
 */
import {
  createSpanRepository,
  migrateLatest,
  evaluatorRepoFromPool,
  runEvaluator,
} from "../packages/core/dist/index.js";
import { performance } from "node:perf_hooks";

const URI = process.env.THEOLENS_PG_URI;
if (!URI) {
  console.error("THEOLENS_PG_URI required");
  process.exit(1);
}

const N = 200; // traces per run
const RUNS = 3;
const WS = "bench-ws";

function stats(xs) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { mean, std };
}

async function seed(spanRepo, n) {
  // n single-span traces (root span carries I/O so the judge has something to judge).
  for (let i = 0; i < n; i++) {
    await spanRepo.save(
      [
        {
          spanId: `s${i}`,
          traceId: `t${i}`,
          name: "op",
          startTimeUnixNano: "1700000000000000000",
          endTimeUnixNano: "1700000000100000000",
          statusCode: i % 2 === 0 ? "ERROR" : "OK",
          inputValue: "rome catacombs tour please",
          outputValue: "here is your itinerary",
        },
      ],
      WS,
    );
  }
}

async function main() {
  const { repo: spanRepo, pool } = createSpanRepository(URI);
  await migrateLatest(pool);
  await pool.query("TRUNCATE spans, traces, sessions, evaluators, guards, span_evaluations");
  await seed(spanRepo, N);

  const evalRepo = evaluatorRepoFromPool(pool);
  const ruleEv = await evalRepo.createEvaluator(
    { name: "is_error", kind: "rule", target: "", enabled: true, config: { predicate: "status:error" } },
    WS,
  );
  // A deterministic judge stub — measures engine+DB throughput, not the LLM.
  const stubJudge = { judge: async () => ({ score: 0.9, label: "good" }) };
  const judgeEv = await evalRepo.createEvaluator(
    { name: "judge_quality", kind: "llm_judge", target: "", enabled: true, config: { prompt: "rate", model: "stub" } },
    WS,
  );

  const ruleDeps = { evaluatorRepo: evalRepo, spanRepo, judge: null, backfillMax: 1000 };
  const judgeDeps = { evaluatorRepo: evalRepo, spanRepo, judge: stubJudge, backfillMax: 1000 };

  const ruleRates = [];
  const judgeRates = [];
  for (let r = 0; r < RUNS; r++) {
    let t0 = performance.now();
    const rr = await runEvaluator(ruleEv, { limit: N }, WS, ruleDeps);
    ruleRates.push((rr.written / (performance.now() - t0)) * 1000);

    t0 = performance.now();
    const jr = await runEvaluator(judgeEv, { limit: N }, WS, judgeDeps);
    judgeRates.push((jr.written / (performance.now() - t0)) * 1000);
  }

  const out = {
    N,
    RUNS,
    rule_evals_per_sec: stats(ruleRates),
    judge_evals_per_sec_mocked: stats(judgeRates),
  };
  console.log(JSON.stringify(out, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
