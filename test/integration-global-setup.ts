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
  if (process.env["THEOLENS_PG_URI"]) return; // fast path — respect an externally-provided PG
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  // Every worker process forks AFTER globalSetup, inheriting this env var.
  process.env["THEOLENS_PG_URI"] = container.getConnectionUri();
}

export async function teardown(): Promise<void> {
  if (container) {
    await container.stop();
    container = undefined;
  }
}
