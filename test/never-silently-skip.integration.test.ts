import { describe, expect, it } from "vitest";

/**
 * M97 (B-M4) meta-guard. Unlike every other `*.integration.test.ts`, this file is NOT gated on
 * `THEOLENS_PG_URI` — it runs unconditionally and FAILS LOUDLY when no Postgres is available. If the
 * Testcontainers globalSetup ever stops provisioning a DB (and none is externally provided), the
 * whole integration suite would otherwise self-skip into a green-but-empty pass; this test converts
 * that silent skip into a red failure, so "pnpm test:integration proves nothing" can never recur.
 */
describe("integration suite never silently skips", () => {
  it("a Postgres URI is present (Testcontainers provisioned one, or the env provided it)", () => {
    expect(process.env["THEOLENS_PG_URI"], "THEOLENS_PG_URI must be set for the integration suite").toBeTruthy();
  });
});
