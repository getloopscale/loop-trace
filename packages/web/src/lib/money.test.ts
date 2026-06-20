import { describe, it, expect } from "vitest";
import { formatUsd } from "./money.js";

describe("formatUsd", () => {
  it("format_usd_renders_currency", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0125)).toBe("$0.0125");
    expect(formatUsd(0.5)).toBe("$0.50");
  });
});
