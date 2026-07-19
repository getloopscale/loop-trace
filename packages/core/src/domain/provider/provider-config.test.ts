import { execSync } from "node:child_process";

import { describe, expect, test } from "vitest";

import {
  DEFAULT_PROVIDER_RETRY,
  parseProviderBreaker,
  parseProviderRetry,
} from "./provider-config.js";
import { DEFAULT_PROVIDER_BREAKER } from "./provider-breaker.js";

describe("provider-config", () => {
  test("test_provider_config_has_no_import_cycle", () => {
    // Structural gate: severing the chat → evaluator-config edge must leave the core module graph acyclic.
    // madge prints the "✔ No circular dependency found!" verdict to stderr and "Processed N files" to
    // stdout, so merge both streams (2>&1) before asserting.
    const out = execSync("npx madge --circular --extensions ts packages/core/src 2>&1", {
      encoding: "utf8",
    });
    expect(out).toContain("No circular dependency found");
  });

  test("test_parse_provider_retry_move_equivalence", () => {
    // Unset → documented defaults (identical to the pre-move behavior).
    expect(parseProviderRetry({})).toEqual({
      maxAttempts: 2,
      baseDelayMs: 250,
      maxBackoffMs: 60000,
    });
    expect(parseProviderRetry({})).toEqual(DEFAULT_PROVIDER_RETRY);
    // Valid override respected.
    expect(
      parseProviderRetry({
        THEOLENS_PROVIDER_MAX_ATTEMPTS: "5",
        THEOLENS_PROVIDER_RETRY_BASE_MS: "100",
        THEOLENS_PROVIDER_MAX_BACKOFF_MS: "1000",
      }),
    ).toEqual({ maxAttempts: 5, baseDelayMs: 100, maxBackoffMs: 1000 });
    // Malformed (≤0 / non-integer) degrades to default — never throws.
    expect(
      parseProviderRetry({ THEOLENS_PROVIDER_MAX_ATTEMPTS: "-1" }),
    ).toEqual(DEFAULT_PROVIDER_RETRY);
    expect(
      parseProviderRetry({ THEOLENS_PROVIDER_RETRY_BASE_MS: "abc" }),
    ).toEqual(DEFAULT_PROVIDER_RETRY);
  });

  test("test_parse_provider_breaker_move_equivalence", () => {
    // Unset → documented defaults.
    expect(parseProviderBreaker({})).toEqual({
      failureThreshold: 5,
      cooldownMs: 30000,
    });
    expect(parseProviderBreaker({})).toEqual(DEFAULT_PROVIDER_BREAKER);
    // Valid override respected.
    expect(
      parseProviderBreaker({
        THEOLENS_PROVIDER_BREAKER_THRESHOLD: "3",
        THEOLENS_PROVIDER_BREAKER_COOLDOWN_MS: "5000",
      }),
    ).toEqual({ failureThreshold: 3, cooldownMs: 5000 });
    // Malformed → default (never throws).
    expect(
      parseProviderBreaker({ THEOLENS_PROVIDER_BREAKER_THRESHOLD: "0" }),
    ).toEqual(DEFAULT_PROVIDER_BREAKER);
  });
});
