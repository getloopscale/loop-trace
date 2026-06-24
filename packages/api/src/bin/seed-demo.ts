import { pathToFileURL } from "node:url";

import { createSpanRepository, migrateLatest } from "@usetheo/lens-core";

import { parseResourceSpans } from "../otlp/parse-resource-spans.js";
import {
  buildTravelAgentEnvelope,
  DEMO_SERVICE_NAME,
} from "../demo/travel-agent-fixture.js";

/**
 * CLI entry (`pnpm db:seed:demo`, M28): build the deterministic travel-agent demo
 * envelope, run it through the REAL OTLP parse (so the content is identical to live
 * ingestion), and `save` it via the span repository. Idempotent — deterministic ids
 * + `onConflictDoNothing` mean re-seeding never duplicates. Fails loud (exit 1) on a
 * missing connection string (Rule 8 — never guess a default DB). Exported for testing
 * the fail-loud path. `THEOLENS_DEMO_TRACES` / `THEOLENS_DEMO_SESSIONS` tune the size.
 */
export async function main(): Promise<void> {
  const uri = process.env["THEOLENS_PG_URI"];
  if (!uri) {
    console.error(
      JSON.stringify({ level: "error", msg: "THEOLENS_PG_URI is required" }),
    );
    process.exit(1);
    return;
  }
  const traces = Number(process.env["THEOLENS_DEMO_TRACES"] ?? 8);
  const sessions = Number(process.env["THEOLENS_DEMO_SESSIONS"] ?? 3);

  const spans = parseResourceSpans(buildTravelAgentEnvelope({ traces, sessions }));
  const { repo, pool } = createSpanRepository(uri);
  try {
    await migrateLatest(pool);
    await repo.save(spans);
    console.error(
      JSON.stringify({
        level: "info",
        msg: "seeded demo",
        service: DEMO_SERVICE_NAME,
        traces: new Set(spans.map((s) => s.traceId)).size,
        spans: spans.length,
        sessions: new Set(spans.map((s) => s.sessionId).filter(Boolean)).size,
      }),
    );
  } finally {
    await pool.end();
  }
}

const invokedAsEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsEntry) void main();
