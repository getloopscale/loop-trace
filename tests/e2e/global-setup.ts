import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createPool, migrateLatest } from "@usetheo/lens-core";

/**
 * E2E global setup: bring up the full docker-compose stack (Postgres + API),
 * wait for the API to serve, then apply the committed migrations to the same
 * Postgres the API container uses. Fails loudly (throws) if compose cannot start
 * — e2e never silently skips (unlike env-gated integration tests).
 */

const PG_PORT = process.env["THEOLENS_PG_PORT"] ?? "55432";
const API_PORT = process.env["THEOLENS_API_PORT"] ?? "44318";
const PG_URI = `postgresql://theolens:theolens@localhost:${PG_PORT}/theolens`;
const BASE = `http://localhost:${API_PORT}`;

const composeEnv = {
  ...process.env,
  THEOLENS_PG_PORT: PG_PORT,
  THEOLENS_API_PORT: API_PORT,
};

async function waitForApi(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Any HTTP response (even 404) means the server is up and routing.
      const res = await fetch(`${BASE}/v1/spans/__healthcheck__`);
      if (res.status === 404 || res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(2000);
  }
  throw new Error(`API did not become reachable at ${BASE} within ${timeoutMs}ms`);
}

export async function setup(): Promise<void> {
  execSync("docker compose up -d --build", {
    stdio: "inherit",
    env: composeEnv,
  });
  await waitForApi(120_000);

  const pool = createPool(PG_URI);
  try {
    await migrateLatest(pool);
  } finally {
    await pool.end();
  }

  process.env["THEOLENS_E2E_BASE"] = BASE;
}

export async function teardown(): Promise<void> {
  execSync("docker compose down", { stdio: "inherit", env: composeEnv });
}
