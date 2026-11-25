#!/usr/bin/env node
/**
 * M22 auth-overhead benchmark — measures the per-request latency the multi-tenant
 * auth path adds (bearerAuth + requireScopeOnPrincipal + the SHA-256 `looptrace_api_keys`
 * lookup) vs single-tenant (no verifier, DEFAULT_PRINCIPAL), on the read + ingest
 * hot paths. Requires LOOPTRACE_PG_URI (a real Postgres). Run from packages/api so
 * the workspace deps resolve:
 *   LOOPTRACE_PG_URI=… node ../../benchmarks/auth-overhead.mjs   (or via the repo root with the script path)
 *
 * Reports p50/p95 + mean ± std dev over N iterations × 3 runs. NO fabricated
 * numbers — every figure comes from a real timed request against a real DB.
 */
import { createApp } from "../packages/api/dist/server/app.js";
import { ApiKeyAuthVerifier } from "../packages/api/dist/server/auth/api-key-verifier.js";
import { createSpanRepository, migrateLatest } from "../packages/core/dist/index.js";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

const URI = process.env.LOOPTRACE_PG_URI;
if (!URI) {
  console.error("LOOPTRACE_PG_URI required");
  process.exit(1);
}

const N = 500; // requests per run
const RUNS = 3;

function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
  const variance =
    samples.reduce((s, x) => s + (x - mean) ** 2, 0) / samples.length;
  return {
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    mean,
    std: Math.sqrt(variance),
  };
}

const OTLP = JSON.stringify({
  resourceSpans: [{ scopeSpans: [{ spans: [] }] }],
});

async function timeRequests(app, makeReq, n) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const res = await app.request(makeReq());
    const t1 = performance.now();
    if (res.status >= 500) throw new Error(`unexpected ${res.status}`);
    samples.push(t1 - t0);
  }
  return stats(samples);
}

async function main() {
  const { repo, pool } = createSpanRepository(URI);
  await migrateLatest(pool);

  // Seed a real per-tenant key in looptrace_api_keys for the authed app.
  const secret = "looptrace_live_" + randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(secret).digest("hex");
  const id = "apk-" + randomBytes(8).toString("hex");
  await pool.query(
    `INSERT INTO workspaces (id, name) VALUES ('bench-ws','bench-ws') ON CONFLICT DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO looptrace_api_keys (id, subject, tenant_id, workspace_id, key_name, key_hash, key_prefix, scopes)
     VALUES ($1,'bench','self','bench-ws','bench',$2,$3,$4::jsonb)`,
    [id, hash, secret.slice(0, 12), JSON.stringify(["lens:read", "lens:write"])],
  );

  const authed = createApp(repo, undefined, {
    pool,
    verifier: new ApiKeyAuthVerifier(pool),
    requireCredential: true,
  });
  const single = createApp(repo); // no verifier → single-tenant default principal

  const readAuthed = () =>
    new Request("http://x/v1/traces", { headers: { authorization: `Bearer ${secret}` } });
  const readSingle = () => new Request("http://x/v1/traces");
  const ingestAuthed = () =>
    new Request("http://x/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: OTLP,
    });
  const ingestSingle = () =>
    new Request("http://x/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: OTLP,
    });

  const results = {};
  for (const [label, app, makeReq] of [
    ["read_single_tenant", single, readSingle],
    ["read_multi_tenant", authed, readAuthed],
    ["ingest_single_tenant", single, ingestSingle],
    ["ingest_multi_tenant", authed, ingestAuthed],
  ]) {
    await timeRequests(app, makeReq, 50); // warmup
    const runs = [];
    for (let r = 0; r < RUNS; r++) runs.push(await timeRequests(app, makeReq, N));
    results[label] = {
      p50: avg(runs.map((s) => s.p50)),
      p95: avg(runs.map((s) => s.p95)),
      mean: avg(runs.map((s) => s.mean)),
      std: avg(runs.map((s) => s.std)),
    };
  }

  function avg(xs) {
    return xs.reduce((s, x) => s + x, 0) / xs.length;
  }

  const readDelta = results.read_multi_tenant.p50 - results.read_single_tenant.p50;
  const ingestDelta = results.ingest_multi_tenant.p50 - results.ingest_single_tenant.p50;

  console.log(JSON.stringify({ N, RUNS, results, readDeltaP50Ms: readDelta, ingestDeltaP50Ms: ingestDelta }, null, 2));

  await pool.query(`DELETE FROM looptrace_api_keys WHERE id = $1`, [id]);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
