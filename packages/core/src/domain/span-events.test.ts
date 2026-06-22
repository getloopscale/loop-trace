import { describe, it, expect } from "vitest";
import {
  capText,
  extractSpanEvents,
  INPUT_OUTPUT_CAP,
  MAX_EVENTS,
} from "./span-events.js";

// Identity flatten for tests (the real ingest passes its recursive flattenAttrs).
const flat = (a: unknown): Record<string, unknown> | undefined =>
  a && typeof a === "object" ? (a as Record<string, unknown>) : undefined;

describe("capText (M12 D5/EC-2)", () => {
  it("test_cap_text_returns_short_text_unchanged", () => {
    expect(capText("hello", 10)).toBe("hello");
  });

  it("test_cap_text_truncates_with_marker", () => {
    const out = capText("a".repeat(9000), INPUT_OUTPUT_CAP);
    expect([...out].length).toBeLessThanOrEqual(INPUT_OUTPUT_CAP + "…[truncated]".length);
    expect(out.endsWith("…[truncated]")).toBe(true);
    expect(out.startsWith("aaaa")).toBe(true);
  });

  it("test_cap_text_does_not_split_surrogate_pair", () => {
    // 10 emoji (each a surrogate pair in UTF-16) capped at 5 code points.
    const out = capText("😀".repeat(10), 5);
    // No lone surrogate: re-encoding round-trips cleanly (every code point intact).
    expect([...out.replace("…[truncated]", "")].every((c) => c === "😀")).toBe(true);
    expect([...out.replace("…[truncated]", "")].length).toBe(5);
  });
});

describe("extractSpanEvents (M12 D3)", () => {
  it("test_extract_span_events_maps_name_time_attributes", () => {
    const events = extractSpanEvents(
      [{ name: "chunk", timeUnixNano: "1700000000000000000", attributes: { i: 1 } }],
      flat,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "chunk",
      timeUnixNano: "1700000000000000000",
      attributes: { i: 1 },
    });
  });

  it("test_extract_span_events_capped_at_50", () => {
    const raw = Array.from({ length: 60 }, (_, i) => ({ name: `e${i}` }));
    expect(extractSpanEvents(raw, flat)).toHaveLength(MAX_EVENTS);
  });

  it("test_extract_span_events_caps_per_event_attribute_size", () => {
    const big = { blob: "x".repeat(10000) };
    const [event] = extractSpanEvents([{ name: "e", attributes: big }], flat);
    expect(JSON.stringify(event!.attributes).length).toBeLessThan(10000);
    expect(event!.attributes).toHaveProperty("__truncated");
  });

  it("test_extract_span_events_skips_nameless_and_non_array", () => {
    expect(extractSpanEvents([{ timeUnixNano: "1" }], flat)).toEqual([]);
    expect(extractSpanEvents("nope", flat)).toEqual([]);
    expect(extractSpanEvents(undefined, flat)).toEqual([]);
  });
});
