# Deploying Draftroom (staging on Render)

Status (2026-09-27): **definition only.** Nothing has been provisioned, nobody has contacted Render, and the Blueprint has never been synced. The container images were rebuilt and smoke-tested on a local Docker host (below), including a browser run against the same topology, and `render.yaml` validates against Render's published schema. Everything that could only be proven on Render is marked **UNVERIFIED**.

The milestone-1 wiring blockers are resolved (see [resolved blockers](#resolved-in-the-platform-phase)). Two blockers remain before staging is usable: [sign-in keys and the tldraw license key](#still-open).

Files: `render.yaml` (Blueprint), `docker/*.Dockerfile` + `docker/entrypoint.sh` + `docker/api-and-worker.mjs` (images), `.dockerignore`, `.env.example` (every variable), `.github/workflows/ci.yml` (CI).

## Architecture on Render

```
browser ── https ──> draftroom-staging-web   (static site: SPA + rewrites /api/*, /files/* -> api)
   │                         │ rewrite (HTTP proxy, UNVERIFIED details)
   │                         v
   │                 draftroom-staging-api   (Docker web service: Fastify API + preview worker,
   │                         │   disk /var/data)      1 instance, disk = uploads, jobs, derivatives
   │                         │ private network (host:port from the Blueprint): DATABASE_URL,
   │                         │ api <-> sync internal calls (x-draftroom-internal)
   │                         v
   │                 draftroom-staging-db    (Render Postgres 18)
   │
   └── wss, DIRECT ──> draftroom-staging-sync (Docker web service: tldraw rooms, 1 instance,
       (VITE_DRAFTROOM_SYNC_ORIGIN;               disk /var/data/rooms/board-<id>.sqlite;
        ticket authenticates)                     Origin must be in ALLOWED_ORIGINS)
```

| Resource | Render type | Plan | Image / build | Disk | Health check |
|---|---|---|---|---|---|
| `draftroom-staging-web` | static site | free | `pnpm --filter @draftroom/web build` → `apps/web/dist` | — | — |
| `draftroom-staging-api` | web service, Docker | `1c-2g` | `docker/api-worker.Dockerfile` | `draftroom-staging-files`, 5 GB at `/var/data` | `GET /healthz` |
| `draftroom-staging-sync` | web service, Docker | `0.5c-512mb` | `docker/sync.Dockerfile` | `draftroom-staging-rooms`, 1 GB at `/var/data` | `GET /healthz` |
| `draftroom-staging-db` | Postgres 18 | `0.1c-256mb` | — | 1 GB storage | — |
| `draftroom-staging-secrets` | environment group | — | two generated 256-bit secrets | — | — |

All in `oregon` (services only share a private network within one region and workspace). Plan IDs are the names Render introduced in August 2026 (`0.5c-512mb` was "Starter", `1c-2g` "Standard"); the legacy names still work, the new ones are used here.

### Why the board socket goes straight to sync

Render static-site rewrites don't proxy WebSockets. This is an open Render feature request since 2020 (<https://feedback.render.com/features/p/support-websockets-in-static-site-rewrites>), and Render's WebSocket docs cover web services only. Two options were considered:

| Option | Result |
|---|---|
| **(a) Static site + a build-time sync origin (chosen)** | `apps/web` reads `VITE_DRAFTROOM_SYNC_ORIGIN` at build time and opens `wss://draftroom-staging-sync.onrender.com/connect/<board>?ticket=…`. The 60 s board ticket authenticates, so no cookie is needed cross-origin. Sync checks `Origin` against `ALLOWED_ORIGINS` before the upgrade, as defense in depth. $0 extra. |
| (b) Replace the static site with a reverse-proxy web service (e.g. Caddy) serving the SPA and proxying `/api`, `/files` and `/connect` | Same single-origin topology as dev. About $7/month more and one more service to run. Still the fallback if the rewrite checks below fail. |

How it behaves:

- **Unset `VITE_DRAFTROOM_SYNC_ORIGIN`** (dev, e2e, any single-origin edge): the socket goes to the page's own origin, as before (`apps/web/src/board/ticket.ts`).
- **Set**: an origin only, `https://host[:port]` or `wss://…` (`http` → `ws`, `https` → `wss`). A value with a path, query, credentials, another scheme, or an insecure socket from an https page is reported once in the browser console and the page origin is used instead.
- The value is inlined at build time. Changing the sync hostname needs a **static-site rebuild**.
- **Sync `ALLOWED_ORIGINS`**: exact origins, comma- or space-separated, normalized the way browsers serialize `Origin`. Required and https-only under `NODE_ENV=production`. A handshake from any other origin, with `Origin: null`, or with no `Origin` gets `403` before the upgrade: before the ticket is read and before any room opens. The log line names the refused origin, never the URL (the URL holds the ticket). Unset outside production means no check (the Vite proxy forwards whatever page is open).
- A non-browser client can forge `Origin`. That is why the ticket, not this check, is the authentication.
- The ticket is in the socket URL's query string on the sync hostname, as it was on the web origin before. It lives 60 s and is bound to one board. Render's edge logs are not ours to control.

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

### Resolved in the platform phase

1. **The board WebSocket can't go through the static site.** Resolved with option (a) [above](#why-the-board-socket-goes-straight-to-sync): `VITE_DRAFTROOM_SYNC_ORIGIN` on the static site, `ALLOWED_ORIGINS` on sync. Proven with a browser against the same topology (below); the Render side stays UNVERIFIED until the first deploy.
2. **Internal URLs can't be wired by the Blueprint.** Resolved: both `DRAFTROOM_SYNC_INTERNAL_URL` (api) and `DRAFTROOM_API_INTERNAL_URL` (sync) accept a full `http(s)` URL **or** `host:port`, which becomes `http://host:port`. `render.yaml` injects them with `fromService.property: hostport`, so there are no manual internal-URL steps any more. Under `NODE_ENV=production` both are **required**, and loopback addresses are refused at startup: `localhost`, `*.localhost`, `127.0.0.0/8`, `0.0.0.0`, `::1`, `::`, IPv4-mapped loopback, in any spelling WHATWG URL normalizes (`127.1`, `2130706433`, `[0:0::1]`). The api also refuses to start in production without an explicit `PUBLIC_ORIGIN`. Before this, a missing value silently meant `127.0.0.1`: access pushes failed, sync's re-checks failed *open*, and revocation was never enforced.
5. **Client IPs behind proxies.** Resolved in code: `TRUST_PROXY` is wired into Fastify's `trustProxy`, so `req.ip` and every per-IP rate limit use it. `render.yaml` sets `3`. Whether that is right for requests arriving through the static-site rewrite is UNVERIFIED; see [client IPs](#client-ips-and-trust_proxy).
6. **Health check endpoint.** Resolved: the api has `GET /healthz` (no database, no auth, not rate limited), and `render.yaml` uses it.

### Still open

3. **Sign-in.** Under `NODE_ENV=production` the api refuses `DRAFTROOM_DEV_AUTH=1` and `AUTH_PROVIDER=dev` (verified again in the rebuilt image). Staging therefore needs Clerk keys, and the Clerk adapter is **UNVERIFIED** until keys exist. Do not weaken the production guard to get a demo. Staging is internet-reachable, and dev sign-in lets anyone become anyone.
4. **tldraw license key.** See [below](#tldraw-license-key).

## Client IPs and TRUST_PROXY

The api's sign-in, logout and invitation routes are rate limited per client IP (`@fastify/rate-limit`, keyed on `req.ip`). Behind proxies, `req.ip` is only as good as the `TRUST_PROXY` setting:

| `TRUST_PROXY` | `req.ip` is | Use when |
|---|---|---|
| unset, `false`, `0` (default) | the socket peer | nothing proxies the api (local dev, the Vite proxy) |
| `N` (1–10) | the address `N` hops back from the socket (socket peer = hop 0, then X-Forwarded-For right to left) | exactly `N` proxies that **append** to X-Forwarded-For are in front of **every** request |
| `a,b,c` | the first address, walking from the socket, that is not one of these IPs / CIDRs / presets (`loopback`, `linklocal`, `uniquelocal`) | the proxies' addresses are known and stable |
| `true` | the leftmost X-Forwarded-For entry | only behind a proxy that **replaces** the header; otherwise any client picks its own bucket |

Fastify 5.12 deliberately treats a *numeric* `trustProxy` as "trust nothing" (a hop count cannot tell a proxy from a direct client), so the hop count is passed as a function. Tests: `apps/api/test/config.test.ts` drives the real sign-in limit through `app.inject` with a socket peer and forwarded chains, including clients that prepend fake entries.

What we know about Render:

- Render's DDoS article says traffic passes through Cloudflare and Render's load balancers, and the client IP must be read from `x-forwarded-for`.
- Render staff said in 2021 that Render sets the first entry to the real client IP.
- A third-party measurement from 2026-09-26 (<https://github.com/Kigen29/seo-agent-capstone/issues/199>) contradicts that. A direct request carried `client, <Cloudflare 172.64.0.0/13 address>, <10.x load balancer>`. Client-written entries were **kept**, and the client was 3 hops back from the process.

On that evidence, `true` would let any client choose its own rate-limit bucket on Render, and `3` keys direct requests on the real client without being spoofable. **UNVERIFIED by us:**

- the chain on requests that arrive through the static-site rewrite. That path adds at least one more proxy.
  - If it keeps the browser's address further left, `3` makes all browser users share the rewrite proxy's bucket. That is safe, but the sign-in limit becomes shared.
  - Raising the value is not a fix: the api's own `onrender.com` hostname is public, so any `N` above the direct-path count lets direct callers spoof. If the rewrite path needs more hops, use an address list of the rewrite proxy's ranges, or option (b).
- whether Render keeps that chain shape.

First-deploy check: from two different networks, send 31 `POST /api/auth/logout` requests in a minute through the static site from one (the 31st gets `429`). Confirm the other network still gets `200`.

## Secrets and configuration

Every variable is documented with a safe placeholder in `.env.example`. Where each value comes from on Render:

| Variable | Service(s) | Source in `render.yaml` |
|---|---|---|
| `DRAFTROOM_TICKET_SECRET`, `DRAFTROOM_INTERNAL_SECRET` | api, sync | env group `draftroom-staging-secrets`, `generateValue: true`. These are two independent base64 256-bit values, 44 chars each. The services require ≥ 32 chars, and both refuse two equal values. |
| `DATABASE_URL` | api | `fromDatabase … connectionString` (the internal URL). Internal connections don't require TLS. For `sslmode=require`, append it by hand; `verify-full` isn't supported internally. |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | api | `sync: false` (prompted once, at Blueprint creation) |
| `DRAFTROOM_SYNC_INTERNAL_URL` | api | `fromService: {type: web, name: draftroom-staging-sync, property: hostport}` → `draftroom-staging-sync-xxxx:10000` → `http://…`. Required, non-loopback in production. |
| `DRAFTROOM_API_INTERNAL_URL` | sync | `fromService: {type: web, name: draftroom-staging-api, property: hostport}`. Same rules. |
| `PUBLIC_ORIGIN` | api | `https://draftroom-staging-web.onrender.com`. Required and https in production. Confirm the hostname Render assigns. |
| `ALLOWED_ORIGINS` | sync | `https://draftroom-staging-web.onrender.com` (the same web origin). Required and https in production. |
| `TRUST_PROXY` | api | `"3"` ([client IPs](#client-ips-and-trust_proxy)) |
| `VITE_DRAFTROOM_SYNC_ORIGIN` | web (build time) | `https://draftroom-staging-sync.onrender.com`. Confirm the hostname; a change needs a rebuild. |
| `VITE_TLDRAW_LICENSE_KEY` | web (build time) | `sync: false` |
| `NODE_ENV=production`, `DRAFTROOM_DATA_DIR=/var/data`, `AUTH_PROVIDER=clerk`, `ACCESS_RECHECK_MS=10000` | as listed | plain values |
| `HOST=0.0.0.0` | api, sync | image default (Render needs the public server on `0.0.0.0`) |
| `PORT` | api, sync | injected by Render (default 10000) |

Rules:

- **Never set** `DRAFTROOM_DEV_AUTH` or `VITE_DRAFTROOM_DEV_AUTH` on any deployed service.
- `sync: false` values are prompted **only at initial Blueprint creation**. Later Blueprint syncs ignore them. Change them in the Dashboard.
- The api and sync reference each other's `hostport`. The schema accepts this; UNVERIFIED that Render resolves the mutual reference on the first sync (fallback: set the two values by hand as `host:port` once, then re-sync).
- Render passes every service env var to Docker builds as a **build argument**. Our Dockerfiles declare no `ARG`, so no secret enters an image layer. Keep it that way. Don't add Render "secret files" for these services either. Render copies secret files into the build context root, and while our Dockerfiles copy only explicit paths, this is easy to get wrong later.
- Logs contain route patterns, not URLs. Tickets, query strings and invitation tokens never appear. Verified again in the smoke run below: sync logs `refused on board …: bad_signature` and `refused: Origin "https://evil.example" is not in ALLOWED_ORIGINS`.
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
2. At the prompts, enter the Clerk keys and the tldraw key. The internal URLs are wired by the Blueprint (`hostport`).
3. When the services exist, compare the public `onrender.com` hostnames with the four places that name them:
   - `PUBLIC_ORIGIN` (api) and `ALLOWED_ORIGINS` (sync): the web hostname;
   - the web `routes` destinations: the api hostname;
   - `VITE_DRAFTROOM_SYNC_ORIGIN` (web): the sync hostname.
   If Render added a suffix, fix `render.yaml`, re-sync, and **rebuild** the static site. A startup refusal in the api or sync logs names the variable at fault.
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
- **api.** Runs `app.close()`, finishes in-flight requests and closes the pool, then exits 0. It force-exits (exit 1) after 5 s.
  - **Fixed in the features-integration pass (2026-09-27):** an open board event stream (`GET /api/boards/:bid/events`, SSE) used to keep `app.close()` waiting, so with one open stream `docker stop` took the 5 s force-exit path (exit 1 in 5.27 s, measured on the NAS) and the supervised container exited 1. `apps/api/src/events/routes.ts` now ends open streams in a `preClose` hook (test: `apps/api/test/events.test.ts`); clients reconnect on their own. Not re-measured on the NAS.
- **worker.** Finishes the current job (up to 10 s) or releases it.
- **Readiness.** `/healthz` (sync and api) answers as soon as the server listens. Sync opens rooms lazily; the api has already migrated by then. Render stops routing to an instance after 15 s of failed checks and restarts it after 60 s. Background workers have no health checks, which matters for milestone 3.
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
- **Platform config.** A web build from before the platform phase ignores `VITE_DRAFTROOM_SYNC_ORIGIN` and connects to the static site, which cannot carry the socket. On Render, don't roll the static site back past it. A sync or api build from before it ignores `ALLOWED_ORIGINS`/`TRUST_PROXY` and refuses to start with the Blueprint's `host:port` internal URLs (it wants `http://…`). Don't roll those back past it either, or set full URLs by hand first.
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

This is within the build plan's staging allowance of $25–100/month. It excludes the tldraw license (quote-only), Clerk, and build-minute charges (UNVERIFIED). Option (b) for the WebSocket would add about $7. Cheaper options don't work here:

- free web services can't have disks or receive private-network traffic;
- free Postgres expires after 30 days.

## First-deploy checks (UNVERIFIED until done)

1. The static-site build works on Render's native image: pnpm installed via `npm install -g pnpm@10.34.5`, and Node taken from `.node-version`. Verified in a Debian container with Node 24.19.0 only (milestone 1).
2. The rewrite proxy `/api/*` and `/files/*` → api passes through:
   - the `Cookie` request header and `Set-Cookie` response header;
   - the `Origin` header unchanged (CSRF check);
   - query strings (`?board=`);
   - `POST` bodies up to 500 MB, and `Range` requests.
   It also needs acceptable timeouts, including for the long-lived board event stream (SSE). If any of these fail, use option (b).
3. The assigned hostnames match `render.yaml` (the four places in [first provisioning](#first-provisioning)), and the `hostport` references resolved.
4. api ↔ sync private-network calls work. Test: revoke a member's access and confirm their open board disconnects within 15 s (contract §7).
5. The board WebSocket goes to `wss://draftroom-staging-sync.onrender.com` (browser devtools, Network → WS). A page on another origin gets `403` (sync log: `refused: Origin …`).
6. Per-client rate limits ([client IPs](#client-ips-and-trust_proxy)): the two-network check.
7. The disk is mounted and owned as expected. The entrypoint logs nothing on success; `ls -la /var/data` in a Render shell should show `node node`.
8. SQLite commit latency on the Render disk: `synchronous=FULL` fsync blocks the event loop (`docs/research/SYNTHESIS.md`). Measure p99 event-loop delay under load.
9. Reconnect across a deploy: connect, edit in two browsers, deploy sync, and confirm both reconnect and converge.
10. The tldraw key is accepted on the staging hostname (no blanking after 6 s).
11. Postgres over the internal URL works (verified locally against a PostgreSQL 18.6 server).

## Validation and build evidence

### Platform phase (2026-09-27)

**Blueprint.**

- `render.yaml` was parsed with PyYAML 6.0 and validated with Ajv 8.20.0 (draft 2020-12). The schema is Render's published one, <https://render.com/schema/render.yaml.json> (byte-identical to the milestone-1 copy: `last-modified: Sat, 26 Sep 2026 02:28:12 GMT`). Result: **valid**.
- The `fromService` references use the schema's `serviceEnvVarProperty` enum (`host`, `port`, `hostport`, `slug`, `connectionString`).
- Negative checks all fail validation as they should: `property: url`, a `fromService` without `name`, an unknown service type, `value` together with `fromService`, a health check on the static site, an unknown plan, and a boolean `autoDeployTrigger`.

**Config rules, unit and integration tests** (all in the normal suites):

- `apps/api/test/config.test.ts`: the production requirements (`PUBLIC_ORIGIN`, sync URL), loopback refusal in 15 spellings, `host:port`, `TRUST_PROXY` parsing, and 4 behavioral rate-limit scenarios through Fastify.
- `apps/sync/src/config.test.ts`: the same rules for sync, plus `ALLOWED_ORIGINS`.
- `apps/sync/test/http/origin.test.ts`: the real upgrade path, including loadConfig → server.
- `apps/web/src/board/ticket.test.ts`: `VITE_DRAFTROOM_SYNC_ORIGIN` handling.
- A production `vite build` with the variable set inlines it into the board chunk.

**Images.** Rebuilt from the current tree on the Docker 29.6.2 amd64 host, using a dedicated `docker-container` buildx builder capped at 2 GB (memory.peak 2038 MiB, almost all page cache: 120 MB anon; no OOM events). The Dockerfiles are unchanged.

| Image | Build | Size | Filtered install |
|---|---|---|---|
| sync | 15 s | 251 MB | 5 of 14 workspace projects |
| api | 8 s | 302 MB | 7 of 14 |
| worker | 64 s | 776 MB | 2 of 14 |
| api-worker | 13 s | 843 MB | 8 of 14 |

**Production boot rules** (image defaults: `NODE_ENV=production`). Each refusal exits 1 with a one-line message naming the variable.

- **sync refuses to start:**
  - without `DRAFTROOM_API_INTERNAL_URL`;
  - with `127.0.0.1:10000` or `http://localhost:10000`;
  - without `ALLOWED_ORIGINS`;
  - with an `http` origin in `ALLOWED_ORIGINS`.
- **api (api-worker image) refuses to start:**
  - without `PUBLIC_ORIGIN`;
  - without `DRAFTROOM_SYNC_INTERNAL_URL`;
  - with `http://127.0.0.1:5858`;
  - with `TRUST_PROXY=yes`;
  - with `DRAFTROOM_DEV_AUTH=1` (the milestone-1 rule).
- **Good production configs boot**, using host:port internal URLs, https origins, `TRUST_PROXY=3`, Clerk placeholder keys and PostgreSQL 18.6:
  - sync and api `/healthz` → `200 ok`;
  - `/api/auth/config` → `{"providers":["clerk"],…}`;
  - api → sync internal call over `draftroom-buildcheck-sync:10000` → 200;
  - sync → api `/internal/access` over `draftroom-buildcheck-api:10000` → `200 {"role":null}`;
  - `docker stop` → exit 0 in 0.26 s (sync) and 0.25 s (api-worker: both children exited 0).

**Render topology on one host** (dev sign-in, because that needs no vendor keys):

- the api-worker, sync and PostgreSQL 18.6 containers on a private network, with internal URLs in `host:port` form and access re-checks set to 10 min (so only the push path can revoke);
- a stand-in for the static site: it serves the SPA and rewrites `/api` + `/files`, and **refuses WebSocket upgrades**, like Render;
- sync published directly.

Smoke run from a container on the private network:

- api `/healthz` → 200. Login with a foreign `Origin` → 403.
- Upload a PNG → the co-located worker processed it (`thumb`, `display`) → derivative served as `image/webp`. The same derivative for a user without access → 404.
- A board ticket from the allowed origin → the socket stays open.
- The same ticket from `https://evil.example` → `403` before the upgrade. With no `Origin` → `403`. A tampered ticket from the allowed origin → `4099 NOT_AUTHENTICATED`.
- **Revocation over the host:port channel:** grant bob editor, and bob's socket opens. Remove bob → his open socket closed with `4099 FORBIDDEN` 15 ms later (api push → sync → api re-check). Bob's next ticket → 404.

Browser run from this PC (Chrome 153 via playwright-core) against the same host:

- sign-in through the UI;
- the board socket went to the sync origin, not the page origin (`ws://…:18472/connect/<board>`), and the status pill showed Live;
- a second user saw the first user's shapes and vice versa;
- a WebSocket to the page origin's `/connect` failed (1006), as on Render;
- a page on another origin holding the same **valid** ticket was refused (1006; sync logged `refused: Origin "http://…:18473"`), and its sign-in POST got `403`.

**Worker image:** processed a 1920×1080 PNG (`thumb`, `display`), a 4-page PDF (`page` ×4, `thumb`) and an H.264/AAC MP4 (`poster`, `thumb`) as uid 1000. `docker stop` → `[worker] SIGTERM: stopping`, `[worker] stopped`, exit 0.

**api-worker crash:** SIGKILL of the worker child → `[supervisor] worker exited on its own (signal SIGKILL); stopping the other process`, api stopped, container exit 1.

**Host isolation:**

- Everything was named `draftroom-buildcheck-*`, and sources lived in `/volume3/Apps/draftroom-buildcheck/`. No system prune was run, and nothing of the existing compose project was touched.
- Afterwards the containers, images (including `postgres:18` and `moby/buildkit`), network, builder (with its state volume) and folder were removed.
- `docker ps -a` / `images` / `volume ls` / `network ls` / `buildx ls` / `system df` and `/volume3/Apps` were **identical** before and after.

### Milestone 1 (2026-09-26/27)

- `ci.yml` validates against SchemaStore's `github-workflow.json`.
- **Static-site build command:** it ran in a Node 24.19.0 Debian container: 208 packages, `vite build` OK, `dist` 5.3 MB.
- With PGlite (no `DATABASE_URL`), the api uses about 500 MB RSS and was OOM-killed at a 1 GB limit with PGlite on tmpfs. With Postgres it uses about 125 MB.
- The api-worker's graceful stop and crash behavior, the worker fixtures and the Postgres run were first verified then, and re-verified above.

Reproduce locally (any Docker host, from the repo root). Production mode needs the platform variables:

```bash
docker build -f docker/sync.Dockerfile -t draftroom-sync .
docker run --rm -e DRAFTROOM_DATA_DIR=/var/data --tmpfs /var/data:mode=0755 -e PORT=10000 \
  -e DRAFTROOM_TICKET_SECRET="$(openssl rand -base64 32)" -e DRAFTROOM_INTERNAL_SECRET="$(openssl rand -base64 32)" \
  -e DRAFTROOM_API_INTERNAL_URL=api-host:10000 -e ALLOWED_ORIGINS=https://draftroom.example \
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

- Blueprint spec (`fromService` `host` / `port` / `hostport`): <https://render.com/docs/blueprint-spec>, schema <https://render.com/schema/render.yaml.json>
- Compute plans (August 2026 IDs): <https://render.com/docs/compute-plans>; pricing: <https://render.com/pricing>
- Persistent disks (single instance, no zero-downtime deploys, snapshots, disallowed mount paths): <https://render.com/docs/disks>
- Deploys (SIGTERM, 30 s default shutdown delay, pre-deploy runs on a separate instance): <https://render.com/docs/deploys>
- Health checks: <https://render.com/docs/health-checks>; rollbacks: <https://render.com/docs/rollbacks>
- Docker (BuildKit, env vars become build args, secret files in the context): <https://render.com/docs/docker>
- Web services (bind `0.0.0.0`, `PORT` default 10000): <https://render.com/docs/web-services>; WebSockets: <https://render.com/docs/websocket>
- Private network (web services receive, static sites not on it, Connect → Internal): <https://render.com/docs/private-network>
- Default environment variables: <https://render.com/docs/environment-variables>; env groups and redeploys: <https://render.com/docs/configure-environment-variables>
- Static-site redirects/rewrites (full-URL destinations, file-exists precedence): <https://render.com/docs/redirects-rewrites>; WebSocket rewrite request: <https://feedback.render.com/features/p/support-websockets-in-static-site-rewrites>
- Client IPs: <https://render.com/articles/how-render-handles-ddos-attacks> (Cloudflare + load balancers, read `x-forwarded-for`); <https://feedback.render.com/features/p/send-the-correct-xforwardedfor> (2021 staff reply); measured chain 2026-09-26: <https://github.com/Kigen29/seo-agent-capstone/issues/199>. Fastify's numeric `trustProxy` fails closed: `node_modules/fastify/lib/request.js` (5.12.5).
- Node version selection (precedence, default 24.21.0): <https://render.com/docs/node-version>
- Postgres connections (internal vs external, TLS): <https://render.com/docs/postgresql-creating-connecting>; free-tier limits: <https://render.com/docs/free>
- Root-owned disk report: <https://github.com/Otblakee/workspace-mcp-fixed/pull/35>
- Base image tag and digest: Docker Hub API, `library/node` tag `24.19.0-trixie-slim` (index `sha256:ab3eebe9…b3de`, updated 2026-08-25)
