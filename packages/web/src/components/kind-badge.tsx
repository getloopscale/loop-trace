import { Badge } from "@theokit/ui";
import type { SpanKind } from "../lib/span-kind.js";

/**
 * Kind → theo-ui Badge variant (M18 D3). The design system has no reserved
 * agent/llm/tool tokens, so we map to semantic variants: llm→accent (highlight),
 * tool→warning (amber), retriever/embedding→primary (violet), chain→default,
 * unknown→outline. Text label carries the meaning (never color-only — a11y).
 */
const VARIANT: Record<
  SpanKind,
  "primary" | "accent" | "warning" | "default" | "outline"
> = {
  llm: "accent",
  tool: "warning",
  retriever: "primary",
  embedding: "primary",
  chain: "default",
  unknown: "outline",
};

export function KindBadge({ kind }: { kind: SpanKind }) {
  return (
    <Badge variant={VARIANT[kind]} size="sm">
      {kind}
    </Badge>
  );
}
