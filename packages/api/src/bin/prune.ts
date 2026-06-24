import { pathToFileURL } from "node:url";

import {
  createSpanRepository,
  parseRetentionConfig,
  type PruneStats,
  type RetentionConfig,
  type SpanRepository,
} from "@usetheo/lens-core";

const DAY_MS = 86_400_000;

/**
 * Pure: run one prune when retention is enabled; return its stats, or `null` when
 * disabled. No env/DB/process access — the cutoff is `now - retentionDays`. Unit-
 * testable with a fake repo (the entry wrapper supplies the real repo + clock).
 */
export async function runPrune(
  repo: Pick<SpanRepository, "prune">,
  config: RetentionConfig,
  now: Date,
): Promise<PruneStats | null> {
  if (config.retentionDays == null) return null;
  const cutoff = new Date(now.getTime() - config.retentionDays * DAY_MS);
  return repo.prune(cutoff);
}

/**
 * CLI entry (`pnpm db:prune`): read config, run ONE prune, log structured stats
 * (Rule 8 — a destructive op is visible). Fails loud (exit 1) on a missing
 * connection string or when retention is not explicitly enabled — a manual prune
 * never guesses a window.
 */
async function main(): Promise<void> {
  const uri = process.env["THEOLENS_PG_URI"];
  if (!uri) {
    console.error(JSON.stringify({ level: "error", msg: "THEOLENS_PG_URI is required" }));
    process.exit(1);
    return;
  }
  const config = parseRetentionConfig(process.env);
  if (config.warning) {
    console.error(JSON.stringify({ level: "warn", msg: config.warning }));
  }
  if (config.retentionDays == null) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "set THEOLENS_RETENTION_DAYS to a positive integer to prune",
      }),
    );
    process.exit(1);
    return;
  }
  const { repo, pool } = createSpanRepository(uri);
  try {
    const stats = await runPrune(repo, config, new Date());
    console.error(JSON.stringify({ level: "info", msg: "pruned", ...stats }));
  } finally {
    await pool.end();
  }
}

const invokedAsEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsEntry) void main();
