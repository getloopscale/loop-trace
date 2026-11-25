/**
 * Runnable sample — list recent traces. Run against a real engine:
 *   LENS_BASE_URL=https://api.getloopscale.com LENS_API_KEY=looptrace_live_… npx tsx examples/list-traces.ts
 * Skips honestly (no crash) when the env is unset.
 */
import { LensReadClient } from "@looptrace/sdk";

const baseUrl = process.env["LENS_BASE_URL"];
const apiKey = process.env["LENS_API_KEY"];
if (!baseUrl || !apiKey) {
  console.log("Set LENS_BASE_URL and LENS_API_KEY to run this example against a real engine. Skipping.");
  process.exit(0);
}

const client = new LensReadClient({ baseUrl, apiKey });
const { traces, total } = await client.listTraces({ limit: 10 });
console.log(`Fetched ${traces.length} of ${total} trace(s):`);
for (const t of traces) {
  console.log(`  ${t.traceId}  ${t.name ?? ""}  ${t.model ?? ""}`);
}
