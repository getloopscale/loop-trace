import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit config for M0. Schema lives in packages/core (infrastructure/db);
 * migrations are committed to the repo. Dev: `pnpm db:push`; prod/CI: `pnpm db:generate`.
 */
export default defineConfig({
  schema: "./packages/core/src/infrastructure/db/schema.ts",
  out: "./packages/core/src/infrastructure/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env["LOOPTRACE_PG_URI"] ??
      "postgresql://looptrace:looptrace@localhost:5432/looptrace",
  },
  verbose: true,
  strict: true,
});
