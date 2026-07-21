import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "./drizzle-span-repository.js";

/**
 * Regression guard for the boot-migration path. `migrateLatest` lives at
 * `infrastructure/db/observability/`, but the Drizzle migrations live one level
 * up at `infrastructure/db/migrations` (and copy-migrations.mjs copies them
 * there in `dist`). A `./migrations` resolution points at a non-existent
 * `observability/migrations`, so the server crashes on boot with
 * "Can't find meta/_journal.json". This test fails if the `../migrations`
 * resolution regresses back to `./migrations`.
 */
describe("migrateLatest — migrations folder resolution", () => {
  it("resolves to a real Drizzle migrations folder containing meta/_journal.json", () => {
    expect(MIGRATIONS_DIR.endsWith(join("infrastructure", "db", "migrations"))).toBe(true);
    expect(existsSync(join(MIGRATIONS_DIR, "meta", "_journal.json"))).toBe(true);
  });
});
