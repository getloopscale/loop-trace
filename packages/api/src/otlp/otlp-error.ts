/** Thrown when an OTLP envelope/value cannot be parsed or normalized. */
export class OtlpParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OtlpParseError";
  }
}
