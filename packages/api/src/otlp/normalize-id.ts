import { OtlpParseError } from "./otlp-error.js";

/**
 * Normalize an OTLP trace/span id to canonical lowercase hex, regardless of wire
 * encoding (resolves M0 review F-otlp-6). Mirrors langfuse's `parseId`
 * (OtelIngestionProcessor.ts:2914): the OTel JS SDK sends hex strings; the
 * Python SDK + the protobuf path yield byte arrays / Buffers → hex.
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
