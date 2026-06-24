import { describe, it, expect } from "vitest";
import { kindColor } from "./kind-color.js";
import { kindColorClass } from "../components/SankeyDiagram.js";
import type { SpanKind } from "./span-kind.js";

const ALL_KINDS: SpanKind[] = [
  "llm",
  "tool",
  "retriever",
  "embedding",
  "chain",
  "unknown",
];

const TOKEN_CLASS = /^text-(primary|accent|warning|info|success|muted-foreground)$/;

describe("kindColor (M29 canonical kind→colour)", () => {
  it("test_every_kind_has_a_token_text_class", () => {
    for (const k of [...ALL_KINDS, "terminal" as const]) {
      expect(kindColor(k).textClass).toMatch(TOKEN_CLASS);
    }
  });

  it("test_kinds_are_visually_distinct", () => {
    // The parity guarantee: agent(chain) ≠ llm ≠ tool ≠ retriever are four colours.
    const four = ["chain", "llm", "tool", "retriever"].map(
      (k) => kindColor(k as SpanKind).textClass,
    );
    expect(new Set(four).size).toBe(4);
  });

  it("test_maps_to_the_reference_concept", () => {
    expect(kindColor("llm").textClass).toBe("text-accent"); // orange
    expect(kindColor("tool").textClass).toBe("text-warning"); // amber
    expect(kindColor("chain").textClass).toBe("text-primary"); // violet (agent)
    expect(kindColor("retriever").textClass).toBe("text-info"); // blue
  });

  it("test_sankey_kindcolor_delegates_to_canonical", () => {
    // The Agent Graph/Path nodes derive colour from the SAME source (no divergence).
    for (const k of [...ALL_KINDS, "terminal" as const]) {
      expect(kindColorClass(k)).toBe(kindColor(k).textClass);
    }
  });
});
