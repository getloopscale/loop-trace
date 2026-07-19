import { describe, it, expect } from "vitest";
import { shapeSessionDetail, type RawSessionDetail } from "./session.js";

const base: RawSessionDetail = {
  sessionId: "s1",
  firstSeenAt: new Date("2026-06-22T00:00:00Z"),
  lastSeenAt: new Date("2026-06-22T01:00:00Z"),
  traceCount: 4,
  costUsd: 0.012345,
  totalTokens: 1500,
  errorCount: 1,
  p50: 10.1234,
  p95: 88.5678,
  traces: [],
};

describe("shapeSessionDetail (M13)", () => {
  it("test_shape_session_detail_sums_and_rounds", () => {
    const out = shapeSessionDetail(base);
    expect(out.costUsd).toBe(0.012);
    expect(out.latencyP50Ms).toBe(10.123);
    expect(out.latencyP95Ms).toBe(88.568);
    expect(out.totalTokens).toBe(1500);
    expect(out.firstSeenAt).toBe("2026-06-22T00:00:00.000Z");
  });

  it("test_shape_session_error_rate_zero_guard", () => {
    const out = shapeSessionDetail({ ...base, traceCount: 0, errorCount: 0 });
    expect(out.errorRate).toBe(0); // no NaN on zero traceCount
  });

  it("test_shape_session_detail_error_rate_rounded", () => {
    const out = shapeSessionDetail({ ...base, traceCount: 3, errorCount: 1 });
    expect(out.errorRate).toBe(0.333); // 1/3 round3-ed
  });

  it("test_shape_session_null_aggregates_coalesce_to_zero", () => {
    // EC-1: an all-tokenless session has NULL SUM/percentile → 0, not NaN/reject.
    const out = shapeSessionDetail({
      ...base,
      costUsd: null,
      totalTokens: null,
      p50: null,
      p95: null,
    });
    expect(out.costUsd).toBe(0);
    expect(out.totalTokens).toBe(0);
    expect(out.latencyP50Ms).toBe(0);
    expect(out.latencyP95Ms).toBe(0);
  });

  it("test_shape_session_detail_maps_member_traces", () => {
    const out = shapeSessionDetail({
      ...base,
      traces: [{ traceId: "t1", durationMs: 5, statusCode: "ok" }],
    });
    expect(out.traces).toEqual([{ traceId: "t1", durationMs: 5, statusCode: "ok" }]);
  });
});
