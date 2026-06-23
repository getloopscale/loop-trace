import { useState } from "react";
import { Tabs } from "@theokit/ui";
import type { SpanNodeData } from "../api/types.js";
import { durationMs, formatDuration } from "../lib/duration.js";
import { deriveKindFromSignals } from "../lib/span-kind.js";
import { KindBadge } from "./kind-badge.js";
import { EmptyState } from "./states.js";
import { JsonBlock } from "./JsonBlock.js";

function strAttr(
  attrs: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const v = attrs?.[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Center pane of the trace 3-pane (M19): tabbed info about the selected span —
 * Trace Info (status · duration · model · provider · tokens + kind badge),
 * Attributes (collapsible JSON), Events (JSON list). Migrated from SpanDetail's
 * info sections (M12); every section degrades to an EmptyState (backward-compat).
 */
export function SpanInfoPanel({ span }: { span: SpanNodeData }) {
  const [tab, setTab] = useState("info");
  const dur = durationMs(span.startTimeUnixNano, span.endTimeUnixNano);
  const hasModel = span.model != null || span.provider != null;
  const hasTokens = span.inputTokens != null || span.outputTokens != null;
  const hasEvents = span.events != null && span.events.length > 0;
  const hasAttrs =
    span.attributes != null && Object.keys(span.attributes).length > 0;
  const kind = deriveKindFromSignals({
    operationName: strAttr(span.attributes, "gen_ai.operation.name"),
    toolName: strAttr(span.attributes, "gen_ai.tool.name"),
    model: span.model ?? undefined,
    hasChildren: false,
  });

  return (
    <section aria-label="span info" className="span-detail flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <KindBadge kind={kind} />
        <h2 className="text-title-md font-display">{span.name}</h2>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <Tabs.List>
          <Tabs.Trigger value="info">Trace Info</Tabs.Trigger>
          <Tabs.Trigger value="attributes">Attributes</Tabs.Trigger>
          <Tabs.Trigger value="events">Events</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="info">
          <div className="detail-overview flex flex-col gap-1">
            <span>
              Status:{" "}
              <span aria-label={`status: ${span.statusCode ?? "unknown"}`}>
                {span.statusCode ?? "—"}
              </span>
            </span>
            <span>Duration: {formatDuration(dur)}</span>
          </div>
          <h3>Model</h3>
          {hasModel ? (
            <p className="detail-model">
              {span.model ?? "—"}
              {span.provider ? ` (${span.provider})` : ""}
            </p>
          ) : (
            <EmptyState message="No model recorded" />
          )}
          <h3>Tokens</h3>
          {hasTokens ? (
            <p className="detail-tokens">
              in {span.inputTokens ?? 0} / out {span.outputTokens ?? 0}
            </p>
          ) : (
            <EmptyState message="No token usage" />
          )}
        </Tabs.Content>

        <Tabs.Content value="attributes">
          {hasAttrs ? (
            <JsonBlock value={span.attributes} summary="Attributes" open />
          ) : (
            <EmptyState message="No attributes" />
          )}
        </Tabs.Content>

        <Tabs.Content value="events">
          {hasEvents ? (
            <ul className="detail-events">
              {span.events!.map((e, i) => (
                <li key={`${e.name}-${i}`}>
                  <JsonBlock value={e} summary={e.name} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState message="No events" />
          )}
        </Tabs.Content>
      </Tabs>
    </section>
  );
}
