import { describe, it, expect } from "vitest";
import { parseRetentionConfig } from "./retention.js";

describe("parseRetentionConfig (M23)", () => {
  it("parse_retention_config_disabled_when_unset", () => {
    const c = parseRetentionConfig({});
    expect(c.retentionDays).toBeNull();
    expect(c.sweepHours).toBe(6);
    expect(c.warning).toBeUndefined();
  });

  it("parse_retention_config_enabled_with_positive_days", () => {
    const c = parseRetentionConfig({ THEOLENS_RETENTION_DAYS: "90" });
    expect(c.retentionDays).toBe(90);
  });

  it("parse_retention_config_rejects_nonpositive", () => {
    // a 0 / negative / garbage window must NEVER enable a delete-all → disabled + warning
    for (const bad of ["0", "-3", "x", "1.5"]) {
      const c = parseRetentionConfig({ THEOLENS_RETENTION_DAYS: bad });
      expect(c.retentionDays).toBeNull();
      expect(c.warning).toMatch(/not a positive integer/);
    }
  });

  it("parse_retention_config_sweep_hours_fallback", () => {
    // EC-4: invalid sweep falls back to the default (a 0-hour interval would busy-loop)
    expect(parseRetentionConfig({ THEOLENS_RETENTION_SWEEP_HOURS: "0" }).sweepHours).toBe(6);
    expect(parseRetentionConfig({ THEOLENS_RETENTION_SWEEP_HOURS: "x" }).sweepHours).toBe(6);
    expect(parseRetentionConfig({ THEOLENS_RETENTION_SWEEP_HOURS: "12" }).sweepHours).toBe(12);
  });
});
