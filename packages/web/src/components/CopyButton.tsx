import { useState } from "react";

/**
 * Copy `text` to the clipboard (M12). Guarded (EC-5): when `navigator.clipboard`
 * is unavailable (non-secure context / older runtime / jsdom) the click is a
 * no-op and NEVER throws into render. Shows a transient "Copied" confirmation.
 */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const available = typeof navigator !== "undefined" && !!navigator.clipboard?.writeText;

  function onCopy(): void {
    if (!available) return; // EC-5: guarded no-op
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => {
        /* clipboard denied — fail-soft, never throw */
      });
  }

  return (
    <button
      type="button"
      className="inline-flex items-center rounded-md border border-border bg-background px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
      onClick={onCopy}
      disabled={!available}
      aria-label={label}
    >
      {copied ? "Copied" : label}
    </button>
  );
}
