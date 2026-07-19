import { useEffect, useRef, useState } from "react";

/**
 * Free-text "Filter spans" bar (M30 — Arize live-parity). Types a span-query DSL
 * (`kind:llm status:error model:gpt-4o name:"…"`) that the server parses; debounced
 * (300ms, own timer, cleaned up on unmount — same shape as the M9 model/tag inputs) so
 * typing does not fire a request per keystroke. An empty bar is "no filter" → emits
 * `undefined`, not "". Token-styled, labelled, keyboard-operable. No raw hex.
 * (The structured "Add Filter" builder is M30b.)
 */
const fieldCls =
  "rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
const labelCls = "flex flex-col gap-1 text-xs text-muted-foreground";

export function SpanFilterBar({
  value,
  onChange,
}: {
  value?: string | undefined;
  onChange: (spanQuery: string | undefined) => void;
}) {
  const [input, setInput] = useState(value ?? "");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => setInput(value ?? ""), [value]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onInput = (next: string) => {
    setInput(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const trimmed = next.trim();
      onChange(trimmed.length > 0 ? trimmed : undefined);
    }, 300);
  };

  return (
    <label className={labelCls}>
      <span>Filter spans</span>
      <input
        type="text"
        aria-label="filter spans"
        placeholder='kind:llm status:error model:gpt-4o name:"…"'
        value={input}
        onChange={(e) => onInput(e.target.value)}
        className={`${fieldCls} min-w-80`}
      />
    </label>
  );
}
