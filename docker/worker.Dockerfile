# Draftroom preview worker (thumbnails, PDF pages, video posters) as its own process. It needs the
# SAME DRAFTROOM_DATA_DIR as the API (M0/M1 file store = local disk), so on Render it only becomes a
# separate background worker once files move to object storage (milestone 3); until then Render staging
# runs it inside docker/api-worker.Dockerfile. Use this image where a volume can be shared.
# Build from the repository root:
#   docker build -f docker/worker.Dockerfile -t draftroom-worker .

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
  pnpm install --frozen-lockfile --prod --store-dir /pnpm/store --filter "@draftroom/worker..."

FROM base
# tini is PID 1: forwards SIGTERM to the worker (it finishes or releases its current job) and reaps
# the ffmpeg / PDF child processes. ffmpeg + ffprobe come from Debian; FFMPEG_PATH/FFPROBE_PATH default
# to the PATH lookup.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && command -v setpriv && command -v ffmpeg && command -v ffprobe
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app /app
# Sources only; tests, fixtures scripts, dev.env and node_modules are excluded by /.dockerignore.
COPY packages/ packages/
COPY apps/worker/ apps/worker/
COPY docker/entrypoint.sh /usr/local/bin/draftroom-entrypoint
RUN chmod 0755 /usr/local/bin/draftroom-entrypoint
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/draftroom-entrypoint"]
CMD ["node", "apps/worker/src/worker.ts"]
