import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";

import { OtlpParseError, OtlpTooLargeError } from "./otlp-error.js";

/** M93 — default bound on the DECOMPRESSED OTLP body (a gzip-bomb guard). Above the raw-body cap
 *  since gzip legitimately inflates; overridable per-call (the route reads it from env). */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024;

/**
 * Decode an OTLP request body (JSON or protobuf, optionally gzip-compressed) into
 * the `{ resourceSpans }` envelope that `parseResourceSpans` consumes.
 *
 * NOTE (course-correction from blueprint ADR D1): `@opentelemetry/otlp-transformer`'s
 * public `ProtobufTraceSerializer` is client-side (serializeRequest + deserializeResponse)
 * and does NOT expose request decoding. We reuse the package's generated protobuf
 * `ExportTraceServiceRequest` (Apache-2.0, maintained) via a single deep `require` —
 * the package declares no `exports` map, so this resolves to the file directly. The
 * dependency is pinned (`~0.205.0`) so an internal-path move arrives only via a
 * reviewed bump, and the decode is isolated here + pinned by contract tests.
 */
const require = createRequire(import.meta.url);

export interface ExportTraceServiceRequestType {
  decode(buf: Uint8Array): unknown;
  toObject(
    msg: unknown,
    opts?: Record<string, unknown>,
  ): { resourceSpans?: unknown };
  fromObject(o: unknown): unknown;
  encode(m: unknown): { finish(): Uint8Array };
}

let cachedType: ExportTraceServiceRequestType | undefined;

/** Resolve the generated `ExportTraceServiceRequest` proto type (single fragile site). */
export function exportTraceServiceRequestType(): ExportTraceServiceRequestType {
  if (cachedType) return cachedType;
  try {
    const root = require(
      "@opentelemetry/otlp-transformer/build/esm/generated/root.js",
    ) as {
      opentelemetry: {
        proto: {
          collector: {
            trace: { v1: { ExportTraceServiceRequest: ExportTraceServiceRequestType } };
          };
        };
      };
    };
    cachedType =
      root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
    return cachedType;
  } catch (err) {
    throw new OtlpParseError(
      "OTLP protobuf decoder unavailable (otlp-transformer generated proto not found)",
      { cause: err },
    );
  }
}

/** Decode an OTLP request body to the `{ resourceSpans }` envelope. The gzip path is bounded to
 *  `opts.maxDecompressedBytes` (default {@link DEFAULT_MAX_DECOMPRESSED_BYTES}) — a gzip-bomb that
 *  inflates past the bound throws {@link OtlpTooLargeError} (→ 413), distinct from a corrupt stream (→ 400). */
export function decodeOtlpBody(
  body: Buffer,
  contentType: string,
  contentEncoding?: string,
  opts?: { maxDecompressedBytes?: number },
): unknown {
  let buf = body;
  if (contentEncoding?.toLowerCase().includes("gzip")) {
    const maxOutputLength = opts?.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
    try {
      buf = gunzipSync(buf, { maxOutputLength });
    } catch (err) {
      // Node throws ERR_BUFFER_TOO_LARGE when the inflated output exceeds maxOutputLength — a
      // gzip-bomb (well-formed but too big) → 413, NOT a corrupt-stream 400.
      if ((err as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE") {
        throw new OtlpTooLargeError(
          `OTLP body decompresses past the ${maxOutputLength}-byte limit`,
          { cause: err },
        );
      }
      throw new OtlpParseError("failed to gunzip OTLP body", { cause: err });
    }
  }

  const ct = contentType.toLowerCase();
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(buf.toString("utf8"));
    } catch (err) {
      throw new OtlpParseError("failed to parse OTLP JSON body", { cause: err });
    }
  }
  if (ct.includes("application/x-protobuf")) {
    try {
      const type = exportTraceServiceRequestType();
      const decoded = type.decode(new Uint8Array(buf));
      // longs:String guarantees 64-bit nano timestamps stay precise strings,
      // independent of protobuf-js Long defaults (review F-otlp-9).
      return type.toObject(decoded, { defaults: false, longs: String });
    } catch (err) {
      if (err instanceof OtlpParseError) throw err;
      throw new OtlpParseError("failed to decode OTLP protobuf body", {
        cause: err,
      });
    }
  }
  throw new OtlpParseError(`unsupported content-type: ${contentType}`);
}
