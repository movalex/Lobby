# Deploying Draftroom (staging on Render)

Status (2026-09-27, milestone 3): **definition only.** Nothing has been provisioned from this version of the Blueprint and nobody has contacted Render for it. An earlier version was synced once on 2026-09-27 and Render refused it (`maxShutdownDelaySeconds` on services with a disk; removed). `render.yaml` validates against Render's published schema, with and without the optional worker. The milestone-3 container images have **not been built yet** (no Docker on the dev PC): the NAS proof phase builds and runs them. Everything that can only be proven on Render is marked **UNVERIFIED**.

What changed in milestone 3 ([docs/M3-STORAGE-CONTRACTS.md](M3-STORAGE-CONTRACTS.md)):

- Files moved off the api's disk. Uploads stream to **Cloudflare R2**; asset metadata and the preview-job queue moved into **Postgres**.
- The api has **no disk** and runs on the smallest paid plan (`0.5c-512mb`). The preview worker no longer runs inside it.
- Preview workers are separate HTTP clients of the api and can run **anywhere**: on the NAS (primary, see [deploy/nas/README.md](../deploy/nas/README.md)) and, optionally, as a Render background worker.
- Default monthly cost went from about $39.80 to about **$20.25** ([Cost](#cost)).

Two blockers remain before staging is usable: [sign-in keys and the tldraw license key](#still-open).

Files: `render.yaml` (Blueprint), `docker/api.Dockerfile`, `docker/sync.Dockerfile`, `docker/worker.Dockerfile`, `docker/entrypoint.sh` (images), `.dockerignore`, `.env.example` (every variable), `deploy/nas/` (NAS worker), `.github/workflows/ci.yml` (CI).

## Architecture on Render

```
browser ── https ──> draftroom-staging-web     static site: SPA + rewrites /api/*, /files/* -> api
   │                         │ rewrite (HTTP proxy; pass-through details UNVERIFIED)
   │                         v
   │                 draftroom-staging-api     Docker web service, NO disk, 1 instance
   │                   │   │   │               Fastify API; streams uploads to R2 and proxies file
   │                   │   │   │               bytes back (Range, all M0 headers); asset rows + jobs
   │                   │   │   │               in Postgres
   │                   │   │   └── https, S3 API, api-only keys ──> Cloudflare R2  bucket draftroom-staging
   │                   │   │                                          ^
   │                   │   │ private network: DATABASE_URL,           │ presigned GET original /
   │                   │   │ api <-> sync internal calls              │ PUT derivatives (<= 15 min)
   │                   │   v                                          │
   │                   │ draftroom-staging-db   Render Postgres 18     │
   │                   │                                              │
   │                   │ /api/worker/*  (Authorization: Bearer DRAFTROOM_WORKER_TOKEN)
   │         ┌─────────┴──────────────────────────┐                   │
   │   https, api's public URL             private host:port          │
   │         │                                    │                   │
   │   NAS preview worker (primary)     draftroom-staging-worker      │
   │         │                          (OPTIONAL, commented out)     │
   │         └──────────────────┬─────────────────┘                   │
   │                            └── original / derivative bytes ──────┘
   │
   └── wss, DIRECT ──> draftroom-staging-sync   Docker web service: tldraw rooms, 1 instance,
       (VITE_DRAFTROOM_SYNC_ORIGIN;              disk /var/data/rooms/board-<id>.sqlite;
        ticket authenticates)                    Origin must be in ALLOWED_ORIGINS
```

| Resource | Render type | Plan | Image / build | Disk | Health check |
|---|---|---|---|---|---|
| `draftroom-staging-web` | static site | free | `pnpm --filter @draftroom/web build` → `apps/web/dist` | — | — |
| `draftroom-staging-api` | web service, Docker | `0.5c-512mb` | `docker/api.Dockerfile` | **none** | `GET /healthz` |
| `draftroom-staging-sync` | web service, Docker | `0.5c-512mb` | `docker/sync.Dockerfile` | `draftroom-staging-rooms`, 1 GB at `/var/data` | `GET /healthz` |
| `draftroom-staging-db` | Postgres 18 | `0.1c-256mb` | — | 1 GB storage | — |
| `draftroom-staging-secrets` | environment group (api, sync) | — | ticket + internal secrets, generated | — | — |
| `draftroom-staging-worker-token` | environment group (api, workers) | — | worker token, generated | — | — |
| `draftroom-staging-worker` | background worker, Docker | `0.5c-512mb` | `docker/worker.Dockerfile` | none | none (workers have none) |

The last row is **optional and commented out** in `render.yaml`. Cloudflare R2 is outside Render; the user created the bucket and token already ([Cloudflare R2](#cloudflare-r2)).

Everything is in `oregon`: services only share a private network within one region and workspace. Plan IDs are the names Render introduced in August 2026 (`0.5c-512mb` was "Starter", `1c-2g` "Standard"); the legacy names still work, the new ones are used here.

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

### Sync: one instance, one disk, no autoscaling (unchanged)

Exactly one `TLSocketRoom` may own a board. The sync service therefore has `numInstances: 1`, no `scaling` block, and the per-board SQLite files on its own persistent disk. A second instance would open a second room on a different disk and split the board. Render cannot scale a service that has a disk anyway, and a disk also disables zero-downtime deploys (see [interruptions](#what-users-see-during-a-deploy)). Scaling past one process is a separate architecture decision (build plan §6).

### api: no disk, one instance

- **Nothing durable in the container.** With `DRAFTROOM_BLOB_STORE=r2` the bytes are in R2, and with `DATABASE_URL` the metadata and job queue are in Postgres. `DRAFTROOM_DATA_DIR` is set to `/tmp/draftroom-api`, a scratch path on the ephemeral filesystem, only because the api's config still asks for one. Never remove `DATABASE_URL`: without it the api would put PGlite there and lose the database on the next deploy.
- **Browser file access is unchanged.** `/files/<ast>/<ver>/original` and `/files/<ast>/<ver>/d/<drv>` stay same-origin (through the static-site rewrite). The api authorizes them exactly as before and proxies the bytes from R2, forwarding `Range` and setting every M0 header. So the bucket needs no CORS and no public access, and canvas exports keep working.
- **One instance.** `numInstances: 1` stays, even though a service without a disk could scale. The board event hub (SSE) and the rate-limit counters are in-process (`apps/api/src/events/hub.ts`), so a second instance would miss the other's events. Scaling needs a shared transport (Postgres `LISTEN/NOTIFY` or Key Value) first.
- **Zero-downtime deploys are back.** Render keeps the old instance serving until the new one passes `/healthz`, then sends the old one SIGTERM about 60 s later. Consequences are under [deploying](#deploying).
- **Memory.** The api measured about 125 MB RSS with Postgres (milestone 1). Uploads stream to R2 with an exact `Content-Length` and are never buffered in full. Measured locally against the real bucket (2026-09-27, [evidence](#milestone-3-integration-live-r2-from-the-dev-pc-2026-09-27)): a 200 MiB upload raised the api's working set by **21 MiB** and streaming it back out by **35 MiB**. Still UNVERIFIED on Render; see the [first-deploy checks](#first-deploy-checks-unverified-until-done).
- **`DATABASE_URL` is also a memory requirement.** Without it the api runs PGlite (in-process Postgres), whose startup alone peaked at **0.83–1.13 GB** working set on the dev PC (settling near 290 MB). That can't fit `0.5c-512mb`. With `DATABASE_URL` PGlite is never loaded.

### Retired: the co-located api + worker image

Milestones 1–2 ran the preview worker inside the api container (`docker/api-worker.Dockerfile` + the `docker/api-and-worker.mjs` supervisor) because the file store was local disk and a Render disk attaches to one service only. Milestone 3 removes that reason: the worker now reaches files only through the api's worker routes and presigned URLs. Both files were **deleted** (they stay in git history):

- no deployment uses them any more, and an untested deployment file drifts;
- the supervisor would now start a worker that needs `DRAFTROOM_API_URL` and a token only to talk to its own container;
- keeping the worker out of the api is what lets the api fit `0.5c-512mb` (the worker's PDF child alone may take 384 MB).

Don't roll the api back to a milestone-1/2 build on Render ([rollback](#rollback)).

## Preview workers

Protocol ([contract §4–§5](M3-STORAGE-CONTRACTS.md)): a worker polls `POST /api/worker/claim` and gets a 120 s lease on the oldest queued job (`FOR UPDATE SKIP LOCKED` in Postgres, so any number of workers can poll at once). It downloads the original from a presigned R2 URL, renders the derivatives with the M0 limits, reserves each one and `PUT`s it to a presigned URL, then calls `complete` (or `retry`). It heartbeats at least every 30 s. A worker that dies loses its lease, and another worker reclaims the job after the lease expires.

- **No worker running** is a safe state. New uploads keep their placeholder tiles (queued) and originals stay downloadable. The jobs wait in Postgres until a worker comes back.
- **What a worker holds:** `DRAFTROOM_API_URL` and `DRAFTROOM_WORKER_TOKEN`, nothing else. No database URL, no R2 keys, no ticket or internal secret. The token can read the originals of queued jobs and write their derivatives. It can't read boards, users or other assets.
- **Where they run:**

| Worker | Cost | `DRAFTROOM_API_URL` | Notes |
|---|---|---|---|
| **NAS** (primary) | $0 on Render | `https://draftroom-staging-api.onrender.com` (the api's own public URL) | Built and started by `deploy/nas/` ([deploy/nas/README.md](../deploy/nas/README.md)): one container with memory/CPU caps, `restart: unless-stopped`, no published ports, `cap_drop: ALL`, `no-new-privileges`, and an env file holding only the two values. Outbound HTTPS only. |
| **Render background worker** (optional) | +$7/month (`0.5c-512mb`) | the api's private `host:port`, injected by the Blueprint | Always-on backup when the NAS is off. Commented out in `render.yaml`. |

To enable the Render worker, delete the leading `# ` from every line of the block at the end of `render.yaml` (the block validates; see [validation](#validation-and-build-evidence)) and sync the Blueprint. Nothing needs to be prompted: the token comes from its environment group.

### Public URL or private `host:port`

| | Public `https://draftroom-staging-api.onrender.com` | Private `hostport` (`draftroom-staging-api-xxxx:10000`) |
|---|---|---|
| Reachable from | anywhere | Render services in `oregon`, same workspace only |
| Wiring | a literal hostname that must match what Render assigned | `fromService … property: hostport`: nothing to guess or fix after creation |
| Transport | TLS through Cloudflare and Render's edge | plain HTTP on Render's private network, like api ↔ sync and the database |
| Bandwidth | api responses count as billable outbound bandwidth | private traffic is not billed |
| Client IP | passes the `TRUST_PROXY` hop logic | direct socket peer |
| **Used by** | **the NAS worker** (the only option outside Render) | **the Render worker** |

The NAS worker uses the api's own hostname, not the static site's `/api/*` rewrite. Worker routes aren't browser routes, and the rewrite adds a proxy whose behavior is still UNVERIFIED.

The worker turns `host:port` into `http://host:port`, the same rule the api and sync apply to their internal URLs (`apps/worker/src/env.ts`). Under `NODE_ENV=production` it accepts plain http only for private-network hosts, such as a single-label name like Render's `hostport` or an RFC 1918 or loopback address, and refuses `http://draftroom-staging-api.onrender.com`. Checked on 2026-09-27 by feeding the Blueprint's worker environment to `loadWorkerEnv`: `draftroom-staging-api-xxxx:10000` → `http://draftroom-staging-api-xxxx:10000` (accepted), and the NAS URL `https://…` (accepted). Real Render resolution of the `hostport` stays UNVERIFIED until the first deploy.

### Worker token

- It lives in its own environment group, `draftroom-staging-worker-token`, generated by Render (base64, 256-bit, 44 chars; the api requires ≥ 32). The group is linked to the api and the optional Render worker.
- Why not `draftroom-staging-secrets`: that group also holds the ticket secret (which can mint a ticket for any board) and the internal secret, and a worker must get neither. An environment group can only be linked whole.
- **NAS:** copy the value from Dashboard → Environment Groups → `draftroom-staging-worker-token` into the NAS env file. Never commit it or paste it into chat or tickets.
- **Rotate** (e.g. after a NAS compromise): replace the value in the group with a new random one (≥ 32 chars, e.g. `openssl rand -base64 32`, different from the two secrets in the other group). Then redeploy the api and the Render worker by hand, since autodeploy is off. Then update the NAS env file and restart that container. Until then the NAS worker gets `401` and claims nothing.

### Sizing

- `WORKER_CONCURRENCY=1` everywhere to start.
- The PDF child's heap is capped by `WORKER_PDF_HEAP_MB` (default 384). On the 512 MB Render worker, `render.yaml` sets **256**, so an oversized PDF fails as a job error instead of the instance being OOM-killed and the job retried until `maxAttempts`. UNVERIFIED on Render. If real PDFs fail there, move the worker to `1c-2g` ($25) with the default heap.
- **Temp space:** each job downloads its original (≤ 500 MB for video) into `WORKER_TMP_DIR` (default: the OS temp dir, `/tmp` in the image). Budget ≥ 1 GB per concurrent job. Render's ephemeral `/tmp` is reportedly capped at 2 GB (a 2022 user report, no Render statement; UNVERIFIED).

## Cloudflare R2

Done by the user (2026-09-27):

- Bucket **`draftroom-staging`**, private: no public `r2.dev` URL, no custom domain, no CORS rules. None are needed. The browser never talks to R2, and workers aren't browsers.
- An R2 API token **scoped to that bucket only**, with permission **Object Read & Write**. It gives an Access Key ID and a Secret Access Key (S3-compatible credentials). The Cloudflare account ID comes from the dashboard.
- The values are in the gitignored `.env.deploy.local` on the dev PC, for the opt-in live R2 tests (`CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`). They run only with `DRAFTROOM_LIVE_R2=1`, write only under `test/<run-id>/`, and delete what they wrote. The e2e stack can also point its api at the bucket (`E2E_BLOB_STORE=r2` plus the four `R2_*` values in the environment). The api has no key prefix, so that run writes real `assets/…` keys, and whoever runs it must delete them afterwards ([how it was done](#milestone-3-integration-live-r2-from-the-dev-pc-2026-09-27)).

Rules:

- **Don't change the bucket's settings** (public access, CORS, lifecycle, location) as part of a deploy.
- Only the api gets R2 credentials. They're entered at Blueprint creation (`sync: false`): `R2_ACCOUNT_ID` (the Cloudflare account ID, 32 hex characters), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` = `draftroom-staging`.
- The api checks them at startup and refuses to start, naming the variable, never the value, if one is missing or malformed. Under `NODE_ENV=production` it also refuses to start without an explicit `DRAFTROOM_BLOB_STORE`. The user's real values (`.env.deploy.local`, with `CLOUDFLARE_ACCOUNT_ID` as `R2_ACCOUNT_ID`) pass these checks (2026-09-27, checked offline, no value printed).
- Endpoint: `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>` (path style, region `auto`). Object keys are `assets/<ast>/<ver>/original` and `assets/<ast>/<ver>/d/<drv>.<webp|png>`.
- Presigned URLs live ≤ 15 min, are scoped to one key and one method, go only to authenticated workers, and are never logged or stored.
- **Rotating the R2 token:** create a new bucket-scoped token in Cloudflare. Set both new values on the api (Dashboard → `draftroom-staging-api` → Environment; Blueprint syncs ignore `sync: false` values). Redeploy the api, then delete the old token.
- Use a separate bucket and token for production. Never share the staging token with a production service.
- The bucket's location relative to `oregon` wasn't chosen here, so upload and file-proxy latency is UNVERIFIED.

## Known blockers

### Resolved in the platform phase

1. **The board WebSocket can't go through the static site.** Resolved with option (a) [above](#why-the-board-socket-goes-straight-to-sync): `VITE_DRAFTROOM_SYNC_ORIGIN` on the static site, `ALLOWED_ORIGINS` on sync. Proven with a browser against the same topology (below); the Render side stays UNVERIFIED until the first deploy.
2. **Internal URLs can't be wired by the Blueprint.** Resolved: both `DRAFTROOM_SYNC_INTERNAL_URL` (api) and `DRAFTROOM_API_INTERNAL_URL` (sync) accept a full `http(s)` URL **or** `host:port`, which becomes `http://host:port`. `render.yaml` injects them with `fromService.property: hostport`, so there are no manual internal-URL steps any more.
   - Under `NODE_ENV=production` both are **required**, and loopback addresses are refused at startup: `localhost`, `*.localhost`, `127.0.0.0/8`, `0.0.0.0`, `::1`, `::`, IPv4-mapped loopback, in any spelling WHATWG URL normalizes (`127.1`, `2130706433`, `[0:0::1]`).
   - The api also refuses to start in production without an explicit `PUBLIC_ORIGIN`.
   - Before this fix, a missing value silently meant `127.0.0.1`: access pushes failed, sync's re-checks failed *open*, and revocation was never enforced.
5. **Client IPs behind proxies.** Resolved in code: `TRUST_PROXY` is wired into Fastify's `trustProxy`, so `req.ip` and every per-IP rate limit use it. `render.yaml` sets `3`. Whether that is right for requests arriving through the static-site rewrite is UNVERIFIED; see [client IPs](#client-ips-and-trust_proxy).
6. **Health check endpoint.** Resolved: the api has `GET /healthz` (no database, no auth, not rate limited), and `render.yaml` uses it.

### Resolved in milestone 3

7. **Files on the api's disk.** They're now in R2, and the metadata and jobs are in Postgres. The api has no disk and the worker is separate (this document).

### Still open

3. **Sign-in.** Under `NODE_ENV=production` the api refuses `DRAFTROOM_DEV_AUTH=1` and `AUTH_PROVIDER=dev` (verified in the platform-phase image). Staging therefore needs Clerk keys, and the Clerk adapter is **UNVERIFIED** until keys exist. Don't weaken the production guard to get a demo. Staging is internet-reachable, and dev sign-in lets anyone become anyone.
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

Worker routes are rate limited per **token**, not per IP, so the NAS worker's public path and the Render worker's private path are both unaffected by this setting.

First-deploy check: from two different networks, send 31 `POST /api/auth/logout` requests in a minute through the static site from one (the 31st gets `429`). Confirm the other network still gets `200`.

## Secrets and configuration

Every variable is documented with a safe placeholder in `.env.example`. Where each value comes from on Render:

| Variable | Service(s) | Source in `render.yaml` |
|---|---|---|
| `DRAFTROOM_TICKET_SECRET`, `DRAFTROOM_INTERNAL_SECRET` | api, sync | env group `draftroom-staging-secrets`, `generateValue: true`. Two independent base64 256-bit values, 44 chars each. The services require ≥ 32 chars and refuse two equal values. |
| `DRAFTROOM_WORKER_TOKEN` | api, Render worker; NAS worker by hand | env group `draftroom-staging-worker-token`, `generateValue: true` ([worker token](#worker-token)). Dev placeholders (`dev-only-…`) are refused in production. |
| `DRAFTROOM_BLOB_STORE` | api | `r2`. Required in production: no silent local-disk default on a host without a disk. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | api only | `sync: false` (prompted once, at Blueprint creation). Bucket `draftroom-staging`. |
| `DATABASE_URL` | api | `fromDatabase … connectionString` (the internal URL). Internal connections don't require TLS. For `sslmode=require`, append it by hand; `verify-full` isn't supported internally. |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | api | `sync: false` |
| `DRAFTROOM_SYNC_INTERNAL_URL` | api | `fromService: {type: web, name: draftroom-staging-sync, property: hostport}` → `draftroom-staging-sync-xxxx:10000` → `http://…`. Required, non-loopback in production. |
| `DRAFTROOM_API_INTERNAL_URL` | sync | `fromService: {type: web, name: draftroom-staging-api, property: hostport}`. Same rules. |
| `DRAFTROOM_API_URL` | Render worker | the same `fromService … hostport` as above ([public or private](#public-url-or-private-hostport)); NAS: the api's public URL |
| `PUBLIC_ORIGIN` | api | `https://draftroom-staging-web.onrender.com`. Required and https in production. Confirm the hostname Render assigns. |
| `ALLOWED_ORIGINS` | sync | `https://draftroom-staging-web.onrender.com` (the same web origin). Required and https in production. |
| `TRUST_PROXY` | api | `"3"` ([client IPs](#client-ips-and-trust_proxy)) |
| `VITE_DRAFTROOM_SYNC_ORIGIN` | web (build time) | `https://draftroom-staging-sync.onrender.com`. Confirm the hostname; a change needs a rebuild. |
| `VITE_TLDRAW_LICENSE_KEY` | web (build time) | `sync: false` |
| `DRAFTROOM_DATA_DIR` | api, sync | api: `/tmp/draftroom-api` (scratch); sync: `/var/data` (its disk) |
| `NODE_ENV=production`, `AUTH_PROVIDER=clerk`, `ACCESS_RECHECK_MS=10000`, `WORKER_CONCURRENCY=1`, `WORKER_PDF_HEAP_MB=256` | as listed | plain values |
| `HOST=0.0.0.0` | api, sync | image default (Render needs the public server on `0.0.0.0`) |
| `PORT` | api, sync | injected by Render (default 10000) |

Rules:

- **Never set** `DRAFTROOM_DEV_AUTH` or `VITE_DRAFTROOM_DEV_AUTH` on any deployed service.
- `sync: false` values are prompted **only at initial Blueprint creation**, and later Blueprint syncs ignore them. Change them in the Dashboard.
- An environment group can't hold `sync: false` values or references to services. That is why the R2 values sit on the api service itself.
- The api and sync reference each other's `hostport`. The schema accepts this. UNVERIFIED that Render resolves the mutual reference on the first sync (fallback: set the two values by hand as `host:port` once, then re-sync).
- Render passes every service env var to Docker builds as a **build argument**. Our Dockerfiles declare no `ARG`, so no secret (R2 keys included) enters an image layer. Keep it that way.
- Don't add Render "secret files" for these services either. Render copies secret files into the build context root, and while our Dockerfiles copy only explicit paths, this is easy to get wrong later.
- Logs contain route patterns, not URLs. Tickets, query strings, invitation tokens, worker tokens and presigned URLs never appear. The sync examples (`refused on board …: bad_signature`, `refused: Origin "https://evil.example" is not in ALLOWED_ORIGINS`) were verified in the platform phase. The worker-route rules are in the contract (§4, §7); re-check the logs on the first deploy.
- **Rotating** a group secret restarts every linked service. Render redeploys linked services on env-group changes when autodeploy is on. Autodeploy is off here, so redeploy the linked services by hand, together. Tickets live 60 s, so in-flight reconnects fail once and retry.

## tldraw license key

The editor runs free only on `http:` or loopback hosts. On **any HTTPS host without a key whose hosts include that hostname, the editor goes blank 5 s after load**, and a beacon goes to `cdn.tldraw.com` (probed in `docs/research/license.md` §4).

- Staging on `draftroom-staging-web.onrender.com` therefore needs a key that lists that exact hostname. A trial key works: 100 days, no grace period, and it sends `window.location.href` to tldraw.
- The license's Development Environment exemption covers staging only while it isn't accessible to end users. The internal pilot is production.
- The key is inlined **at build time** (`VITE_TLDRAW_LICENSE_KEY`). Adding a hostname or renewing requires a **rebuild** of the static site, not just a restart.
- The price is quote-only and still open (`docs/research/license.md` §10).

After deploy, load a board for more than 6 s and check that `[data-testid="tl-license-expired"]` is absent.

## Deploying

Automatic deploys are **off** for every service (`autoDeployTrigger: "off"`), and the Blueprint should be on **Manual Sync**: by default Render deploys added or modified resources on every push that changes `render.yaml`. Order matters. An automatic deploy starts each service independently, and we found no documented ordering (UNVERIFIED).

1. **api first.** It runs database migrations at startup (`migrate(db)` in `apps/api/src/app.ts`, one transaction per migration, forward-only).
   - With zero-downtime deploys the **old api keeps serving while the new one migrates and starts**, and both run side by side for about a minute.
   - So every migration must work with the previous api build (add first, remove in a later release). `0007_assets` only creates tables and indexes.
2. **sync second.** Deploy the server before any client that knows new shapes. A client with an unknown shape type fails on its first push with `INVALID_RECORD`, which is terminal (`docs/research/SYNTHESIS.md`).
3. **web third.**
4. **workers last** (Render worker, then the NAS: `deploy/nas/README.md`). A worker needs the api's worker routes. The protocol has no version negotiation, so deploy the api and every worker from the same commit.

Schedule deploys outside workshops: step 2 interrupts every board connection.

### First provisioning (one-click Blueprint)

This is the first cost-bearing step (about $20.25/month, [cost](#cost)), so it needs the user's explicit go-ahead.

Prerequisites:

- The repository is on GitHub with this `render.yaml` at its root.
- The Clerk keys and a tldraw key for `draftroom-staging-web.onrender.com` are at hand.
- The R2 values are at hand (above).

Steps:

1. *(Optional, recommended)* Validate with Render's own validator: `render blueprints validate` (Render CLI ≥ 2.7.1, after `render login`). It checks semantic rules the public schema doesn't, like the `maxShutdownDelaySeconds` refusal. This contacts Render, so the user runs it.
2. Dashboard → **New → Blueprint** → **Connect** the repository. Name it `draftroom-staging`, pick the branch, and leave the Blueprint path at `render.yaml`.
3. Review the plan: 1 database, 3 services (web, api, sync) and 2 environment groups, or 4 services if you enabled the worker.
4. Enter the prompted `sync: false` values:
   - `VITE_TLDRAW_LICENSE_KEY` (web);
   - `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` (api);
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` = `draftroom-staging` (api).

   The internal URLs, database URL and secrets are wired by the Blueprint.
5. Click **Deploy Blueprint**.
6. In the Blueprint's settings, switch to **Manual Sync** (exact location UNVERIFIED).
7. Compare the public `onrender.com` hostnames with the places that name them. If Render added a suffix, fix `render.yaml`, re-sync, and **rebuild** the static site. A startup refusal in the api or sync logs names the variable at fault.
   - `PUBLIC_ORIGIN` (api) and `ALLOWED_ORIGINS` (sync): the web hostname;
   - the web `routes` destinations: the api hostname;
   - `VITE_DRAFTROOM_SYNC_ORIGIN` (web): the sync hostname;
   - the NAS worker's `DRAFTROOM_API_URL`: the api hostname.
8. Copy the worker token ([above](#worker-token)) into the NAS env file and deploy the NAS worker (`deploy/nas/README.md`).
9. Run the [first-deploy checks](#first-deploy-checks-unverified-until-done).

**If an earlier version of this Blueprint already created resources**, syncing this one changes them in place. Check these by hand:

- **The api's old disk.** Blueprint changes never delete resources. After the sync, look at `draftroom-staging-api` → Disks. If `draftroom-staging-files` is still there, delete it by hand; it holds only pre-milestone-3 files, which are not migrated, and costs $1.25/month. UNVERIFIED whether the sync detaches it.
- **The R2 values.** They aren't prompted on an existing Blueprint. Add the four `R2_*` values to the api's Environment **before** its deploy. In r2 mode the api refuses to start without them (`apps/api/src/config.ts`).
- **The plan.** The change from `1c-2g` to `0.5c-512mb` should apply on sync. Confirm it on the service page.

### What users see during a deploy

- **api** (zero-downtime, no disk):
  - New requests move to the new instance once it's healthy, and the old instance gets SIGTERM about 60 s later.
  - At shutdown, Fastify answers `503` while closing (`return503OnClosing`). Open board event streams end and the clients reconnect to the new instance.
  - During the overlap, event hints published by one instance don't reach streams still held by the other. Events are hints: a client refetches when its stream reopens, so updates are delayed, never lost.
  - Uploads still streaming to the old instance when it closes fail and must be retried. No partial blob or row is kept (contract §3).
  - For preview workers, a call that fails during the swap is an ordinary transient error. A lease lost in the gap expires after 120 s and the job is reclaimed.
- **sync** (disk, so no zero-downtime):
  - Render **stops the old instance before starting the new one**; its docs call this "a few seconds" of unavailability. Our boot time comes on top: under 2 s on the NAS test host, UNVERIFIED on Render.
  - Every WebSocket closes. Clients show *Offline* and keep local edits in memory ("kept in this tab only until reconnect"). A reload during the gap loses them.
  - `useSync` reconnects by itself, fetching a **fresh ticket** on every attempt (`createTicketUri`, backoff 0.5–5 s). It never uploads an old snapshot.
  - Nothing acknowledged is lost: each push is committed to SQLite before the ack.
  - A failed sync deploy is worse with a disk. The old instance is already gone, so the service stays down until you roll back or fix forward.
- **workers:**
  - A Render background worker also deploys with an overlap. Two workers briefly poll side by side, which the `SKIP LOCKED` claim is built for.
  - On SIGTERM a worker finishes or releases its current job.
- **web.** The static site deploys without interruption. Tabs keep running the old bundle until reload.

### Graceful shutdown, readiness and restarts (as implemented)

- **Signal path.** Render sends SIGTERM, then SIGKILL after the default 30 s shutdown delay.
  - `maxShutdownDelaySeconds` isn't set anywhere: Render refused it on services with a disk (first Blueprint sync, 2026-09-27), and 30 s is enough for every service.
  - **api and sync:** tini (PID 1) → `docker/entrypoint.sh`, which `exec`s the app as the unprivileged `node` user.
  - **Worker:** starts as `node` directly under tini. The worker image has no root phase, which is what lets it run under `cap_drop: ALL`.
  - The app is always tini's direct child and receives the signal. tini also reaps the worker's ffmpeg/PDF children.
- **sync.** Stops accepting connections, closes all rooms (flushing the tombstone prune before closing each database), terminates sockets, and exits 0. It force-exits after 5 s.
- **api.** Runs `app.close()`: ends open event streams in a `preClose` hook, finishes in-flight requests, closes the pool, then exits 0. It force-exits (exit 1) after 5 s.
- **Worker.** Finishes the current job or releases it (contract §5). A job it can't release is reclaimed when its 120 s lease expires.
- **Readiness.** `/healthz` (sync and api) answers as soon as the server listens. Sync opens rooms lazily, and the api has already migrated by then. Render stops routing to an instance after 15 s of failed checks and restarts it after 60 s. Background workers have no health checks: a wedged worker shows up only as jobs that stay queued. Watch the worker's log.
- **Disk ownership (sync).** Render reportedly mounts disks owned by root (from another Render user's report, 2026-09-25; UNVERIFIED by us). The entrypoint starts as root only to `chown` the top of `DRAFTROOM_DATA_DIR`, then drops to `node` via `setpriv --no-new-privs`. It never chowns recursively, because everything below is created by the app. Tested with a root-owned 0755 tmpfs mount. The api's `/tmp/draftroom-api` goes through the same path: it is created, then chowned.

## Backups: not yet (milestone 4)

There are **no application-level backups and no restore drill yet.** What exists by platform default:

- **Render disk snapshots (sync).** One every 24 h, kept at least 7 days. Restoring one discards everything written after it.
  - These are infrastructure snapshots of live WAL-mode SQLite files, **not** consistent application backups. The build plan requires SQLite-backup-API copies to private storage with checksums (milestone 4).
  - They are **not** rolled back with a service rollback.
- **Render Postgres (paid).** Point-in-time recovery, with a 3-day window on the Hobby workspace and 7 days on Pro, plus on-demand logical exports. Postgres now also holds the asset metadata and job queue.
- **R2.** No versioning or replication has been configured, and bucket settings are left alone. A deleted object is gone.
- The three are **not coordinated**. Restoring Postgres to an earlier time can reference blobs deleted since, or orphan newer ones; restoring sync can reference assets the database no longer knows.

Treat staging data as disposable until milestone 4.

## Rollback

- **How.** Dashboard → service → Deploys → *Rollback*. Render reuses the earlier build artifact (no rebuild) and that deploy's environment variables. Disks, plan and static-site settings are *not* rolled back. A Dashboard rollback also disables autodeploy, which is already off.
- **Database.** Migrations are forward-only (never edit a shipped one). Rolling the api back past a migration is safe only if the older code tolerates the newer schema. Otherwise, fix forward.
- **api past milestone 3: don't.** A milestone-1/2 api build reads files from `meta.json` on a local disk that no longer exists. It would never see R2 objects or `asset_versions` rows, and it expects its co-located worker. Fix forward instead.
- **Workers.** Roll a worker back only to a build that speaks the api's current worker protocol. The simplest way to stop previews is to stop the workers: jobs wait in Postgres.
- **Canvas schema.** Don't roll sync back below a canvas-schema migration. Boards already migrated on disk can't be loaded by the older server (`Incompatible schema?`), and newer clients are refused (`SERVER_TOO_OLD`). Rolling back the web client is safe while every shape migration keeps its `down`: an older client is served down-migrated records. Roll back sync only when its schema didn't change.
- **Platform config.** A web build from before the platform phase ignores `VITE_DRAFTROOM_SYNC_ORIGIN` and connects to the static site, which can't carry the socket. On Render, don't roll the static site back past it. A sync build from before it ignores `ALLOWED_ORIGINS` and refuses to start with the Blueprint's `host:port` internal URLs.
- **Disks.** Disk contents never roll back. To recover data you'd need a snapshot restore, which loses newer data (see above).

## Cost

Render prices from <https://render.com/pricing>, read **2026-09-27 23:35 UTC**, in USD per month, on a Hobby workspace. Re-check at provisioning.

**Default Blueprint** (what `render.yaml` creates as committed):

| Resource | Plan | Price (pricing page) | Monthly |
|---|---|---|---|
| `draftroom-staging-api` | web service `0.5c-512mb` (0.5 CPU, 512 MB) | $7/month | $7.00 |
| `draftroom-staging-sync` | web service `0.5c-512mb` | $7/month | $7.00 |
| disk `draftroom-staging-rooms` | 1 GB | $0.25 per GB per month | $0.25 |
| `draftroom-staging-db` | Postgres `0.1c-256mb` (256 MB RAM) | $6/month | $6.00 |
| Postgres storage | 1 GB | "Expandable storage ($0.30/GB)" next to "1 GB SSD storage included"; which applies is UNVERIFIED | $0.00–$0.30 |
| `draftroom-staging-web` | static site | free | $0.00 |
| environment groups (2) | — | no charge listed | $0.00 |
| Workspace | Hobby ($0) | Pro is $25/month | $0.00 |
| **Total** | | | **$20.25–$20.55** |

**Optional additions:**

| Addition | Monthly |
|---|---|
| Render background worker `draftroom-staging-worker`, `0.5c-512mb` (the commented block) | +$7.00 → **$27.25–$27.55** |
| the same worker on `1c-2g` (1 CPU, 2 GB), if PDFs don't fit 512 MB | +$25.00 instead of +$7.00 |
| Pro workspace | +$25.00 |
| WebSocket option (b), a proxy web service `0.5c-512mb` | +$7.00 |
| NAS worker | $0 on Render (the NAS's own power and bandwidth) |

**Usage-based:**

- **Render bandwidth.** Hobby includes 5 GB per month, then $0.15 per GB. Render bills all outbound traffic to the public internet, including requests a service sends to external APIs and object storage, but not private-network traffic.
  - So each upload counts once, api → R2, and each file view counts at least once, api → browser. Whether a view through the static-site rewrite counts twice is UNVERIFIED.
  - Worker calls over the private network are free. The NAS worker's calls are small JSON. Its file bytes go directly to and from R2, so they aren't Render traffic.
- **Cloudflare R2** (<https://developers.cloudflare.com/r2/pricing/>, read 2026-09-27):
  - The free tier covers 10 GB-month of storage, 1 million Class A operations (PutObject, ListObjects) and 10 million Class B operations (GetObject, HeadObject) per month.
  - Above that: $0.015 per GB-month, $4.50 per million Class A and $0.36 per million Class B operations.
  - Egress is free, and DeleteObject is free. Staging should stay at **$0**.
- **Build pipeline minutes.** No price is shown on the pricing page (UNVERIFIED).

For comparison, the milestone-1/2 topology (api + worker on `1c-2g` with a 5 GB disk) was about $39.80. This excludes the tldraw license (quote-only), Clerk, and build minutes. Cheaper options don't work here:

- free web services can't have disks or receive private-network traffic;
- free Postgres expires after 30 days;
- background workers have no free plan.

## First-deploy checks (UNVERIFIED until done)

1. The static-site build works on Render's native image: pnpm installed via `npm install -g pnpm@10.34.5`, and Node taken from `.node-version`. Verified in a Debian container with Node 24.19.0 only (milestone 1).
2. The rewrite proxy `/api/*` and `/files/*` → api passes through:
   - the `Cookie` request header and `Set-Cookie` response header;
   - the `Origin` header unchanged (CSRF check);
   - query strings (`?board=`);
   - `POST` bodies up to 500 MB, and `Range` requests (`206`, `416`) with their `Content-Range`.

   It also needs acceptable timeouts, including for the long-lived board event stream (SSE) and a 500 MB upload. If any of these fail, use option (b).
3. The assigned hostnames match `render.yaml` (the places in [first provisioning](#first-provisioning-one-click-blueprint)), and the `hostport` references resolved.
4. api ↔ sync private-network calls work. Test: revoke a member's access and confirm their open board disconnects within 15 s (contract §7).
5. The board WebSocket goes to `wss://draftroom-staging-sync.onrender.com` (browser devtools, Network → WS). A page on another origin gets `403` (sync log: `refused: Origin …`).
6. Per-client rate limits ([client IPs](#client-ips-and-trust_proxy)): the two-network check.
7. The sync disk is mounted and owned as expected. The entrypoint logs nothing on success; `ls -la /var/data` in a Render shell should show `node node`.
8. SQLite commit latency on the Render disk: `synchronous=FULL` fsync blocks the event loop (`docs/research/SYNTHESIS.md`). Measure p99 event-loop delay under load.
9. Reconnect across a deploy: connect, edit in two browsers, deploy sync, and confirm both reconnect and converge.
10. The tldraw key is accepted on the staging hostname (no blanking after 6 s).
11. Postgres over the internal URL works (verified locally against a PostgreSQL 18.6 server).
12. **R2 upload path.** Upload a PNG, a PDF and an H.264 MP4. Each object appears under `assets/<ast>/<ver>/original` in the Cloudflare dashboard, and the api log shows no R2 URL, key material or signature. A 500 MB video upload leaves the api's memory graph flat (Render metrics).
13. **Worker over the public URL (NAS).** The tiles turn from placeholders into previews, and `/files/…/d/<drv>` answers `image/webp` with `nosniff` and the immutable cache header. A worker with a wrong token gets `401` and claims nothing.
14. **Worker over the private network** (only if the Render worker is enabled). Its log shows claims against the `host:port` URL. Stop the NAS worker and confirm the Render worker still drains the queue. A 500 MB video fits its `/tmp`.
15. **Zero-downtime api deploy.** Keep a board open and upload during an api deploy. The board stays connected (sync is untouched), the event stream reconnects, and an interrupted upload fails cleanly and succeeds on retry.
16. **The bucket stays private.** An unsigned `GET https://<account>.r2.cloudflarestorage.com/draftroom-staging/<key>` is refused, and an expired presigned URL is refused.

## Validation and build evidence

### Milestone 3 (2026-09-27)

**Blueprint** (scratch scripts, not repo code):

- **Parsed** with the `yaml` 2.x parser bundled in `playwright-core` 1.63.0 (already in the pnpm store; nothing installed), both as YAML 1.2 and as YAML 1.1.
  - YAML 1.1 reads a bare `.` as a float, so `dockerContext` is quoted (`"."`). Unquoted, `off` is a boolean in YAML 1.1, so `autoDeployTrigger: "off"` stays quoted.
  - Both readings now produce identical JSON.
- **Validated** with Ajv 8.20.0 (draft 2020-12) against Render's published schema, <https://render.com/schema/render.yaml.json>.
  - The schema is unchanged since the platform phase: `last-modified: Sat, 26 Sep 2026 02:28:12 GMT`, `etag W/"b28e-…"` (45,710 bytes), and the same SHA-256 as the copy validated then.
  - Result: **valid as committed**, and **valid with the optional worker block uncommented** exactly as the comment instructs (4 services).
- **Documented Render rules the schema doesn't encode**, checked by the same script, none violated:
  - no `sync: false` and no service references inside environment groups;
  - every `fromGroup` names a defined group, and every `fromService` names an existing service of the given type;
  - `hostport` only from web/private services, never from the static site;
  - no `maxShutdownDelaySeconds`, scaling or extra instances on a service with a disk;
  - `healthCheckPath` only on web services;
  - the api has no disk, is on `0.5c-512mb`, builds `docker/api.Dockerfile`, has `DRAFTROOM_BLOB_STORE=r2`, all four `R2_*` as `sync: false`, and the worker token;
  - the worker holds no `DATABASE_URL`, `R2_*`, Clerk, ticket or internal secret;
  - no literal value for any `*SECRET*`/`*TOKEN*`/`*KEY*` variable.
- **13 negative mutations**, all rejected:
  - a worker linked to `draftroom-staging-secrets`;
  - `maxShutdownDelaySeconds` on sync;
  - a literal R2 secret;
  - an unknown plan;
  - an unknown runtime;
  - `hostport` from the static site;
  - `property: url`;
  - `sync: false` inside a group;
  - an undefined group;
  - `healthCheckPath` on the worker;
  - an unquoted `off` read as YAML 1.1;
  - the api disk put back;
  - `DATABASE_URL` on the worker.
- **Not run:** Render's own semantic validator (`render blueprints validate` or the validate API): it needs a Render login, and this milestone doesn't contact Render.

**Images: not built yet.** There is no Docker on the dev PC; the NAS proof phase builds `api`, `sync` and `worker` from these Dockerfiles and records the results here. What changed since the platform-phase builds:

- `api.Dockerfile`: comments only. Its filtered install now also pulls `@draftroom/blob-store` and `aws4fetch` through `@draftroom/api...`.
- `worker.Dockerfile`: it runs the HTTP worker as `USER node` under tini, without `docker/entrypoint.sh`, and no longer needs `setpriv`.
- `api-worker.Dockerfile` and the supervisor were removed.
- `sync.Dockerfile`: unchanged.

### Milestone 3 integration: live R2 from the dev PC (2026-09-27)

The real api, sync and worker processes ran on the dev PC through the e2e stack (`e2e/tests/support/stack.ts`). The api used `DRAFTROOM_BLOB_STORE=r2` against the real `draftroom-staging` bucket. The worker ran in HTTP mode with no credentials, so it downloaded originals and uploaded derivatives through presigned R2 URLs.

- **Browser suite.** `e2e/tests/files.spec.ts` with `E2E_PORT_BASE=6500`: **8/8 passed** (1.3 min).
  - It wrote 76 objects (18.1 MiB), and every one is listed in the two stacks' databases.
  - All 76 were deleted (76 × `204`). A `ListObjectsV2` of the whole bucket afterwards returned **0 objects**, the same as before the run.
- **Scripted run** (same stack code, 59/59 checks). It uploaded a PNG, a PDF, an MP4, an encrypted PDF and a ZIP:
  - PNG: thumb and display.
  - PDF: 4 pages plus a thumb, `pageCount` 4.
  - MP4: poster and thumb, h264/aac, 5,000 ms.
  - Encrypted PDF: failed with `PDF_ENCRYPTED`.
  - ZIP: ready as an attachment.

  Through the api, every download came back byte-identical (sha256). HEAD, and Range `0-7`, a middle range and a suffix range answered `206` with the exact `Content-Range`. A range past the end answered `416` `bytes */size`. Every derivative answered `200` with its recorded size and type, and another board id got `404`. Its 15 objects (202 MiB) were deleted and the bucket listed empty again.
- **Memory.** The api's working set was sampled from outside the process every ~100 ms (Windows):

  | | Time | Working-set growth | Private-bytes growth |
  |---|---|---|---|
  | Baseline (PGlite in process) | | 312 MiB | 342 MiB |
  | 200 MiB upload | 20.4 s | **+20.9 MiB** | +24.1 MiB |
  | 200 MiB download, sha256 identical | 5.8 s | **+35.4 MiB** | +45.3 MiB |

  A Range read at 150 MiB returned the right bytes.
- **PGlite at startup.** The process's peak working set was 1,175 MiB, and it came from PGlite at startup, not from the transfers. A separate start peaked at 1,127 MiB within the first second on a fresh data dir and at 834 MiB on an existing one, then settled near 290 MiB. Render's api uses `DATABASE_URL` and never loads PGlite.
- **Secrets.** Credentials reached only the api process, as environment variables; sync and the worker never got them, and the Render key wasn't read. These were scanned for the account id, the access key, the secret, `X-Amz-Signature` and `X-Amz-Credential`:
  - the Playwright output;
  - the scripted stack's api, sync and worker logs;
  - `e2e/test-results`;
  - the web build;
  - the kept data dirs.

  None contained any of them.
- **Not proven here:** Linux RSS on Render, latency from `oregon` to the bucket, and several uploads at once.

### Platform phase (2026-09-27, milestone 1/2 topology; historical)

These results were measured with the co-located `api-worker` image, since retired. They remain valid for sync and for the api's production boot rules; the api and worker images must be re-proven for milestone 3.

- **Blueprint:** the same schema, validated with PyYAML 6.0 + Ajv. Negative checks: `property: url`, a `fromService` without `name`, an unknown service type, `value` together with `fromService`, a health check on the static site, an unknown plan, and a boolean `autoDeployTrigger`.
- **Config rules, unit and integration tests** (all in the normal suites):
  - `apps/api/test/config.test.ts`: the production requirements, loopback refusal in 15 spellings, `host:port`, `TRUST_PROXY` parsing, and 4 behavioral rate-limit scenarios;
  - `apps/sync/src/config.test.ts` and `apps/sync/test/http/origin.test.ts`: the same rules for sync, plus `ALLOWED_ORIGINS`;
  - `apps/web/src/board/ticket.test.ts`: `VITE_DRAFTROOM_SYNC_ORIGIN` handling.
- **Images** were built on the Docker 29.6.2 amd64 NAS host with a 2 GB-capped buildx builder:

  | Image | Build | Size |
  |---|---|---|
  | sync | 15 s | 251 MB |
  | api | 8 s | 302 MB |
  | worker (the filesystem worker) | 64 s | 776 MB |
  | api-worker | 13 s | 843 MB |

- **Production boot rules.** Each refusal exits 1 with a one-line message naming the variable.
  - Sync refuses to start without `DRAFTROOM_API_INTERNAL_URL`, with a loopback one, without `ALLOWED_ORIGINS`, or with an `http` origin.
  - The api refuses to start without `PUBLIC_ORIGIN` or `DRAFTROOM_SYNC_INTERNAL_URL`, with `http://127.0.0.1:5858`, with `TRUST_PROXY=yes`, or with `DRAFTROOM_DEV_AUTH=1`.
  - Good production configs booted:
    - `/healthz` → 200;
    - api → sync and sync → api over `host:port`;
    - `docker stop` → exit 0.
- **Render topology on one host:**
  - the api, sync and PostgreSQL 18.6 on a private network;
  - a stand-in static site that refuses WebSocket upgrades.

  Results:
  - Origin refusals;
  - uploads processed into `image/webp` derivatives;
  - revocation over `host:port` in 15 ms;
  - a browser run: two users converged, the socket went to the sync origin, and a foreign origin was refused.
- **Host isolation:** everything was named `draftroom-buildcheck-*` and removed afterwards. `docker ps -a` / `images` / `volume ls` / `network ls` / `buildx ls` / `system df` were identical before and after, and nothing of the existing compose project was touched.

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

Actions are pinned to commit SHAs. **It has never run**: it starts working once the repository is published to GitHub. Expect to fix environment differences on the first run. The opt-in live R2 test never runs in CI (no `.env.deploy.local` there).

## Sources (read 2026-09-26/27)

- Blueprint spec (`fromService` `host` / `port` / `hostport` for web and private services only; `healthCheckPath` web only; `maxShutdownDelaySeconds` 1–300; env groups can't hold `sync: false` or service references; `generateValue` = base64 256-bit): <https://render.com/docs/blueprint-spec>. Schema: <https://render.com/schema/render.yaml.json>.
- Blueprints (New → Blueprint, Deploy Blueprint, auto-sync vs Manual Sync, "Changes to a Blueprint never cause a resource to be deleted"): <https://render.com/docs/infrastructure-as-code>. Validation CLI: <https://render.com/changelog/validate-blueprint-files-using-the-render-cli-or-api>.
- Compute plans (August 2026 IDs): <https://render.com/docs/compute-plans>. Pricing (read 2026-09-27 23:35 UTC): <https://render.com/pricing>.
- Outbound bandwidth (what is billed): <https://render.com/docs/outbound-bandwidth>.
- Private network (background workers can send, web services receive on port 10000, same region and workspace): <https://render.com/docs/private-network>. Background workers receive no traffic: <https://render.com/docs/background-workers>.
- Deploys (zero-downtime without a disk, SIGTERM about 60 s after the new instance is healthy, 30 s default shutdown delay, workers included; ephemeral filesystem): <https://render.com/docs/deploys>.
- `/tmp` size, a user report only: <https://feedback.render.com/features/p/support-more-tmp-file-storage-on-larger-instance-types> (2022).
- Persistent disks (single instance, no zero-downtime deploys, snapshots): <https://render.com/docs/disks>.
- Health checks: <https://render.com/docs/health-checks>. Rollbacks: <https://render.com/docs/rollbacks>.
- Docker (BuildKit, env vars become build args, secret files in the context): <https://render.com/docs/docker>.
- Web services (bind `0.0.0.0`, `PORT` default 10000): <https://render.com/docs/web-services>. WebSockets: <https://render.com/docs/websocket>.
- Static-site redirects/rewrites: <https://render.com/docs/redirects-rewrites>. WebSocket rewrite request: <https://feedback.render.com/features/p/support-websockets-in-static-site-rewrites>.
- Client IPs:
  - <https://render.com/articles/how-render-handles-ddos-attacks>;
  - <https://feedback.render.com/features/p/send-the-correct-xforwardedfor>;
  - <https://github.com/Kigen29/seo-agent-capstone/issues/199>;
  - `node_modules/fastify/lib/request.js` (5.12.5).
- Cloudflare R2 pricing (free tier, Class A/B, free egress and deletes): <https://developers.cloudflare.com/r2/pricing/>.
- Node version selection: <https://render.com/docs/node-version>. Postgres connections: <https://render.com/docs/postgresql-creating-connecting>. Free-tier limits: <https://render.com/docs/free>.
- Root-owned disk report: <https://github.com/Otblakee/workspace-mcp-fixed/pull/35>.
- Base image: Docker Hub `library/node` tag `24.19.0-trixie-slim` (index `sha256:ab3eebe9…b3de`, updated 2026-08-25).
