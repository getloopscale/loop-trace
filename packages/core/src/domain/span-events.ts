/**
 * Span input/output + events extraction with size caps (M12 ADR D2/D3/D5).
 *
 * Caps are enforced here (pure, unit-testable) and applied at the ingest trust
 * boundary so unbounded prompt/response blobs and event floods never persist
 * (risk #1). Text is capped on Unicode code points (not UTF-16 code units) so a
 * truncation never leaves a lone surrogate that would be invalid UTF-8 to pg (EC-2).
 */

/** Max stored chars (code points) for input/output text. */
export const INPUT_OUTPUT_CAP = 8192;
/** Max stored span events per span. */
export const MAX_EVENTS = 50;
/** Max serialized chars for a single event's attributes (EC-3). */
export const EVENT_ATTRS_CAP = 4096;

const TRUNCATION_MARKER = "…[truncated]";

/**
 * Truncate `text` to at most `cap` Unicode code points, appending a marker when
 * truncated. Splitting on code points (via the spread iterator) guarantees no
 * lone surrogate is left behind (EC-2). A non-truncated string is returned as-is.
 */
export function capText(text: string, cap: number = INPUT_OUTPUT_CAP): string {
  const points = [...text];
  if (points.length <= cap) return text;
  return points.slice(0, cap).join("") + TRUNCATION_MARKER;
}

/** A normalized span event ready for the `events` jsonb column. */
export interface SpanEvent {
  name: string;
  timeUnixNano?: string;
  attributes?: Record<string, unknown>;
}

/**
 * Normalize raw OTLP span events (already attribute-flattened by the caller) into
 * capped {@link SpanEvent}s: at most {@link MAX_EVENTS}, each event's attributes
 * serialized-size-bounded (EC-3). Non-array / malformed input → empty array.
 */
export function extractSpanEvents(
  rawEvents: unknown,
  flattenAttrs: (attrs: unknown) => Record<string, unknown> | undefined,
  cap: number = MAX_EVENTS,
): SpanEvent[] {
  if (!Array.isArray(rawEvents)) return [];
  const out: SpanEvent[] = [];
  for (const raw of rawEvents.slice(0, cap)) {
    if (raw == null || typeof raw !== "object") continue;
    const e = raw as { name?: unknown; timeUnixNano?: unknown; attributes?: unknown };
    if (typeof e.name !== "string") continue;
    const event: SpanEvent = { name: e.name };
    if (e.timeUnixNano != null) event.timeUnixNano = String(e.timeUnixNano);
    const attrs = e.attributes != null ? flattenAttrs(e.attributes) : undefined;
    if (attrs && Object.keys(attrs).length > 0) {
      event.attributes = boundAttrs(attrs);
    }
    out.push(event);
  }
  return out;
}

/**
 * Bound a single event's attributes by total serialized size (EC-3). When the
 * JSON exceeds {@link EVENT_ATTRS_CAP}, collapse to a single truncated marker
 * attribute rather than persisting an unbounded blob.
 */
function boundAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  let serialized: string;
  try {
    serialized = JSON.stringify(attrs);
  } catch {
    return { __unserializable: true };
  }
  // Measure in code points (consistent with capText's truncation unit).
  if ([...serialized].length <= EVENT_ATTRS_CAP) return attrs;
  return { __truncated: capText(serialized, EVENT_ATTRS_CAP) };
}
