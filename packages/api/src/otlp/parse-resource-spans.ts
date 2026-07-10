import {
  spanSchema,
  extractSpanEvents,
  extractEvaluations,
  selectAdapter,
  type Span,
} from "@usetheo/lens-core";

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

/** The OTLP partial-success outcome of parsing a batch — valid spans + how many were rejected.
 *  Mirrors the OTLP `ExportTracePartialSuccess` contract (rejected_spans + error_message). */
export interface ParseResourceSpansResult {
  spans: Span[];
  /** Number of spans that failed validation and were dropped (0 = full success). */
  rejected: number;
  /** The first per-span validation error (for the OTLP `error_message`); undefined when rejected=0. */
  firstError?: string;
}

/**
 * Map an OTLP/JSON envelope (`resourceSpans[].scopeSpans[].spans[]`) to validated domain {@link Span}s,
 * **totally** per span (M93): a malformed span is DROPPED and counted (never throws), so one bad span
 * does not reject a whole batch. The caller reports `rejected`/`firstError` as OTLP partial-success.
 * Envelope-shape leniency is unchanged (a non-array `resourceSpans` yields zero spans); the hard
 * trust-boundary 400 lives upstream in `decodeOtlpBody` (an undecodable body). See
 * `references/laminar/app-server/proto/opentelemetry/trace_service.proto:46-75`.
 */
export function parseResourceSpansPartial(envelope: unknown): ParseResourceSpansResult {
  const out: Span[] = [];
  let rejected = 0;
  let firstError: string | undefined;
  const resourceSpans = asArray(
    (envelope as { resourceSpans?: unknown } | null)?.resourceSpans,
  );
  for (const rs of resourceSpans) {
    // M15: pick the agent adapter once per resource (service.name is resource-level)
    // — Claude Code / future external agents map their own attribute convention;
    // an unknown producer falls back to the default (gen_ai/OpenInference) adapter.
    const resourceAttrs = flattenAttrs(
      (rs as { resource?: { attributes?: unknown } })?.resource?.attributes,
    );
    const adapter = selectAdapter(resourceAttrs);
    for (const ss of asArray((rs as { scopeSpans?: unknown })?.scopeSpans)) {
      for (const raw of asArray((ss as { spans?: unknown })?.spans)) {
        const r = raw as Record<string, unknown>;
        const status = r["status"] as
          | { code?: unknown; message?: unknown }
          | undefined;
        const attrs =
          r["attributes"] != null ? flattenAttrs(r["attributes"]) : undefined;
        // M12 (D3): OTLP span events are parsed (capped) — previously dropped. M34:
        // the adapter needs them — the tool result lives in a `tool.output` event.
        const events = extractSpanEvents(r["events"], flattenAttrs);
        const genai = adapter.extract(attrs, String(r["name"] ?? ""), events);
        // M12 (D2/EC-8): move-not-copy — when input/output text was actually
        // extracted (string path) into the capped typed field, delete the key
        // from the persisted bag so the uncapped duplicate never lands on disk.
        // A non-string input.value is NOT extracted, so it stays in the bag.
        if (attrs) {
          // The capped typed field is the single home for the text — strip every
          // source key (default `input.value`; Claude's `user_prompt`, M15; the M34
          // tool inputs `full_command`/`file_path`) so the uncapped duplicate never
          // persists in the bag (M12 invariant + PII bound).
          if (genai.inputValue !== undefined) {
            delete attrs["input.value"];
            delete attrs["user_prompt"];
            delete attrs["full_command"];
            delete attrs["file_path"];
          }
          if (genai.outputValue !== undefined) delete attrs["output.value"];
        }
        // M26: extract online-eval attributes (`eval.<name>.score/label/explanation`)
        // into typed evaluations + strip the matched keys (same move-not-copy seam as
        // GenAI). Total — a malformed eval attr is ignored, never fatal.
        const { evaluations, strippedKeys } = extractEvaluations(attrs);
        if (attrs) for (const k of strippedKeys) delete attrs[k];
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
          ...genai, // model/provider/tokens/inputValue/outputValue (only defined)
          ...(sessionIdOf(attrs) !== undefined
            ? { sessionId: sessionIdOf(attrs) }
            : {}),
          ...(events.length > 0 ? { events } : {}),
          ...(evaluations.length > 0 ? { evaluations } : {}),
          ...(attrs !== undefined ? { attributes: attrs } : {}),
        };
        const parsed = spanSchema.safeParse(candidate);
        if (!parsed.success) {
          // M93 — total per span: drop + count the malformed span (partial-success), never throw.
          rejected += 1;
          firstError ??= `invalid OTLP span: ${parsed.error.message}`;
          continue;
        }
        out.push(parsed.data);
      }
    }
  }
  return { spans: out, rejected, ...(firstError !== undefined ? { firstError } : {}) };
}

/**
 * Strict variant: throws {@link OtlpParseError} if ANY span is malformed (the pre-M93 behavior).
 * Retained for the seed/demo/SDK-contract callers that treat a bad fixture as a hard failure; the
 * OTLP ingest route uses {@link parseResourceSpansPartial} for per-span durability.
 */
export function parseResourceSpans(envelope: unknown): Span[] {
  const { spans, rejected, firstError } = parseResourceSpansPartial(envelope);
  if (rejected > 0) {
    throw new OtlpParseError(firstError ?? "invalid OTLP span");
  }
  return spans;
}
