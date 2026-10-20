# The theater Lobby on the NAS

Lobby for Banzerini House (`docs/OPEN-SIGNIN.md`): open email sign-in and one planning board per theaitre-bot
production. It runs entirely on the home NAS, next to the photo workers, at no cost: no Render services, no cloud
database, no cloud storage. The internet reaches it only through a Cloudflare Tunnel, which the NAS opens outward.
There are no published ports and nothing to forward on the router.

## What runs

Compose project `lobby-theater`, folder `/volume3/Apps/lobby-theater/` (mode 700; `V:\lobby-theater` on the PC).

| Service | What | Memory cap |
|---|---|---|
| `db` | Postgres 18 (`postgres:18-alpine`), volume `lobby-theater_pg` | 512 MB |
| `api` | `docker/api.Dockerfile`; uploads on volume `lobby-theater_files` (`DRAFTROOM_BLOB_STORE=fs`); runs the migrations on start | 768 MB |
| `sync` | `docker/sync.Dockerfile`; the board rooms (SQLite) on volume `lobby-theater_rooms` | 768 MB |
| `web` | `docker/web.Dockerfile`: nginx with the built web app, proxying `/api`, `/files` and the board socket `/connect` to api and sync (one origin) | 128 MB |
| `worker` | `docker/worker.Dockerfile`: thumbnails, PDF pages, video posters, Office previews and deck import (through `office`), background removal (with `models/u2netp.onnx`) | 1 GB |
| `office` | the same image's LibreOffice converter: **no network**, read-only, shares only the `office-jobs` volume with the worker | 1 GB |
| `tunnel` | `cloudflare/cloudflared`, started only once `secrets/tunnel.env` exists | 128 MB |

The volumes are Docker's own storage on the NAS's disks (never a network share: `AGENTS.md`).

## One-time setup: the address

1. Cloudflare dashboard (banzerinihouse.org's DNS is there) → **Zero Trust → Networks → Tunnels → Create a tunnel →
   Cloudflared**. Name it `lobby-theater`. Copy the token from the install command (the long string after `--token`).
2. In the same tunnel, **Public Hostname → Add**: subdomain `lobby`, domain `banzerinihouse.org`, service type
   `HTTP`, URL `web:8080`.
3. On the PC, create `deploy/nas/theater/.env.tunnel` (gitignored) with one line: `TUNNEL_TOKEN=<the token>`.
   (Done 2026-10-06 through the Cloudflare API: tunnel `lobby-theater`, `c3b29063-7164-4561-a5a6-19c2020eda34`.)
4. Deploy (below). The tunnel starts, and `https://lobby.banzerinihouse.org` serves the Lobby.

A different address: change `LOBBY_ORIGIN` in `settings.env`, and use that host in step 2.

## Sign-in: Google

`settings.env` (committed, not secret) holds the address, the workspace name and the sign-in methods. To make
"Continue with Google" the only way in:

1. Google Cloud Console → (the theater's project) → **APIs & Services → Credentials → Create credentials → OAuth
   client ID** → Application type **Web application**, name `Lobby (theater)`, **Authorized JavaScript origins**:
   `https://lobby.banzerinihouse.org`. No redirect URI. Create, and copy the **Client ID** (it is public; the client
   secret is not used).
2. **OAuth consent screen / Audience**: user type *External*, publishing status **In production**, so any Google
   account can sign in (in *Testing* only listed test users can).
3. In `settings.env`: `LOBBY_SIGNIN_METHODS=google` and `LOBBY_GOOGLE_CLIENT_ID=<the client id>`, then deploy.

## Features

The api and sync turn on the same feature switches as staging (`render.yaml`); in `docker-compose.yml` each is `"on"`
or off, and all of them default to off:

- **api**: design previews (Photoshop, Illustrator, TIFF), live activities (polls, scales, word clouds), join codes,
  breakouts, doc cards, background removal, deck import, workspace admin.
- **sync**: reactions and planning. These are fail-closed kill switches: anything but `on` refuses those writes.
- **Off on purpose**: the AI features (`DRAFTROOM_AI_VISION`, `DRAFTROOM_FILE_SEARCH` and the rest of AI). They need
  `OPENAI_API_KEY`, which costs money. Chat hooks work: the deploy adds `DRAFTROOM_WEBHOOK_SECRET` to `secrets/api.env`
  once.

When Lobby adds a switch, compare `render.yaml` with `docker-compose.yml` and mirror it.

## Background removal

The worker removes backgrounds only with the approved model at `models/u2netp.onnx`. Its sha256 is pinned in
`apps/worker/src/ops/bg-model.ts`; anything else is ignored and the feature is not offered. It was copied on
2026-10-20 from the DBC worker's approved copy (`/volume3/Apps/draftroom-worker/models/`). The deploy creates
`models/` and says when the file is missing; Lobby never downloads it.

## Deploy / update

```bash
bash deploy/nas/theater/deploy-theater.sh            # bundle, upload, create missing secrets, build, start
bash deploy/nas/theater/deploy-theater.sh status     # containers, health, memory, last log lines
bash deploy/nas/theater/deploy-theater.sh smoke      # from inside the NAS: page, api health, sign-in config
bash deploy/nas/theater/deploy-theater.sh logs api   # or db, sync, web, worker, tunnel; add N or -f
bash deploy/nas/theater/deploy-theater.sh stop       # and start
```

The script uploads the working tree's sources (no tests, env files or local data), builds the four images one at a
time on the NAS (the photo workers keep running), and starts the project. A failed build restores the previous sources
and leaves the running containers alone. **Updating Lobby for the theater is this one command** after changing
Draftroom. theaitre-bot needs nothing.

## Secrets

All of them are created on the NAS by the first deploy, kept across deploys, mode 600, and never printed:

- `secrets/shared.env`: ticket and internal secrets (api + sync).
- `secrets/db.env`: the Postgres password.
- `secrets/api.env`: `DATABASE_URL` (the same password), the worker token, and **`DRAFTROOM_PARTNER_TOKEN`**.
- `secrets/worker.env`: the worker token.
- `secrets/tunnel.env`: yours, from `.env.tunnel`.

theaitre-bot needs the partner token. Open `V:\lobby-theater\secrets\api.env` on the PC and copy the value after
`DRAFTROOM_PARTNER_TOKEN=` into theaitre-bot's Render environment as `LOBBY_PARTNER_TOKEN`. Set `LOBBY_API_URL` to
`https://lobby.banzerinihouse.org`.

## Limits and care

- It is as available as the NAS and the home internet connection.
- Cloudflare's free plan caps an upload at 100 MB per request.
- If Cloudflare's Bot Fight Mode is on for the zone, it can challenge theaitre-bot's server-to-server partner call.
  Exempt `lobby.banzerinihouse.org/api/partner/*`, or keep Bot Fight Mode off.
- **Backups**: the three volumes hold everything. A cold copy:
  `docker run --rm -v lobby-theater_pg:/v -v /volume3/Apps/lobby-theater/backup:/b alpine tar czf /b/pg.tgz -C /v .`
  and the same for `rooms` and `files`, with the project stopped. Never delete the volumes: `docker compose down`
  keeps them, `down -v` does not.
