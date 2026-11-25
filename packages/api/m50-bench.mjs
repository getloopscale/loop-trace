// M50 benchmark — OTLP ingest throughput + latency through the REAL HTTP receiver
// (Hono app.request, real auth + parse + persist), with Claude-Code-shaped spans.
process.env.LOOPTRACE_REQUIRE_CREDENTIAL = "1";
process.env.LOOPTRACE_PLATFORM_ADMIN_BOOTSTRAP = "dev-bootstrap-token-change-me-min-32-chars";
const { bootstrap } = await import("./dist/server/index.js");
const PG_URI = process.env.LOOPTRACE_PG_URI;
const { app, pool } = await bootstrap(PG_URI);

async function mint(ws) {
  const r = await app.request("/v1/admin/keys", {
    method: "POST",
    headers: { Authorization: "Bearer dev-bootstrap-token-change-me-min-32-chars", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "bench", workspace_id: ws, scopes: ["observability:write"] }),
  });
  return (await r.json()).secret;
}
const key = await mint("benchws");

// one CC-shaped trace (interaction + llm_request) per request, unique ids
function body(n) {
  const tid = ("bench" + n).padEnd(16, "0").slice(0, 16);
  const s1 = ("bi" + n).padEnd(16, "0").slice(0, 16);
  const s2 = ("bl" + n).padEnd(16, "0").slice(0, 16);
  return JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
      scopeSpans: [{ spans: [
        { traceId: tid, spanId: s1, startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000005000000000", status: { code: 0 }, name: "claude_code.interaction", attributes: [{ key: "session.id", value: { stringValue: "bench-" + n } }, { key: "user_prompt", value: { stringValue: "bench" } }] },
        { traceId: tid, spanId: s2, parentSpanId: s1, startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000005000000000", status: { code: 0 }, name: "claude_code.llm_request", attributes: [{ key: "session.id", value: { stringValue: "bench-" + n } }, { key: "gen_ai.request.model", value: { stringValue: "claude-opus-4-8" } }, { key: "gen_ai.system", value: { stringValue: "anthropic" } }, { key: "input_tokens", value: { intValue: "1000" } }, { key: "output_tokens", value: { intValue: "50" } }] },
      ] }],
    }],
  });
}

const N = 300; // requests, 2 spans each = 600 spans
// warmup
for (let i = 0; i < 20; i++) await app.request("/v1/traces", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: body("w" + i) });

const lat = [];
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
  const a = process.hrtime.bigint();
  const r = await app.request("/v1/traces", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: body(i) });
  const b = process.hrtime.bigint();
  if (r.status !== 200) { console.log("NON_200 at " + i + " status=" + r.status); }
  lat.push(Number(b - a) / 1e6); // ms
}
const t1 = process.hrtime.bigint();
const wallSec = Number(t1 - t0) / 1e9;

lat.sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))];
const reqPerSec = N / wallSec;
const spansPerSec = (N * 2) / wallSec;

console.log(JSON.stringify({
  requests: N, spans_ingested: N * 2, wall_seconds: +wallSec.toFixed(3),
  req_per_sec: +reqPerSec.toFixed(1), spans_per_sec: +spansPerSec.toFixed(1),
  ingest_latency_ms: { p50: +pct(50).toFixed(2), p95: +pct(95).toFixed(2), p99: +pct(99).toFixed(2), max: +lat[lat.length - 1].toFixed(2) },
}, null, 2));
await pool.end();
process.exit(0);
