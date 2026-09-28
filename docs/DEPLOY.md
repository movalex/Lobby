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
- Only the api and, for offsite board backups ([backups](#backups)), the sync service get R2 credentials. They're entered at Blueprint creation (`sync: false`): `R2_ACCOUNT_ID` (the Cloudflare account ID, 32 hex characters), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` = `draftroom-staging`.
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

**Measured on staging (2026-09-28, `TRUST_PROXY=3`).** From one client, four `GET /api/invitations/<made-up token>` requests alternated between the api's own hostname and the static site's `/api/*` rewrite. `x-ratelimit-remaining` counted down 599 → 598 → 597 → 596 across both paths, so both paths land in the **same** per-IP bucket.
- The direct path resolves to the real client (the chain above).
- The rewrite path therefore does too. If it added hops, the third hop back would be a proxy address and the two buckets would differ.

The browser's per-IP limits therefore apply per real client (per office NAT, for people who share one), not per rewrite proxy. Still open: the two-network half of the check below.

Worker routes are rate limited per **token**, not per IP, so the NAS worker's public path and the Render worker's private path are both unaffected by this setting.

First-deploy check: from two different networks, send 31 `POST /api/auth/logout` requests in a minute through the static site from one (the 31st gets `429`). Confirm the other network still gets `200`.

## Secrets and configuration

Every variable is documented with a safe placeholder in `.env.example`. Where each value comes from on Render:

| Variable | Service(s) | Source in `render.yaml` |
|---|---|---|
| `DRAFTROOM_TICKET_SECRET`, `DRAFTROOM_INTERNAL_SECRET` | api, sync | env group `draftroom-staging-secrets`, `generateValue: true`. Two independent base64 256-bit values, 44 chars each. The services require ≥ 32 chars and refuse two equal values. |
| `DRAFTROOM_WORKER_TOKEN` | api, Render worker; NAS worker by hand | env group `draftroom-staging-worker-token`, `generateValue: true` ([worker token](#worker-token)). Dev placeholders (`dev-only-…`) are refused in production. |
| `DRAFTROOM_BLOB_STORE` | api | `r2`. Required in production: no silent local-disk default on a host without a disk. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | api; sync (offsite backups) | `sync: false` (prompted once, at Blueprint creation). Bucket `draftroom-staging`. |
| `DRAFTROOM_BACKUP_STORE`, `DRAFTROOM_BACKUP_INTERVAL_MS` | sync | `sync: false` / default ([backups](#backups)): `r2` on staging, set together with the sync's `R2_*`. |
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

**What actually happened on staging (2026-09-28, the milestone-3 switch).** The Blueprint sync after the push applied the new **environment variables only**. It did **not** change the existing api's plan, Dockerfile path or disk. The switch was finished through the Render API (`PATCH /v1/services/<api>`):
- plan `0.5c-512mb`;
- `dockerfilePath ./docker/api.Dockerfile`;
- the four `R2_*` values set with `PUT /v1/services/<api>/env-vars/<key>`.

It was deployed in the order api → sync → web; all three went live on the first try. The old disk `draftroom-staging-files` stayed attached; staging had no uploads before the switch, so nothing had to be migrated. With the owner's go-ahead it was deleted through the Render API (`DELETE /v1/disks/<id>`, 2026-09-28) after confirming the live api used `/tmp` and R2 only. Render did not restart the api for it, and `/healthz` stayed 200. The NAS worker (`WORKER_ID=nas-1`) was deployed with `deploy/nas/deploy-worker.sh` against the public api URL.

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

## Backups

What holds what: **board content** (every shape, note and connector) lives in one SQLite file per board on the sync disk; **everything else** (people, workspaces, the board list, permissions, comments, asset metadata) lives in Postgres; **file bytes** (uploads and their previews) live in R2 under `assets/`.

### Board backups (sync)

- **Local.** Every 15 minutes (`DRAFTROOM_BACKUP_INTERVAL_MS`), each open board that changed is backed up with SQLite's online-backup API on the room's own connection (one consistent copy, never a raw copy of a live WAL file), and a changed board is backed up once more before an idle room closes. Copies go to `/var/data/backups/<board>/` with a `manifest.json`; the newest 12 are kept. They are on the **same disk** as the boards: good against a bad write, useless if the disk is lost.
- **Offsite (wave 3).** After each local backup, the sync server copies it to the store set by `DRAFTROOM_BACKUP_STORE` (R2 on staging):
  - `backups/sync/<board>/<stamp>-c<clock>.sqlite`: the file, streamed from disk and hashed on the way. If the bytes sent don't match the local manifest's sha256, the object is deleted again and the file is never retried.
  - `backups/sync/<board>/manifest.json`: per backup, its time (`createdAt`, `uploadedAt`), document clock, tldraw schema, size, sha256 of the file and of its records, and the asset versions the board references (`assets: [{assetId, versionId}]`, from file cards and image records). This is the build plan's "coordinated manifest with board, schema and asset versions".
  - `backups/sync/index.json`: the boards that have offsite backups (the restore tools use it; the store has no list call).
  - **Signed** ([below](#signed-backups-tamper-evidence)): every manifest entry, every `manifest.json` and `index.json` carry an HMAC signature, checked by the restore tools before they trust a checksum.
  - **Retention:** the newest 12, plus the newest backup of each of the last 14 days (UTC). The rest are deleted; a failed delete stays listed under `pendingDeletes` and is retried.
- **Failures** never affect the local backup or the board. Each one is counted and logged as `[backup] offsite upload failed for board <id>: NETWORK ECONNRESET (retried on the next pass)`: an error code, HTTP status and S3 code only, never a credential, URL or response body. It's retried on the next pass (every `DRAFTROOM_BACKUP_INTERVAL_MS`) or the board's next backup, and at every server start.
- **Memory.** Uploads stream. Measured on the dev PC (`apps/sync/test/backup/memory.test.ts`, a 52.9 MiB backup): RSS +0–4 MiB through the R2 driver (to a loopback S3 stand-in) and the fs driver; a control that buffers the file shows +53 MiB. Not measured against real R2 or on Render.
- **Render bandwidth.** Uploads to R2 are outbound traffic that Render bills ([cost](#cost)): each backup of a board is uploaded once, so a 5 MB board edited all day costs about 5 MB every 15 minutes. Staging boards are small; watch it if boards grow.

**Status.** `GET /internal/backups/status` (internal secret, private network only) shows, per board: the last offsite success (`lastSuccessAt`, `lastSuccessFile`), how many backups the store holds, what is still pending, the failure counts and the last error. From the sync service's Shell:

```sh
node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/internal/backups/status',{headers:{'x-draftroom-internal':process.env.DRAFTROOM_INTERNAL_SECRET}}).then(r=>r.text()).then(console.log)"
```

The server also logs its setting at startup, never a credential: `[backup] offsite backups: r2 (bucket draftroom-staging-backups; backup-only bucket and token)`, or with the shared settings `r2 (bucket draftroom-staging; shared with the api: R2_BUCKET and the R2_* token, see docs/DEPLOY.md "Backups")`, or `off`.

### Signed backups (tamper evidence)

Without this, anyone who can write the bucket could replace a backup file and rewrite the checksums its manifest lists, and the drill would pass and `restore-board` would stage the changed board (review finding SEAM-08). Now:

- The sync server signs each manifest entry (its file, times, clock, schema, counts, both checksums and asset list, bound to the board id), each `manifest.json` as a whole, and `index.json`, with HMAC-SHA256. The key is derived from `DRAFTROOM_INTERNAL_SECRET` (HKDF-SHA256 with a label used for nothing else), so the secret itself never signs anything and never appears in the store. Each signature records a `keyId`, a hash of the derived key (not secret).
- The drill and `restore-board --from=store` check the index, then the manifest, then the entry, **before** they trust any checksum. A signature that is present and wrong always fails, `--allow-unsigned` or not: `FAIL the offsite manifest does not match its signature: it was changed outside the sync server`.
- Both tools need the server's `DRAFTROOM_INTERNAL_SECRET`. The sync service's Shell has it. The `pnpm` scripts read `apps/sync/dev.env`, which matches `pnpm dev`.
- **Backups taken before signing** have no signatures. The tools refuse them (`… is not signed (written before backups were signed, or its signature was removed); rerun with --allow-unsigned to accept it`). With `--allow-unsigned` they're accepted, but every such line prints as `WARN UNVERIFIED: …`, the drill ends with `restore drill passed, with unsigned backups accepted (--allow-unsigned)`, `restore-board` prints `staged … (UNSIGNED, accepted with --allow-unsigned)`, and the server's `[restore]` log line says so too. The first start of the signing build signs each board's manifest and the index once. Old entries stay unsigned, because sync never vouches for data it did not write in this form. Every new backup is signed, so the drill of the newest backup passes without the flag once a board has been backed up again, and old entries age out with retention (14 days).
- **Rotating `DRAFTROOM_INTERNAL_SECRET`**: backups signed under the old secret show `… is signed with another key (key id …; this server's is …)`. They need `--allow-unsigned` until they age out. The next start re-signs the manifests and the index; entries keep their old signatures. The same message appears when a Shell's secret differs from the server's.
- **Limits.** A valid signature proves "written by something that holds `DRAFTROOM_INTERNAL_SECRET`". The api holds that secret too (shared env group). So signing protects against anyone with only a bucket token (a leaked token, a mistake on the Cloudflare side). It protects against a compromised api only once backups have their own bucket that the api has no token for ([next section](#separate-backup-bucket-and-token-recommended)). It can't tell a pre-signing manifest from one whose signatures were stripped: use `--allow-unsigned` only for backups you know are older than the signing build. It doesn't stop deletion. It can't detect an older, genuinely signed manifest put back in place; the drill names the backup file it used, and the name holds its time.

### Separate backup bucket and token (recommended)

By default backups share the api's bucket and token (review finding SEAM-09). R2 tokens are scoped to buckets, not prefixes. So the api's token can read and delete every backup, sync's token can read and delete every upload and thumbnail, and deleting the bucket loses the files and their "offsite" copies together. Sync reads optional backup-only settings that replace their `R2_*` counterparts for backups only, so the switch needs no code change:

| Backup-only variable | Replaces | Notes |
|---|---|---|
| `DRAFTROOM_BACKUP_R2_BUCKET` | `R2_BUCKET` | the backup bucket |
| `DRAFTROOM_BACKUP_R2_ACCESS_KEY_ID`, `DRAFTROOM_BACKUP_R2_SECRET_ACCESS_KEY` | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | set both or neither; a backup key id is never paired with the shared secret |
| `DRAFTROOM_BACKUP_R2_ACCOUNT_ID` | `R2_ACCOUNT_ID` | only for a bucket in another Cloudflare account |
| `DRAFTROOM_BACKUP_R2_ENDPOINT` | `R2_ENDPOINT` | only for a jurisdiction bucket; `R2_ENDPOINT` is never used for a bucket in another account |

With the bucket and both credentials set, sync needs none of the api's `R2_*` token values. The api never reads these variables. Validation is the same as for `R2_*`, and messages name the variable, never its value.

**Steps for the owner** (none of this has been done yet):

1. Cloudflare dashboard → R2 → **Create bucket** `draftroom-staging-backups`: private, no public access, no custom domain, no CORS. The same account is fine. A bucket in another Cloudflare account isolates it further; then note that account's ID too.
2. R2 → **Manage API tokens** → **Create API token**: permission **Object Read & Write**, applied to **specific buckets only** → `draftroom-staging-backups` alone. Copy the Access Key ID and the Secret Access Key.
3. Render → `draftroom-staging-sync` → **Environment**, in **one save**: add `DRAFTROOM_BACKUP_R2_BUCKET=draftroom-staging-backups`, `DRAFTROOM_BACKUP_R2_ACCESS_KEY_ID`, `DRAFTROOM_BACKUP_R2_SECRET_ACCESS_KEY` (plus `DRAFTROOM_BACKUP_R2_ACCOUNT_ID` for another account). In the same save, delete `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` from sync. Keep `R2_ACCOUNT_ID` unless you set the backup one, and keep `DRAFTROOM_BACKUP_STORE=r2`. Do both in one save: deleting the `R2_*` values first would make sync refuse to start. Leave the api's variables alone.
4. Deploy (or restart) sync. The startup log must read `[backup] offsite backups: r2 (bucket draftroom-staging-backups; backup-only bucket and token)`. Its first pass uploads every board's local backups (up to 12 each) to the new bucket.
5. In the sync Shell: `node apps/sync/src/backup/restore-drill.ts --from=store` must print `PASS` for every board.
6. The old copies under `backups/` in `draftroom-staging` are no longer managed. Keep them until the new bucket holds 14 days of backups, then delete that folder (the api's token could still delete them in the meantime). Restoring from them before then means putting the old settings back on sync for that restore.

What this buys: a leaked api token can no longer touch backups, a leaked sync token can no longer touch uploads, and losing one bucket leaves the other. Sync's backup token can still delete backups, because retention needs to. R2 bucket lock rules would prevent that, but they are **not** compatible with the current layout without changes: the manifest is rewritten in place under the same prefix. That's UNVERIFIED (not tried); don't enable a lock rule on this bucket without testing uploads first.

### Configuration (sync)

| Variable | Values |
|---|---|
| `DRAFTROOM_BACKUP_STORE` | `off` (default, in production too: an unset value must not take the boards down on a deploy), `fs` (`<DATA>/blobs`: development and tests only, it is the same disk), `r2` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (optional `R2_ENDPOINT`) | Required for `r2`, with the api's rules, except those replaced by a backup-only value ([above](#separate-backup-bucket-and-token-recommended)). A missing or malformed value makes sync **refuse to start**, naming the variable, never the value. |
| `DRAFTROOM_BACKUP_R2_*` | Optional: the backups' own bucket and token ([above](#separate-backup-bucket-and-token-recommended)). |
| `DRAFTROOM_INTERNAL_SECRET` | Already set on sync. Also the root of the backup signing key: rotating it has [consequences for backups](#signed-backups-tamper-evidence). |
| `DRAFTROOM_BACKUP_INTERVAL_MS` | Backup and retry interval. Default `900000` (15 min), 1 000 to 86 400 000. |

**Turning it on for staging** (the integration step; nothing here has been done on Render yet):

1. On `draftroom-staging-sync`, set the values together, in the Dashboard (Environment) or with `PUT /v1/services/<sync>/env-vars/<key>`, **before** deploying the sync build that reads them: `DRAFTROOM_BACKUP_STORE=r2` and `R2_ACCOUNT_ID`, plus either the backup-only bucket and token (recommended, [steps above](#separate-backup-bucket-and-token-recommended)) or the shared `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET=draftroom-staging`.
   - `render.yaml` lists the store and the four `R2_*` as `sync: false`, and names the backup-only ones in a comment. On an existing Blueprint, `sync: false` values are never prompted. If a Blueprint sync set only `DRAFTROOM_BACKUP_STORE=r2`, sync would refuse to start without the R2 values, and a sync deploy stops the old instance first.
   - With the shared bucket, the api's token works. R2 tokens are scoped to buckets, not prefixes, so whichever token sync uses can still read and delete everything in the bucket, `assets/` and `backups/` alike. No object lock or versioning is configured, so whoever holds a token can delete backups.
2. Deploy sync. Check the startup line, edit a board, and within 15 minutes check the status endpoint (or restart the service: a start uploads what is missing).
3. Run the drill from the store (below).

### Restore drill (read-only)

```sh
pnpm --filter @draftroom/sync backup:restore-drill --from=store [--board <id>]   # dev (fs: DRAFTROOM_BACKUP_STORE=fs)
node apps/sync/src/backup/restore-drill.ts --from=store [--board <id>]          # Render sync Shell (the image has no pnpm)
```

It first verifies the signatures of the index, the board's manifest and the newest entry ([signed backups](#signed-backups-tamper-evidence); `--allow-unsigned` accepts pre-signing backups with a `WARN` line each). Then it downloads the newest offsite backup of each board (or the given ones; without `--board`, every board in `index.json`) into a temp dir, streamed, and checks its size and sha256 against the offsite manifest. It restores the backup into a clean temp data dir, checks the record count, clock and records digest, opens it through the sync server's own room registry (SQLiteSyncStorage, schema check, tldraw migrations) and compares every record. When the live board hasn't changed since, it's compared too. It prints `PASS`/`FAIL` per board and exits 0 only if every board passed. It never writes to the store or to a live board. `--from=local` (the default) drills `/var/data/backups` instead. The drill keeps a board's records in memory to compare them; next to the server on the 512 MB instance that is fine for today's boards (UNVERIFIED on Render).

### Restoring a board on Render from R2

The sync disk can only be reached from the running service's Shell (Render: one-off jobs can't see a service's disk). So a restore is **staged** while the server runs and **applied by the next start**, before the server accepts connections.

Before you start:

- You need the board id: the `b-…` part of the board's URL.
- Tell people: the restart in step 3 disconnects every board for a few seconds. Open tabs of the restored board reset to the restored state, and edits made after that backup are lost there, including edits not yet sent.

Steps:

1. **Drill** (Dashboard → `draftroom-staging-sync` → Shell): `node apps/sync/src/backup/restore-drill.ts --from=store --board <id>` must print `PASS`. To take an older backup than the newest, pick its `file` from `backups/sync/<id>/manifest.json`. A `FAIL … does not match its signature` means the store was changed outside the sync server: stop and find out why before restoring anything.
2. **Stage** (same Shell): `node apps/sync/src/backup/restore-board.ts --from=store --board <id> [--file <name>]`. Add `--allow-unsigned` only for a backup taken before backups were signed; the output then says `UNSIGNED`. It verifies the backup exactly like the drill, signatures first, then writes `/var/data/restore/board-<id>.sqlite` and a request next to it. Nothing live changes yet. While it works it needs free space on the sync disk (1 GB) of about three times the backup's size. `--list` shows what's staged; `--board <id> --cancel` removes it.
3. **Restart** the sync service (Dashboard → Manual Deploy → Restart service, or `POST /v1/services/<sync>/restart`; both UNVERIFIED, a manual deploy of the same commit works too). Before listening, the server:
   - keeps the current database as `/var/data/rooms/board-<id>.sqlite.pre-restore-<stamp>`;
   - puts the backup in place with its document clock raised past anything a client can have seen, so open tabs reset instead of keeping "ghost" shapes;
   - logs `[restore] board <id>: restored from r2 backup <file> (… records); clock …; previous database kept as …`.

   A request is applied once, even if its files couldn't be removed. A request that fails is logged as `restore NOT applied: …`, renamed `.failed.json`, and leaves the board untouched.
4. **Check**: open the board in a browser. While it is open, the next backup pass (within 15 minutes) backs up the restored state, locally and offsite.
5. **Undo** (if it was the wrong backup): `node apps/sync/src/backup/restore-board.ts --from=file --path /var/data/rooms/board-<id>.sqlite.pre-restore-<stamp> --board <id>`, then restart again. Delete the `.pre-restore-` file by hand once you're sure.

A board restore puts back the board's content only. Comments, votes, permissions and the title live in Postgres, and the file bytes in R2 `assets/`. The manifest's `assets` list says which file versions the backup references. Neither the drill nor the restore checks that they still exist.

Shell sessions may run as root (UNVERIFIED). `restore-board` hands the files it stages to the owner of the data dir, as the entrypoint does, so the server (user `node`) can consume them.

Tests: `apps/sync/test/backup/` (fs driver: upload, manifest, index, retention, failure and retry, restarts, the drill from the store and its failures, staging and applying through a real server start, the memory check; `signing.test.ts`: signatures, the reviewers' tamper probe, pre-signing manifests, key rotation, both CLIs; `backup-config.test.ts`: the backup-only bucket and token, down to the bucket and key id a request is signed with, against a loopback S3 stand-in), `e2e/tests/offsite-backups.spec.ts` (browser edits → offsite copy → drill from the store; a damaged copy fails), `e2e/tests/backups-2.spec.ts` (signed copies verified with the stack's secret only; a changed backup with a rewritten entry fails the drill and `restore-board` stages nothing; a pre-signing manifest passes only with `--allow-unsigned`). The live R2 test (`apps/sync/test/backup/r2-live.test.ts`, `DRAFTROOM_LIVE_R2=1`, a random `test/<run>/` prefix that it deletes) has **not been run** yet, and no separate backup bucket exists yet, so the backup-only settings have been tested against the stand-in only.

### Postgres and platform snapshots

- **Render Postgres, our plan** (a paid `0.1c-256mb` instance on the Hobby workspace; <https://render.com/docs/postgresql-backups>, read 2026-09-27):
  - Point-in-time recovery for the **past 3 days** (Pro and higher: 7 days; upgrading doesn't backfill the window).
  - A recovery creates a **new** database instance at the chosen time, which can't be within the last 10 minutes. Validate it, then point the api's `DATABASE_URL` at it.
  - Logical backups, generated automatically for paid instances and kept 7 days on every plan, plus on-demand exports from the Dashboard or `pg_dump`.
- **Render disk snapshots (sync).** One every 24 h, kept at least 7 days. They're infrastructure snapshots of live WAL-mode SQLite files, not consistent application backups, and restoring one discards everything written after it on the whole disk. They are **not** rolled back with a service rollback.
- **R2.** No versioning or replication is configured, and bucket settings are left alone. A deleted object is gone, backups included.

### Coordinating a full restore

The windows differ: Postgres goes back 3 days to any minute; board backups go back 14 days, one per day beyond the newest 12. To restore everything to a time T within the last 3 days: recover Postgres to T, then restore each board from its newest offsite backup at or before T (`--file`). Files deleted from R2 after T are gone. The backup manifests list what each board needs, so a missing file can be found, not recovered. This has **not been rehearsed** on staging.

## Rollback

- **How.** Dashboard → service → Deploys → *Rollback*. Render reuses the earlier build artifact (no rebuild) and that deploy's environment variables. Disks, plan and static-site settings are *not* rolled back. A Dashboard rollback also disables autodeploy, which is already off.
- **Database.** Migrations are forward-only (never edit a shipped one). Rolling the api back past a migration is safe only if the older code tolerates the newer schema. Otherwise, fix forward. By default an older api build **refuses to start** once the database has recorded a migration it doesn't know (`database has migration …, which this build does not know`). To roll back anyway, follow [Rolling the api back past a migration](#rolling-the-api-back-past-a-migration).
- **api past milestone 3: don't.** A milestone-1/2 api build reads files from `meta.json` on a local disk that no longer exists. It would never see R2 objects or `asset_versions` rows, and it expects its co-located worker. Fix forward instead.
- **Workers.** Roll a worker back only to a build that speaks the api's current worker protocol. The simplest way to stop previews is to stop the workers: jobs wait in Postgres.
- **Canvas schema.** Don't roll sync back below a canvas-schema migration. Boards already migrated on disk can't be loaded by the older server (`Incompatible schema?`), and newer clients are refused (`SERVER_TOO_OLD`). Rolling back the web client is safe while every shape migration keeps its `down`: an older client is served down-migrated records. Roll back sync only when its schema didn't change.
- **Platform config.** A web build from before the platform phase ignores `VITE_DRAFTROOM_SYNC_ORIGIN` and connects to the static site, which can't carry the socket. On Render, don't roll the static site back past it. A sync build from before it ignores `ALLOWED_ORIGINS` and refuses to start with the Blueprint's `host:port` internal URLs.
- **Disks.** Disk contents never roll back. To recover data you'd need a snapshot restore, which loses newer data (see above).

### Rolling the api back past a migration

`DRAFTROOM_ALLOW_NEWER_SCHEMA=1` lets an api build start on a database that has migrations newer than it knows. With the flag the migration runner:

- tolerates recorded migrations numbered **above** every migration file of the build;
- applies nothing;
- logs a warning on every start that names those migrations.

It still refuses to start in four cases, and no flag makes them safe:

- a recorded migration the build should know but doesn't (a gap below its newest file);
- a checksum mismatch (`changed after it was applied`);
- a migration of the build that the database never got;
- a build with no migration files at all (they weren't shipped), which has nothing to check the database against.

Only builds from this change onward read the flag. Every build before it refuses a newer schema, whatever the environment says.

1. **Check that the migrations you are skipping are additive for the older code.** Additive means new tables, new nullable columns or columns with defaults, and new indexes. It rules out dropped or renamed columns, a new `NOT NULL` without a default, and new `CHECK`s or triggers that the older code's writes would break. Also check what the older code *doesn't enforce*: rows the newer build wrote, which the older one would read without the newer rules. If you aren't sure, fix forward instead. `apps/api/test/migrations.pg.test.ts` checks a similar question on real Postgres for 0009 onwards: nothing existing changes, and a pre-wave-3 build's writes still work.
2. **Set the flag and deploy the older build.**
   - Set `DRAFTROOM_ALLOW_NEWER_SCHEMA=1` on the api service (Dashboard → Environment).
   - Deploy the older commit with Manual Deploy → *Deploy a specific commit*. That is a normal deploy, so it builds the commit with the service's current environment.
   - Don't use *Rollback*: Render's docs say a rollback reuses the **target deploy's** environment variables, so the flag set now wouldn't reach it.
   - This procedure hasn't been rehearsed on staging.
3. **Confirm the start.** The api log shows `DRAFTROOM_ALLOW_NEWER_SCHEMA=1: this build is running on a database with newer migrations than it knows`, with `newerMigrations` listing what it skipped.
4. **Roll forward** as soon as the fix is out. Deploy the newer build again: its migrations are already recorded, so it applies nothing. Then remove the flag. While the flag is set, every start logs a reminder to remove it.

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
