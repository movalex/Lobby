# Draftroom sync service: tldraw rooms, one SQLite database per board under DRAFTROOM_DATA_DIR.
# Build from the repository root (the build context must be the repo root):
#   docker build -f docker/sync.Dockerfile -t draftroom-sync .
# Runtime contract: docs/M1-CONTRACTS.md §1 and docs/DEPLOY.md. Exactly ONE instance per data directory.

# node:24.19.0 on Debian 13 (trixie) slim; digest = the multi-arch index verified on Docker Hub
# 2026-09-26. Bump the tag and digest together with .node-version.
FROM node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de AS base

# Only the package manifests + lockfile (+ patches/: pnpm hashes every patchedDependencies file at install
# start, even under --filter), so the dependency layer below stays cached until one changes.
FROM base AS manifests
COPY . /src
RUN mkdir /out && cd /src \
  && find . -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /out \; \
  && cp pnpm-lock.yaml pnpm-workspace.yaml /out/ \
  && cp -r patches /out/patches

FROM base AS deps
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
RUN npm install -g --no-fund --no-audit pnpm@10.34.5
WORKDIR /app
COPY --from=manifests /out/ ./
# A normal filtered workspace install. NOT `pnpm deploy` / injected deps: those copy workspace packages
# into node_modules, where Node refuses to strip TypeScript (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
RUN --mount=type=cache,id=draftroom-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --prod --store-dir /pnpm/store --filter "@draftroom/sync..."

FROM base
# tini is PID 1: forwards SIGTERM to the app and reaps zombies (Render has no `docker run --init`). It runs
# as `node`, like the app (docker/entrypoint.sh starts it after dropping root): Render runs containers
# without CAP_KILL, so a root tini cannot signal a `node` process (EPERM, seen on every deploy until
# 2026-09-28), and the app was killed without its graceful shutdown.
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
COPY apps/sync/ apps/sync/
COPY docker/entrypoint.sh /usr/local/bin/draftroom-entrypoint
RUN chmod 0755 /usr/local/bin/draftroom-entrypoint
# DRAFTROOM_DATA_DIR has no default on purpose: without it the server refuses to start instead of
# silently writing boards to the container's ephemeral filesystem.
ENTRYPOINT ["/usr/local/bin/draftroom-entrypoint"]
# Native type stripping (Node 24): the TypeScript sources run as-is, no build step.
CMD ["node", "apps/sync/src/server.ts"]
