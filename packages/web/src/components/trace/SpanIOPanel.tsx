import { useState } from "react";
import type { SpanNodeData } from "../../api/types.js";
import { isErrorStatus } from "../../lib/span-kind.js";
import { EmptyState } from "../primitives/States.js";
import { MarkdownText } from "../primitives/MarkdownText.js";

/**
 * Right pane of the trace 3-pane (M19): the selected span's Input/Output — the
 * primary read. A Pretty/Raw toggle (M29d — Arize live-parity) switches between
 * rendered markdown (Pretty, default; XSS-safe MarkdownText — never
 * dangerouslySetInnerHTML) and the exact unrendered string (Raw; a `<pre>` text node,
 * which React escapes — also XSS-safe). An errored span surfaces a role=alert with its
 * status message. Each section degrades to an EmptyState (backward-compat, M12 DoD#3).
 */
type DisplayFormat = "pretty" | "raw";

const toggleBtn =
  "rounded px-2 py-0.5 text-xs transition-colors aria-[pressed=true]:bg-muted aria-[pressed=true]:text-foreground text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";

function Section({ label, value, format }: { label: string; value: string | undefined; format: DisplayFormat }) {
  const has = value != null && value.length > 0;
  return (
    <>
      <h3 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </h3>
      {has ? (
        format === "pretty" ? (
          <MarkdownText text={value!} />
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-body-sm text-foreground">
            {value}
          </pre>
        )
      ) : (
        <EmptyState message={`No ${label.toLowerCase()} recorded`} />
      )}
    </>
  );
}

export function SpanIOPanel({ span }: { span: SpanNodeData }) {
  const [format, setFormat] = useState<DisplayFormat>("pretty");

  return (
    <section aria-label="span input/output" className="flex flex-col gap-2">
      <div role="group" aria-label="display format" className="flex items-center gap-1 self-end">
        {(["pretty", "raw"] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={toggleBtn}
            aria-pressed={format === f}
            onClick={() => setFormat(f)}
          >
            {f === "pretty" ? "Pretty" : "Raw"}
          </button>
        ))}
      </div>

      <Section label="Input" value={span.inputValue} format={format} />
      <Section label="Output" value={span.outputValue} format={format} />

      {isErrorStatus(span.statusCode) && (
        <div
          role="alert"
          className="mt-4 rounded-md bg-destructive/10 p-3 text-destructive"
        >
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide">
            Error
          </h3>
          <p>{span.statusMessage ?? "Span ended with ERROR status"}</p>
        </div>
      )}
    </section>
  );
}
