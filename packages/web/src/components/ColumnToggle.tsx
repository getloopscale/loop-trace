/**
 * Columns menu (M29d — Arize live-parity `Select tracing table columns`). A native
 * `<details>` disclosure (jsdom-stable, keyboard-operable, no Radix) listing a
 * checkbox per toggleable executions column; checked = visible. The `name` column is
 * never passed in (always-on), so the table can never be fully blanked. Token-styled,
 * no raw hex.
 */
const fieldCls =
  "rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";

export function ColumnToggle({
  columns,
  hidden,
  onToggle,
}: {
  columns: { key: string; label: string }[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <details className="relative">
      <summary className={`${fieldCls} inline-flex cursor-pointer list-none items-center`}>
        Columns
      </summary>
      <div
        role="group"
        aria-label="toggle columns"
        className="absolute right-0 z-10 mt-1 flex min-w-40 flex-col gap-1 rounded-md border border-border bg-background p-2 shadow-lg"
      >
        {columns.map((c) => (
          <label
            key={c.key}
            className="flex items-center gap-2 text-sm text-foreground"
          >
            <input
              type="checkbox"
              checked={!hidden.has(c.key)}
              onChange={() => onToggle(c.key)}
              className="accent-primary"
            />
            {c.label}
          </label>
        ))}
      </div>
    </details>
  );
}
