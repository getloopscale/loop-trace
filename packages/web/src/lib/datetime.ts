/**
 * Format an ISO-8601 timestamp as a human-readable local date-time, e.g.
 * "2026-06-22T01:00:00.000Z" → "Jun 22, 2026, 1:00 AM" (locale-dependent). An
 * unparseable value falls back to the raw string (never throws into render).
 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
