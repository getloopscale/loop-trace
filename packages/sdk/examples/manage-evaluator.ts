/**
 * Runnable sample — create a rule evaluator and run it. Run against a real engine:
 *   LENS_BASE_URL=https://api.usetheo.dev LENS_API_KEY=theo_live_… npx tsx examples/manage-evaluator.ts
 * Skips honestly (no crash) when the env is unset. Operates on a clearly-named example evaluator.
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
  // createEvaluator is idempotent (upsert by name) — safe to re-run.
  const evaluator = await client.createEvaluator({
    name: "sdk-example-errors",
    kind: "rule",
    config: { predicate: "status:error" },
  });
  console.log(`evaluator: ${evaluator.id} (${evaluator.name})`);

  const result = await client.runEvaluator(evaluator.id, { limit: 100 });
  console.log(`run wrote ${result.written} verdict(s), skipped ${result.skipped}`);
} catch (err) {
  if (err instanceof LensApiError) {
    console.error(`failed: ${err.status} ${err.code} — ${err.message}`);
    process.exit(1);
  }
  throw err;
}
