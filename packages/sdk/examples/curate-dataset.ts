/**
 * Runnable sample — create a dataset and add a synthetic example. Run against a real engine:
 *   LENS_BASE_URL=https://api.getloopscale.com LENS_API_KEY=looptrace_live_… npx tsx examples/curate-dataset.ts
 * Skips honestly (no crash) when the env is unset. Operates on a clearly-named example dataset.
 */
import { LensReadClient } from "@looptrace/sdk";

const baseUrl = process.env["LENS_BASE_URL"];
const apiKey = process.env["LENS_API_KEY"];
if (!baseUrl || !apiKey) {
  console.log("Set LENS_BASE_URL and LENS_API_KEY to run this example against a real engine. Skipping.");
  process.exit(0);
}

const client = new LensReadClient({ baseUrl, apiKey });

// createDataset is idempotent (create-or-get by name) — safe to re-run.
const dataset = await client.createDataset({ name: "sdk-example-set" });
console.log(`dataset: ${dataset.id} (${dataset.name})`);

const detail = await client.addDatasetItem(dataset.id, {
  input: "What is 2 + 2?",
  output: "4",
});
console.log(`items now: ${detail.items.length}`);
