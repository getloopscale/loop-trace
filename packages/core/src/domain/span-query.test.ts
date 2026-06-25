import { describe, it, expect } from "vitest";
import { parseSpanQuery } from "./span-query.js";

describe("parseSpanQuery (M30)", () => {
  it("test_parse_single_clause", () => {
    expect(parseSpanQuery("kind:llm")).toEqual({
      clauses: [{ field: "kind", value: "llm" }],
      ignored: [],
    });
  });

  it("test_parse_multi_clause_implicit_and", () => {
    const r = parseSpanQuery("kind:llm status:error model:gpt-4o");
    expect(r.clauses).toEqual([
      { field: "kind", value: "llm" },
      { field: "status", value: "error" },
      { field: "model", value: "gpt-4o" },
    ]);
    expect(r.ignored).toEqual([]);
  });

  it("test_parse_quoted_value", () => {
    const r = parseSpanQuery('name:"Chat Open AI"');
    expect(r.clauses).toEqual([{ field: "name", value: "Chat Open AI" }]);
  });

  it("test_parse_ignores_unknown_field", () => {
    const r = parseSpanQuery("foo:bar kind:llm");
    expect(r.clauses).toEqual([{ field: "kind", value: "llm" }]);
    expect(r.ignored).toEqual(["foo:bar"]);
  });

  it("test_parse_ignores_bad_kind_and_status", () => {
    const r = parseSpanQuery("kind:wizard status:maybe");
    expect(r.clauses).toEqual([]);
    expect(r.ignored).toEqual(["kind:wizard", "status:maybe"]);
  });

  it("test_parse_accepts_every_kind_value", () => {
    const r = parseSpanQuery(
      "kind:llm kind:tool kind:retriever kind:embedding kind:chain kind:unknown",
    );
    expect(r.clauses.map((c) => c.value)).toEqual([
      "llm",
      "tool",
      "retriever",
      "embedding",
      "chain",
      "unknown",
    ]);
    expect(r.ignored).toEqual([]);
  });

  it("test_parse_empty_and_whitespace_total", () => {
    expect(parseSpanQuery("")).toEqual({ clauses: [], ignored: [] });
    expect(parseSpanQuery("   ")).toEqual({ clauses: [], ignored: [] });
    // a bare token with no colon, an empty value, and a colon-led token → all ignored, never throws
    expect(parseSpanQuery("noColonToken kind: :value")).toEqual({
      clauses: [],
      ignored: ["noColonToken", "kind:", ":value"],
    });
  });

  it("test_parse_never_throws_on_garbage", () => {
    for (const junk of ['"""', "::::", "kind:\"unterminated", "🙂:x", "a:b:c:d"]) {
      expect(() => parseSpanQuery(junk)).not.toThrow();
    }
  });
});
