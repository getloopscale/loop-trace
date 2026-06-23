import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { KindBadge } from "./kind-badge.js";
import {
  deriveTraceListItemKind,
  type SpanKind,
} from "../lib/span-kind.js";
import type { TraceListItem } from "../api/types.js";

function withTheme(ui: React.ReactNode) {
  return (
    <ThemeProvider defaultTheme="violet-forge" defaultMode="dark" themes={[violetForge]}>
      {ui}
    </ThemeProvider>
  );
}

describe("KindBadge + deriveTraceListItemKind", () => {
  it("kind_badge_maps_kind_to_variant", () => {
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
      const { unmount } = render(withTheme(<KindBadge kind={k} />));
      expect(screen.getByText(k)).toBeInTheDocument();
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
