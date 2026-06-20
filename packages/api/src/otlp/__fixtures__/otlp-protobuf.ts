import { exportTraceServiceRequestType } from "../decode-protobuf.js";

/**
 * TEST FIXTURE — encode a `{ resourceSpans }` envelope to OTLP protobuf bytes,
 * reusing the same generated proto type the decoder uses. Lives under
 * `__fixtures__/` (excluded from the production build) so the prod `decode-protobuf`
 * module exposes only `decodeOtlpBody` (review F-wiring-2).
 */
export function encodeOtlpProtobuf(envelope: {
  resourceSpans: unknown[];
}): Buffer {
  const type = exportTraceServiceRequestType();
  return Buffer.from(type.encode(type.fromObject(envelope)).finish());
}
