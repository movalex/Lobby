# Draftroom API (Fastify) WITHOUT the preview worker: for hosts where api and worker can share
# DRAFTROOM_DATA_DIR (e.g. one Docker host with a shared volume) and, from milestone 3, for Render once
# files live in object storage. Render staging in milestone 1 uses docker/api-worker.Dockerfile instead
# (docs/DEPLOY.md, "File storage").
# Build from the repository root:
#   docker build -f docker/api.Dockerfile -t draftroom-api .

# node:24.19.0 on Debian 13 (trixie) slim; digest = the multi-arch index verified on Docker Hub
# 2026-09-26. Bump the tag and digest together with .node-version.
FROM node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de AS base

# Only the package manifests + lockfile, so the dependency layer below stays cached until one changes.
FROM base AS manifests
COPY . /src
RUN mkdir /out && cd /src \
  && find . -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /out \; \
  && cp pnpm-lock.yaml pnpm-workspace.yaml /out/

FROM base AS deps
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
RUN npm install -g --no-fund --no-audit pnpm@10.34.5
WORKDIR /app
COPY --from=manifests /out/ ./
# A normal filtered workspace install. NOT `pnpm deploy` / injected deps: those copy workspace packages
# into node_modules, where Node refuses to strip TypeScript (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
RUN --mount=type=cache,id=draftroom-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --prod --store-dir /pnpm/store --filter "@draftroom/api..."

FROM base
# tini is PID 1: forwards SIGTERM to the app and reaps zombies (Render has no `docker run --init`).
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/* \
  && command -v setpriv
ENV NODE_ENV=production \
  HOST=0.0.0.0
WORKDIR /app
COPY --from=deps /app /app
# Sources only; tests, dev.env and node_modules are excluded by /.dockerignore.
COPY packages/ packages/
COPY apps/api/ apps/api/
COPY docker/entrypoint.sh /usr/local/bin/draftroom-entrypoint
RUN chmod 0755 /usr/local/bin/draftroom-entrypoint
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/draftroom-entrypoint"]
# Native type stripping (Node 24): the TypeScript sources run as-is, no build step.
CMD ["node", "apps/api/src/server.ts"]
