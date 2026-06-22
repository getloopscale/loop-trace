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
      className="copy-button"
      onClick={onCopy}
      disabled={!available}
      aria-label={label}
    >
      {copied ? "Copied" : label}
    </button>
  );
}
