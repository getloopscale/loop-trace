import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { main } from "./prune.js";

/**
 * CLI fail-loud paths (EC-6, Rule 8). The pure use-case (`runPrune`) is tested in
 * `server/retention-run.test.ts`; here we prove the entry exits non-zero (never a
 * silent no-op) on misconfig, WITHOUT touching a real DB (it must exit before
 * `createSpanRepository`).
 */
describe("db:prune CLI fail-loud (M23 T2.1)", () => {
  const saved = { ...process.env };
  let exit: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("prune_cli_exits_when_pg_uri_missing", async () => {
    delete process.env["THEOLENS_PG_URI"];
    await main();
    expect(exit).toHaveBeenCalledWith(1);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("THEOLENS_PG_URI is required"),
    );
  });

  it("prune_cli_exits_when_retention_disabled", async () => {
    // a connection string but no retention window → refuse (never guess a window)
    process.env["THEOLENS_PG_URI"] = "postgresql://x:y@localhost:5/z";
    delete process.env["THEOLENS_RETENTION_DAYS"];
    await main();
    expect(exit).toHaveBeenCalledWith(1);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("THEOLENS_RETENTION_DAYS"),
    );
  });
});
