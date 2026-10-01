#!/bin/sh
# Builds the cut-over candidate (src-x, a39a1c5) the way the prep built R0: api and sync images tagged
# draftroom-rehearsal-{api,sync}:excalidraw, then the web into web/dist-x (no licence key, no engine flag:
# render.yaml at a39a1c5 has neither).
set -eu
D=/volume3/Apps/draftroom-rehearsal
NODE_IMG=node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de
cd $D/src-x
echo "BUILD-API-START $(date -u +%FT%TZ)"
docker build -f docker/api.Dockerfile -t draftroom-rehearsal-api:excalidraw --label com.draftroom.component=rehearsal .
echo "BUILD-API-DONE $(date -u +%FT%TZ)"
echo "BUILD-SYNC-START $(date -u +%FT%TZ)"
docker build -f docker/sync.Dockerfile -t draftroom-rehearsal-sync:excalidraw --label com.draftroom.component=rehearsal .
echo "BUILD-SYNC-DONE $(date -u +%FT%TZ)"
echo "WEB-BUILD-START $(date -u +%FT%TZ)"
docker run --rm --name draftroom-rehearsal-webbuild --env-file $D/env/web-build-x.env -e NPM_CONFIG_UPDATE_NOTIFIER=false -v $D/src-x:/src:ro -v $D/web:/out -v draftroom-rehearsal-pnpm-store:/pnpm/store $NODE_IMG sh -c "set -e; cp -a /src /work && cd /work && npm install -g --no-fund --no-audit pnpm@10.34.5 && pnpm install --frozen-lockfile --store-dir /pnpm/store --filter @draftroom/web... && pnpm --filter @draftroom/web build && rm -rf /out/dist-x && cp -a apps/web/dist /out/dist-x && echo WEB-BUILD-OK"
echo "WEB-BUILD-DONE $(date -u +%FT%TZ)"
