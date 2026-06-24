import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "@usetheo/lens-core";
import type pg from "pg";

import { bootstrap } from "./index.js";

/**
 * Integration test for the M23 retention wiring in `bootstrap` (composition root):
 * the opt-in sweep starts ONLY when `THEOLENS_RETENTION_DAYS` is set, and the
 * returned `stop` is always a callable no-op when disabled. Gated by THEOLENS_PG_URI.
 */
const PG_URI = process.env["THEOLENS_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

suite("bootstrap retention wiring (integration, M23 T3.1)", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = createPool(PG_URI as string);
  });
  afterEach(() => {
    delete process.env["THEOLENS_RETENTION_DAYS"];
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("bootstrap_no_sweep_when_retention_disabled", async () => {
    delete process.env["THEOLENS_RETENTION_DAYS"];
    const setI = vi.spyOn(global, "setInterval");
    const { stop, pool: bootPool } = await bootstrap(PG_URI as string);
    // no retention window → no interval registered; stop is a callable no-op
    expect(setI).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
    await bootPool.end();
  });

  it("bootstrap_starts_sweep_when_retention_enabled", async () => {
    process.env["THEOLENS_RETENTION_DAYS"] = "90";
    const setI = vi.spyOn(global, "setInterval");
    const { stop, pool: bootPool } = await bootstrap(PG_URI as string);
    // a retention window → exactly one sweep interval registered
    expect(setI).toHaveBeenCalledTimes(1);
    stop(); // clears the interval — no leaked timer
    await bootPool.end();
  });
});
