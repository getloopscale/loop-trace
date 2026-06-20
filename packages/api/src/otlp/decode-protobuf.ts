import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";

import { OtlpParseError } from "./otlp-error.js";

/**
 * Decode an OTLP request body (JSON or protobuf, optionally gzip-compressed) into
 * the `{ resourceSpans }` envelope that `parseResourceSpans` consumes.
 *
 * NOTE (course-correction from blueprint ADR D1): `@opentelemetry/otlp-transformer`'s
 * public `ProtobufTraceSerializer` is client-side (serializeRequest + deserializeResponse)
 * and does NOT expose request decoding. We reuse the package's generated protobuf
 * `ExportTraceServiceRequest` (Apache-2.0, maintained) via a deep `require` — the
 * package declares no `exports` map, so this resolves to the file directly. The
 * decode is isolated here and pinned by contract tests, so a version path-drift
 * surfaces immediately in CI rather than in production.
 */
const require = createRequire(import.meta.url);

interface ProtoType {
  decode(buf: Uint8Array): unknown;
  toObject(
    msg: unknown,
    opts?: Record<string, unknown>,
  ): { resourceSpans?: unknown };
}

let cachedType: ProtoType | undefined;
function exportTraceServiceRequestType(): ProtoType {
  if (cachedType) return cachedType;
  try {
    const root = require(
      "@opentelemetry/otlp-transformer/build/esm/generated/root.js",
    ) as {
      opentelemetry: {
        proto: { collector: { trace: { v1: { ExportTraceServiceRequest: ProtoType } } } };
      };
    };
    cachedType = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
    return cachedType;
  } catch (err) {
    throw new OtlpParseError(
      "OTLP protobuf decoder unavailable (otlp-transformer generated proto not found)",
      { cause: err },
    );
  }
}

/** Decode an OTLP request body to the `{ resourceSpans }` envelope. */
export function decodeOtlpBody(
  body: Buffer,
  contentType: string,
  contentEncoding?: string,
): unknown {
  let buf = body;
  if (contentEncoding?.toLowerCase().includes("gzip")) {
    try {
      buf = gunzipSync(buf);
    } catch (err) {
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
      return type.toObject(decoded, { defaults: false });
    } catch (err) {
      if (err instanceof OtlpParseError) throw err;
      throw new OtlpParseError("failed to decode OTLP protobuf body", {
        cause: err,
      });
    }
  }
  throw new OtlpParseError(`unsupported content-type: ${contentType}`);
}

/** Encode a `{ resourceSpans }` envelope to protobuf bytes (test fixture helper). */
export function encodeOtlpProtobuf(envelope: {
  resourceSpans: unknown[];
}): Buffer {
  const root = require(
    "@opentelemetry/otlp-transformer/build/esm/generated/root.js",
  ) as {
    opentelemetry: {
      proto: {
        collector: {
          trace: {
            v1: {
              ExportTraceServiceRequest: {
                fromObject(o: unknown): unknown;
                encode(m: unknown): { finish(): Uint8Array };
              };
            };
          };
        };
      };
    };
  };
  const T = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
  return Buffer.from(T.encode(T.fromObject(envelope)).finish());
}
