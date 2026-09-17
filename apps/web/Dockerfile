# E01-S01 minimal web image: pinned base, non-root, read-only capable.
# Build context must never contain .env or secret files (see .dockerignore).
# Provenance: node:22-alpine resolved 2026-09-17 to Node v22.23.2 on
# Alpine 3.24.1, digest below. Bump tag+digest together, never tag alone.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY apps/web/tsconfig.json apps/web/tsconfig.json
COPY apps/web/src apps/web/src
RUN npm ci --ignore-scripts && \
    npx --no-install tsc -p apps/web/tsconfig.json && \
    npm prune --omit=dev
# The runtime server has zero dependencies; the runtime layer copies only the
# compiled dist output plus package.json metadata (no node_modules needed).

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime
ENV NODE_ENV=production APP_ENV=production
WORKDIR /app
# Production dependencies are required at runtime since E01-S02 (pg backs
# sessions/tenancy/commands/policy). The build layer prunes devDependencies,
# so only prod modules ship here — verify with the smoke's no-secret check.
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/apps/web/dist ./dist
COPY --from=build /src/package.json ./package.json
ARG APP_RELEASE=dev
ARG GIT_SHA=unknown
ENV APP_RELEASE=${APP_RELEASE} GIT_SHA=${GIT_SHA} PORT=3000
USER 65532:65532
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
