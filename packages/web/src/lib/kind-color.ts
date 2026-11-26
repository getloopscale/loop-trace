import type { SpanKind } from "./span-kind.js";

/**
 * Canonical span-kind → colour mapping (M29) — the SINGLE source of truth consumed
 * by KindBadge, the SpanTree glyph, and the Agent Graph/Path (SankeyDiagram) nodes,
 * so a span kind reads the same colour everywhere.
 *
 * Colours are design-system TOKENS surfaced as Tailwind text classes (no raw hex), one per kind:
 *   agent/chain → primary (lime) · llm → foreground (bone) · tool → warning (yellow)
 *   retriever  → info (blue)    · embedding → success (green) · unknown/terminal → muted
 * The brand has one color, so LLM, the most common kind, takes the neutral text color and the
 * rarer kinds take the semantic ones. `accent` is a fill token and never a text color.
 *
 * Consumers apply `textClass` to a glyph, a `<Badge>` dot, or an SVG via
 * `fill="currentColor"`. Colour is never the sole cue — every consumer keeps a text
 * label (WCAG 1.4.1).
 */
export interface KindColor {
  /** Tailwind token text class, e.g. `text-warning`. Drives glyph / dot / `currentColor`. */
  textClass: string;
}

const KIND_COLOR: Record<SpanKind | "terminal", KindColor> = {
  llm: { textClass: "text-foreground" },
  tool: { textClass: "text-warning" },
  retriever: { textClass: "text-info" },
  embedding: { textClass: "text-success" },
  chain: { textClass: "text-primary" },
  unknown: { textClass: "text-muted-foreground" },
  terminal: { textClass: "text-muted-foreground" },
};

/** The canonical colour for a span kind (single source — M29). */
export function kindColor(kind: SpanKind | "terminal"): KindColor {
  return KIND_COLOR[kind];
}
