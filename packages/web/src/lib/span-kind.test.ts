import { describe, it, expect } from "vitest";
import { deriveSpanKind, hasErrorDescendant, isErrorStatus } from "./span-kind.js";
import type { TraceTreeNode } from "../api/types.js";

function node(over: Partial<TraceTreeNode> & { spanId: string }): TraceTreeNode {
  return {
    traceId: "t1",
    name: over.spanId,
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    children: [],
    ...over,
  };
}

describe("deriveSpanKind (M10)", () => {
  it("test_derive_span_kind_tool_from_tool_name_or_execute_tool", () => {
    expect(deriveSpanKind(node({ spanId: "a", attributes: { "gen_ai.tool.name": "search" } }))).toBe("tool");
    expect(deriveSpanKind(node({ spanId: "b", attributes: { "gen_ai.operation.name": "execute_tool" } }))).toBe("tool");
  });

  it("test_derive_span_kind_tool_from_typed_toolname_column", () => {
    // M34/F-arch-1: a Claude Code tool span carries the typed `toolName` column and
    // NO `gen_ai.tool.name` attribute — it must still classify as "tool".
    expect(deriveSpanKind(node({ spanId: "c", toolName: "Bash" }))).toBe("tool");
  });

  it("test_derive_span_kind_llm_from_operation_or_model", () => {
    expect(deriveSpanKind(node({ spanId: "a", attributes: { "gen_ai.operation.name": "chat" } }))).toBe("llm");
    expect(deriveSpanKind(node({ spanId: "b", model: "gpt-4o" }))).toBe("llm");
  });

  it("test_derive_span_kind_chain_for_parent_without_signal", () => {
    const parent = node({ spanId: "p", children: [node({ spanId: "c" })] });
    expect(deriveSpanKind(parent)).toBe("chain");
  });

  it("test_derive_span_kind_unknown_fallback", () => {
    expect(deriveSpanKind(node({ spanId: "x" }))).toBe("unknown");
  });

  it("test_derive_span_kind_tolerates_missing_attributes", () => {
    // no `attributes` key at all (the common shape)
    expect(() => deriveSpanKind(node({ spanId: "x" }))).not.toThrow();
    expect(deriveSpanKind(node({ spanId: "x" }))).toBe("unknown");
    // attributes a non-record value must not throw either
    expect(deriveSpanKind(node({ spanId: "y", attributes: 42 as never, model: "gpt-4o" }))).toBe("llm");
  });

  it("test_has_error_descendant_propagates_from_child", () => {
    const okRootErrChild = node({ spanId: "r", statusCode: "1", children: [node({ spanId: "c", statusCode: "2" })] });
    expect(hasErrorDescendant(okRootErrChild)).toBe(true);
    const allOk = node({ spanId: "r", statusCode: "1", children: [node({ spanId: "c", statusCode: "1" })] });
    expect(hasErrorDescendant(allOk)).toBe(false);
    expect(hasErrorDescendant(node({ spanId: "r", statusCode: "ERROR" }))).toBe(true);
    // EC-5: STATUS_CODE_ERROR token now counts
    expect(isErrorStatus("STATUS_CODE_ERROR")).toBe(true);
  });
});
