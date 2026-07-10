import { describe, it, expect, vi } from "vitest";
import { gracefulShutdown, type ShutdownDeps } from "./shutdown.js";

function deps(overrides: Partial<ShutdownDeps> = {}): {
  d: ShutdownDeps;
  order: string[];
  exited: number[];
} {
  const order: string[] = [];
  const exited: number[] = [];
  const d: ShutdownDeps = {
    server: { close: (cb) => { order.push("server.close"); cb?.(); } },
    pool: { end: async () => { order.push("pool.end"); } },
    stop: () => order.push("stop"),
    drainMs: 1000,
    exit: (code) => { order.push("exit"); exited.push(code); },
    setTimer: () => ({ unref: () => {} }), // deadline never fires in these tests
    logger: () => {},
    ...overrides,
  };
  return { d, order, exited };
}

describe("M94 gracefulShutdown", () => {
  it("stops timers, closes the server, ends the pool, then exits(0) — in order", async () => {
    const { d, order, exited } = deps();
    await gracefulShutdown(d);
    expect(order).toEqual(["stop", "server.close", "pool.end", "exit"]);
    expect(exited).toEqual([0]);
  });

  it("still ends the pool + exits when the drain deadline fires before the server closes", async () => {
    // server.close never invokes its callback (a hung in-flight request); the injected timer fires.
    let fireDeadline: (() => void) | undefined;
    const { d, order } = deps({
      server: { close: () => { order.push("server.close"); /* no cb → simulates a stuck drain */ } },
      setTimer: (cb) => { fireDeadline = cb; return { unref: () => {} }; },
    });
    const p = gracefulShutdown(d);
    fireDeadline?.(); // deadline elapses
    await p;
    expect(order).toEqual(["stop", "server.close", "pool.end", "exit"]); // still drains + exits
  });

  it("exits even when pool.end rejects (a stuck resource must not block the deploy)", async () => {
    const { d, order, exited } = deps({
      pool: { end: async () => { order.push("pool.end"); throw new Error("pool stuck"); } },
    });
    await gracefulShutdown(d);
    expect(order).toContain("exit");
    expect(exited).toEqual([0]); // never rejects; still exits
  });

  it("pool.end is called exactly once", async () => {
    const end = vi.fn(async () => {});
    const { d } = deps({ pool: { end } });
    await gracefulShutdown(d);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
