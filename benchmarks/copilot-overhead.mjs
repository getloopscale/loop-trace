#!/usr/bin/env node
/**
 * M33 copilot-overhead benchmark — measures the looptrace-side latency of the
 * `POST /v1/traces/:traceId/ask` endpoint (rate-limit check + trace read + prompt
 * assembly + response cap), with a DETERMINISTIC mock chat client so the (provider-
 * bound) LLM round-trip is excluded. Isolates what looptrace adds on top of the LLM.
 * Requires LOOPTRACE_PG_URI. Reports p50/p95/mean±std over RUNS runs. NO fabricated
 * numbers — every figure is a real timed run.
 *
 *   LOOPTRACE_PG_URI=… node benchmarks/copilot-overhead.mjs
 */
import { createSpanRepository, migrateLatest, RateLimiter } from "../packages/core/dist/index.js";
import { createApp } from "../packages/api/dist/server/app.js";
import { performance } from "node:perf_hooks";

const URI = process.env.LOOPTRACE_PG_URI;
if (!URI) {
  console.error("LOOPTRACE_PG_URI required");
  process.exit(1);
}

const N = 200; // ask requests per run
const RUNS = 3;
const WS = "default"; // single-tenant dev collapses to the default workspace

function stats(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { mean, std, p50: pct(50), p95: pct(95) };
}

// A deterministic mock chat — returns instantly, isolating looptrace-side overhead.
const mockChat = { ask: async () => "This step called a tool and returned a result." };

async function seed(spanRepo) {
  await spanRepo.save(
    [
      {
        spanId: "s1",
        traceId: "t1",
        name: "research_agent",
        startTimeUnixNano: "1700000000000000000",
        endTimeUnixNano: "1700000000100000000",
        statusCode: "OK",
        model: "gpt-4o",
        inputValue: "rome catacombs tour please",
        outputValue: "here is your itinerary",
      },
    ],
    WS,
  );
}

async function main() {
  const { repo, pool } = createSpanRepository(URI);
  await migrateLatest(pool);
  await pool.query("TRUNCATE spans, traces, sessions");
  await seed(repo);

  const app = createApp(repo, undefined, {}, undefined, {
    spanRepo: repo,
    chat: mockChat,
    limiter: new RateLimiter(1_000_000), // effectively unthrottled for the measurement
  });

  const ask = () =>
    app.request("http://x/v1/traces/t1/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spanId: "s1", question: "why did this step run?" }),
    });

  // Warm-up (JIT + pool) — not measured.
  for (let i = 0; i < 20; i++) await ask();

  const runP50 = [];
  const runP95 = [];
  const runMean = [];
  for (let r = 0; r < RUNS; r++) {
    const lat = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const res = await ask();
      const dt = performance.now() - t0;
      if (res.status !== 200) {
        console.error(`unexpected status ${res.status}`);
        process.exit(1);
      }
      lat.push(dt);
    }
    const s = stats(lat);
    runP50.push(s.p50);
    runP95.push(s.p95);
    runMean.push(s.mean);
  }

  const out = {
    N,
    RUNS,
    note: "looptrace-side overhead only — mock chat client (LLM latency excluded)",
    latency_ms: {
      p50: stats(runP50),
      p95: stats(runP95),
      mean: stats(runMean),
    },
  };
  console.log(JSON.stringify(out, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
