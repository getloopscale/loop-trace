import { OtlpParseError } from "./otlp-error.js";

/**
 * Normalize an OTLP trace/span id to canonical lowercase hex, regardless of wire
 * encoding (resolves M0 review F-otlp-6). Mirrors langfuse's `parseId`
 * (OtelIngestionProcessor.ts:2914): the OTel JS SDK sends hex strings; the
 * Python SDK + the protobuf path yield byte arrays / Buffers → hex.
 *
 * KNOWN M1 LIMITATION (review F-otlp-1): the OTLP/JSON spec encodes ids as
 * base64 strings, but the dominant OTel JS SDK emits hex strings. This function
 * (like langfuse's parseId) treats ANY string as already-hex. So hex strings
 * (OTel-JS) and byte arrays (protobuf / Python SDK) normalize correctly, but a
 * spec-compliant OTLP/JSON client sending base64 ids would have them lowercased
 * as-is (not decoded). Deferred to a later milestone (detect base64 vs hex by
 * charset/length). For M1 the JSON path is exercised by hex-emitting SDKs and the
 * protobuf path by bytes, so the round-trip stays consistent.
 */
export function normalizeId(raw: unknown): string {
  if (typeof raw === "string") return raw.toLowerCase();

  let bytes: ArrayLike<number> | undefined;
  if (raw instanceof Uint8Array) {
    bytes = raw;
  } else if (Array.isArray(raw)) {
    bytes = raw;
  } else if (raw && typeof raw === "object" && "data" in raw) {
    const data = (raw as { data?: unknown }).data;
    if (data instanceof Uint8Array || Array.isArray(data)) bytes = data;
  }

  if (bytes === undefined) {
    throw new OtlpParseError("unrecognized OTLP id encoding");
  }
  return Buffer.from(bytes).toString("hex");
}
