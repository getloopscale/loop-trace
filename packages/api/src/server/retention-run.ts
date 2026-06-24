import type { PruneStats, RetentionConfig, SpanRepository } from "@usetheo/lens-core";

const DAY_MS = 86_400_000;

/**
 * Pure retention use-case (M23): run one prune when retention is enabled; return
 * its stats, or `null` when disabled. No env/DB/process access — the cutoff is
 * `now - retentionDays`. The single helper both the CLI (`bin/prune.ts`) and the
 * in-process scheduler (`server/index.ts`) delegate to (DRY — one cutoff math, one
 * call site). Lives in `server/` so neither entry point depends on the other.
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
