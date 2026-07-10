import { gzipSync } from "node:zlib";
import { describe, it, expect } from "vitest";
import { decodeOtlpBody } from "./decode-protobuf.js";
import { encodeOtlpProtobuf } from "./__fixtures__/otlp-protobuf.js";
import { OtlpParseError, OtlpTooLargeError } from "./otlp-error.js";

const jsonEnvelope = {
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: [
            {
              name: "op",
              traceId: "0102",
              spanId: "0304",
              startTimeUnixNano: "100",
              endTimeUnixNano: "200",
            },
          ],
        },
      ],
    },
  ],
};

function asArr(v: unknown): unknown[] {
  return ((v as { resourceSpans?: unknown[] }).resourceSpans ?? []) as unknown[];
}

describe("decodeOtlpBody", () => {
  it("decode_json_returns_resourceSpans", () => {
    const out = decodeOtlpBody(
      Buffer.from(JSON.stringify(jsonEnvelope)),
      "application/json",
    );
    expect(asArr(out)).toHaveLength(1);
  });

  it("decode_gzip_json_inflates_then_parses", () => {
    const gz = gzipSync(Buffer.from(JSON.stringify(jsonEnvelope)));
    const out = decodeOtlpBody(gz, "application/json", "gzip");
    expect(asArr(out)).toHaveLength(1);
  });

  it("decode_protobuf_bytes_returns_resourceSpans", () => {
    // EC-2: encode a known envelope via the transformer proto, then decode it.
    const bytes = encodeOtlpProtobuf({
      resourceSpans: [
        { scopeSpans: [{ spans: [{ name: "op", traceId: Buffer.from([1, 2]), spanId: Buffer.from([3, 4]) }] }] },
      ],
    });
    const out = decodeOtlpBody(bytes, "application/x-protobuf");
    const rs = asArr(out) as Array<{
      scopeSpans: Array<{ spans: Array<{ name: string }> }>;
    }>;
    expect(rs).toHaveLength(1);
    expect(rs[0]?.scopeSpans[0]?.spans[0]?.name).toBe("op");
  });

  it("decode_corrupt_gzip_throws_OtlpParseError", () => {
    expect(() =>
      decodeOtlpBody(Buffer.from("not gzip"), "application/json", "gzip"),
    ).toThrow(OtlpParseError);
  });

  it("M93_decode_gzip_bomb_over_limit_throws_OtlpTooLargeError", () => {
    // a highly-compressible 1 MiB payload gzips to ~KB but inflates past a tiny maxDecompressed cap
    const big = gzipSync(Buffer.alloc(1024 * 1024, 0x61)); // 1 MiB of 'a' → a few KB gzipped
    expect(() =>
      decodeOtlpBody(big, "application/json", "gzip", { maxDecompressedBytes: 4096 }),
    ).toThrow(OtlpTooLargeError);
    // it is NOT a generic parse error — the route maps this to 413, not 400
    expect(() =>
      decodeOtlpBody(big, "application/json", "gzip", { maxDecompressedBytes: 4096 }),
    ).not.toThrow(/gunzip/i);
  });

  it("M93_decode_gzip_under_limit_still_parses", () => {
    const gz = gzipSync(Buffer.from(JSON.stringify(jsonEnvelope)));
    const out = decodeOtlpBody(gz, "application/json", "gzip", { maxDecompressedBytes: 1024 * 1024 });
    expect(asArr(out)).toHaveLength(1);
  });

  it("decode_unsupported_content_type_throws", () => {
    expect(() =>
      decodeOtlpBody(Buffer.from("x"), "text/csv"),
    ).toThrow(OtlpParseError);
  });

  it("decode_malformed_protobuf_throws_OtlpParseError", () => {
    expect(() =>
      decodeOtlpBody(Buffer.from([0xff, 0xff, 0xff, 0xff]), "application/x-protobuf"),
    ).toThrow(OtlpParseError);
  });
});
