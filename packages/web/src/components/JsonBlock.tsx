import { CopyButton } from "./CopyButton.js";

/** Pretty-print a value; never throw into render on a non-serializable value. */
function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * A collapsible JSON view with copy-to-clipboard (M12 D4). Uses a native
 * `<details>` (no JS state, keyboard-accessible by default) + a `<pre>` of
 * pretty-printed JSON. Values render as escaped text (React) — never as HTML —
 * so a structured value can carry no XSS.
 */
export function JsonBlock({
  value,
  summary,
  open = false,
}: {
  value: unknown;
  summary: string;
  open?: boolean;
}) {
  const json = pretty(value);
  return (
    <details className="json-block" open={open}>
      <summary>{summary}</summary>
      <div className="json-block-body">
        <CopyButton text={json} label="Copy JSON" />
        <pre className="json-block-pre">{json}</pre>
      </div>
    </details>
  );
}
