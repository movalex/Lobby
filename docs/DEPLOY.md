# Deploying Draftroom (milestone 1 staging on Render)

Status (2026-09-27): **definition only.** Nothing has been provisioned, nobody has contacted Render, and the Blueprint has never been synced. The container images were built and smoke-tested on a local Docker host (below), and `render.yaml` validates against Render's published schema. Everything that could only be proven on Render is marked **UNVERIFIED**. Staging does not work end to end until the [known blockers](#known-blockers) are resolved.

Files: `render.yaml` (Blueprint), `docker/*.Dockerfile` + `docker/entrypoint.sh` + `docker/api-and-worker.mjs` (images), `.dockerignore`, `.env.example` (every variable), `.github/workflows/ci.yml` (CI).

## Architecture on Render

```
browser ── https ──> draftroom-staging-web   (static site: SPA + rewrites /api/*, /files/* -> api)
   │                         │ rewrite (HTTP proxy, UNVERIFIED details)
   │                         v
   │                 draftroom-staging-api   (Docker web service: Fastify API + preview worker,
   │                         │   disk /var/data)      1 instance, disk = uploads, jobs, derivatives
   │                         │ private network: DATABASE_URL, internal calls (x-draftroom-internal)
   │                         v
   │                 draftroom-staging-db    (Render Postgres 18)
   │
   └── wss (direct; see blocker 1) ──> draftroom-staging-sync (Docker web service: tldraw rooms,
                                           1 instance, disk /var/data/rooms/board-<id>.sqlite)
```

| Resource | Render type | Plan | Image / build | Disk | Health check |
|---|---|---|---|---|---|
| `draftroom-staging-web` | static site | free | `pnpm --filter @draftroom/web build` → `apps/web/dist` | — | — |
| `draftroom-staging-api` | web service, Docker | `1c-2g` | `docker/api-worker.Dockerfile` | `draftroom-staging-files`, 5 GB at `/var/data` | `GET /api/auth/config` |
| `draftroom-staging-sync` | web service, Docker | `0.5c-512mb` | `docker/sync.Dockerfile` | `draftroom-staging-rooms`, 1 GB at `/var/data` | `GET /healthz` |
| `draftroom-staging-db` | Postgres 18 | `0.1c-256mb` | — | 1 GB storage | — |
| `draftroom-staging-secrets` | environment group | — | two generated 256-bit secrets | — | — |

All in `oregon` (services only share a private network within one region and workspace). Plan IDs are the names Render introduced in August 2026 (`0.5c-512mb` was "Starter", `1c-2g` "Standard"); the legacy names still work, the new ones are used here.

### Sync: one instance, one disk, no autoscaling

