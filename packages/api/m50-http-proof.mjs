// M50 LIVE proof (tier 1.5) — the REAL HTTP receiver + auth + scope-gate exercised
// in-process via Hono app.request (no socket), with the REAL Claude Code OTLP payload.
// Proves: bootstrap-mint -> keyed POST /v1/traces 200 -> read back; un-keyed 401 (fail-closed);
// cross-workspace isolation (ws-A key cannot read ws-B data).
import { readFileSync } from "node:fs";

process.env.LOOPTRACE_REQUIRE_CREDENTIAL = "1";
process.env.LOOPTRACE_PLATFORM_ADMIN_BOOTSTRAP = "dev-bootstrap-token-change-me-min-32-chars";

const { bootstrap } = await import("./dist/server/index.js");
const PG_URI = process.env.LOOPTRACE_PG_URI;
const payload = readFileSync(new URL("./m50-cc-otlp-fixture.json", import.meta.url), "utf8");

const { app, pool } = await bootstrap(PG_URI);
const results = {};

async function mint(ws) {
  const r = await app.request("/v1/admin/keys", {
    method: "POST",
    headers: { Authorization: "Bearer dev-bootstrap-token-change-me-min-32-chars", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "m50-" + ws, workspace_id: ws, scopes: ["observability:write", "observability:read", "observability:admin"] }),
  });
  const j = await r.json();
  return j.secret;
}

// clean
await pool.query("DELETE FROM spans WHERE trace_id='cc11111111111111'").catch(() => {});
await pool.query("DELETE FROM traces WHERE trace_id='cc11111111111111'").catch(() => {});

// 1) un-keyed POST is fail-closed
const unauth = await app.request("/v1/traces", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
results.unkeyed_post_status = unauth.status; // expect 401

// 2) keyed POST with a consumer key (ws=m50ws) -> 200 OTLP partial success
const keyA = await mint("m50ws");
const post = await app.request("/v1/traces", {
  method: "POST",
  headers: { Authorization: "Bearer " + keyA, "Content-Type": "application/json" },
  body: payload,
});
results.keyed_post_status = post.status; // expect 200
results.keyed_post_body = (await post.text()).slice(0, 120);

// 3) read back through the HTTP read path (same key) -> trace visible
const read = await app.request("/v1/traces?limit=5", { headers: { Authorization: "Bearer " + keyA } });
const readBody = await read.text();
results.read_status = read.status;
results.read_has_trace = readBody.includes("cc11111111111111");

// 4) cross-workspace isolation: a DIFFERENT workspace's key must NOT see ws-A's trace
const keyB = await mint("m50ws-other");
const readB = await app.request("/v1/traces?limit=5", { headers: { Authorization: "Bearer " + keyB } });
const readBBody = await readB.text();
results.crosstenant_leak = readBBody.includes("cc11111111111111"); // expect false

console.log(JSON.stringify(results, null, 2));
const ok =
  results.unkeyed_post_status === 401 &&
  results.keyed_post_status === 200 &&
  results.read_status === 200 &&
  results.read_has_trace === true &&
  results.crosstenant_leak === false;
console.log("M50_TIER1.5_VERDICT=" + (ok ? "PASS" : "FAIL"));
await pool.end();
process.exit(ok ? 0 : 3);
