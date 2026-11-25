/**
 * Runnable sample — annotate the most recent trace. Run against a real engine:
 *   LENS_BASE_URL=https://api.getloopscale.com LENS_API_KEY=looptrace_live_… npx tsx examples/annotate-trace.ts
 * Skips honestly (no crash) when the env is unset or there are no traces yet.
 */
import { LensReadClient, LensApiError } from "@looptrace/sdk";

const baseUrl = process.env["LENS_BASE_URL"];
const apiKey = process.env["LENS_API_KEY"];
if (!baseUrl || !apiKey) {
  console.log("Set LENS_BASE_URL and LENS_API_KEY to run this example against a real engine. Skipping.");
  process.exit(0);
}

const client = new LensReadClient({ baseUrl, apiKey });

const { traces } = await client.listTraces({ limit: 1 });
const trace = traces[0];
if (!trace) {
  console.log("No traces to annotate yet — ingest a trace first. Skipping.");
  process.exit(0);
}

try {
  const res = await client.annotateTrace(trace.traceId, {
    label: "reviewed",
    note: "annotated by the SDK example",
  });
  console.log(`annotated ${trace.traceId}: ${res.annotations.length} annotation(s)`);
} catch (err) {
  if (err instanceof LensApiError) {
    console.error(`annotate failed: ${err.status} ${err.code} — ${err.message}`);
    process.exit(1);
  }
  throw err;
}
