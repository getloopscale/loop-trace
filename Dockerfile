# Theo Lens API image — multi-stage pnpm workspace build.
# Stage 1 builds @usetheo/lens-core + @usetheo/lens-api (EC-3: core IS built);
# stage 2 ships only prod deps + compiled dist.

FROM node:22-alpine AS build
RUN npm install -g pnpm@11.1.0
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/api/package.json ./packages/api/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
RUN pnpm build

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
ENV THEOLENS_PORT=4318
EXPOSE 4318
CMD ["node", "packages/api/dist/server/index.js"]
