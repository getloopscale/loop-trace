import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
// M122 — the infra concretes live behind the `/infra` subpath; the root barrel
// exposes domain ports only (guarded by barrel-surface.test.ts).
import { createPool, migrateLatest } from "@looptrace/core/infra";

/**
 * E2E global setup: bring up the full docker-compose stack (Postgres + API),
 * wait for the API to serve, then apply the committed migrations to the same
 * Postgres the API container uses. Fails loudly (throws) if compose cannot start
 * — e2e never silently skips (unlike env-gated integration tests).
 */

const PG_PORT = process.env["LOOPTRACE_PG_PORT"] ?? "55432";
const API_PORT = process.env["LOOPTRACE_API_PORT"] ?? "44318";
const PG_URI = `postgresql://looptrace:looptrace@localhost:${PG_PORT}/looptrace`;
const BASE = `http://localhost:${API_PORT}`;

const composeEnv = {
  ...process.env,
  LOOPTRACE_PG_PORT: PG_PORT,
  LOOPTRACE_API_PORT: API_PORT,
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

// When LOOPTRACE_E2E_EXTERNAL=1, run against an already-running stack (CI / local
// server) instead of managing docker compose here. LOOPTRACE_E2E_BASE + PG must
// already point at it. The default path (unset) still builds + runs compose.
const EXTERNAL = process.env["LOOPTRACE_E2E_EXTERNAL"] === "1";

export async function setup(): Promise<void> {
  if (!EXTERNAL) {
    execSync("docker compose up -d --build", {
      stdio: "inherit",
      env: composeEnv,
    });
  }
  await waitForApi(120_000);

  const pool = createPool(PG_URI);
  try {
    await migrateLatest(pool);
  } finally {
    await pool.end();
  }

  process.env["LOOPTRACE_E2E_BASE"] = BASE;
}

export async function teardown(): Promise<void> {
  if (EXTERNAL) return;
  execSync("docker compose down", { stdio: "inherit", env: composeEnv });
}
