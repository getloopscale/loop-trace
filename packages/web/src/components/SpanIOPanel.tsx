import type { SpanNodeData } from "../api/types.js";
import { isErrorStatus } from "../lib/span-kind.js";
import { EmptyState } from "./states.js";
import { MarkdownText } from "./MarkdownText.js";

/**
 * Right pane of the trace 3-pane (M19): the selected span's Input/Output — the
 * primary read. Rendered as XSS-safe markdown (M12 MarkdownText; never
 * dangerouslySetInnerHTML). An errored span surfaces a role=alert with its status
 * message. Each section degrades to an EmptyState (backward-compat, M12 DoD#3).
 */
export function SpanIOPanel({ span }: { span: SpanNodeData }) {
  const hasInput = span.inputValue != null && span.inputValue.length > 0;
  const hasOutput = span.outputValue != null && span.outputValue.length > 0;

  return (
    <section aria-label="span input/output" className="span-detail flex flex-col gap-2">
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

      {isErrorStatus(span.statusCode) && (
        <div role="alert" className="detail-error">
          <h3>Error</h3>
          <p>{span.statusMessage ?? "Span ended with ERROR status"}</p>
        </div>
      )}
    </section>
  );
}
