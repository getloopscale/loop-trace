import { describe, it, expect } from "vitest";
import { normalizeId } from "./normalize-id.js";
import { OtlpParseError } from "./otlp-error.js";

describe("normalizeId", () => {
  it("normalizeId_passes_through_hex_string_lowercased", () => {
    expect(normalizeId("2CCE18F7E8CD065A")).toBe("2cce18f7e8cd065a");
  });

  it("normalizeId_converts_byte_array_to_hex", () => {
    expect(normalizeId([44, 206, 24, 247])).toBe("2cce18f7");
  });

  it("normalizeId_converts_uint8array_to_hex", () => {
    expect(normalizeId(new Uint8Array([44, 206, 24, 247]))).toBe("2cce18f7");
  });

  it("normalizeId_converts_data_wrapper_to_hex", () => {
    expect(normalizeId({ data: [44, 206] })).toBe("2cce");
  });

  it("normalizeId_throws_on_unrecognized_encoding", () => {
    expect(() => normalizeId(42)).toThrow(OtlpParseError);
    expect(() => normalizeId(null)).toThrow(OtlpParseError);
  });
});
