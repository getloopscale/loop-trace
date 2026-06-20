import type { SpanNodeData } from "../api/types.js";
import { durationMs, formatDuration } from "../lib/duration.js";
import { EmptyState } from "./states.js";

function isErrorStatus(code?: string): boolean {
  return code === "2" || code === "ERROR";
}

/** Pretty-print attributes; never throw into render on a non-serializable value. */
function prettyAttributes(attrs: Record<string, unknown>): string {
  try {
    return JSON.stringify(attrs, null, 2);
  } catch {
    return String(attrs);
  }
}

/**
 * Detail panel for a selected span (M3 DoD #2). Fixed sections — Overview / Model
 * / Tokens / Attributes (the raw gen_ai bag: prompt/output/tool/metadata) / Error.
 * Each data section degrades to an EmptyState when the span carries no such data.
 */
export function SpanDetail({ span }: { span: SpanNodeData }) {
  const dur = durationMs(span.startTimeUnixNano, span.endTimeUnixNano);
  const hasModel = span.model != null || span.provider != null;
  const hasTokens = span.inputTokens != null || span.outputTokens != null;
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

      <h3>Attributes</h3>
      {hasAttrs ? (
        <pre className="detail-attributes">{prettyAttributes(span.attributes!)}</pre>
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
