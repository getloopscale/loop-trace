import { describe, expect, test } from "vitest";

import { positiveIntEnv } from "./env.js";

describe("positiveIntEnv", () => {
  test("test_positive_int_env_falls_back_to_default_on_invalid", () => {
    // Unset → default.
    expect(positiveIntEnv({}, "K", 7)).toBe(7);
    // Non-positive → default (never ≤ 0).
    expect(positiveIntEnv({ K: "-1" }, "K", 7)).toBe(7);
    expect(positiveIntEnv({ K: "0" }, "K", 7)).toBe(7);
    // Non-integer → default.
    expect(positiveIntEnv({ K: "1.5" }, "K", 7)).toBe(7);
    expect(positiveIntEnv({ K: "abc" }, "K", 7)).toBe(7);
    // Valid positive integer → parsed.
    expect(positiveIntEnv({ K: "12" }, "K", 7)).toBe(12);
  });
});
