import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * M97 (audit B-M4) — vitest globalSetup for the integration suite. When `THEOLENS_PG_URI` is NOT
 * set, spin ONE ephemeral Postgres via Testcontainers and expose its URI so every
 * `*.integration.test.ts` (which gates on `THEOLENS_PG_URI` and self-skips when absent) actually
 * runs — `pnpm test:integration` never silently skips the query layer. When the env var IS set
 * (local dev with a docker-compose PG, or CI providing its own), that fast path is honored and no
 * container is started. The container is session-scoped (started once, reused across all files).
 */
let container: StartedPostgreSqlContainer | undefined;

export async function setup(): Promise<void> {
  if (process.env["THEOLENS_PG_URI"]) {
    await assertReachable(process.env["THEOLENS_PG_URI"]);
    return; // fast path — respect an externally-provided PG
  }
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  // Every worker process forks AFTER globalSetup, inheriting this env var.
  process.env["THEOLENS_PG_URI"] = container.getConnectionUri();
}

/**
 * Fail LOUDLY when an externally-provided URI does not point at a reachable host.
 *
 * Be precise about what this does and does not buy, because the obvious story is wrong: a URI
 * that is set but broken does NOT cause a silent skip — the 48 suites gate on the variable being
 * PRESENT, so they run and fail on connect, loudly. The genuinely silent path is the opposite one:
 * `THEOLENS_PG_URI` UNSET and this globalSetup not running at all (someone invokes vitest without
 * `-c vitest.integration.config.ts`), which reports green with zero integration tests executed.
 *
 * This check cannot cover that path — nothing inside a setup that did not run can. What it does
 * cover is the cheap, common CI misconfiguration: a service container whose port was resolved
 * wrong. Failing here names the cause in one line instead of scattering 48 connection errors.
 */
async function assertReachable(uri: string): Promise<void> {
  const { hostname, port } = new URL(uri);
  const net = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: hostname, port: Number(port) || 5432 });
    const fail = (cause: unknown) => {
      socket.destroy();
      reject(
        new Error(
          `THEOLENS_PG_URI points at ${hostname}:${port}, which is not accepting connections. ` +
            `Unset it to use Testcontainers, or fix the service port.`,
          { cause },
        ),
      );
    };
    socket.setTimeout(10_000);
    socket.once("connect", () => { socket.end(); resolve(); });
    socket.once("timeout", () => fail(new Error("timeout")));
    socket.once("error", fail);
  });
}


export async function teardown(): Promise<void> {
  if (container) {
    await container.stop();
    container = undefined;
  }
}
