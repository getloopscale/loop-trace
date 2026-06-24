import { describe, it, expect, vi } from "vitest";
import { runPrune } from "./prune.js";
import type { PruneStats } from "@usetheo/lens-core";

const STATS: PruneStats = {
  cutoff: "2026-03-26T00:00:00.000Z",
  tracesDeleted: 2,
  spansDeleted: 5,
  tagsDeleted: 1,
  replaySessionsDeleted: 0,
  sessionsDeleted: 1,
};

describe("runPrune (M23 CLI core)", () => {
  it("run_prune_calls_repo_with_cutoff_and_returns_stats", async () => {
    const prune = vi.fn().mockResolvedValue(STATS);
    const now = new Date("2026-06-24T00:00:00.000Z");
    const stats = await runPrune({ prune }, { retentionDays: 90, sweepHours: 6 }, now);
    expect(stats).toBe(STATS);
    // cutoff = now - 90 days
    expect(prune).toHaveBeenCalledWith(new Date(now.getTime() - 90 * 86_400_000));
  });

  it("run_prune_noop_when_disabled", async () => {
    const prune = vi.fn();
    const stats = await runPrune(
      { prune },
      { retentionDays: null, sweepHours: 6 },
      new Date(),
    );
    expect(stats).toBeNull();
    expect(prune).not.toHaveBeenCalled();
  });
});
