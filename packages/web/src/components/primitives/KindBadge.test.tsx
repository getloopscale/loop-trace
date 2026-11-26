import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { KindBadge } from "./KindBadge.js";
import {
  deriveTraceListItemKind,
  type SpanKind,
} from "../../lib/span-kind.js";
import { kindColor } from "../../lib/kind-color.js";
import type { TraceListItem } from "../../api/types.js";

function withTheme(ui: React.ReactNode) {
  return (
    <>
      {ui}
    </>
  );
}

describe("KindBadge + deriveTraceListItemKind", () => {
  it("kind_badge_renders_label_and_canonical_colour_dot", () => {
    // the kind label is always rendered as text (a11y: meaning not in color alone)
    const kinds: SpanKind[] = [
      "llm",
      "tool",
      "retriever",
      "embedding",
      "chain",
      "unknown",
    ];
    for (const k of kinds) {
      const { container, unmount } = render(withTheme(<KindBadge kind={k} />));
      expect(screen.getByText(k)).toBeInTheDocument();
      // the dot carries the canonical kind colour (single source — M29)
      const dot = container.querySelector('[aria-hidden="true"]');
      expect(dot?.className).toContain(kindColor(k).textClass);
      unmount();
    }
  });

  it("derive_trace_list_item_kind_from_root_signals", () => {
    const tool: TraceListItem = { traceId: "a", rootToolName: "search_web" };
    const retr: TraceListItem = { traceId: "b", rootOperationName: "retrieve" };
    const llmByOp: TraceListItem = { traceId: "c", rootOperationName: "chat" };
    const llmByModel: TraceListItem = { traceId: "d", model: "gpt-4o" };
    const unknown: TraceListItem = { traceId: "e" };
    expect(deriveTraceListItemKind(tool)).toBe("tool");
    expect(deriveTraceListItemKind(retr)).toBe("retriever");
    expect(deriveTraceListItemKind(llmByOp)).toBe("llm");
    expect(deriveTraceListItemKind(llmByModel)).toBe("llm");
    expect(deriveTraceListItemKind(unknown)).toBe("unknown");
  });
});
