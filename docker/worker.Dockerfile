# Draftroom preview worker (thumbnails, PDF pages, video posters, Office documents): the HTTP worker of
# docs/M3-STORAGE-CONTRACTS.md §5. It claims jobs from the API, downloads the original from a presigned
# URL into a temp file, renders derivatives, uploads them to presigned URLs and reports back. The same
# image also runs the office sidecar (apps/worker/src/office-sidecar.ts), which converts Office
# documents to PDF with LibreOffice from a container with no network and no secrets
# (deploy/nas/worker/docker-compose.yml, service `office`).
# Runs the same on Render (optional background worker in render.yaml), on the NAS
# (deploy/nas/README.md) or next to a local API.
#
# Holds NO database, storage or session credentials and needs NO data directory or volume. Required
# env: DRAFTROOM_API_URL and DRAFTROOM_WORKER_TOKEN. Optional: WORKER_ID (default: the hostname),
# WORKER_CONCURRENCY, WORKER_POLL_MS, WORKER_PDF_HEAP_MB, WORKER_TMP_DIR, FFMPEG_PATH, FFPROBE_PATH, ...
# (see .env.example). Temp files go to WORKER_TMP_DIR (default /tmp): budget >= 1 GB per concurrent job
# (a 500 MB video original, its derivatives, headroom). Render's /tmp is reportedly capped at 2 GB.
#
# Starts directly as the unprivileged `node` user (uid/gid 1000) with no root phase, so it runs under
# `cap_drop: ALL` + `no-new-privileges` (docker/entrypoint.sh's root phase would need CAP_CHOWN and
# CAP_SETUID/SETGID, which is why this image does not use it).
# Build from the repository root:
#   docker build -f docker/worker.Dockerfile -t draftroom-worker .

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
  pnpm install --frozen-lockfile --prod --store-dir /pnpm/store --filter "@draftroom/worker..."

FROM base
# tini is PID 1: forwards SIGTERM to the worker (it finishes or releases its current job) and reaps
# the ffmpeg / PDF child processes. ffmpeg + ffprobe come from Debian; FFMPEG_PATH/FFPROBE_PATH default
# to the PATH lookup.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && command -v ffmpeg && command -v ffprobe
# Office previews (wave 4): LibreOffice without a GUI or Java, run ONLY by the office sidecar (compose
# service `office`: the same image with `node apps/worker/src/office-sidecar.ts`, no network, no
# secrets, its own memory cap). Fonts that keep Office layouts: Liberation (metric-compatible with Arial,
# Times New Roman, Courier New), Carlito (Calibri), Caladea (Cambria), plus DejaVu for everything else.
# /office-jobs is the mount point of the volume the worker and the sidecar share; owned by `node`, so a
# new named volume starts out owner-only for that user. Its own layer: the one above stays cached.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
    fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/* \
  && command -v soffice \
  && install -d -o node -g node -m 700 /office-jobs
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app /app
# Sources only; tests, fixture scripts, dev.env and node_modules are excluded by /.dockerignore.
# Root-owned, so the worker cannot modify its own code; it writes only to /tmp (HOME is /home/node).
COPY packages/ packages/
COPY apps/worker/ apps/worker/
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
# Native type stripping (Node 24): the TypeScript sources run as-is, no build step.
CMD ["node", "apps/worker/src/worker.ts"]
