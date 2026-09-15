# syntax=docker/dockerfile:1

# Builder, pinned by digest. It runs on the build host's platform: the output is JavaScript plus pure JS/WASM
# node_modules, both architecture-independent, so multi-arch images need no emulated installs.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS base
RUN npm install -g pnpm@11.25.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm/store

# Runtime: distroless, so no shell or package manager, running as the non-root uid 65532, pinned by digest.
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 9080
# The image entrypoint is `node`. Source maps make stack traces point at the TypeScript sources.
CMD ["--enable-source-maps", "dist/app.js"]
