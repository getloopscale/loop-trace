import { Badge } from "@usetheo/ui";
import type { SpanKind } from "../../lib/span-kind.js";
import { kindColor } from "../../lib/kind-color.js";

/**
 * Kind badge (M18; M29 unified) — a neutral Badge with a leading colour dot whose
 * colour is the canonical `kindColor(kind)` (the SAME source the SpanTree glyph and
 * the Agent Graph/Path nodes use), so a kind reads one colour everywhere. The text
 * label always carries the meaning (never colour-only — WCAG 1.4.1).
 */
export function KindBadge({ kind }: { kind: SpanKind }) {
  return (
    <Badge variant="outline" size="sm">
      <span className={`mr-1 ${kindColor(kind).textClass}`} aria-hidden="true">
        ●
      </span>
      {kind}
    </Badge>
  );
}
