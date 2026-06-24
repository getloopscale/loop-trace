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
    <details className="my-1" open={open}>
      <summary className="cursor-pointer text-xs text-muted-foreground">
        {summary}
      </summary>
      <div className="relative mt-1">
        <span className="absolute right-1 top-1 z-10">
          <CopyButton text={json} label="Copy JSON" />
        </span>
        <pre className="overflow-auto rounded-md bg-muted p-3 text-xs text-foreground">
          {json}
        </pre>
      </div>
    </details>
  );
}
