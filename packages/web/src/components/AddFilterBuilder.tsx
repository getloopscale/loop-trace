import { useState } from "react";

/**
 * Structured "Add Filter" builder (M30b — Arize live-parity). A field `<select>` +
 * a value control (an enum `<select>` for kind/status; a text input for name/model)
 * + an "Add filter" button that APPENDS `field:value` to the shared span-query string
 * (D3 — one source of truth: the free-text bar and this builder edit the same string).
 * Values with whitespace are quoted (`name:"Chat Open AI"`). Native `<select>` (Radix
 * is jsdom-flaky — M24 lesson). Token-styled, labelled, keyboard-operable. No raw hex.
 */
type Field = "kind" | "name" | "status" | "model";

// Web-local mirrors of the core span-query whitelist (the web is decoupled from core).
const FIELDS: Field[] = ["kind", "name", "status", "model"];
const KIND_VALUES = ["llm", "tool", "retriever", "embedding", "chain", "unknown"];
const STATUS_VALUES = ["ok", "error"];

/** Enum options for a dropdown field, or null when the field takes free text. */
function optionsFor(field: Field): string[] | null {
  if (field === "kind") return KIND_VALUES;
  if (field === "status") return STATUS_VALUES;
  return null; // name / model → free text
}

/** Default value when a field is (re)selected: first enum value, or "" for text. */
function defaultValue(field: Field): string {
  return optionsFor(field)?.[0] ?? "";
}

/** Append `field:value` to the current query (quote a value containing whitespace). */
function appendClause(current: string, field: Field, value: string): string {
  const quoted = /\s/.test(value) ? `"${value}"` : value;
  const clause = `${field}:${quoted}`;
  return current ? `${current} ${clause}` : clause;
}

const fieldCls =
  "rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
const btnCls =
  "rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";

export function AddFilterBuilder({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [field, setField] = useState<Field>("kind");
  const [fieldValue, setFieldValue] = useState<string>(defaultValue("kind"));
  const options = optionsFor(field);

  function changeField(next: Field): void {
    setField(next);
    setFieldValue(defaultValue(next));
  }
  function add(): void {
    onChange(appendClause(value, field, fieldValue));
    setFieldValue(defaultValue(field));
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span>Field</span>
        <select
          aria-label="filter field"
          value={field}
          onChange={(e) => changeField(e.target.value as Field)}
          className={fieldCls}
        >
          {FIELDS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span>Value</span>
        {options ? (
          <select
            aria-label="filter value"
            value={fieldValue}
            onChange={(e) => setFieldValue(e.target.value)}
            className={fieldCls}
          >
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            aria-label="filter value"
            placeholder={field === "model" ? "gpt-4o" : "span name"}
            value={fieldValue}
            onChange={(e) => setFieldValue(e.target.value)}
            className={fieldCls}
          />
        )}
      </label>
      <button
        type="button"
        className={btnCls}
        onClick={add}
        disabled={fieldValue.trim().length === 0}
      >
        Add filter
      </button>
    </div>
  );
}
