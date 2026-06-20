import { describe, it, expect } from "vitest";
import { durationMs, formatDuration } from "./duration.js";

describe("duration", () => {
  it("duration_from_nanos_computes_ms", () => {
    expect(durationMs("1000000", "6000000")).toBe(5);
    expect(durationMs("0", "0")).toBe(0);
  });

  it("duration_undefined_when_endTime_missing_or_negative", () => {
    expect(durationMs("100")).toBeUndefined();
    expect(durationMs("6000000", "1000000")).toBeUndefined();
  });

  it("formats_duration_with_em_dash_when_unknown", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(5)).toBe("5 ms");
    expect(formatDuration(0)).toBe("<1 ms");
  });

  it("sub_millisecond_durations_truncate_to_under_1ms_end_to_end", () => {
    // 900_000 ns = 0.9 ms → integer-truncates to 0 → "<1 ms" (M3 ms-granularity).
    expect(formatDuration(durationMs("0", "900000"))).toBe("<1 ms");
  });
});
