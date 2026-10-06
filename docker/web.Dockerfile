# The web app behind nginx, for a single-origin deployment (the theater Lobby on the NAS,
# deploy/nas/theater). nginx serves the built SPA and proxies /api, /files and the board socket /connect to
# the api and sync containers, so the page, the api and the socket share one origin: no
# VITE_DRAFTROOM_SYNC_ORIGIN, no DRAFTROOM_EVENTS_ORIGIN, the session cookie is first-party.
# Render's staging serves the same build as a static site instead (render.yaml).

FROM node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de AS build
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
RUN npm install -g --no-fund --no-audit pnpm@10.34.5
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=draftroom-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@draftroom/web..."
RUN pnpm --filter @draftroom/web build

FROM nginx:1.27-alpine
COPY deploy/nas/theater/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
# Unprivileged: listens on 8080, pid and temp files under /tmp (a tmpfs in the compose file).
USER nginx
EXPOSE 8080
