import type { SpanNodeData } from "../api/types.js";
import { durationMs, formatDuration } from "../lib/duration.js";
import { isErrorStatus } from "../lib/span-kind.js";
import { EmptyState } from "./states.js";
import { MarkdownText } from "./MarkdownText.js";
import { JsonBlock } from "./JsonBlock.js";

/**
 * Detail panel for a selected span (M3 → M12). Distinct sections — Overview /
 * Model / Tokens / Input / Output / Events / Attributes / Error. Input & output
 * render as XSS-safe markdown (M12 D4); events & attributes as collapsible
 * JSON-with-copy. Every data section degrades to an EmptyState when the span
 * carries no such data (backward-compatible — DoD#3).
 */
export function SpanDetail({ span }: { span: SpanNodeData }) {
  const dur = durationMs(span.startTimeUnixNano, span.endTimeUnixNano);
  const hasModel = span.model != null || span.provider != null;
  const hasTokens = span.inputTokens != null || span.outputTokens != null;
  const hasInput = span.inputValue != null && span.inputValue.length > 0;
  const hasOutput = span.outputValue != null && span.outputValue.length > 0;
  const hasEvents = span.events != null && span.events.length > 0;
  const hasAttrs =
    span.attributes != null && Object.keys(span.attributes).length > 0;

  return (
    <section aria-label="span detail" className="span-detail">
      <h2>{span.name}</h2>
      <div className="detail-overview">
        <span>Status: {span.statusCode ?? "—"}</span>
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

      <h3>Input</h3>
      {hasInput ? (
        <MarkdownText text={span.inputValue!} />
      ) : (
        <EmptyState message="No input recorded" />
      )}

      <h3>Output</h3>
      {hasOutput ? (
        <MarkdownText text={span.outputValue!} />
      ) : (
        <EmptyState message="No output recorded" />
      )}

      <h3>Events</h3>
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

      <h3>Attributes</h3>
      {hasAttrs ? (
        <JsonBlock value={span.attributes} summary="Attributes" open />
      ) : (
        <EmptyState message="No attributes" />
      )}

      {isErrorStatus(span.statusCode) && (
        <div role="alert" className="detail-error">
          <h3>Error</h3>
          <p>{span.statusMessage ?? "Span ended with ERROR status"}</p>
        </div>
      )}
    </section>
  );
}
