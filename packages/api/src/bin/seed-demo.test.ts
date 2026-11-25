import { describe, it, expect, vi, afterEach } from "vitest";
import { main } from "./seed-demo.js";

const ORIGINAL_URI = process.env["LOOPTRACE_PG_URI"];

afterEach(() => {
  if (ORIGINAL_URI === undefined) delete process.env["LOOPTRACE_PG_URI"];
  else process.env["LOOPTRACE_PG_URI"] = ORIGINAL_URI;
  vi.restoreAllMocks();
});

describe("seed-demo CLI", () => {
  it("fails_fast_when_pg_uri_missing", async () => {
    delete process.env["LOOPTRACE_PG_URI"];
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(((): never => undefined as never));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(); // must NOT throw, must NOT open a DB connection

    expect(exit).toHaveBeenCalledWith(1);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("LOOPTRACE_PG_URI is required"),
    );
  });
});
