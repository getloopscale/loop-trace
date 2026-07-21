# Theo Lens image — multi-stage pnpm workspace build (M7: one image serves API + UI).
# Stage 1 builds @usetheo/lens-core + @usetheo/lens-api AND the web bundle
# (built with an empty VITE_THEOLENS_API so the UI calls the API same-origin).
# Stage 2 ships only prod deps + the compiled API dist + the static web dist;
# the API serves both /v1/* and the UI at one port (D1).

FROM node:22-alpine AS build
RUN npm install -g pnpm@11.1.0
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
# Build only what the image serves: `tsc -b packages/api` compiles the API and
# its project reference (core), skipping sdk + examples/agent (not in the image,
# their deps are intentionally not installed here).
RUN pnpm exec tsc -b packages/api
# Same-origin: empty base → the client fetches /v1/... relative (D1).
RUN VITE_THEOLENS_API="" pnpm --filter @usetheo/lens-web build

FROM node:22-alpine AS runtime
RUN npm install -g pnpm@11.1.0
WORKDIR /app
ENV NODE_ENV=production
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/api/package.json ./packages/api/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/api/dist ./packages/api/dist
# Drizzle migrations are the release artifact migrateLatest() applies on boot;
# tsc does not copy .sql, so place them where the compiled JS resolves
# `./migrations` (next to drizzle-span-repository.js in dist).
COPY --from=build /app/packages/core/src/infrastructure/db/migrations ./packages/core/dist/infrastructure/db/migrations
# Static UI bundle served by the API at runtime (CWD-relative root, EC-1).
COPY --from=build /app/packages/web/dist ./packages/web/dist
ENV THEOLENS_PORT=4318
EXPOSE 4318

# Drop root. The `node` user ships with the base image (uid 1000), so this needs no useradd —
# it only needs to be said. Surfaced by the CD SAST lane (dockerfile.security.missing-user).
#
# The API writes nothing to the filesystem: it serves a static bundle and talks to Postgres over
# the network, so /app stays read-only to the runtime user. Ownership is set on the copied trees
# rather than chown -R at the end, which would duplicate every layer's bytes.
RUN chown -R node:node /app
USER node

CMD ["node", "packages/api/dist/server/index.js"]
