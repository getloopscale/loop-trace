/**
 * Runnable sample — read the observability time-series. Run against a real engine:
 *   LENS_BASE_URL=https://api.usetheo.dev LENS_API_KEY=theo_live_… npx tsx examples/observability.ts
 * Skips honestly (no crash) when the env is unset.
 */
import { LensReadClient, LensApiError } from "@usetheo/lens-sdk";

const baseUrl = process.env["LENS_BASE_URL"];
const apiKey = process.env["LENS_API_KEY"];
if (!baseUrl || !apiKey) {
  console.log("Set LENS_BASE_URL and LENS_API_KEY to run this example against a real engine. Skipping.");
  process.exit(0);
}

const client = new LensReadClient({ baseUrl, apiKey });
try {
  const metrics = await client.observability({ range: "24h" });
  console.log(`Observability over ${metrics.range}:`);
  console.log(`  traffic buckets: ${metrics.traffic.length}`);
  console.log(`  latency buckets: ${metrics.latency.length}`);
} catch (err) {
  if (err instanceof LensApiError) {
    console.error(`Request failed: ${err.status} ${err.code} — ${err.message}`);
    process.exit(1);
  }
  throw err;
}
