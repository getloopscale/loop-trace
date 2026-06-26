import { useState } from "react";
import { Tabs } from "@theokit/ui";
import type { SpanNodeData } from "../api/types.js";
import { durationMs, formatDuration } from "../lib/duration.js";
import { deriveKindFromSignals } from "../lib/span-kind.js";
import { KindBadge } from "./kind-badge.js";
import { EmptyState } from "./states.js";
import { JsonBlock } from "./JsonBlock.js";
import { AnnotationsPanel } from "./AnnotationsPanel.js";

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
  // M34: Claude Code perf/cost signals — rendered ONLY when present (absent for
  // other producers, so no "undefined" rows leak into a generic span's info).
  const hasTtft = span.ttftMs != null;
  const hasCache =
    span.cacheReadTokens != null || span.cacheCreationTokens != null;
  const hasEvents = span.events != null && span.events.length > 0;
  const hasEvals = span.evaluations != null && span.evaluations.length > 0;
  const hasAttrs =
    span.attributes != null && Object.keys(span.attributes).length > 0;
  // FE-02: derive from the span's own signals with hasChildren:false (a SpanNodeData
  // carries no subtree here), so this badge never resolves "chain" — matching the M18
  // list's deriveTraceListItemKind simplification. The left SpanTree glyph IS the
  // authoritative kind view (it has the full node with children); this badge is a hint.
  const kind = deriveKindFromSignals({
    operationName: strAttr(span.attributes, "gen_ai.operation.name"),
    // M34: typed `toolName` column wins (Claude Code's `tool_name`), attr is fallback.
    toolName: span.toolName ?? strAttr(span.attributes, "gen_ai.tool.name"),
    model: span.model ?? undefined,
    hasChildren: false,
  });

  return (
    <section aria-label="span info" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <KindBadge kind={kind} />
        <h2 className="text-title-md font-display">{span.name}</h2>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <Tabs.List>
          <Tabs.Trigger value="info">Trace Info</Tabs.Trigger>
          <Tabs.Trigger value="attributes">Attributes</Tabs.Trigger>
          <Tabs.Trigger value="events">Events</Tabs.Trigger>
          <Tabs.Trigger value="evaluations">Evaluations</Tabs.Trigger>
          <Tabs.Trigger value="annotations">Annotations</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="info">
          <div className="flex flex-col gap-1 text-sm">
            <span>
              Status:{" "}
              <span aria-label={`status: ${span.statusCode ?? "unknown"}`}>
                {span.statusCode ?? "—"}
              </span>
            </span>
            <span>Duration: {formatDuration(dur)}</span>
          </div>
          <h3 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Model
          </h3>
          {hasModel ? (
            <p className="text-sm">
              {span.model ?? "—"}
              {span.provider ? ` (${span.provider})` : ""}
            </p>
          ) : (
            <EmptyState message="No model recorded" />
          )}
          <h3 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Tokens
          </h3>
          {hasTokens ? (
            <p className="text-sm">
              in {span.inputTokens ?? 0} / out {span.outputTokens ?? 0}
            </p>
          ) : (
            <EmptyState message="No token usage" />
          )}
          {hasTtft && (
            <>
              <h3 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                TTFT
              </h3>
              <p className="text-sm">{formatDuration(span.ttftMs!)}</p>
            </>
          )}
          {hasCache && (
            <>
              <h3 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Cache tokens
              </h3>
              <p className="text-sm">
                read {span.cacheReadTokens ?? 0} / created{" "}
                {span.cacheCreationTokens ?? 0}
              </p>
            </>
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
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
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

        <Tabs.Content value="evaluations">
          {hasEvals ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {span.evaluations!.map((ev, i) => (
                <li
                  key={`${ev.name}-${i}`}
                  className="flex flex-col gap-1 rounded-md border border-border bg-card p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-label font-display">{ev.name}</span>
                    <span className="flex items-center gap-2 text-body-sm">
                      {ev.label != null ? (
                        <span className="rounded-full border border-border px-2 py-0.5">
                          {ev.label}
                        </span>
                      ) : null}
                      {ev.score != null ? (
                        <span className="font-display tabular-nums">
                          {ev.score.toFixed(2)}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  {ev.explanation != null ? (
                    <p className="text-body-sm text-muted-foreground">
                      {ev.explanation}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState message="No evaluations" />
          )}
        </Tabs.Content>

        <Tabs.Content value="annotations">
          {/* M26b: writable human feedback (👍/👎 + note) for the selected span. */}
          <AnnotationsPanel traceId={span.traceId} spanId={span.spanId} />
        </Tabs.Content>
      </Tabs>
    </section>
  );
}
