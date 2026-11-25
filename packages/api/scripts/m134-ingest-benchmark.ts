/**
 * M134 benchmark — what does auto-evaluation cost the ingest path?
 *
 * The milestone's goal states `POST /v1/traces` p99 must be unchanged. This
 * measures exactly that, in one process, against a stub repository.
 *
 * Why a stub and not a real database: the question is what the HOOK costs, not
 * what Postgres costs. Running against a real DB would put ~1ms of query noise
 * on every sample and drown the signal we are actually trying to bound. The
 * end-to-end behaviour is proven separately by the integration suite.
 *
 * Three arms, same process, interleaved to cancel drift:
 *   OFF   — no hook configured (the pre-M134 code path exactly)
 *   FAST  — hook configured, enqueue resolves immediately
 *   SLOW  — hook configured, enqueue takes 50ms
 *
 * SLOW is the one that matters. Per ADR D5 the enqueue is fire-and-forget, so a
 * slow eval side must NOT appear in ingest latency. If SLOW ≈ OFF, the
 * decoupling is real. If SLOW tracks the enqueue delay, D5 is not implemented —
 * whatever the unit tests say.
 *
 * Run: pnpm tsx packages/api/scripts/m134-ingest-benchmark.ts
 */
import type { SpanRepository } from "@looptrace/core";

import { createApp } from "../src/server/app.js";

const WARMUP = 300;
const SAMPLES = 3_000;

const ENVELOPE = JSON.stringify({
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: Array.from({ length: 10 }, (_, i) => ({
            traceId: "bench-trace",
            spanId: `s${i}`,
            name: "chat",
            startTimeUnixNano: "1700000000000000000",
            endTimeUnixNano: "1700000000100000000",
          })),
        },
      ],
    },
  ],
});

function stubRepo(): SpanRepository {
  return {
    save: async () => {},
    listTraces: async () => [],
  } as unknown as SpanRepository;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

async function measure(
  app: ReturnType<typeof createApp>,
  n: number,
): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    await app.request("http://x/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ENVELOPE,
    });
    samples.push(performance.now() - t0);
  }
  return samples;
}

function build(enqueue?: () => Promise<void>): ReturnType<typeof createApp> {
  const ingest =
    enqueue === undefined ? undefined : { enqueueAutoEval: async () => enqueue() };
  return createApp(
    stubRepo(),
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    ingest,
  );
}

const arms = {
  OFF: build(),
  FAST: build(async () => {}),
  SLOW: build(async () => {
    await new Promise((r) => setTimeout(r, 50));
  }),
} as const;

type Arm = keyof typeof arms;
const names = Object.keys(arms) as Arm[];

// Warm up every arm before measuring — JIT and the first-request path would
// otherwise land entirely on whichever arm ran first.
for (const name of names) await measure(arms[name], WARMUP);

// Interleave rounds so any drift (GC, thermal, other load) hits all arms
// equally rather than penalising the one that happens to run last.
const collected: Record<Arm, number[]> = { OFF: [], FAST: [], SLOW: [] };
const ROUNDS = 10;
for (let r = 0; r < ROUNDS; r += 1) {
  for (const name of names) {
    collected[name].push(...(await measure(arms[name], SAMPLES / ROUNDS)));
  }
}

const rows = names.map((name) => {
  const s = [...collected[name]].sort((a, b) => a - b);
  return {
    arm: name,
    n: s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1]!,
  };
});

const base = rows.find((r) => r.arm === "OFF")!;
const fmt = (x: number) => x.toFixed(3).padStart(8);

console.log("\nM134 — POST /v1/traces latency (ms), stub repo, same process");
console.log(`samples/arm=${SAMPLES}  warmup=${WARMUP}  rounds=${ROUNDS} (interleaved)\n`);
console.log("arm        p50      p95      p99      max     Δp99 vs OFF");
console.log("-".repeat(64));
for (const r of rows) {
  const d = r.p99 - base.p99;
  const pct = base.p99 > 0 ? (d / base.p99) * 100 : 0;
  const delta = r.arm === "OFF" ? "     —" : `${d >= 0 ? "+" : ""}${d.toFixed(3)}ms (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`;
  console.log(
    `${r.arm.padEnd(6)}${fmt(r.p50)} ${fmt(r.p95)} ${fmt(r.p99)} ${fmt(r.max)}   ${delta}`,
  );
}

const slow = rows.find((r) => r.arm === "SLOW")!;
console.log(
  `\nDecoupling check (ADR D5): a 50ms enqueue adds ${(slow.p99 - base.p99).toFixed(3)}ms to ingest p99.`,
);
console.log(
  slow.p99 < base.p99 + 5
    ? "  PASS — the enqueue is genuinely off the response path.\n"
    : "  FAIL — enqueue latency is leaking into ingest; D5 is not implemented.\n",
);
