import { z } from "zod";

/**
 * Data retention (M23). Counts deleted per table by a prune, plus the cutoff — for
 * structured logging (Rule 8 — a destructive op must be visible). Trace-granular:
 * a trace is pruned with all its spans/tags/replay rows; a session is pruned only
 * when all its traces are gone.
 */
export interface PruneStats {
  /** ISO cutoff — traces with `updated_at < cutoff` were pruned. */
  cutoff: string;
  tracesDeleted: number;
  spansDeleted: number;
  tagsDeleted: number;
  replaySessionsDeleted: number;
  sessionsDeleted: number;
  /** M26 read-path eval rows of pruned traces (cascade — avoids orphan evals). */
  evaluationsDeleted: number;
  /** M26b human-feedback annotations of pruned traces (cascade — avoids orphans). */
  annotationsDeleted: number;
  /**
   * M134 auto-eval job rows of pruned traces (cascade). Two distinct reasons,
   * both from EC-4: without it the queue table grows without bound, AND a
   * completed row outliving its trace turns the `ON CONFLICT DO NOTHING`
   * dedup into a tombstone that permanently suppresses re-evaluation if the
   * same trace_id is ever re-ingested.
   */
  evalJobsDeleted: number;
}

/** Parsed retention config. `retentionDays === null` means retention is DISABLED. */
export interface RetentionConfig {
  retentionDays: number | null;
  sweepHours: number;
  /** Set when an env value was present but invalid (logged by callers). */
  warning?: string;
}

const DEFAULT_SWEEP_HOURS = 6;

/**
 * Pure parse of retention env (M23, default OFF). `THEOLENS_RETENTION_DAYS` must be
 * a positive integer to enable retention — absent/blank/`0`/negative/garbage all
 * disable it (a `0`-day window must NEVER become a delete-everything, EC). An
 * invalid `THEOLENS_RETENTION_SWEEP_HOURS` falls back to the default (a `0`-hour
 * interval would busy-loop, EC-4). Takes `env` as an argument — no global read.
 */
export function parseRetentionConfig(
  env: Record<string, string | undefined>,
): RetentionConfig {
  const daysRaw = env["THEOLENS_RETENTION_DAYS"];
  const hoursRaw = env["THEOLENS_RETENTION_SWEEP_HOURS"];

  let retentionDays: number | null = null;
  let warning: string | undefined;
  if (daysRaw != null && daysRaw.trim() !== "") {
    const parsed = z.coerce.number().int().positive().safeParse(daysRaw);
    if (parsed.success) {
      retentionDays = parsed.data;
    } else {
      warning = `THEOLENS_RETENTION_DAYS=${daysRaw} is not a positive integer; retention disabled`;
    }
  }

  let sweepHours = DEFAULT_SWEEP_HOURS;
  const parsedHours = z.coerce.number().positive().safeParse(hoursRaw);
  if (hoursRaw != null && hoursRaw.trim() !== "" && parsedHours.success) {
    sweepHours = parsedHours.data;
  }

  return warning != null
    ? { retentionDays, sweepHours, warning }
    : { retentionDays, sweepHours };
}
