/** Thrown when an OTLP envelope/value cannot be parsed or normalized. */
export class OtlpParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OtlpParseError";
  }
}

/**
 * M93 — thrown when an OTLP body decompresses past the configured bound (a gzip-bomb). Distinct from
 * {@link OtlpParseError} so the route maps it to **413 Payload Too Large**, not 400 — the input is
 * well-formed-but-too-big, not corrupt.
 */
export class OtlpTooLargeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OtlpTooLargeError";
  }
}
