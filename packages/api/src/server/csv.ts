import type { TraceListItem } from "@looptrace/core";

/** The exported columns (a fixed, small set — hand-serialized, no CSV lib needed). */
const COLUMNS = [
  "traceId",
  "name",
  "statusCode",
  "durationMs",
  "totalTokens",
] as const;

/**
 * Serialize one CSV field: RFC-4180 quoting (wrap in `"`, double internal `"`)
 * AND a CSV-injection guard — a value starting with `= + - @` is prefixed with a
 * single quote so a spreadsheet does not evaluate it as a live formula.
 */
function csvField(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Serialize the trace list to CSV (header + one row per trace). The columns are
 * the stable `TraceListItem` fields; every field is quoted + injection-guarded.
 * CRLF line endings per RFC 4180.
 */
export function tracesToCsv(items: TraceListItem[]): string {
  const header = COLUMNS.join(",");
  const rows = items.map((it) =>
    COLUMNS.map((col) =>
      csvField((it as Record<string, unknown>)[col]),
    ).join(","),
  );
  return [header, ...rows].join("\r\n") + "\r\n";
}
