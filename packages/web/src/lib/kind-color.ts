import type { SpanKind } from "./span-kind.js";

/**
 * Canonical span-kind → colour mapping (M29) — the SINGLE source of truth consumed
 * by KindBadge, the SpanTree glyph, and the Agent Graph/Path (SankeyDiagram) nodes,
 * so a span kind reads the same colour everywhere.
 *
 * Colours are Violet-Forge semantic TOKENS surfaced as Tailwind text classes (no raw
 * hex). The mapping matches the *concept* of the Arize/Sigil peer palette — one
 * distinct colour per kind — on our own design language, not a pixel-copy:
 *   agent/chain → primary (violet)   · llm → accent (orange) · tool → warning (amber)
 *   retriever  → info (blue)        · embedding → success (green) · unknown/terminal → muted
 * `accent` is oklch hue ~39° (orange) and `warning` ~65° (amber), so LLM and TOOL read
 * as the reference's orange/yellow while staying token-based.
 *
 * Consumers apply `textClass` to a glyph, a `<Badge>` dot, or an SVG via
 * `fill="currentColor"`. Colour is never the sole cue — every consumer keeps a text
 * label (WCAG 1.4.1).
 */
export interface KindColor {
  /** Tailwind token text class, e.g. `text-accent`. Drives glyph / dot / `currentColor`. */
  textClass: string;
}

const KIND_COLOR: Record<SpanKind | "terminal", KindColor> = {
  llm: { textClass: "text-accent" },
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
