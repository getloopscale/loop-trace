import { serve } from "@hono/node-server";
import { createSpanRepository } from "@usetheo/lens-core";

import { createApp } from "./app.js";

/**
 * Composition root: read config, wire the concrete Drizzle repository into the
 * app (the only place that knows about persistence concretes), and serve.
 */
function main(): void {
  const uri = process.env["THEOLENS_PG_URI"];
  if (!uri) {
    console.error(
      JSON.stringify({ level: "error", msg: "THEOLENS_PG_URI is required" }),
    );
    process.exit(1);
  }

  const { repo } = createSpanRepository(uri);
  const app = createApp(repo);
  const port = Number(process.env["THEOLENS_PORT"] ?? 4318);

  serve({ fetch: app.fetch, port });
  console.error(JSON.stringify({ level: "info", msg: "listening", port }));
}

main();
