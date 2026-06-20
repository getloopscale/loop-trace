import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useReplay } from "./useReplay.js";
import type { SpanNodeData } from "../api/types.js";

const steps: SpanNodeData[] = [
  { spanId: "a", traceId: "t", name: "a", startTimeUnixNano: "0", endTimeUnixNano: "0" },
  { spanId: "b", traceId: "t", name: "b", startTimeUnixNano: "1", endTimeUnixNano: "1" },
  { spanId: "c", traceId: "t", name: "c", startTimeUnixNano: "2", endTimeUnixNano: "2" },
];

describe("useReplay", () => {
  it("useReplay_next_prev_clamp_at_bounds_and_jumpTo_sets_index", () => {
    const { result } = renderHook(() => useReplay(steps));
    expect(result.current.index).toBe(0);
    expect(result.current.active?.spanId).toBe("a");

    act(() => result.current.prev()); // clamp at 0
    expect(result.current.index).toBe(0);

    act(() => result.current.next());
    expect(result.current.active?.spanId).toBe("b");

    act(() => result.current.jumpTo("c"));
    expect(result.current.index).toBe(2);

    act(() => result.current.next()); // clamp at last
    expect(result.current.index).toBe(2);

    act(() => result.current.jumpTo("missing")); // no-op (gap tolerance)
    expect(result.current.index).toBe(2);
  });
});
