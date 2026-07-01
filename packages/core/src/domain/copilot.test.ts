import { describe, it, expect } from "vitest";
import { buildCopilotPrompt, validateQuestion, capAnswer, CopilotError, MAX_ANSWER_BYTES } from "./copilot.js";
import type { TraceTreeNode } from "./span-repository.js";

function node(over: Partial<TraceTreeNode> & { spanId: string }): TraceTreeNode {
  return {
    spanId: over.spanId, traceId: "t1", name: over.name ?? "op",
    startTimeUnixNano: "1", endTimeUnixNano: "2", children: over.children ?? [],
    ...over,
  } as TraceTreeNode;
}

describe("M33 buildCopilotPrompt (T2.1)", () => {
  it("test_prompt_includes_span_context_and_question", () => {
    const tree = node({ spanId: "root", model: "gpt-4o", inputValue: "hi", children: [] });
    const msgs = buildCopilotPrompt(tree, "root", "why slow?");
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.content).toContain("model=gpt-4o");
    expect(msgs[1]!.content).toContain("why slow?");
  });
  it("test_prompt_bounds_large_io", () => {
    const big = "x".repeat(20000);
    const tree = node({ spanId: "root", inputValue: big });
    const msgs = buildCopilotPrompt(tree, "root", "q");
    expect(Buffer.byteLength(msgs[1]!.content, "utf8")).toBeLessThan(20000);
  });
  it("test_prompt_trace_mode_when_no_spanId", () => {
    const tree = node({ spanId: "root", children: [node({ spanId: "c", name: "child" })] });
    const msgs = buildCopilotPrompt(tree, undefined, "summarize");
    expect(msgs[1]!.content).toContain("TRACE t1 spans:");
    expect(msgs[1]!.content).toContain("child");
  });
  it("test_prompt_throws_span_not_found_when_spanId_absent", () => {
    // EC-2: a spanId not in the trace is a typed client error, NOT a silent
    // fall-back to the root span — the handler turns this into a 404.
    const tree = node({ spanId: "root", children: [node({ spanId: "c", name: "child" })] });
    expect(() => buildCopilotPrompt(tree, "ghost", "why?")).toThrow(CopilotError);
    try {
      buildCopilotPrompt(tree, "ghost", "why?");
    } catch (err) {
      expect((err as CopilotError).code).toBe("SPAN_NOT_FOUND");
    }
  });
});

describe("M33 validateQuestion + capAnswer (T2.1 / EC-1 / EC-6)", () => {
  it("test_validate_question_rejects_empty_and_oversized", () => {
    expect(() => validateQuestion("")).toThrow(CopilotError);
    expect(() => validateQuestion("   ")).toThrow(CopilotError);
    expect(() => validateQuestion("x".repeat(5000))).toThrow(CopilotError);
    expect(validateQuestion("  ok  ")).toBe("ok");
  });
  it("test_cap_answer", () => {
    expect(Buffer.byteLength(capAnswer("y".repeat(40000)), "utf8")).toBe(MAX_ANSWER_BYTES);
    expect(capAnswer("short")).toBe("short");
  });
});
