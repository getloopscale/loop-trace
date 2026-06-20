import { spanSchema, extractGenAi, type Span } from "@usetheo/lens-core";

import { normalizeId } from "./normalize-id.js";
import { OtlpParseError } from "./otlp-error.js";

// Re-export so existing importers (`app.ts`, tests) keep their import path.
export { OtlpParseError } from "./otlp-error.js";

/**
 * Flatten an OTLP `AnyValue` wrapper to a plain JS value. Handles every oneof
 * kind: string/bool/int/double/bytes scalars, and the recursive arrayValue /
 * kvlistValue composites (mirrors the canonical receiver — list attributes like
 * `gen_ai.prompt` MUST become real JS arrays, not the raw `{values:[...]}` wrapper).
 * An unrecognized kind degrades to a JSON string, never an opaque wrapper object.
 */
function flattenValue(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  if ("stringValue" in v) return v["stringValue"];
  if ("boolValue" in v) return v["boolValue"];
  if ("intValue" in v) return v["intValue"]; // proto-json encodes int64 as string
  if ("doubleValue" in v) return v["doubleValue"];
  if ("bytesValue" in v) return v["bytesValue"]; // base64 string per OTLP/JSON
  if ("arrayValue" in v) {
    const values = (v["arrayValue"] as { values?: unknown } | null)?.values;
    return Array.isArray(values) ? values.map(flattenValue) : [];
  }
  if ("kvlistValue" in v) {
    const kvs = (v["kvlistValue"] as { values?: unknown } | null)?.values;
    const out: Record<string, unknown> = {};
    if (Array.isArray(kvs)) {
      for (const kv of kvs) {
        const e = kv as { key?: unknown; value?: unknown };
        if (typeof e.key === "string") out[e.key] = flattenValue(e.value);
      }
    }
    return out;
  }
  return JSON.stringify(v); // unknown AnyValue kind — never persist a raw wrapper
}

/** Flatten OTLP `attributes: [{key, value}]` to a `Record<string, unknown>`. */
function flattenAttrs(attrs: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(attrs)) return undefined;
  const out: Record<string, unknown> = {};
  for (const entry of attrs) {
    if (entry && typeof entry === "object") {
      const e = entry as { key?: unknown; value?: unknown };
      if (typeof e.key === "string") out[e.key] = flattenValue(e.value);
    }
  }
  return out;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Session id from a session attribute, when present (plan Q1; nullable otherwise). */
function sessionIdOf(
  attrs: Record<string, unknown> | undefined,
): string | undefined {
  if (!attrs) return undefined;
  const v = attrs["session.id"] ?? attrs["gen_ai.conversation.id"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Map an OTLP/JSON envelope (`resourceSpans[].scopeSpans[].spans[]`) to validated
 * domain {@link Span}s. Fail-fast: a malformed span throws {@link OtlpParseError}
 * (M0 rejects the whole batch; M1 may switch to OTLP partialSuccess semantics).
 */
export function parseResourceSpans(envelope: unknown): Span[] {
  const out: Span[] = [];
  const resourceSpans = asArray(
    (envelope as { resourceSpans?: unknown } | null)?.resourceSpans,
  );
  for (const rs of resourceSpans) {
    for (const ss of asArray((rs as { scopeSpans?: unknown })?.scopeSpans)) {
      for (const raw of asArray((ss as { spans?: unknown })?.spans)) {
        const r = raw as Record<string, unknown>;
        const status = r["status"] as
          | { code?: unknown; message?: unknown }
          | undefined;
        const attrs =
          r["attributes"] != null ? flattenAttrs(r["attributes"]) : undefined;
        const genai = extractGenAi(attrs);
        const candidate = {
          // Normalize all ids to canonical lowercase hex (resolves M0 F-otlp-6).
          spanId: normalizeId(r["spanId"]),
          traceId: normalizeId(r["traceId"]),
          name: r["name"],
          startTimeUnixNano:
            r["startTimeUnixNano"] != null
              ? String(r["startTimeUnixNano"])
              : undefined,
          endTimeUnixNano:
            r["endTimeUnixNano"] != null
              ? String(r["endTimeUnixNano"])
              : undefined,
          ...(r["parentSpanId"] != null
            ? { parentSpanId: normalizeId(r["parentSpanId"]) }
            : {}),
          ...(r["kind"] != null ? { kind: String(r["kind"]) } : {}),
          ...(status?.code != null ? { statusCode: String(status.code) } : {}),
          ...(status?.message != null
            ? { statusMessage: String(status.message) }
            : {}),
          ...genai, // model/provider/inputTokens/outputTokens (only defined)
          ...(sessionIdOf(attrs) !== undefined
            ? { sessionId: sessionIdOf(attrs) }
            : {}),
          ...(attrs !== undefined ? { attributes: attrs } : {}),
        };
        const parsed = spanSchema.safeParse(candidate);
        if (!parsed.success) {
          throw new OtlpParseError(`invalid OTLP span: ${parsed.error.message}`);
        }
        out.push(parsed.data);
      }
    }
  }
  return out;
}
