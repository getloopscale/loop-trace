import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Contract test for the fail-loud boot path (T1.3, Rule 8): when migrate-on-boot
 * fails, `main` must log a structured error and exit non-zero — never serve a
 * stack that cannot ingest. Mocks the core so no real Postgres is needed.
 */
vi.mock("@usetheo/lens-core", () => ({
  createSpanRepository: () => ({
    repo: {},
    pool: { end: async () => undefined },
  }),
  migrateLatest: vi.fn(async () => {
    throw new Error("simulated migration failure");
  }),
  // M22: the auth middleware (imported transitively via app.ts) reads these.
  DEFAULT_WORKSPACE_ID: "default",
  DEFAULT_OWNER_USER_ID: "default-owner",
  roleSatisfies: () => true,
}));

vi.mock("@hono/node-server", () => ({
  serve: vi.fn(),
}));

describe("composition root fail-loud on boot (contract)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["THEOLENS_PG_URI"];
  });

  it("test_boot_migrate_failure_exits_nonzero", async () => {
    process.env["THEOLENS_PG_URI"] = "postgresql://stub/stub";
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const errLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { main } = await import("./index.js");
    await main();

    expect(exit).toHaveBeenCalledWith(1);
    // The structured error log carries context (Rule 8), not a bare message.
    const logged = errLog.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("migration");
  });
});
