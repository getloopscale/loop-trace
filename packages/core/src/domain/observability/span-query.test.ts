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

  // M92 — arbitrary attribute clause
  it("test_parse_attr_clause_key_and_value", () => {
    expect(parseSpanQuery("attr:gen_ai.request.temperature=0.7")).toEqual({
      clauses: [{ field: "attr", key: "gen_ai.request.temperature", value: "0.7" }],
      ignored: [],
    });
  });

  it("test_parse_attr_quoted_spaced_value", () => {
    // the whole key=value is quoted so the space in the value does not split the token
    expect(parseSpanQuery('attr:"gen_ai.system=Anthropic PBC"')).toEqual({
      clauses: [{ field: "attr", key: "gen_ai.system", value: "Anthropic PBC" }],
      ignored: [],
    });
  });

  it("test_parse_attr_value_may_contain_equals", () => {
    // only the FIRST '=' splits key/value; the value keeps the rest
    expect(parseSpanQuery("attr:url=https://x/y?a=b")).toEqual({
      clauses: [{ field: "attr", key: "url", value: "https://x/y?a=b" }],
      ignored: [],
    });
  });

  it("test_parse_attr_composes_with_typed_clause", () => {
    const r = parseSpanQuery("kind:llm attr:foo=bar");
    expect(r.clauses).toEqual([
      { field: "kind", value: "llm" },
      { field: "attr", key: "foo", value: "bar" },
    ]);
    expect(r.ignored).toEqual([]);
  });

  it("test_parse_attr_rejects_malformed_and_injection_shaped_keys", () => {
    const bad = [
      "attr:=x", // empty key
      "attr:foo", // no '='
      "attr:=", // empty key and value
      "attr:k=", // empty value
      `attr:${"a".repeat(200)}=v`, // over-long key
      "attr:has space=v", // space in key (would be split anyway, but assert the whole token drops)
    ];
    for (const token of bad) {
      const r = parseSpanQuery(token);
      expect(r.clauses).toEqual([]); // no attr clause from a malformed key/value
    }
    // an injection-shaped key is dropped by the shape guard (defense-in-depth; the SQL binds it regardless)
    const inj = parseSpanQuery(`attr:"a') OR 1=1--=1"`);
    expect(inj.clauses).toEqual([]);
    expect(() => parseSpanQuery(`attr:"a') OR 1=1--=1"`)).not.toThrow();
  });
});