Exactly one `TLSocketRoom` may own a board. The sync service therefore has `numInstances: 1`, no `scaling` block, and the per-board SQLite files on its own persistent disk. A second instance would open a second room on a different disk and split the board. Render cannot scale a service that has a disk anyway, and a disk also disables zero-downtime deploys (see [interruptions](#what-users-see-during-a-deploy)). Scaling past one process is a separate architecture decision (build plan §6).

### File storage: why the worker runs inside the api service (milestones 1–2)

The M0/M1 file store is **local disk** under `DRAFTROOM_DATA_DIR` (`packages/dev-assets`). The api writes each upload's original bytes, its `meta.json`, and a job file in `jobs/queued/`. The preview worker claims that job and writes derivatives next to the original. Both processes must see the **same directory**. A Render persistent disk attaches to **one service instance only** and can't be shared. So a separate api service and a separate background worker would each get their own filesystem, and no upload would ever reach the worker.

Options considered:

| Option | Result on Render today |
|---|---|
| api + separate background worker (the target architecture) | Uploads stay `queued` forever, and they vanish on every api deploy (no disk). Not acceptable. |
| Disable file routes in staging | Needs an api feature flag that doesn't exist, and staging would lose a core feature. |
| **api + worker in one container on one disk (chosen)** | Works exactly like local dev and was smoke-tested end to end (upload → worker → derivative served). |

The chosen stance is explicit in `render.yaml`. `docker/api-worker.Dockerfile` runs `docker/api-and-worker.mjs`, a small supervisor that starts `apps/api` and `apps/worker` in the same container. There is no separate `type: worker` service in milestones 1–2. The costs, all accepted for staging:

- the api is also limited to one instance;
- the api has no zero-downtime deploys either;
- the plan is `1c-2g`, because the worker's PDF child alone may use a 512 MB heap.

Supervisor semantics:

- It forwards the first SIGTERM/SIGINT once to both children.
- If either child exits on its own, it stops the other child and exits non-zero, so Render restarts the whole container.
- It sends SIGKILL to any child still running 25 s after the forwarded signal.

**Milestone 3** moves files to private object storage. Then:

1. The api service switches to `docker/api.Dockerfile` (no ffmpeg) and drops its disk, which restores zero-downtime deploys.
2. The worker becomes a `type: worker` service built from `docker/worker.Dockerfile`.
3. `docker/api-worker.Dockerfile` and the supervisor are deleted.

`docker/api.Dockerfile` and `docker/worker.Dockerfile` already build and run. Use them today on any Docker host where the two containers can share a volume.

## Known blockers

These must be fixed before staging is usable. All are outside this area's files and are reported as contract issues.

1. **The board WebSocket can't go through the static site.** Render static-site rewrites don't proxy WebSockets. This is an open Render feature request since 2020 (<https://feedback.render.com/features/p/support-websockets-in-static-site-rewrites>), and Render's WebSocket docs cover web services only. `apps/web` opens `wss://<page origin>/connect/<board>` (`apps/web/src/board/ticket.ts`), which on the static site is answered by the SPA fallback. Fix options:
   - (a) `apps/web` reads a build-time sync origin (for example `VITE_DRAFTROOM_SYNC_ORIGIN=https://draftroom-staging-sync.onrender.com`; a commented entry is ready in `render.yaml`) and connects there. The ticket carries the authentication, so no cookie is needed cross-origin. Sync should then also check `Origin` against the web origin as defense in depth.
   - (b) Replace the static site with a small reverse-proxy web service (for example Caddy) that serves the SPA and proxies `/api`, `/files` and `/connect` over the private network. This gives the same single-origin topology as dev, for about $7/month more.
2. **Internal URLs can't be wired by the Blueprint.** `DRAFTROOM_SYNC_INTERNAL_URL` (api) and `DRAFTROOM_API_INTERNAL_URL` (sync) must be full `http://host:port` URLs. A Blueprint can only inject a service's `host`, `port` or `hostport`, with no scheme. Until the configs accept a host:port (for example `*_INTERNAL_HOSTPORT` from `fromService.property: hostport`), they are `sync: false` and set by hand ([first provisioning](#first-provisioning)). Warning: left unset, they default to `127.0.0.1`. The api's access-change pushes then fail and sync's periodic re-checks fail too. Sync fails *open* by design (contract §7), so **revocation would silently not be enforced**. Consider refusing loopback defaults when `NODE_ENV=production`.
3. **Sign-in.** Under `NODE_ENV=production` the api refuses `DRAFTROOM_DEV_AUTH=1` and `AUTH_PROVIDER=dev` (verified in the image). Staging therefore needs Clerk keys, and the Clerk adapter is **UNVERIFIED** until keys exist. Do not weaken the production guard to get a demo. Staging is internet-reachable, and dev sign-in lets anyone become anyone.
4. **tldraw license key.** See [below](#tldraw-license-key).
5. **Client IPs behind two proxies.** The api's sign-in rate limit (`@fastify/rate-limit`, per IP) runs behind Render's proxy plus the static-site rewrite, and Fastify `trustProxy` isn't configured. All users may share one bucket (60/min), or share the proxy's IP. The api needs a deliberate `trustProxy` setting for Render. UNVERIFIED which address arrives.
6. **Health check endpoint.** The api has no `/healthz`. `render.yaml` uses the contract's public `GET /api/auth/config` (no database access, not rate limited, 200). Add a dedicated `/healthz` and switch the health check path.

## Secrets and configuration

Every variable is documented with a safe placeholder in `.env.example`. Where each value comes from on Render:

| Variable | Service(s) | Source in `render.yaml` |
|---|---|---|
| `DRAFTROOM_TICKET_SECRET`, `DRAFTROOM_INTERNAL_SECRET` | api, sync | env group `draftroom-staging-secrets`, `generateValue: true`. These are two independent base64 256-bit values, 44 chars each. The services require ≥ 32 chars, and the api requires the two values to differ. |
| `DATABASE_URL` | api | `fromDatabase … connectionString` (the internal URL). Internal connections don't require TLS. For `sslmode=require`, append it by hand; `verify-full` isn't supported internally. |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | api | `sync: false` (prompted once, at Blueprint creation) |
| `DRAFTROOM_SYNC_INTERNAL_URL` / `DRAFTROOM_API_INTERNAL_URL` | api / sync | `sync: false`. Set by hand (blocker 2). |
| `PUBLIC_ORIGIN` | api | `https://draftroom-staging-web.onrender.com` (must be https in production). Confirm the hostname Render assigns. |
| `VITE_TLDRAW_LICENSE_KEY` | web (build time) | `sync: false` |
| `NODE_ENV=production`, `DRAFTROOM_DATA_DIR=/var/data`, `AUTH_PROVIDER=clerk`, `ACCESS_RECHECK_MS=10000` | as listed | plain values |
| `HOST=0.0.0.0` | api, sync | image default (Render needs the public server on `0.0.0.0`) |
| `PORT` | api, sync | injected by Render (default 10000) |

Rules:

- **Never set** `DRAFTROOM_DEV_AUTH` or `VITE_DRAFTROOM_DEV_AUTH` on any deployed service.
- `sync: false` values are prompted **only at initial Blueprint creation**. Later Blueprint syncs ignore them. Change them in the Dashboard.
- Render passes every service env var to Docker builds as a **build argument**. Our Dockerfiles declare no `ARG`, so no secret enters an image layer. Keep it that way. Don't add Render "secret files" for these services either. Render copies secret files into the build context root, and while our Dockerfiles copy only explicit paths, this is easy to get wrong later.
- Logs contain route patterns, not URLs. Tickets, query strings and invitation tokens never appear. Verified in the smoke run below: the sync log shows only `refused on board …: bad_signature`.
- **Rotating** a group secret restarts every linked service. Render redeploys linked services on env-group changes when autodeploy is on. Autodeploy is off here, so redeploy api and sync by hand, together. Tickets live 60 s, so in-flight reconnects fail once and retry.

## tldraw license key

The editor runs free only on `http:` or loopback hosts. On **any HTTPS host without a key whose hosts include that hostname, the editor goes blank 5 s after load**, and a beacon goes to `cdn.tldraw.com` (probed in `docs/research/license.md` §4).

- Staging on `draftroom-staging-web.onrender.com` therefore needs a key that lists that exact hostname. A trial key works: 100 days, no grace period, and it sends `window.location.href` to tldraw.
- The license's Development Environment exemption covers staging only while it isn't accessible to end users. The internal pilot is production.
- The key is inlined **at build time** (`VITE_TLDRAW_LICENSE_KEY`). Adding a hostname or renewing requires a **rebuild** of the static site, not just a restart.
- The price is quote-only and still open (`docs/research/license.md` §10).

After deploy, load a board for more than 6 s and check that `[data-testid="tl-license-expired"]` is absent.

## Deploying

Automatic deploys are **off** for every service (`autoDeployTrigger: "off"`). Order matters, and an automatic deploy starts each service independently on a commit. We found no documented ordering, so this is UNVERIFIED.

1. **api first.** It runs database migrations at startup (`migrate(db)` in `apps/api/src/app.ts`, one transaction per migration, forward-only).
2. **sync second.** Deploy the server before any client that knows new shapes. A client with an unknown shape type fails on its first push with `INVALID_RECORD`, which is terminal (`docs/research/SYNTHESIS.md`).
3. **web last.**

Schedule deploys outside workshops: steps 1 and 2 each interrupt service.

### First provisioning

1. Publish the repo, then create the Blueprint from `render.yaml` in the Dashboard. This is the first cost-bearing step, so it needs an explicit go-ahead.
2. At the prompts, enter the following:
   - the Clerk keys;
   - the tldraw key;
   - for the two `*_INTERNAL_URL` values, the expected addresses (for example `http://draftroom-staging-sync:10000` and `http://draftroom-staging-api:10000`).
3. When the services exist, compare against what Render actually assigned, and fix any mismatch:
   - each service's **Connect → Internal** address;
   - the public `onrender.com` hostnames.
   Update the internal URLs in the Dashboard. Update the `PUBLIC_ORIGIN` value and the web `routes` destinations in `render.yaml` if the hostnames got a suffix. Redeploy in the order above.
4. Run the [first-deploy checks](#first-deploy-checks-unverified-until-done).

### What users see during a deploy

A disk disables zero-downtime deploys. Render **stops the old instance before starting the new one**; its docs call this "a few seconds" of unavailability. Our boot time comes on top: under 2 s on the NAS test host, UNVERIFIED on Render.

- **sync.** Every WebSocket closes when the instance is replaced.
  - Clients show *Offline* and keep local edits in memory ("kept in this tab only until reconnect"). A reload during the gap loses them.
  - `useSync` reconnects by itself, fetching a **fresh ticket** on every attempt (`createTicketUri`, backoff 0.5–5 s). It never uploads an old snapshot.
  - Nothing acknowledged is lost: each push is committed to SQLite before the ack.
- **api.** Requests fail during the swap. While closing, Fastify answers `503` (`return503OnClosing`). Ticket fetches retry with backoff.
  - A preview job in progress gets up to 10 s to finish (`WORKER_SHUTDOWN_GRACE_MS`).
  - An abandoned claim is requeued after 120 s (`LIMITS.staleProcessingMs`).
  - Uploads in flight during the swap fail and must be retried.
- **web.** The static site deploys without interruption. Tabs keep running the old bundle until reload.

A failed deploy is worse with a disk. The old instance is already gone, so the service stays down until you roll back or fix forward. A deploy that isn't healthy within 15 min is cancelled.

### Graceful shutdown, readiness and restarts (as implemented)

- **Signal path.** Render sends SIGTERM, then SIGKILL after `maxShutdownDelaySeconds` (30 s, set explicitly). The route is tini (PID 1) → `docker/entrypoint.sh`, which `exec`s the app as the unprivileged `node` user. The app is tini's direct child and receives the signal. tini also reaps the worker's ffmpeg/PDF children.
- **sync.** Stops accepting connections, closes all rooms (flushing the tombstone prune before closing each database), terminates sockets, and exits 0. It force-exits after 5 s.
- **api.** Runs `app.close()`, finishes in-flight requests and closes the pool, then exits 0. It force-exits after 5 s.
- **worker.** Finishes the current job (up to 10 s) or releases it.
- **Readiness.** `/healthz` (sync) and `/api/auth/config` (api) answer as soon as the server listens. Sync opens rooms lazily; the api has already migrated by then. Render stops routing to an instance after 15 s of failed checks and restarts it after 60 s. Background workers have no health checks, which matters for milestone 3.
- **Disk ownership.** Render reportedly mounts disks owned by root (from another Render user's report, 2026-09-25; UNVERIFIED by us). The entrypoint starts as root only to `chown` the top of `DRAFTROOM_DATA_DIR`, then drops to `node` via `setpriv --no-new-privs`. It never chowns recursively, because everything below is created by the app. Tested with a root-owned 0755 tmpfs mount.

## Backups: not yet (milestone 4)

There are **no application-level backups and no restore drill yet.** What exists by platform default:

- **Render disk snapshots.** One every 24 h, kept at least 7 days. Restoring one discards everything written after it.
  - These are infrastructure snapshots of live WAL-mode SQLite files, **not** consistent application backups. The build plan requires SQLite-backup-API copies to private storage with checksums (milestone 4).
  - They are **not** rolled back with a service rollback.
- **Render Postgres (paid).** Point-in-time recovery, with a 3-day window on the Hobby workspace and 7 days on Pro, plus on-demand logical exports.
- Postgres and canvas backups are **not coordinated**. A restore of one without the other can leave board ids or asset references dangling.

Treat staging data as disposable until milestone 4.

## Rollback

- **How.** Dashboard → service → Deploys → *Rollback*. Render reuses the earlier build artifact (no rebuild) and that deploy's environment variables. Disks, plan and static-site settings are *not* rolled back. A Dashboard rollback also disables autodeploy, which is already off.
- **Database.** Migrations are forward-only (never edit a shipped one). Rolling the api back past a migration is safe only if the older code tolerates the newer schema. Otherwise, fix forward.
- **Canvas schema.** Don't roll sync back below a canvas-schema migration. Boards already migrated on disk can't be loaded by the older server (`Incompatible schema?`), and newer clients are refused (`SERVER_TOO_OLD`). Rolling back the web client is safe while every shape migration keeps its `down`: an older client is served down-migrated records. Roll back sync only when its schema didn't change.
- **Disks.** Disk contents never roll back. To recover data you'd need a snapshot restore, which loses newer data (see above).

## Cost-bearing resources

Render prices from <https://render.com/pricing>, read 2026-09-27, USD per month. Re-check at provisioning.

| Resource | Plan | Monthly |
|---|---|---|
| `draftroom-staging-api` (api + worker) | `1c-2g` (1 CPU, 2 GB) | $25.00 |
| disk `draftroom-staging-files` | 5 GB × $0.25/GB | $1.25 |
| `draftroom-staging-sync` | `0.5c-512mb` (0.5 CPU, 512 MB) | $7.00 |
| disk `draftroom-staging-rooms` | 1 GB × $0.25/GB | $0.25 |
| `draftroom-staging-db` | `0.1c-256mb` | $6.00 |
| Postgres storage | 1 GB × $0.30/GB (the page also says "1 GB SSD storage included"; UNVERIFIED which applies) | ≤ $0.30 |
| `draftroom-staging-web` | static site | $0 |
| Bandwidth | Hobby: 5 GB included, then $0.15/GB. Pro: 25 GB included. | usage |
| Workspace | Hobby $0 (≤ 25 services) or Pro $25 | $0 or $25 |
| **Total** | | **≈ $39.80** (+ $25 on a Pro workspace, + bandwidth) |

This is within the build plan's staging allowance of $25–100/month. It excludes the tldraw license (quote-only), Clerk, and build-minute charges (UNVERIFIED). Cheaper options don't work here:

- free web services can't have disks or receive private-network traffic;
- free Postgres expires after 30 days.

## First-deploy checks (UNVERIFIED until done)

1. The static-site build works on Render's native image: pnpm installed via `npm install -g pnpm@10.34.5`, and Node taken from `.node-version`. Verified in a Debian container with Node 24.19.0 only.
2. The rewrite proxy `/api/*` and `/files/*` → api passes through:
   - the `Cookie` request header and `Set-Cookie` response header;
   - the `Origin` header unchanged (CSRF check);
   - query strings (`?board=`);
   - `POST` bodies up to 500 MB, and `Range` requests.
   It also needs acceptable timeouts. If any of these fail, use blocker 1 option (b).
3. The assigned hostnames and internal addresses match `render.yaml`.
4. api ↔ sync private-network calls work. Test: revoke a member's access and confirm their open board disconnects within 15 s (contract §7).
5. The disk is mounted and owned as expected. The entrypoint logs nothing on success; `ls -la /var/data` in a Render shell should show `node node`.
6. SQLite commit latency on the Render disk: `synchronous=FULL` fsync blocks the event loop (`docs/research/SYNTHESIS.md`). Measure p99 event-loop delay under load.
7. The WebSocket path once blocker 1 is fixed: connect, edit in two browsers, deploy sync, and confirm both reconnect and converge.
8. The tldraw key is accepted on the staging hostname (no blanking after 6 s).
9. Postgres over the internal URL works (verified locally against a PostgreSQL 18.6 server).

## Validation and build evidence (2026-09-26/27)

**Blueprint.**

- `render.yaml` was parsed with PyYAML 6.0 and validated with Ajv 8.20.0 (draft 2020-12). The schema is Render's published one, <https://render.com/schema/render.yaml.json> (the SchemaStore entry for `render.yaml`; `last-modified: 2026-09-26`). Result: **valid**.
- Negative checks all fail validation as they should: an unknown plan, an unknown field, a disk without `mountPath`, a header using `key` instead of `name`, unquoted `off` (YAML 1.1 reads it as a boolean), and a service plan used for Postgres.
- `ci.yml` validates against SchemaStore's `github-workflow.json`.

**Images.** Built on a Docker 29.6.2 amd64 host, using a dedicated `docker-container` buildx builder capped at 2 GB. The builder peaked at 934 MiB.

| Image | Build | Size | Filtered install |
|---|---|---|---|
| sync | 6–15 s | 251 MB | 4 of 14 workspace projects |
| api | 8 s | 302 MB | 7 of 14 |
| worker | 65 s (Debian ffmpeg 7.1.5) | 776 MB | 2 of 14 |
| api-worker | 13 s | 843 MB | 8 of 14 |

**Smoke runs.** All containers ran with memory limits and a root-owned data mount, which the entrypoint chowned. Each app ran as uid 1000.

- **sync:** `sync listening on 0.0.0.0:10000 (data: /var/data)`, `/healthz` → 200. `docker stop` → exit 0 in 0.25 s.
- **worker:** `[worker] started (data: /var/data, poll 500 ms)`. It processed real fixtures: a 1920×1080 PNG (thumb + display), a 4-page PDF (pages + thumb, via pdfjs + @napi-rs/canvas), and an H.264/AAC MP4 (poster + thumb, via Debian ffmpeg). `docker stop` → `[worker] SIGTERM: stopping`, `[worker] stopped`, exit 0.
- **api:** `api listening on 0.0.0.0:10000 (data: /var/data)`, `GET /api/auth/config` → 200. `docker stop` → exit 0. With `NODE_ENV=production` and `DRAFTROOM_DEV_AUTH=1` it refuses to start: `api: DRAFTROOM_DEV_AUTH=1 is refused when NODE_ENV=production`, exit 1.
  - Note: with PGlite (no `DATABASE_URL`) the api uses about 500 MB RSS and was OOM-killed at a 1 GB limit with PGlite on tmpfs. With Postgres it uses about 125 MB.
- **api-worker + sync + PostgreSQL 18.6** on a private Docker network, with dev sign-in because that needs no vendor keys:
  - migrations applied;
  - a login with a foreign `Origin` → 403;
  - dev login, board create;
  - upload a PNG → the worker in the same container processed it → derivative served (`image/webp`); via another board id → 404; without a session → 401;
  - a board ticket was accepted by sync (the socket stayed open), and a tampered ticket was closed with `4099 NOT_AUTHENTICATED`;
  - sync → api `GET /internal/access` → 200 (shared internal secret).
- **api-worker, graceful stop:** `docker stop` → the supervisor forwarded SIGTERM once, both children exited 0, container exit 0.
- **api-worker, crash:** SIGKILL of the worker child → `[supervisor] worker exited on its own (signal SIGKILL); stopping the other process`, api stopped, container exit 1.
- **api-worker, production-mode boot:** `NODE_ENV=production`, `AUTH_PROVIDER=clerk` with placeholder keys (no Clerk route was called), https `PUBLIC_ORIGIN`, and Postgres. It started, and `GET /api/auth/config` → `{"providers":["clerk"],...}`.
- **Static-site build command:** it ran in a Node 24.19.0 Debian container: 208 packages, `vite build` OK, `dist` 5.3 MB.

Reproduce locally (any Docker host, from the repo root):

```bash
docker build -f docker/sync.Dockerfile -t draftroom-sync .
docker run --rm -e DRAFTROOM_DATA_DIR=/var/data --tmpfs /var/data:mode=0755 -e PORT=10000 \
  -e DRAFTROOM_TICKET_SECRET="$(openssl rand -base64 32)" -e DRAFTROOM_INTERNAL_SECRET="$(openssl rand -base64 32)" \
  draftroom-sync
```

## CI

`.github/workflows/ci.yml` runs the same gate as `pnpm verify` on `ubuntu-24.04`:

1. Node from `.node-version` (24.19.0), pnpm from `packageManager` (10.34.5).
2. `pnpm install --frozen-lockfile`.
3. apt `ffmpeg`.
4. `pnpm lint`, `pnpm typecheck`, `pnpm fixtures`, `pnpm test`.
5. The Playwright chromium headless shell plus branded Google Chrome for the `@chrome` tests (H.264 playback).
6. `pnpm e2e`.
7. Test results uploaded on failure.

Actions are pinned to commit SHAs. **It has never run**: it starts working once the repository is published to GitHub. Expect to fix environment differences on the first run.

## Sources (read 2026-09-26/27)

- Blueprint spec: <https://render.com/docs/blueprint-spec>, schema <https://render.com/schema/render.yaml.json>
- Compute plans (August 2026 IDs): <https://render.com/docs/compute-plans>; pricing: <https://render.com/pricing>
- Persistent disks (single instance, no zero-downtime deploys, snapshots, disallowed mount paths): <https://render.com/docs/disks>
- Deploys (SIGTERM, 30 s default shutdown delay, pre-deploy runs on a separate instance): <https://render.com/docs/deploys>
- Health checks: <https://render.com/docs/health-checks>; rollbacks: <https://render.com/docs/rollbacks>
- Docker (BuildKit, env vars become build args, secret files in the context): <https://render.com/docs/docker>
- Web services (bind `0.0.0.0`, `PORT` default 10000): <https://render.com/docs/web-services>; WebSockets: <https://render.com/docs/websocket>
- Private network (web services receive, static sites not on it, Connect → Internal): <https://render.com/docs/private-network>
- Default environment variables: <https://render.com/docs/environment-variables>; env groups and redeploys: <https://render.com/docs/configure-environment-variables>
- Static-site redirects/rewrites (full-URL destinations, file-exists precedence): <https://render.com/docs/redirects-rewrites>; WebSocket rewrite request: <https://feedback.render.com/features/p/support-websockets-in-static-site-rewrites>
- Node version selection (precedence, default 24.21.0): <https://render.com/docs/node-version>
- Postgres connections (internal vs external, TLS): <https://render.com/docs/postgresql-creating-connecting>; free-tier limits: <https://render.com/docs/free>
- Root-owned disk report: <https://github.com/Otblakee/workspace-mcp-fixed/pull/35>
- Base image tag and digest: Docker Hub API, `library/node` tag `24.19.0-trixie-slim` (index `sha256:ab3eebe9…b3de`, updated 2026-08-25)
