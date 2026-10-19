# Lobby go-live on DBC's Azure (plan)

**Status: plan only.** First written 2026-10-05 from `main` at `bdb35b42`. **Refreshed 2026-10-19 against `main` at
`e1942f75`** (waves J to W, drop-legacy, the theater Lobby and the NAS worker rebuilds; what changed is listed in
[What changed since the first version](#what-changed-since-the-first-version)). Nothing in this document has been built,
provisioned or tested on Azure. When something is marked **UNVERIFIED**, the text says what would verify it. The
Microsoft and Okta facts were read on 2026-10-05 from the pages linked next to them (full list in [Sources](#sources)) and
were **not re-read** for the refresh; the VM and disk prices added in the refresh were read from the Azure Retail Prices
API on 2026-10-19. Where a page does not state a claim, the claim is marked UNVERIFIED instead of being left as fact.

**Nothing here is approved.** The owner has decided the direction only (the list below). No Azure resource, DNS record,
Okta or Entra app, rehearsal or cut-over is approved by this plan, and no spend is. Each of those needs the owner's explicit
yes in chat (and DBC IT's own approvals where it is DBC's tenant). Earlier approvals (for example the 2026-10-01 rehearsal
dump from Render Postgres) covered only what they named and do not carry over.

**Who this is for:** Chase (the owner), DBC's in-house developers who take over the code, and whoever runs DBC's Azure,
Okta and DNS. New to the codebase? Read [`docs/DEVELOPER-HANDOFF.md`](DEVELOPER-HANDOFF.md) first.

**Related docs:**

- `docs/DEVELOPER-HANDOFF.md`: the codebase, its invariants, and where the sign-in seam is.
- `docs/DEPLOY.md`: today's staging on Render, every kill switch and rollback.
- `docs/EXCALIDRAW-CUTOVER.md`: the runbook pattern this plan reuses.
- `docs/DOMAIN-ACCESS-CONTRACTS.md`: who may create boards.
- `deploy/nas/README.md`: today's preview worker and Office sidecar.

**The owner's decision (2026-10-05):**

- Production moves to DBC's Azure, on the darkburn.com domain.
- Sign-in is through Okta and Microsoft accounts ("MSA").
- Fewer than 100 people: DBC staff plus invited outside reviewers.

---

## What changed since the first version

The ten corrections that matter most (the rest are inline):

1. **The preview worker does much more, and its placement is now a real decision.** Since wave W it also runs worker
   "ops" (`worker_ops` table, migration `0039_formats`): `extract-text` (search inside PDF and Office files),
   `render-pages` (deck import) and `remove-bg` (background removal with an ONNX model). Each child process has a
   resident-memory cap (PDF 768 MB, PDF text 768 MB, background removal 640 MB). The recommendation moves from "the
   worker on the one VM" to **a second small VM for the worker** ([section 2](#the-setup)).
2. **A model file is now part of the deployment.** Background removal needs `u2netp.onnx` (4,574,861 bytes, sha256
   `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`, Apache-2.0), placed by hand and never downloaded
   by Lobby (AGENTS.md, wave W rule). Without it the worker simply does not offer `remove-bg`.
3. **Twelve feature kill switches and new required keys.** Waves N to W added api switches (`DRAFTROOM_DESIGN_PREVIEWS`,
   three wave V and five wave W switches), sync keys that must be `on` (`DRAFTROOM_REACTIONS`, `DRAFTROOM_PLANNING`), and
   memory and pool caps sized for Render's 512 MB plans ([section 5](#config-only)).
4. **New outbound hosts on the server side.** The api now calls `api.miro.com` (Miro import), `hooks.slack.com` and
   Teams Workflows URLs (chat notifications), and still OpenAI and arbitrary public sites for link previews. Each is an
   egress rule DBC's network has to allow ([section 2](#outbound-network-egress)). ElevenLabs is **not** used at run time.
5. **A secret that must be carried, not regenerated.** Saved Slack and Teams webhook URLs are sealed in Postgres under
   `DRAFTROOM_WEBHOOK_SECRET`. A fresh value on Azure would make every saved hook unreadable
   ([section 6](#the-secrets)).
6. **Migrations: 39 now, the sign-in one is `0040`.** The first version expected `0028`; waves L to W used `0028` to
   `0039`. Every one of `0001`–`0039` must restore byte-identical.
7. **Drop-legacy is done** (2026-10-09, `docs/CUTOVER-LOG.md`). The board files carry no tldraw tables and
   `VITE_TLDRAW_LICENSE_KEY` is already gone; the "move after drop-legacy" condition is met.
8. **Staging holds real work now.** At drop-legacy there were 18 board files (not 4), and the team-ready release (wave P,
   2026-10-15) invited staff in. The account-link window is no longer for one person; counts must be taken again before
   the rehearsal ([section 6](#6-moving-the-data)).
9. **One-origin serving has a precedent.** The theater Lobby (`deploy/nas/theater/`, live since 2026-10-06) serves the page,
   `/api`, `/files` and `/connect` from one hostname through nginx (`docker/web.Dockerfile`). It is not a proof for Azure
   (it sits behind a Cloudflare Tunnel, and its stream timings were not found in the records), and its nginx config is not
   ready to copy: it logs full request lines (board tickets travel in the `/connect` query string) and has no
   `/lobby-assets/*` 404 rule.
10. **The sign-in work is bigger, and its seam is mapped.** The creator lookup reads one provider's addresses only
    (`CreatorLookup.source` in `apps/api/src/auth/creator-sql.ts`), so two sign-in providers in one api need a schema and
    SQL change, and more code now reads verified addresses (outside markers, Internal only, the feedback inbox, chat
    hooks, email invitations through Clerk). Estimate 14–17 days instead of 12–14; total 29–38 engineer-days instead of
    24–32 ([section 5](#5-what-changes-in-the-code)). New: [who does what](#9-what-the-owners-developers-do-vs-what-claude-can-do).

---

## 1. What changes and why

Today Lobby runs as staging on Render. Sign-in goes through Clerk, files sit in Cloudflare R2, and file previews and file
processing run on Chase's NAS. For go-live, Lobby moves into DBC's own Azure, at one darkburn.com address (we suggest
`lobby.darkburn.com`). Staff sign in with Okta. Outside reviewers sign in with a Microsoft account. The board engine,
live sync, backups and permissions stay as they are. Four things change:

- **Where it runs.** One Azure virtual machine for the web edge, api and sync, a second small VM for the preview worker,
  plus Azure's managed Postgres. Lobby's board files need a real disk attached to one machine, and a VM is the simplest
  Azure option that gives one.
- **The address.** One darkburn.com hostname serves everything. That lets us remove two workarounds that only exist
  because of Render.
- **Sign-in.** Clerk is replaced by Okta and Microsoft. This is the only part that needs substantial new code: about
  3 to 3.5 weeks of work for one engineer (an estimate, not measured).
- **File processing.** The worker and its Office sidecar move off the NAS onto the worker VM, with the background-removal
  model file placed there by hand.

Optionally, files also move from R2 to Azure Blob Storage, so that all DBC data lives in DBC's Azure tenant. That needs a
new storage driver, about one more week of work.

---

## 2. Recommended Azure setup

### The two hard constraints

These two limits rule out most Azure services. Any design DBC IT proposes must meet both.

**(a) The board files must live on a disk attached to one machine. A network share won't do.**

- Each board is one SQLite file in WAL mode on the sync server's disk. The repo forbids putting it on a network share
  (`AGENTS.md`), and SQLite says WAL mode does not work over a network filesystem
  (<https://www.sqlite.org/wal.html>).
- On Azure that leaves two choices:
  - a **VM with a managed disk**: managed disks are block storage "used with Azure Virtual Machines"
    (<https://learn.microsoft.com/en-us/azure/virtual-machines/managed-disks-overview>);
  - **AKS with an Azure Disk volume** (<https://learn.microsoft.com/en-us/azure/aks/create-volume-azure-disk>).
- Ruled out by Microsoft's own docs:
  - **Container Apps** offers only ephemeral storage or Azure Files, and "doesn't support mounting file shares from
    Azure NetApp Files or Azure Blob Storage" (<https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts>).
  - **App Service**: "Don't use storage mounts for local databases, such as SQLite"
    (<https://learn.microsoft.com/en-us/azure/app-service/configure-connect-to-azure-storage>).
  - **Container Instances** mounts only Azure Files
    (<https://learn.microsoft.com/en-us/azure/container-instances/container-instances-volume-azure-files>).
  - **Azure Files over NFS** is still a network share, so the repo rule excludes it.
- There must be **exactly one** sync server and one api server, never scaled out. Each board has one room owner, and the
  api keeps state in its own memory: the board event hub and its 30-second stream tickets (`apps/api/src/events/`), the
  rate-limit counters, the spotlight (wave L), the deck-import request rate (wave W, `DECK_LIMITS.requestRate`) and the
  link-preview queue. So: no autoscaling, and no blue/green deploys that would run two sync servers against one disk or
  two apis at once for long.

**(b) The live connections must pass through without buffering.**

- Lobby keeps two long-lived connections per open board:
  - the board **WebSocket** (`/connect/<board>`, for edits and cursors);
  - the board **event stream** (Server-Sent Events, SSE, under `/api/...`, for votes, timers, comments, polls, breakouts
    and access changes).
- Both send a heartbeat every 15 seconds: `HEARTBEAT_MS` in `apps/api/src/events/routes.ts` and in
  `apps/web/src/canvas/sync/transport/socket.ts`. So an idle limit of a few minutes only costs a reconnect. That covers
  Azure's own public-IP idle timeout too: 4 minutes by default for inbound flows, adjustable to 30
  (<https://learn.microsoft.com/en-us/azure/virtual-network/ip-services/public-ip-addresses>).
- A hop that **buffers** the stream breaks it quietly: events then arrive only every 40 seconds. That is the bug wave H
  fixed on Render.
- What Microsoft documents for the common front ends:
  - **Azure Front Door**: "Front Door doesn't support Server-Sent Events (SSE)". Its WebSockets idle out after
    5 minutes and last at most 2 hours
    (<https://learn.microsoft.com/en-us/azure/frontdoor/standard-premium/websocket>).
  - **Static Web Apps**: "WebSocket, for example, is not supported", and an API request lasts at most 45 seconds
    (<https://learn.microsoft.com/en-us/azure/static-web-apps/apis-overview>).
  - **Application Gateway** works if response buffering is turned off and the request time-out is longer than the gap
    between events (<https://learn.microsoft.com/en-us/azure/application-gateway/use-server-sent-events>). The Standard v2
    tier's fixed charge is about $146 a month (Azure Retail Prices API, East US 2, 2026-10-05), which is too much for a
    tool this size. A cheaper Basic v2 tier is listed at about $16 a month plus capacity units; its WebSocket and SSE
    behaviour was **not checked** (UNVERIFIED), and it would still leave the VM and a hostname to run.
  - **Caddy**, a small proxy running on the VM itself, is the recommendation. Its docs say responses with
    `Content-Type: text/event-stream` "are flushed immediately", and WebSockets become "a bidirectional tunnel"
    (<https://caddyserver.com/docs/caddyfile/directives/reverse_proxy>). That is the vendor's statement only.
    **UNVERIFIED on Azure, for both streams**, until they have been run through this stack: the smoke test's stream
    section (`scripts/smoke/live-smoke.mjs` 5b, which times `/api/diag/stream`) covers the event stream, and only a real
    two-user board session, held for 30 minutes and then surviving a `docker restart` of sync, covers the board
    WebSocket.
  - **nginx** is the alternative the repo already has: `docker/web.Dockerfile` builds the web app into an nginx image
    with `deploy/nas/theater/nginx.conf`, which proxies `/api`, `/files` and `/connect` on one origin with
    `proxy_buffering off` for the stream. It has served the theater Lobby since 2026-10-06, behind a Cloudflare Tunnel; no
    stream timing for it was found in the records (UNVERIFIED). Before reuse it needs: an access-log format without query
    strings (its default `combined` log writes the `/connect/...?ticket=…` request line), a hard 404 for
    `/lobby-assets/*`, the board socket named in `connect-src`, HSTS, the cache headers below, and a certificate (nginx
    has no automatic HTTPS). Caddy stays the recommendation for its automatic certificates; nginx is fine if DBC supplies
    the certificate.

**A design rule that follows from the code: one origin.**

- The session cookie is host-only and `SameSite=Lax` (`apps/api/src/auth/session.ts`), and the api has no general CORS.
  So the page, `/api/*`, `/files/*` and `/connect/*` must all be served from the same hostname.
- That also retires the two Render workarounds, `VITE_DRAFTROOM_SYNC_ORIGIN` and `DRAFTROOM_EVENTS_ORIGIN`. Once they are
  unset, the code already falls back to the page's own origin (`apps/web/src/board/ticket.ts`,
  `apps/api/src/events/routes.ts`). The theater Lobby runs exactly that way (no sync or events origin).

### The setup

| Part | Azure service | Why |
|---|---|---|
| Front end: HTTPS, the web page, routing | **Caddy** container on the main VM: the only thing listening on ports 80/443 | Automatic HTTPS. Streams SSE and WebSockets as Caddy documents (**UNVERIFIED** here, see above). Serves the built page itself, including `/excalidraw-assets/*` and `/lobby-assets/*` (a miss under either is a hard 404, never a fallback to `index.html`: the font loader and the icon loader read a 200 HTML answer as broken). Sends the cache headers `render.yaml` sets today: `/assets/*` one year immutable, `/excalidraw-assets/*` one week, `/lobby-assets/*` one year immutable except `LICENSES.txt` one day, `/version.json` `no-store` (open tabs use it to learn about a new build). Proxies only an allow-list: `/api/*` and `/files/*` go to the api, `/connect/*` goes to sync. `/internal/*`, `/healthz` and `/healthz/deep` are never published. `/api/worker/*` is published only if the worker stays on the NAS ([question 14](#8-open-questions-for-chase--it)); with the worker VM it arrives on the private network instead. |
| api | container on the main VM (`docker/api.Dockerfile`, unchanged) | No disk of its own: its state lives in Postgres and blob storage. Exactly one instance. Listens on the compose network for Caddy and, on its private VNet address, for the worker VM only (network security group: source = the worker VM). |
| sync (live boards) | container on the main VM (`docker/sync.Dockerfile`, unchanged). Its data folder is a separate **64 GiB Premium SSD managed disk** (P6), ext4, host caching **None**, mounted at `/srv/lobby` and bind-mounted as `/var/data` | Meets constraint (a): block storage attached to one machine, never a share. Exactly one container. **Mount guard (a design requirement, UNVERIFIED until rehearsed):** mount by UUID and start the sync container only when `/srv/lobby` really is the disk (for example a systemd `RequiresMountsFor=/srv/lobby` unit), and make the empty mount point immutable (`chattr +i`). Otherwise a failed mount lets Docker create an empty folder on the OS disk and sync starts with no boards (`docker/entrypoint.sh` only creates and chowns the directory; nothing checks it is the disk). Sync also pauses its local backups and reports `disk` on `/healthz/deep` below 20 % free disk, and shows a notice at 10 % (wave M, `apps/sync/src/disk.ts`). |
| Preview worker + Office sidecar | **a second VM**, `Standard_B2als_v2` (2 vCPU, 4 GiB), Standard SSD OS disk, no inbound ports at all. Two containers from the NAS compose file `deploy/nas/worker/docker-compose.yml` | Keeps untrusted file processing (PDF, Office, PSD, TIFF, video, ONNX inference) off the machine that holds the board disk and the api's secrets, and keeps a hostile file from starving sync. The compose file needs three changes: `cpus: 3` on the worker is more than the VM has (lower to 2; Docker refuses a CPU limit above the host's), the sidecar's `cpus: 2` to 1, and `./models` mounted from the VM's own disk. Memory caps stay (worker 1.5 GB, sidecar 1 GB, each without swap; the children are capped inside at 768/768/640 MB). The sidecar keeps `network_mode: none`. `DRAFTROOM_API_URL` is the api's private `http://<address>:<port>` (plain http is accepted in production only for private addresses, `apps/worker/src/env.ts`). Image size about 1.26 GB. Alternatives: the main VM (then a 4-vCPU size, see [Size](#size-why-one-small-vm-is-enough)) or keeping the NAS ([question 14](#8-open-questions-for-chase--it)). |
| Background-removal model | the file `u2netp.onnx` on the worker VM's disk, read-only at `/models/u2netp.onnx`, `DRAFTROOM_BG_MODEL_PATH=/models/u2netp.onnx` | AGENTS.md (wave W): models are never downloaded by Lobby at build or run time. An operator places the owner-approved file; the worker loads it only when its sha256 matches the pin in `apps/worker/src/ops/bg-model.ts` (and `apps/worker/models/MODELS.json`). A missing or different file only turns `remove-bg` off. The file the NAS uses came from rembg's v0.0.0 release (md5 `8e83ca70e441ab06c318d82300c84806`, as rembg publishes); copying it from the NAS is the simplest source. Inference stays in the worker's child process, never in the api, sync or browser. |
| Postgres | **Azure Database for PostgreSQL Flexible Server**, PostgreSQL 18, Burstable B1ms, 32 GiB, 35-day point-in-time restore, **private access (VNet)** | PostgreSQL 18 is supported, current minor 18.6 when read (<https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/concepts-supported-versions>), the same major the api tests pass against (real PG 18.4 and 18.6 runs, `docs/PROGRESS.md`). No extensions are needed. Public vs private access **cannot be changed after creation**. |
| Files (uploads, previews, op outputs) | **Azure Blob Storage**, Hot LRS (new driver, [section 5](#bigger-code)), or keep Cloudflare R2 at first | Keeps DBC files in DBC's tenant. About $2 a month at today's size. |
| Offsite board backups | a **separate** storage account or container with its own identity, **new and empty** (needs the Azure driver, [section 5](#bigger-code); until it exists, a new R2 bucket) | The api must not be able to delete backups (`docs/DEPLOY.md` "Separate backup bucket and token"). Never Render's bucket: the key prefix `backups/sync` is fixed in code (`OFFSITE_PREFIX`, `apps/sync/src/backup/store.ts`), so two syncs on one bucket would share the manifests of the same board ids, and the 90-day held set would stop being read-only. |
| Secrets | **Key Vault**, read by each VM's managed identity into `0600` env files at deploy time. The worker VM gets only its three values (`DRAFTROOM_API_URL`, `DRAFTROOM_WORKER_TOKEN`, `WORKER_ID`) | No secrets in git or in images. `deploy/nas/deploy-worker.sh` already refuses any other variable in the worker's env file; keep that rule. |
| Container images | **Azure Container Registry** Basic (or GitHub's free registry) | Builds come from a pipeline, not from the VMs. |
| Network | one VNet; the main VM with a static Standard public IP and a network security group that allows only 80/443 from the internet; the worker VM with no inbound rule at all; SSH limited to DBC IPs, just-in-time access or Entra login | Both VMs are closed by default. Outbound: see [Outbound network](#outbound-network-egress). |
| Disk safety net | **Azure Disk Backup** snapshots of the data disk (hourly or daily) | A fast whole-disk rollback. These snapshots are crash-consistent, so Lobby's own signed backups stay the primary board backup. |
| Monitoring | Azure Monitor alerts: VM CPU credits (both VMs), disk latency and free space, Postgres CPU and storage, and the api and sync **`/healthz/deep`** (wave M: the api checks Postgres on its own connection; sync checks free disk, backup failures, its event loop and its access checks against the api; alert on two failures in a row), probed from inside the VNet (Caddy does not publish them). Also alert when the worker has not checked in (`worker_capabilities_seen` older than 10 minutes means the web stops offering search inside files, deck import and Remove background) | Someone at DBC gets told when something breaks. |

```
browser --HTTPS--> lobby.darkburn.com (static public IP)
                     |
                     |  main VM (B2s_v2), docker compose:
                     v
                   caddy --/api/*, /files/*--> api  --> Postgres (Flexible Server, private)
                     |                          ^   --> Blob Storage or R2 (files)
                     +----/connect/*-------> sync --> /var/data (Premium SSD managed disk)
                                                  --> backup storage (signed copies)
                                                ^
                   worker VM (B2als_v2), private network only, no inbound:
                   worker --http, private--> api   (claims jobs and ops; presigned GET/PUT to the file store)
                   office sidecar (no network at all; shares a scratch volume with the worker)
```

### Outbound network (egress)

If DBC filters outbound traffic, these are the destinations each process needs. Hosts in **bold** are new since the first
version of this plan.

| Process | Destination | Why | Where the rule lives |
|---|---|---|---|
| api | Postgres (private) | everything | `DATABASE_URL` |
| api | the file store: `*.r2.cloudflarestorage.com` today, or the Azure storage account | uploads and file reads | `packages/blob-store` |
| api | `api.openai.com` (or `OPENAI_BASE_URL`) | AI actions, Ask, capture (photos and transcripts) | `apps/api/src/features/ai/config.ts`; unset key = AI hidden; `DRAFTROOM_AI=off` |
| api | **`api.miro.com`** (port 443; `/v1/oauth-token` and `/v2/` read paths only) and the hosts in `MIRO_DOWNLOAD_HOSTS` (empty today, so Miro files import as placeholders) | Miro import, only inside a job a creator started with a token they pasted | `apps/api/src/egress/rules.ts`, `packages/contracts/src/miro-import.ts` (AGENTS.md egress exception) |
| api | **`hooks.slack.com`**, **`*.<region>.environment.api.powerplatform.com`** (Teams Workflows) | chat notifications to webhook URLs a workspace admin saved | `CHAT_HOOK_RULES` in `packages/contracts/src/chat-hooks.ts` (AGENTS.md egress exception). The Teams rule is still unconfirmed against a real Workflows URL (`docs/PROGRESS.md`, wave R) |
| api | **any public website**, port 80/443 | link previews (title, image, icon of a pasted link), SSRF-guarded: addresses vetted and pinned, redirects re-checked, time and byte caps | `apps/api/src/features/link-preview/` |
| api | **Okta and Microsoft** token, JWKS and userinfo endpoints (new) | sign-in and the hourly identity check | the new provider ([section 5](#bigger-code)) |
| api | Clerk's API (today only) | sign-in, invitation email | removed with Clerk |
| sync | the backup store | signed offsite backups | `DRAFTROOM_BACKUP_*` |
| sync | the api (compose network) | access checks | `DRAFTROOM_API_INTERNAL_URL` |
| worker | the api (private) | jobs and ops | `DRAFTROOM_API_URL` |
| worker | the file store's public endpoint (or a private endpoint) | presigned GET of originals, PUT of results (≤ 15 min URLs) | handed out by the api |
| office sidecar | nothing | `network_mode: none` | compose file |
| browser | only `lobby.darkburn.com`, plus the Okta and Microsoft sign-in pages as top-level navigations | CSP ([section 4](#4-domain-and-dns)) | AGENTS.md: no request leaves Lobby's origins and the auth provider's |

- If link previews are not acceptable under DBC's egress policy, they can be refused at the network edge; Lobby then
  shows plain link cards (the fetch fails, the board is unaffected). UNVERIFIED as a deliberate mode: no switch exists for
  it.
- **Outbound for the worker VM.** It needs outbound HTTPS to the file store. On a VNet without a default outbound route
  (Microsoft has been retiring default outbound access for new VMs; how DBC's subscription is set up is UNVERIFIED), the
  cheapest way is a static public IP on the worker VM with no inbound rules ($3.65 a month), or a private endpoint once
  files are in Azure Blob.

### Size: why one small VM is enough

- **Measured on the NAS** (`docs/EXCALIDRAW-MIGRATION.md` 2.13, `docs/research/excalidraw/spike-b/B9.md`):
  - 260 concurrent sessions on 0.5 CPU and 512 MB;
  - sync memory at most 147 MB (310 MB with the conversion worker);
  - about 0.3 of a CPU on average (mean 62% of the 0.5 CPU quota).
- That test was a **mixed** result, not a clean pass: memory and acknowledgement latency met their targets, but the server
  event-loop p99 (56 to 115 ms against a 50 ms target) and the CPU windows (maximum 92%, restart and conversion windows
  over 97% of the quota) were missed. Later NAS load tests on the same 0.5 CPU / 512 MB sync passed their own targets: 200
  people answering one poll (wave V, ack p95 19 ms) and the wave W doc-card load test. It is still a stress test on half a
  CPU, so under 100 people on a 2-vCPU VM should be well below that load; the claim is an expectation, not a measurement
  on Azure.
- **Recommended main VM:** `Standard_B2s_v2`, with 2 vCPU, 8 GiB and Ubuntu LTS, running Docker Engine and compose.
- **Recommended worker VM:** `Standard_B2als_v2`, with 2 vCPU and 4 GiB: the worker (1.5 GB cap) and the sidecar (1 GB
  cap) fit with room for the OS. Lobby's worker runs one job at a time (`WORKER_CONCURRENCY=1`).
- **If DBC wants one VM only:** `Standard_B4s_v2` (4 vCPU, 16 GiB, $121.18 a month on 2026-10-19) instead of the two, with
  the worker at `cpus: 1.5` and the sidecar at `cpus: 1`, so file processing can never take more than about 2.5 of the 4
  CPUs. It costs more than the two smaller VMs together and loses the isolation.
- **Caps tuned for Render that can be revisited** (each is a value, no code): `DRAFTROOM_OUTBOUND_BUDGET_MB=64` on sync
  (set for a 512 MB instance; code default 128), `DRAFTROOM_DB_POOL_MAX=5` on the api (set for Render's 0.1-CPU database;
  code default 10), `DRAFTROOM_BACKUP_KEEP=4` on sync (set for a 1 GB disk; code default 12). Keep the Render values for
  go-live and change them only after the rehearsal's load run (UNVERIFIED which values suit Azure).
- **Two caveats**, both **UNVERIFIED**:
  - **CPU credits.** B-series VMs run at a fraction of full CPU on burst credits. A heavy day of PDF, Office and video
    previews could use the worker VM's credits up (then previews queue, which is a safe state: jobs wait in Postgres). A
    credit-balance alert would show it; if it happens, move that VM to a D-series size.
  - **Disk speed.** A P6 disk has a small guaranteed IOPS figure, with bursting. Measure SQLite commit times on the Azure
    disk with the repo's L1/L2 load harness before sign-off. The NAS baseline is a commit p99 of 10.8 ms. A larger disk
    is an online resize away.

### Rough monthly cost

**Not approved.** This is an estimate for the owner and DBC IT to decide on. Nothing is provisioned, and nothing here
authorises spend; the rehearsal VMs (the same sizes, kept for a few days) would add a few dollars on top.

**Pricing basis:** Azure retail list prices for East US 2, pay-as-you-go, from the Azure Retail Prices API (first read
2026-10-05; the B2s_v2, B2als_v2, B4s_v2 and E4 disk lines were read again on 2026-10-19, and B2s_v2 was unchanged).
**UNVERIFIED for DBC:** check them in the Azure Pricing Calculator under DBC's own agreement and region.

| Item | Per month |
|---|---|
| Main VM B2s_v2 | $60.74 |
| Main VM OS disk P6 (64 GiB) | $9.28 |
| Data disk P6 (64 GiB) | $9.28 |
| Disk snapshots | about $1 |
| Static public IP (main VM) | $3.65 |
| **Worker VM B2als_v2** | **$27.45** |
| **Worker VM OS disk E4 (32 GiB Standard SSD)** | **$2.40** |
| **Worker VM outbound IP (no inbound)** | **$3.65** |
| Postgres B1ms + 32 GiB storage | $12.41 + $3.68 |
| Blob storage for files and backups (about 100 GB) | about $2–4 (R2 stays $0 inside its free tier) |
| Key Vault, monitoring, container registry | about $0–10 |
| Internet egress (first 100 GB free) | $0 at this size |
| **Total** | **about $135–150** |

- **Savings:**
  - A 1-year reservation on the main VM takes off roughly $25 a month (not checked against the price API).
  - Keeping the worker on the NAS saves the worker VM's $33.50, at the cost of a dependency on Chase's home network and a
    published `/api/worker/*` route ([question 14](#8-open-questions-for-chase--it)).
  - A leaner variant (a 4 GiB main VM, Postgres in a container on the data disk) is about $90–100 with the worker VM, but
    loses managed point-in-time restore.
- **For comparison**, Render staging today is about $20–27 a month (`docs/DEPLOY.md` "Cost"), with the worker on the NAS
  for free. Azure costs more mainly for the managed database, the Premium disks and the worker VM.
- **Not in the table:** OpenAI usage (pay per call, no spending cap at OpenAI; Lobby's own daily caps are the only brake,
  `DRAFTROOM_AI_*`).

### What DBC IT takes on

- The main VM is a single point of failure. OS patches, Docker updates and reboots of both VMs are DBC's job.
- Plan a monthly reboot window of a few minutes. Open boards reconnect by themselves: all 260 sessions came back in
  about 5 to 8 s after a forced restart on the NAS (5.0–7.6 s across the B9 runs, `docs/PROGRESS.md`). A worker VM reboot
  only delays previews.
- The time to rebuild from a disk snapshot is **UNVERIFIED** (estimated about an hour). Rehearse it once on a scratch VM.
- The model file: keep a copy outside the worker VM (it is not in git or in any image), and check its sha256 after any
  restore.

### Alternatives considered

- **AKS** (one node pool, Azure Disk volume for sync): works, about $130–180 a month. Worth it only if DBC already runs AKS.
- **Container Apps or App Service for the api, plus a VM for sync**: no gain. You would need two hostnames, or an
  Application Gateway, and sync still needs the VM.
- **Container Apps for the worker only**: possible in principle (the worker needs no disk and no inbound port), but its
  1.5 GB and 1 GB caps, the sidecar's `network_mode: none` and the Linux memory watchdog would have to be re-proven there
  (UNVERIFIED). Not recommended for go-live.
- **Front Door or a WAF in front of the VM**: WebSockets would work, but the event stream would not. You would need a
  second hostname that bypasses Front Door (the wave-H `DRAFTROOM_EVENTS_ORIGIN` mechanism), plus Front Door's fixed fee.
  Only if DBC policy requires it.
- **Static Web Apps**: rejected (no WebSockets, 45-second limit).

---

## 3. Sign-in with Okta and Microsoft

### How it will work

- **Two buttons on the sign-in page:** "DBC staff: sign in with Okta" and "Guests and reviewers: sign in with
  Microsoft". The sign-in page also keeps "Have a code?" for workshop join codes (wave V), which needs no account.
- **The flow:**
  1. Clicking a button goes to Okta or Microsoft (a plain link to Lobby's start route, which answers with a redirect
     carrying `state`, a `nonce` and a PKCE challenge). The buttons must be links, not forms: the page's CSP has
     `form-action 'self'`, and a form whose submission is redirected to another origin can be blocked by it.
  2. The person signs in there.
  3. They come back to a Lobby address on `lobby.darkburn.com` with a one-time code.
  4. Lobby's **server** (never the browser) exchanges that code at the provider's token endpoint, proving itself with its own
     client credential and the PKCE verifier. It checks the ID token (signature, `iss`, `aud`, expiry, `nonce`, and for
     Microsoft the `tid`), then sets **Lobby's own session cookie**, as it does today.
  - The `state`, `nonce` and verifier live in the sign-in transaction table, single use and short-lived, and are tied to the
    browser that started the sign-in by a short-lived cookie (SameSite=Lax, which a top-level redirect back from the
    provider still carries), so a code that someone else obtained cannot be replayed into another browser.
- Lobby never sees a password. The Okta or Microsoft tokens never become the session. No Okta or Microsoft script loads
  in the page, so the page's security policy gets *stricter* than today's.
- **Leavers.** About once an hour, when a signed-in person makes a request, Lobby checks with Okta or Microsoft that the
  person still exists and is enabled, and still has the same verified address. This uses a refresh token that Lobby
  stores encrypted, with the key in Key Vault, and it reuses the rules Lobby already has
  (`IDENTITY_RECHECK_MS` 1 hour, `IDENTITY_GRACE_MS` 24 hours in `apps/api/src/auth/creator-sql.ts`;
  `docs/DOMAIN-ACCESS-CONTRACTS.md` §3.4). What that does and does not promise:
  - It runs on the person's **own** next request after the hour, and that request is still answered from the stored data;
    Lobby does not poll Okta or Microsoft for people who are not using it, and an already-open board tab is only re-checked
    against Lobby's own session and board grants (the event stream every 10 s, `ACCESS_RECHECK_MS` in
    `apps/api/src/events/routes.ts`), never against the provider.
  - A refresh that proves the account is gone or disabled ends all of that person's Lobby sessions (and, since wave J,
    closes their open board sockets: every session end is pushed to sync, `apps/api/src/auth/session-sync.ts`). A
    provider answer that is merely an expired token (Okta: unused for 7 days; Microsoft: 90 days) is not proof of that, so
    it sends the person through sign-in again instead.
  - Creator rights lapse when the stored address is older than 24 hours and cannot be confirmed. That is the "within 24
    hours" bound: it applies to creator status, not to boards a person was invited to.
  - Removing a leaver from workspaces is still the manual offboarding step in `docs/DOMAIN-ACCESS-CONTRACTS.md` §13 (a
    disabled account is not removed from boards by itself). The workspace admin page (wave W, `/w/<workspace>/admin`)
    now lists members, invitations, open links and guests, which makes that step easier; it changes nothing by itself.
  - **UNVERIFIED:** that a disabled or deleted account's refresh token is refused (expected as `invalid_grant`; the
    pages read do not say), and that Okta's *org* authorization server issues refresh tokens for this app type (the
    Okta refresh-token guide does not state it). Both need a test with a real disabled user in each tenant. If the org
    server issues none, the fallback is a shorter Lobby session plus a silent re-authentication (`prompt=none`) instead.
  - Microsoft replaces the refresh token on every use (<https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens>),
    so Lobby must store the new one each time and discard the old.
- **Name-only guests** (workshop and review links, and join codes) need no sign-in and work exactly as today: they are
  created and given their session by the invitation code (`apps/api/src/features/guests/join.ts`), which does not use the
  sign-in provider, so removing Clerk does not touch them.
- **One person, two sign-in buttons, two accounts.** Accounts are keyed by provider and subject
  (`apps/api/src/auth/users.ts`, `findOrCreateUser`). Someone who signs in with Okta once and Microsoft another time gets
  two separate Lobby accounts, and there is no merge by email (matching by email is unsafe, see below). Tell staff to use
  only the Okta button; a manual identity-link step is a decision for the owner if it turns out to be needed.
- **Under the hood:** this is a new sign-in adapter behind the existing `AuthProvider` interface in
  `apps/api/src/auth/provider.ts` (`publicConfig`, `register`, `refreshIdentity`, `revokeProviderSessions`), replacing the
  Clerk adapter (`apps/api/src/auth/clerk.ts`). Sessions, permissions and the domain-access code stay as they are, with
  one exception: today the creator lookup reads **one** provider's stored addresses (`CreatorLookup.source`, equal to the
  running provider's id), and two providers in one api need it to read a set of sources with a per-address trust flag
  (Microsoft addresses from a personal account must never satisfy the company-domain rule). The full file list is in
  `docs/DEVELOPER-HANDOFF.md` "Auth"; the work is sized in [section 5](#bigger-code). The repo already verifies one kind of
  ID token without a library (`apps/api/src/auth/google-id-token.ts`, for the theater's Google button), which is a useful
  reference for the JWKS handling and its tests.

### Who can do what

"Creator" means someone who may create workspaces and boards (and, since waves R to W, save chat webhooks as a
workspace admin, restore a `.lobby` backup as a new board, and show join codes). Everyone else sees only what they are
invited to.

| Person | Signs in with | Becomes |
|---|---|---|
| DBC or Trailer Park Group staff | Okta | **Creator**: a verified `darkburn.com`, `trailerparkgroup.com` or `trailerpark.com` address from DBC's Okta |
| DBC staff using their Microsoft work account | Microsoft | **Creator** only if DBC IT lists DBC's tenant ID, the person is a member (not a guest) of that tenant, and Microsoft marks the email's domain as verified (`xms_edov` = true) |
| Outside reviewer with a work Microsoft account | Microsoft | **Invited outsider**: sees only what they are invited to, and shows the "External" marker (wave J). Email-locked invitations match their verified address. |
| Outside reviewer with a personal Microsoft account (outlook.com, or one created with any email address) | Microsoft | **Invited outsider**. Whether an email-locked invitation can match a personal account is **UNVERIFIED**, see below. |
| A personal Microsoft account that shows an `@darkburn.com` address | Microsoft | **Never a creator**, only an outsider. Old personal accounts with company addresses exist, for example a leaver's. |
| Someone on the exceptions list (`DRAFTROOM_CREATOR_EMAILS`) | either | **Creator**, by exact verified address |
| Workshop or review guest | no sign-in (link or join code) | **Name-only guest**, unchanged |

**Clerk test-mode addresses never count, now or after Clerk.** Every address Lobby stores or compares goes through
`normalizeEmail` (`apps/api/src/auth/creators.ts`), which refuses any address containing `+clerk_test`
(`isClerkTestAddress` in `packages/contracts/src/domain-access.ts`), and `DRAFTROOM_CREATOR_EMAILS` refuses such an entry at
start-up. Keep both when Clerk is removed: they cost nothing and the rule fails closed.

**Why Lobby can't just trust the Microsoft email.** Microsoft says the `email` claim "isn't guaranteed to be correct,
and is mutable over time - never use it for authorization", and that users must be keyed on `oid`, `sub` and `tid`
(<https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference>,
<https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference>). So:

- Lobby counts a Microsoft address only when `xms_edov` is true.
- The company-domain creator rule applies only to tenants DBC lists.
- Personal Microsoft accounts all carry one tenant ID, `9188040d-6c67-4c5b-b112-36a304b66dad`, which never counts toward
  creator status.
- **UNVERIFIED: `xms_edov` for personal accounts.** The optional-claims page defines `xms_edov` as "the user's email domain
  owner has been verified" and says the email must belong to the tenant's verified domain, or come from a Microsoft
  account, a Google account or the one-time-passcode flow. It does not list personal Microsoft accounts as a supported
  user type for the claim. If Microsoft does not send `xms_edov: true` for a personal account, Lobby (by this rule) has no
  verified address for that reviewer, and an email-locked invitation cannot match them. Test with a real personal account
  before promising reviewers that route; the fallbacks are letting that reviewer join as a name-only guest through a
  review link (no sign-in, so no email lock) or asking them to use a work account.
- This is a deliberate use of `email` for an authorization decision (invitation matching), which Microsoft warns against;
  `xms_edov` is what makes it acceptable, so it must be tested, not assumed.

The repo's own docs already forbid trusting the Microsoft email for creators (`docs/DEPLOY.md` "Clerk settings for
domain access", `docs/DOMAIN-ACCESS-CONTRACTS.md` §15). This design keeps that rule.

**Not recommended: adding Microsoft inside Okta as a "social login".** It needs less Lobby code, but every outside
reviewer would become a user in DBC's Okta, which may cost Okta licences, and Okta's Microsoft login can't limit which
tenants sign in (<https://developer.okta.com/docs/guides/social-login/microsoft/main/>).

### What to set up in Okta (DBC IT)

1. In DBC's existing Okta org, create an app integration: **OIDC, Web Application**.
2. Grant types: **Authorization Code** and **Refresh Token**. Require PKCE.
3. Client authentication: **public key / private key** (preferred) or a client secret. The secret goes into Key Vault
   only.
4. Sign-in redirect URI: see [the table below](#redirect-urls-on-darkburncom). Sign-out redirect URI:
   `https://lobby.darkburn.com/signin`. It is needed only if Lobby's sign-out should also end the Okta session; without it,
   signing out of Lobby and signing straight back in is silent (the Okta session is still alive), which matters on shared
   computers. The rehearsal check "after a sign-out, the next sign-in asks again" depends on it.
5. Use the **org authorization server**: the issuer is `https://<dbc-org>.okta.com`. It is included with every Okta org
   and supports OIDC single sign-on. A custom authorization server would need the paid API Access Management product,
   and Lobby doesn't need one (<https://developer.okta.com/docs/concepts/auth-servers/>).
6. Assignments: assign the app to the staff group or groups that should use Lobby. Unassigned people can't sign in
   through Okta.
7. Refresh tokens: keep the Web-app default, which is non-rotating. Okta's guide says the lifetime is unlimited but a
   refresh token expires if it is unused for 7 days, so someone away for over a week signs in again
   (<https://developer.okta.com/docs/guides/refresh-tokens/main/>). Select **Refresh Token** as a grant type and request
   `offline_access`. **UNVERIFIED** against DBC's Okta policies, and the guide does not say that the org authorization
   server issues refresh tokens (see [section 3](#how-it-will-work)); test it on the rehearsal app first.
8. Create a **second, separate** app integration for the rehearsal hostname.

Tell the Lobby team three things: the org URL, the client ID, and whether DBC's Okta lets people sign themselves up or
brings in users from other identity providers. If either is on, Okta addresses can't simply be trusted as company-managed.

### What to set up in Microsoft Entra (DBC IT)

1. In DBC's Entra tenant: **App registrations, New registration**.
2. Supported account types: **"Accounts in any organizational directory and personal Microsoft accounts"**. This lets
   outside reviewers use either kind of Microsoft account. If DBC only wants staff plus personal accounts, see
   [question 3](#8-open-questions-for-chase--it). **UNVERIFIED:** a reviewer from another company may be stopped by
   their own tenant's consent policy ("Need admin approval") if that tenant has turned off user consent or requires a
   verified publisher. The basic sign-in permissions requested here are exempt from Microsoft's unverified-publisher
   block, but a tenant's own policy is not (<https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview>).
   Publisher verification is free but needs a verified Microsoft AI Cloud Partner Program account. Try a reviewer from
   a locked-down tenant before launch.
3. Platform: **Web**, never "Single-page application". SPA registrations get 24-hour refresh tokens, Web ones 90 days
   (<https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens>). Redirect URI: see
   [the table below](#redirect-urls-on-darkburncom).
4. Certificates and secrets: a **certificate** (preferred) or a client secret. Client secrets expire after at most
   24 months, so set a renewal reminder.
5. Token configuration, optional claims on the **ID token**: `email`, `xms_edov` and `acct`.
6. Set `authenticationBehaviors.removeUnverifiedEmailClaim = true` through Microsoft Graph. Microsoft then drops the
   `email` claim when the address's domain can't be verified
   (<https://learn.microsoft.com/en-us/graph/api/resources/authenticationbehaviors?view=graph-rest-beta>). That page is the
   Graph **beta** reference, and Microsoft says beta APIs are subject to change and unsupported in production, so
   check whether v1.0 has the property before scripting it. Lobby's own `xms_edov` rule is the control that matters;
   this setting is an extra layer.
7. API permissions: `openid`, `profile`, `email` and `offline_access` only. No admin-consented Graph permissions are
   needed.
8. **Never delete and recreate this registration.** Microsoft's `sub` differs for each registration, so a new
   registration would make every Microsoft user look new. Lobby also stores `oid` and `tid` so that people can be
   remapped if it ever happens.
9. Create a **second** registration for the rehearsal hostname.

Tell the Lobby team the Application (client) ID and DBC's tenant ID. Also give the Trailer Park Group tenant ID, if TPG
staff are in a separate Microsoft tenant.

**Cost:** no new charge is expected. Entra app registrations and personal Microsoft account sign-in are free, the Okta
org authorization server is included with every org, and no Entra External ID or B2B guest invitations are needed. DBC's
Okta and Microsoft licence terms were not seen, so this is **UNVERIFIED** for DBC; IT confirms it before anything is created.

### Redirect URLs on darkburn.com

The paths are **proposed**; they become final when the sign-in code lands. Each sign-in provider gets its own path,
which protects against one provider's answer being passed off as the other's. They sit under `/api/auth/`, next to
today's `/api/auth/clerk/session`, `/api/auth/email/login` and `/api/auth/google/login`.

| Purpose | Production | Rehearsal |
|---|---|---|
| Okta sign-in redirect URI | `https://lobby.darkburn.com/api/auth/oidc/okta/callback` | `https://lobby-rehearsal.darkburn.com/api/auth/oidc/okta/callback` |
| Microsoft redirect URI (Web platform) | `https://lobby.darkburn.com/api/auth/oidc/microsoft/callback` | `https://lobby-rehearsal.darkburn.com/api/auth/oidc/microsoft/callback` |
| Okta "initiate login URI" (optional, for an Okta dashboard tile) | `https://lobby.darkburn.com/api/auth/oidc/okta/start` | same on the rehearsal host |
| Okta sign-out redirect (needed only if sign-out should end the Okta session) | `https://lobby.darkburn.com/signin` | same on the rehearsal host |

The callbacks are plain GET redirects (`response_mode=query`). A form POST from Okta or Microsoft would be refused by
Lobby's cross-site request check. Don't change this setting.

### Claims Lobby needs

| From | Claim | Used for |
|---|---|---|
| Okta | `sub` (the Okta user ID, `00u…`) | the permanent account key |
| Okta | `iss` | must equal DBC's Okta org; anything else is refused |
| Okta | `email`, `email_verified` (fetched server-side from `/userinfo`) | the verified address for creator status and invitations; stored only when `email_verified` is true |
| Okta | `name` | display name (through `cleanDisplayText`, as open sign-in names are since wave J; Clerk names still are not) |
| Microsoft | `tid` + `sub` | the permanent account key |
| Microsoft | `oid` | stored for a future remap; never used to sign in |
| Microsoft | `iss` | must match the `tid` in the token |
| Microsoft | `email` + `xms_edov` | the verified address, stored only when `xms_edov` is true |
| Microsoft | `acct` | 0 = tenant member, 1 = guest; only members of a listed tenant count toward company-domain creator status |
| Microsoft | `name` | display name |

Scopes requested: `openid profile email offline_access`. No profile photos, so no Graph call.

### Moving existing users

- **Everyone signs in once more.** The address changes, and cookies don't move between hostnames.
- **Staging is in use.** At the 2026-10-01 cut-over there was 1 real account and 1 workspace; by drop-legacy (2026-10-09)
  there were 18 board files, and the team-ready release of 2026-10-15 invited staff in (`docs/team/Welcome-to-Lobby.md`).
  The current numbers of accounts, workspaces and boards were **not counted** for this refresh: take them from Render
  Postgres (read-only) before the rehearsal. To keep people's boards and memberships, the new code links a first Okta
  or Microsoft sign-in to the existing account. It does this only inside a short dated window
  (`DRAFTROOM_LEGACY_LINK_UNTIL`, for example 7 days), and only when all of these hold:
  - exactly one existing account has the same verified address;
  - that account has no identity for this provider yet;
  - the address comes from a trusted source (Okta, or a listed DBC tenant for company addresses).
- **A dry-run script runs first.** It lists what would be linked, showing domains only, and an operator reviews it.
- Ambiguous or missing matches create a new account. After the window, the Clerk rows and all Clerk code are removed.
- **Without this step**, every existing person's first sign-in creates a new, empty account, because accounts are looked
  up by provider and subject only (`apps/api/src/auth/users.ts`).
- **Outside accounts on staging** (people who signed up through Clerk with a non-company address) link the same way, by a
  Microsoft address with `xms_edov`; if that never comes, they get a new account and their board grants have to be given
  again. List them in the dry run.
- **Starting fresh** is still possible ([question 12](#8-open-questions-for-chase--it)), but it now throws away real work.
- **Old links break.** Invitation, guest and workshop links and join codes shared from the `onrender.com` address stop
  working when Render is retired. A redirect on the old Render site can carry the links over
  ([section 7](#switch)), or they can be re-issued. Join codes (`/j/ABCD-2345`) are stored in Postgres and keep working
  on the new host once people know its address.

---

## 4. Domain and DNS

**Hostnames:**

| Hostname | Points to | Record |
|---|---|---|
| `lobby.darkburn.com` | the production main VM's static public IP | `A`, TTL 300 seconds around the cut-over (can be raised afterwards) |
| `lobby-rehearsal.darkburn.com` | a rehearsal VM (deleted after the rehearsal, or kept as staging) | `A` |

The worker VM needs no hostname.

- **darkburn.com's DNS doesn't need to move into Azure.** One record per hostname in the current DNS is enough. An Azure
  DNS zone would cost $0.50 a month if DBC wants one.
- **HTTPS certificates:**
  - **Caddy gets and renews them by itself**, from Let's Encrypt. This needs two things: the `A` record must exist and
    ports 80 and 443 must be open before the first start, and any CAA record on darkburn.com must allow
    `letsencrypt.org` (**UNVERIFIED**: the CAA records haven't been checked).
  - **Or DBC supplies its own certificate**, for example a wildcard, from Key Vault. Renewal is then DBC's job.
- **Security headers stay as on Render.** Caddy sends the same set as today (`render.yaml` headers: CSP,
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and the cache headers listed in
  [section 2](#the-setup)), and adds `Strict-Transport-Security` with a 1-year max-age itself (Render's edge used to add
  it), **without** `includeSubDomains` or `preload`: darkburn.com is a shared company domain and this must not change the
  rules for its other sites. It applies the headers **only to the page's own files**, as Render does. The api's `/files`
  answers keep their own stricter policy.
- **The page's security policy gets shorter.** Every Clerk and Cloudflare entry goes (today: the Clerk frontend API,
  `clerk-telemetry.com`, `img.clerk.com`, `challenges.cloudflare.com`, `*.protect.clerk.com`), and so do the separate api
  and sync hosts. Chat hooks, Miro import, OpenAI and link previews are all server-side, so they add nothing here:

  ```
  default-src 'self'; script-src 'self'; connect-src 'self' blob: wss://lobby.darkburn.com;
  img-src 'self' blob: data:; font-src 'self'; style-src 'self' 'unsafe-inline';
  worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self';
  form-action 'self'; frame-ancestors 'none'
  ```

  `connect-src blob:` is for exports of boards with file cards, and `worker-src blob:` for the web's snapshot-decode and
  PDF workers (wave N); both are in today's enforced policy. Still no `unsafe-eval` (AGENTS.md). The board WebSocket is
  named explicitly (`wss://lobby.darkburn.com`, as today's policy names the sync host) rather than left to `'self'`: MDN
  notes that `connect-src 'self'` does not resolve to WebSocket schemes in all browsers
  (<https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src>; WebKit
  bug 201591 is one such case), and only one smoke spec runs on WebKit and Firefox (`e2e/playwright.config.ts`; the rest of
  the suite is Chromium). **UNVERIFIED** for this build: the enforced-CSP production test
  (`e2e/excalidraw-builds/prod-build.spec.ts`) and `pnpm --filter @draftroom/e2e csp:cutover` must show zero violations,
  and a board must be opened in Safari under the enforced header before sign-off. The CSP audit policy
  (`e2e/spike/csp/suite-audit-policy.ts`) and `scripts/smoke/live-smoke.mjs` carry staging's hosts and change with it.
- **Cookie protection on a shared company domain.** Any other `*.darkburn.com` site could set a cookie that Lobby would
  read. So in production Lobby's cookies get the `__Host-` prefix, which browsers refuse to let other subdomains set
  (a small code change, [section 5](#small-code-new-files-or-small-edits)).
- **Later: invitation email.** If Lobby ever sends invitation email from a darkburn.com address, that needs the usual
  mail records (SPF and DKIM). It is not part of go-live ([question 15](#8-open-questions-for-chase--it)).

---

## 5. What changes in the code

All estimates are for one engineer and are **UNVERIFIED** (not measured). The sync engine, the canvas, permissions,
board tickets, the worker protocol (previews and ops), the backup and restore tools, the AI features, chat hooks and
Miro import don't change. Who does each part is in [section 9](#9-what-the-owners-developers-do-vs-what-claude-can-do).

### Config only

| Setting | Azure value |
|---|---|
| `PUBLIC_ORIGIN` (api), `ALLOWED_ORIGINS` (sync), `VITE_PUBLIC_ORIGIN` (web build, og:image) | `https://lobby.darkburn.com`, exactly |
| `PORT` | set explicitly per service. Render injected it; the images don't. |
| `DATABASE_URL` | the Flexible Server URL with `?sslmode=verify-full`. If Node's built-in roots don't accept Azure's chain, add `NODE_EXTRA_CA_CERTS` with Microsoft RSA Root CA 2017 and DigiCert Global Root G2 (<https://learn.microsoft.com/en-us/azure/postgresql/security/security-tls-how-to-connect>). **UNVERIFIED** until a test connection. |
| `DRAFTROOM_SYNC_INTERNAL_URL`, `DRAFTROOM_API_INTERNAL_URL` | `http://sync:<port>`, `http://api:<port>` on the compose network |
| `TRUST_PROXY` | `1` (Caddy is the one proxy), instead of Render's `3` (the theater uses `2`: nginx plus the tunnel). **UNVERIFIED** until the two-network test in `docs/DEPLOY.md` "Client IPs" passes. |
| `DRAFTROOM_EVENTS_ORIGIN`, `VITE_DRAFTROOM_SYNC_ORIGIN` | **unset**: no longer needed on one origin |
| `VITE_TLDRAW_LICENSE_KEY`, `VITE_LOBBY_ENGINE` | already gone (removed at drop-legacy, 2026-10-09); never add them back |
| `DRAFTROOM_ENGINE` (sync) | `excalidraw` |
| `DRAFTROOM_DATA_DIR` | sync: `/var/data` on the managed disk; api: a scratch path |
| `AUTH_PROVIDER` + the new Okta/Microsoft variables | once the sign-in code exists. `CLERK_*` removed. |
| `DRAFTROOM_CREATOR_DOMAINS` (api), `VITE_DRAFTROOM_CREATOR_DOMAINS` (web build, wave K) | default (`darkburn.com,trailerparkgroup.com,trailerpark.com`); the two must match |
| `DRAFTROOM_CREATOR_EMAILS`, `DRAFTROOM_FEEDBACK_ADMINS` | in Key Vault only, never in git (personal data); carried over from Render's Dashboard values |
| `DRAFTROOM_WEBHOOK_SECRET` (api only, own Key Vault secret) | **carried over** ([section 6](#the-secrets)); `DRAFTROOM_WEBHOOK_SECRET_PREVIOUS` for a rotation |
| Blob and backup store | files: `R2_*` carried over, or the new Azure values. Backups: `DRAFTROOM_BACKUP_STORE` with its **own new** bucket and credentials (`DRAFTROOM_BACKUP_R2_*` until the Azure driver exists), never Render's bucket. `DRAFTROOM_BACKUP_SIGNING_SECRET` new |
| `DRAFTROOM_WORKSPACE_QUOTA_MB` | `5120` today (lowered in wave M to stay inside R2's free storage); a decision on Azure ([question 24](#8-open-questions-for-chase--it)) |
| `DRAFTROOM_DB_POOL_MAX`, `DRAFTROOM_OUTBOUND_BUDGET_MB`, `DRAFTROOM_BACKUP_KEEP`, `ACCESS_RECHECK_MS` | Render's `5`, `64`, `4`, `10000` at go-live ([Size](#size-why-one-small-vm-is-enough)) |
| Feature switches, api (each `on`/`off`; anything else stops the api; read at boot) | as on staging today (`render.yaml`, all `on`): `DRAFTROOM_DESIGN_PREVIEWS`, `DRAFTROOM_LIVE_ACTIVITIES`, `DRAFTROOM_JOIN_CODES`, `DRAFTROOM_BREAKOUTS`, `DRAFTROOM_DOC_CARDS`, `DRAFTROOM_REMOVE_BACKGROUND`, `DRAFTROOM_FILE_SEARCH`, `DRAFTROOM_DECK_IMPORT`, `DRAFTROOM_WORKSPACE_ADMIN`, `DRAFTROOM_AI_VISION`. The worker-backed three are offered to the web only while a capable worker checked in within 10 minutes |
| Feature switches, sync | `DRAFTROOM_REACTIONS=on` and `DRAFTROOM_PLANNING=on` (**required**: off, the room refuses those writes and tells the web it is on contracts 13, so planning disappears); `DRAFTROOM_WS_DEFLATE=off` (the wave M hold, until its ack time is measured) |
| AI limits | `OPENAI_API_KEY`, `OPENAI_MODEL`, the `DRAFTROOM_AI_VISION_*` and `DRAFTROOM_AI_TRANSCRIPT_*` caps and `DRAFTROOM_VISITS_RETENTION_DAYS` as in `render.yaml`; `DRAFTROOM_AI=off` switches AI off for everyone |
| Worker VM | `DRAFTROOM_API_URL=http://<api private address>:<port>`, a new `DRAFTROOM_WORKER_TOKEN`, `WORKER_ID` (for example `azure-1`); in the compose file `DRAFTROOM_BG_MODEL_PATH=/models/u2netp.onnx`, `WORKER_CONCURRENCY=1`, `WORKER_PDF_HEAP_MB=384`, `WORKER_PDF_RSS_MB` default 768, `OFFICE_SOCKET`/`OFFICE_JOBS_DIR`; `WORKER_OPS` (`all`, `none` or a list) to limit op kinds |
| `DRAFTROOM_BOOT_MAINTENANCE` (sync) | set only for the cut-over's first boot, then deleted |

Size: about 1.5 days, including the `TRUST_PROXY` measurement.

### Small code (new files or small edits)

| Item | Size |
|---|---|
| Caddy config. Covers: the page with fallback to `index.html`, a hard 404 for missing `/excalidraw-assets/*` and `/lobby-assets/*`, the proxy allow-list, headers, CSP, HSTS, the cache headers (including `/version.json` `no-store`), and `stream_close_delay` so a config reload doesn't drop open WebSockets (Caddy's docs name WebSockets; whether event streams survive a reload is not stated). Also: **no `encode` (compression) on `/api/*` or `/connect/*`** (the api sends `no-transform` for a reason, `apps/api/src/events/routes.ts`), and **no access-log line may carry a query string or the `Sec-WebSocket-Protocol` header**, because board tickets travel in the `/connect` query string (AGENTS.md: never log session tokens or private content). The theater's nginx (`deploy/nas/theater/nginx.conf`) is the closest model for the routing, but it logs full request lines and has no `/lobby-assets/*` rule. | 1 day |
| A web image (or build stage) and compose files for the two VMs. Includes health checks with `node -e fetch(...)` (the images have no curl), log rotation 10 MB × 3, a pinned Caddy version and digest, the worker compose changes from [section 2](#the-setup), and the model mount. `docker/web.Dockerfile` already builds the web app in a pinned Node image. | 1–1.5 days |
| One checked-in header file read by Caddy, the smoke test and the e2e CSP harness, so they can't drift (today `render.yaml` is the source, checked by `scripts/smoke/render-yaml.test.mjs`). Also: adapt `scripts/smoke/live-smoke.mjs` (41 checks today) to one origin. Dropping the Clerk allowances is the smaller part: it derives `<name>-api` and `<name>-sync` hosts from `--base`, checks that `connect-src` names the api and sync origins literally, probes `/healthz` on both (Caddy does not publish it), reads the expected headers from `render.yaml`, and only reports the stream through the web origin as information (the strict first-byte check is on the api origin). | 1–2 days |
| Infrastructure as code (Bicep or Terraform): two VMs, disks, IPs, network security groups, Postgres, Key Vault, storage | 1.5–2.5 days |
| Deploy pipeline: GitHub Actions builds the images, pushes them to the registry, then runs compose on the VMs in the order api, sync, web, then the worker, as in `docs/DEPLOY.md`. CI today is `workflow_dispatch` only (`.github/workflows/ci.yml`) | 1–2 days |
| `__Host-` cookie prefix in production, with tests (the name lives in `SESSION_COOKIE`, but 42 files, mostly tests and e2e helpers, write `dr_session` literally; the prefix also needs `Secure`, `Path=/` and no `Domain`, which the cookie already has) | 0.5–1 day |
| Add the Azure and Okta secret names to the worker and sidecar deny-lists (`apps/worker/src/env.ts`, `apps/worker/src/office-sidecar.ts`) | 1 hour |
| A runbook for placing and checking the model file on the worker VM | 2 hours |
| Docs: a new `docs/DEPLOY-AZURE.md`, `.env.example`, README, `PROGRESS.md`; mark the Render-era comments in `docker/*` as history | 1 day |

Subtotal: about 7.5–11 days.

### Bigger code

| Item | Size |
|---|---|
| **Okta and Microsoft sign-in, replacing Clerk.** | **14–17 days** |
| **Azure Blob storage driver**, only if files leave Cloudflare | **3–5 days** |
| Invitation email sender (optional, after go-live) | 2–3 days |

**Okta and Microsoft sign-in (14–17 days)** covers:

- a new `apps/api/src/auth/oidc.ts` implementing `AuthProvider` (`apps/api/src/auth/provider.ts`) for both providers,
  using the `openid-client` library (MIT licence; 6.8.8 was the latest on npm on 2026-10-05, to be checked again and pinned
  exactly in the catalog) or `node:crypto` as `google-id-token.ts` does;
- config: `AuthProviderId` and the new variables in `apps/api/src/config.ts` (with the "every secret differs" checks),
  `defaultProvider` in `apps/api/src/app.ts`, `AuthConfig.providers` in `packages/contracts/src/index.ts`;
- the next free migration, **`0040`**, which allows the new provider names (both `identities.provider` and
  `user_emails.source` have CHECK constraints that list only `dev`, `clerk` and `email` today, last set in
  `0025_open_signin.sql`) and adds the identity columns (`oid`, `tid`, `acct`), a per-address trust flag, a sign-in
  transaction table and the encrypted refresh tokens;
- creator status from several providers, with the trust rule from [section 3](#who-can-do-what): `CreatorLookup` and the
  three SQL builders in `apps/api/src/auth/creator-sql.ts` (`userColumns`, `qualifiesSql`, `originColumns`) read one
  source today; the outside markers and Internal only (wave J) are built on the same SQL, so their tests cover it;
- encrypted refresh tokens for the hourly check (the AES-256-GCM box in `apps/api/src/crypto/sealed.ts` is the model,
  with its own key);
- `revokeProviderSessions` for "Sign out everywhere" (Okta's revoke endpoint; for Microsoft, dropping the stored refresh
  token), and the optional Okta sign-out redirect;
- the legacy link window and its dry-run script;
- a new sign-in page (`apps/web/src/auth/SignInPage.tsx`), removing the Clerk components and session glue in
  `apps/web/src/auth/` and the Clerk branches in `apps/web/src/api/client.ts` and `apps/web/src/board/ShareDialog.tsx`;
- an invitation path that no longer depends on Clerk (`apps/api/src/features/dashboard/email-invites.ts` and
  `clerk-directory.ts` look up and email people through Clerk; without it the inviter gets a link to send);
- removal of both Clerk packages (`@clerk/backend` in the api, `@clerk/react` in the web), in one serialized lockfile
  change, and of the `clerk_session_id` column's use;
- fake Okta and Microsoft servers for the api tests (the Clerk fake in
  `apps/api/test/features/domain-access/clerk-fake.ts` is the pattern) and for the e2e stack;
- checks against real test tenants (DBC's test users);
- the repo's independent security review.

It needs DBC IT's app registrations before the last two steps.

**Azure Blob storage driver (3–5 days)** covers:

- a new `packages/blob-store` driver next to `r2-store.ts`, plus config;
- offsite backups to Azure;
- a check after each worker upload (preview derivatives and, since wave W, op outputs): an Azure upload link can't pin a
  file's type and size the way R2's can;
- tests: the shared `packages/blob-store/test/suite.ts`, a local emulator (Azurite), and one live run.

Until it exists, files stay on R2.

**Invitation email sender (2–3 days, optional).** Without Clerk, "invite by email" gives the inviter a link to send
themselves. Sending the email would go through Microsoft Graph from a DBC mailbox, or Azure Communication Services
Email.

### Total and order

- **Total:** about **29–38 engineer-days** for config, small code, sign-in, the Azure Blob driver, the rehearsal and the
  cut-over (an estimate; it was 24–32 on 2026-10-05: the second VM, the worker and model steps, the larger sign-in seam
  and more to check in the rehearsal).
- **Order:**
  1. Answer the open questions.
  2. Build sign-in, the Blob driver and the Azure infrastructure in parallel, each with its own files. The changes to
     shared schemas, the migration and the lockfile are made one after another.
  3. Rehearse.
  4. Cut over.

---

## 6. Moving the data

**What there is to move:**

| What | Where today | How it moves |
|---|---|---|
| Everything relational: people and their sign-in identities (`users`, `identities`, `user_emails`, `sessions`), workspaces, the board list, permissions, invitations, link tokens and join codes, comments, history rows (`board_snapshots`), asset records, the search index and file text (wave W), library items, imports, chat hooks and their outbox (sealed URLs), feedback, usage, live activities and breakouts, `worker_ops` | Render Postgres 18, 39 migrations | `pg_dump` → `pg_restore` |
| Board content (one SQLite file per board, WAL mode), trashed boards included | Render sync disk, `rooms/` | through the signed offsite backups, then the restore tools. Those backups are made with SQLite's online-backup API on the live connection, so the `-wal` content is inside the copy (`apps/sync/src/backup/backup.ts`). Never copy a live `.sqlite` file by hand |
| File bytes: uploads, previews and op outputs (`assets/`), the **history checkpoint bodies** (`snapshots/<board>/<id>.json`, the restore points) and the **board thumbnails** (`thumbnails/<workspace>/<board>/<version>`) | R2 bucket | nothing to move if R2 stays; otherwise a key-for-key copy of **all three prefixes**. The Postgres rows only hold these keys: a copy of `assets/` alone would leave every checkpoint and thumbnail pointing at nothing. `imports/restore/` holds only the spooled uploads of `.lobby` restores in progress: nothing to copy once no restore job is running |
| Old offsite backups, including the 90-day disaster sets held until 2026-12-30 (cut-over) and 2027-01-07 (drop-legacy) | R2, `backups/sync/` | not copied: kept read-only in R2 until the holds end |
| Secrets that verify the old backups: `DRAFTROOM_INTERNAL_SECRET`, `DRAFTROOM_BACKUP_SIGNING_SECRET` | Render | copied into Key Vault (never printed or committed), used only by the one-off restore commands below and later to read the old held sets |
| The secret that opens saved chat webhooks: `DRAFTROOM_WEBHOOK_SECRET` | Render env group `draftroom-staging-webhook-secret` (api only) | copied into Key Vault ([below](#the-secrets)) |
| The background-removal model | the NAS, `draftroom-worker/models/u2netp.onnx` | copied to the worker VM by an operator; check the sha256 against `apps/worker/src/ops/bg-model.ts` |

**How much:** at drop-legacy (2026-10-09) the sync disk held 18 board files (`docs/CUTOVER-LOG.md`). The number of
accounts, workspaces, boards and file bytes today was not taken for this refresh (UNVERIFIED); count them (read-only)
when the rehearsal is planned. At that size every step below still takes minutes.

### The secrets

- Generate **new** production values on Azure for `DRAFTROOM_TICKET_SECRET`, `DRAFTROOM_INTERNAL_SECRET`,
  `DRAFTROOM_BACKUP_SIGNING_SECRET` and `DRAFTROOM_WORKER_TOKEN`, so that Render's values die with Render, plus the
  refresh-token encryption key and the Okta and Microsoft credentials. The two **old** verification values above are kept
  only to verify Render's backups.
- **`DRAFTROOM_WEBHOOK_SECRET` is the exception.** The webhook URLs in Postgres are sealed under it (AES-256-GCM, AAD
  `workspaceId:hookId`, `apps/api/src/crypto/sealed.ts`); with a new value every saved Slack or Teams hook stops working
  and the admins must paste them again. Either carry the value over as it is, or (better, so Render's value dies too) set
  the old value as `DRAFTROOM_WEBHOOK_SECRET_PREVIOUS` and a new one as `DRAFTROOM_WEBHOOK_SECRET`: rows sealed under the
  old key still open and the re-seal pass rewrites them; then remove the previous one (`docs/WAVE-R-CONTRACTS.md` §4.3).
- `DRAFTROOM_CREATOR_EMAILS` and `DRAFTROOM_FEEDBACK_ADMINS` are copied from Render's Dashboard into Key Vault (they are
  addresses, not secrets, but personal data). `OPENAI_API_KEY` is copied or replaced (question 22).
- The Lobby secrets must stay different from each other and at least 32 characters long (the code requires the ticket,
  internal and backup-signing secrets to differ from one another, the worker token to differ from the first two, and the
  webhook secret to differ from every other secret of the api: `apps/api/src/config.ts`, `apps/sync/src/config.ts`).

**Recommended: move the data rather than start fresh.** It keeps the boards, their history and the accounts, and the
same tools have already done this once (the NAS dress rehearsal, `docs/research/excalidraw/rehearsal/`).

**Timing:** drop-legacy ran on 2026-10-09, so the copied board files no longer carry the old tldraw tables. Any time
after the sign-in code is ready works.

### Step by step

The commands are the existing ones from `docs/DEPLOY.md` "Backups" and `docs/EXCALIDRAW-CUTOVER.md` C4–C6.

1. **Copy most of the files early** (only if files move to Azure). The day before, copy the R2 prefixes `assets/`,
   `snapshots/` and `thumbnails/` key-for-key into the Azure files container (not `backups/`). A bulk copier such as rclone
   can do it (**UNVERIFIED**: the tool hasn't been tested here). Compare object counts and total bytes. A top-up copy runs
   after the freeze (step 7).
2. **Freeze.** On the Render sync, turn maintenance on with `POST /internal/maintenance {"on":true}`. Every open board
   closes with "Lobby is updating". Check that `GET /internal/maintenance` answers `{"maintenance":true}`. This stops
   board edits only; the Render api still accepts uploads, checkpoints, imports and worker results until step 4 suspends
   it. Stop the NAS worker too (`WORKER_OPS=none` or stop its containers) so no op result lands after the copy.
3. **Final board backups.** In the Render sync Shell, run
   `node apps/sync/src/backup/run-all-cli.ts --expect-maintenance > /var/data/cutover/final-backups.json`. It makes a
   signed offsite copy of every board file on the disk (open or not, trashed ones included), held for 90 days. Keep the
   report, and copy it off Render's disk (the services are suspended later): each board's `documentClock`,
   `recordCount` and `recordsSha256` are the reference for step 8. (On 2026-10-01 and 2026-10-09 the same CLI ran from
   the workstation with `--url` and the secret in its environment, `docs/CUTOVER-LOG.md`; either works.)
4. **Restore points.** In the Render api Shell, run `node apps/api/src/features/history/checkpoint-all-cli.ts`: one
   checkpoint per board (its body goes to R2 under `snapshots/`). Then **suspend the Render api**, so nothing more is
   written to Postgres or R2.
5. **Postgres.**
   1. Temporarily allow the Azure main VM's IP on Render Postgres (its allow-list is empty on purpose). The tool is
      `docs/research/excalidraw/rehearsal/pg-allowlist.mjs add|restore`. The owner's 2026-10-01 approval covered the
      rehearsal's dump only: get a fresh OK for this one, and restore the empty list straight afterwards.
   2. On the VM, in a `postgres:18` container, run
      `pg_dump -Fc --no-owner --no-privileges`, then
      `pg_restore --no-owner --no-privileges --exit-on-error` into a fresh UTF8 database on Flexible Server.
   3. Put Render's allow-list back to empty.
   4. Start the Azure api. It applies the new sign-in migration (`0040`) by itself. Every earlier migration
      (`0001`–`0039`) must be byte-identical, or the api stops on a checksum mismatch. Start it with the worker-backed
      switches as they are: the web offers those features only once the Azure worker has checked in.
6. **Boards.**
   1. Start the Azure sync **in maintenance** (`DRAFTROOM_BOOT_MAINTENANCE=1`), with `DRAFTROOM_REACTIONS=on` and
      `DRAFTROOM_PLANNING=on`.
   2. Run the restore commands with Render's backup bucket and credentials and the two carried secrets, one-off, for those
      commands only (they read the old store; the Azure sync's own backup store is a different, empty one):
      - `node apps/sync/src/backup/restore-drill.ts --from=store` must print **PASS** for every board in the store's
        index, trashed boards included;
      - then, for each of those boards, `node apps/sync/src/backup/restore-board.ts --from=store --board <id>`.
   3. Restart sync, which puts the staged boards in place (the flag keeps it in maintenance across the restart).
   The NAS rehearsal restored every staging board from R2 into a new folder this way, with
   `restore-drill.ts --from=store --keep --data-dir`. Using `restore-board` onto an **empty** data disk is
   **UNVERIFIED**: the code handles a missing live file (`apply` in `apps/sync/src/backup/staged-restore.ts`), but only
   the rehearsal proves it.
   Never copy a live `board-<id>.sqlite` by itself. The newest edits can sit in its `-wal` file.
7. **Files, top-up** (only if files moved). Copy whatever appeared under `assets/`, `snapshots/` and `thumbnails/` since
   step 1, including the checkpoint bodies step 4 wrote. Nothing new can appear after step 4, when the Render api is
   suspended (step 2 stops only board edits, not uploads).
8. **Worker.** Start the Azure worker VM with the model file in place. Its start-up log must name
   `remove-bg:u2netp@1, extract-text@1, render-pages@1` and the child memory caps; `GET /api/auth/config` then shows every
   `formats` value true within a few minutes.
9. **Verify:**
   - Postgres row counts per table equal Render's (the rehearsal's `stack.sh` has a `pg-counts` helper).
   - Each board's element count (`recordCount`) matches step 3's report. The clock and digest do **not** match, by design:
     applied onto an empty disk, a staged restore raises the board clock by 1,000,000 and writes a new epoch
     (`UNKNOWN_LIVE_BUMP` in `staged-restore.ts`, `apps/sync/src/backup/restore.ts`), and `recordsSha256` covers `lb_meta`
     where the clock and epoch live. Expect `documentClock` = step 3's clock + 1,000,000 (read it from
     `GET /internal/boards/<id>/snapshot`, counts only, as on 2026-10-01). The exact-digest proof is step 6.2's drill
     PASS, which restores with no bump and compares to the manifest.
   - Open each real board: shapes, file cards and previews show; open a board's History and a dashboard thumbnail.
   - Send a test chat notification to one saved hook (the webhook secret came across).
   - Then turn maintenance off on the Azure sync, and **remove `DRAFTROOM_BOOT_MAINTENANCE` from its environment**, so a
     reboot starts open (the 2026-10-01 cut-over deleted the flag at C16 for the same reason).
10. **New backups.** The Azure sync's periodic backup only copies boards that are open and have changed
    (`apps/sync/src/backup/backup.ts`, `BACKUP_DEFAULTS`: every 15 minutes), so boards nobody opens would have no offsite
    copy at all. Run `run-all-cli.ts` once on the Azure sync (it backs up every board file, open or not, and holds the set
    90 days) to give the new store a first set signed with the new secrets. Then run `restore-drill.ts --from=store`
    against the **new** store with the **new** secrets: it must PASS for every board, and the status endpoint must show
    `failuresTotal` 0.

---

## 7. Cut-over checklist

### Before the day

- [ ] The open questions in [section 8](#8-open-questions-for-chase--it) are answered.
- [ ] Okta and Entra app registrations exist for both the rehearsal and production hostnames.
- [ ] The sign-in code (and the Blob driver, if chosen) is merged, security-reviewed and green on the full gate (vitest,
      real Postgres through `scripts/nas-pg-api.sh` or CI's postgres job, the whole e2e suite in both event modes,
      `probe:browser`, `test:arrows`, `licence:check`, `audit:prod`, `csp:cutover`).
- [ ] Azure is built from the infrastructure-as-code files, not by hand.
- [ ] Postgres connects with `sslmode=verify-full`.
- [ ] The model file is on the worker VM and its sha256 matches the pin.
- [ ] The DNS records exist, with a TTL of 300 s.

### Rehearsal (on lobby-rehearsal.darkburn.com)

- [ ] Steps 1, 5–10 of [section 6](#6-moving-the-data) run end to end and timed, on copies taken from live staging
      **without freezing it**. The board copies are the newest regular offsite backups (taken every 15 minutes), and
      the database copy is a `pg_dump`, which is a consistent snapshot by itself. Steps 2–4 are timed on the real day.
- [ ] The smoke script adapted to one origin ([section 5](#small-code-new-files-or-small-edits)) passes against the
      rehearsal host:
  - [ ] headers, CSP, HSTS and the cache headers (`/version.json` `no-store`; a missing `/lobby-assets/…` and
        `/excalidraw-assets/…` file answers 404);
  - [ ] the board WebSocket;
  - [ ] the event stream's first byte under 1 second (section 5b);
  - [ ] a 500 MB upload and file range reads through Caddy.
- [ ] A real board opened in Safari and in Chrome under the enforced CSP: no violations, and the socket connects.
- [ ] A 30-minute board session with two users, then `docker restart` of sync: the board reconnects. Same after a
      `caddy reload`.
- [ ] A poll and a breakout run between two users (wave V: they use the event stream).
- [ ] The worker: a PDF, a DOCX and a PSD get previews; a word only inside a PDF is found by search; a PPTX of more than 8
      slides inserts as slides; Remove background works on a PNG. A deliberately huge PDF is killed at its memory cap and
      fails cleanly, and sync's latency does not move while it runs.
- [ ] Reboot both VMs: everything comes back by itself, in the order api, then sync; the worker reconnects. With the data
      disk deliberately left unmounted (on the rehearsal VM only), sync does not start and writes nothing to the OS disk.
- [ ] Sign-in:
  - [ ] staff via Okta becomes a creator;
  - [ ] a reviewer via a personal Microsoft account is an outsider, and the token carries `xms_edov` or the result is
        written down;
  - [ ] a reviewer from a locked-down company tenant can reach the consent step;
  - [ ] an email-locked invitation is accepted with the matching address and refused with another;
  - [ ] a name-only guest link and a join code work;
  - [ ] Okta's org authorization server returns a refresh token, and a disabled test user (Okta and Microsoft) is cut off at
        the next hourly check;
  - [ ] after a sign-out, the next sign-in asks again;
  - [ ] the legacy link dry run lists the expected accounts, by domain only.
- [ ] Revoking access disconnects an open board within 15 s.
- [ ] SQLite commit times on the Azure disk under the L1/L2 load harness are recorded.
- [ ] A disk-snapshot restore onto a scratch VM, and a Postgres point-in-time restore to a new server, are tried once
      each. Write down how long they took.
- [ ] Everything is written up as evidence, then the rehearsal data is wiped.

### The window

**Announce it first:** about 1 hour, boards closed throughout.

1. [ ] **Freeze**: [section 6](#step-by-step), steps 2–4. Render sync goes into maintenance, the NAS worker stops, then the
   final backups and checkpoints run, then the Render api is suspended.
2. [ ] **Copy**: steps 5–8 (Postgres, boards, the file top-up, the worker).
3. [ ] **Verify**: step 9, then the live smoke against `lobby.darkburn.com`, then the owner signs in through Okta and the
   account is linked, a creator, with all of his boards. Then a two-user test, as on 2026-10-05.
4. [ ] **Go / no-go.** Decide here. Rolling back up to this point loses nothing.

### Switch

- [ ] Tell people the new address: `https://lobby.darkburn.com`.
- [ ] Replace the Render web site's rules with a redirect of every path to `https://lobby.darkburn.com`, so old
      invitation and guest links land on the new host. **UNVERIFIED**: Render static sites support redirect rules, but
      this hasn't been tried on this site.
- [ ] Run step 10 (the drill of the new backup store).

### Rollback

- **Before the switch:** resume the Render api, turn maintenance off on the Render sync and start the NAS worker again.
  Render is unchanged and nothing is lost. The Azure copy is simply discarded.
- **After the switch:** going back to Render loses whatever was done on Azure, unless it is copied back with the same
  tools in reverse. That reverse copy is **not rehearsed** (**UNVERIFIED**), so make the go/no-go call in step 4, not
  later.
- **On Azure itself:** a bad board can be restored from its signed backups (`docs/DEPLOY.md` "Restoring a board").
  Postgres has point-in-time restore for up to 35 days, and the data disk has its snapshots. A bad feature is switched
  off by its key and a restart (`docs/DEPLOY.md` waves V and W); the worker by `WORKER_OPS=none`.
- **Keep for 30 days:** the suspended Render services, the R2 bucket and the Clerk dev instance. Keep the R2 backup
  prefix until its holds end (2027-01-07).

### After

- [ ] Watch for 48 hours. Run a daily check like the ones in `docs/CUTOVER-LOG.md`:
  - [ ] api and sync `/healthz/deep` answer 200;
  - [ ] backup status shows `failuresTotal` 0;
  - [ ] the worker checked in within the last 10 minutes;
  - [ ] no error lines in 24 h;
  - [ ] no unexpected restarts.
- [ ] Once the link window closes: remove Clerk (code, packages, CSP, the dev instance), the Render services and
      `render.yaml` (or keep them as staging, [question 17](#8-open-questions-for-chase--it)).
- [ ] Retire the NAS preview worker (`deploy/nas/worker`). The theater Lobby (`deploy/nas/theater`) is a separate
      deployment and is not part of this move.
- [ ] Update `docs/PROGRESS.md`.

---

## 8. Open questions for Chase / IT

Each question comes with a recommended answer. A recommendation is not a decision, and silence is not approval: the owner
(and DBC IT, for anything in DBC's tenant) answers each one explicitly before the work or the spend it implies starts.
Questions 10, 11, 13, 14, 21 and 22 carry a cost, and 6, 8, 9 and 26 need changes in DBC's Entra, Okta, DNS or network.

1. **What does "MSA" mean here?** Recommended: Microsoft accounts for outside reviewers, both personal accounts and other
   companies' work accounts. DBC staff use Okta.
2. **Is DBC's Okta tied to DBC's Microsoft 365 (federated), so that staff could use either button?** Recommended: staff
   use Okta. The Microsoft button also makes staff creators only if IT lists DBC's tenant ID.
3. **Which Microsoft accounts may sign in at all?** Recommended: any Microsoft account (the `common` sign-in), because
   reviewers at companies on Microsoft 365 can't make personal accounts with their work address.
4. **Which Okta org, and does it allow self-sign-up or users brought in from other identity providers?** Recommended:
   DBC's existing org, with neither enabled.
5. **Are trailerparkgroup.com and trailerpark.com staff in DBC's Okta, or in their own Microsoft tenant?** Recommended: in
   DBC's Okta. Otherwise, give us TPG's tenant ID.
6. **Who creates the Okta app and the Entra app registration, and in which tenant?** Recommended: DBC IT, in DBC's
   tenant, as described in [section 3](#3-sign-in-with-okta-and-microsoft).
7. **May Lobby store encrypted refresh tokens, to check hourly that people are still active?** Recommended: yes, with the
   key in Key Vault. The alternative needs admin-approved Graph and Okta API access.
8. **Which hostname?** Recommended: `lobby.darkburn.com`, plus `lobby-rehearsal.darkburn.com`.
9. **Who controls darkburn.com DNS, and is there a CAA record?** Recommended: IT adds the two `A` records and allows Let's
   Encrypt, or provides a DBC certificate.
10. **Which Azure subscription and region, and what rules apply (allowed regions, public IPs, required agents, tags,
    budgets)?** Recommended: DBC's production subscription, the region nearest the staff, a main VM with one public IP
    open only on 80/443 and a worker VM with no inbound ports.
11. **Is this design acceptable, or must it be AKS, or behind Front Door or a WAF?** Recommended: two VMs with Caddy on the
    main one. Front Door can't carry the event stream.
12. **Move the staging boards and accounts, or start fresh?** Recommended: move them (minutes of work), with a 7-day
    account-link window. Staging now holds the team's real work.
13. **Files: keep Cloudflare R2, or move everything into Azure Blob Storage?** Recommended: Azure Blob, so all DBC data
    sits in DBC's tenant. Use R2 only if go-live can't wait the 3–5 days, and then only in a DBC-owned Cloudflare
    account (opening one is a new vendor account, so it needs the owner's explicit OK). Either way the three file prefixes
    (`assets/`, `snapshots/`, `thumbnails/`) move together or stay together ([section 6](#6-moving-the-data)).
14. **Where do previews and file processing run after go-live: Chase's NAS or Azure, and on which VM?** Recommended: a
    separate small worker VM on Azure (B2als_v2, about $33.50 a month with its disk and IP), with the model file placed
    there. Retire the NAS worker a week after go-live. Keeping the NAS means publishing `/api/worker/*` on the public
    hostname and depending on the home network.
15. **Should invitations be emailed, or is a copy-and-send link enough at first?** Recommended: links at go-live, then
    email through Microsoft Graph from a DBC mailbox later.
16. **How does the owner sign in after Clerk, given that his personal exception address isn't a darkburn.com one?**
    Recommended: with his DBC Okta account. Keep the exception only for a personal Microsoft account registered with
    that address.
17. **Does Render staging keep running after go-live?** Recommended: no. Keep it suspended for 30 days as the rollback,
    then use `lobby-rehearsal.darkburn.com` as staging.
18. **Is a few minutes of downtime per monthly patch reboot, and about an hour to rebuild, acceptable?** Recommended:
    yes for a staff tool. Zone-redundant high availability would need a different sync design.
19. **Where does the code live after "transfer to our Azure servers": DBC's GitHub org, or Azure DevOps?** Recommended:
    DBC's GitHub org. GitHub Actions builds the images and deploys to the VMs. CI is manual-only today because of the free
    Actions minutes (`.github/workflows/ci.yml`); DBC's plan decides whether it runs on every push.
20. **Who gets alerts and who has deploy rights?** Recommended: DBC IT and Chase get the Azure Monitor alerts by email.
    Only the pipeline deploys.
21. **Pay-as-you-go or a 1-year VM reservation?** Recommended: pay-as-you-go for the first 2–3 months, then reserve once
    the VM sizes are confirmed.
22. **AI: keep calling OpenAI directly, or use DBC's Azure OpenAI?** Board content, meeting transcripts and (with
    `DRAFTROOM_AI_VISION=on`) photos go to the AI provider. Recommended: decide with DBC's data policy before go-live; the
    feature can be off (`DRAFTROOM_AI=off`) until then. Whether `OPENAI_BASE_URL` alone can point at Azure OpenAI is
    **UNVERIFIED** (Azure OpenAI's paths and key header differ), so Azure OpenAI may need a small adapter.
23. **Who may approve and place the model file on Azure?** Recommended: the owner approves (as on 2026-10-19), DBC's
    operator copies the same file from the NAS and checks its sha256.
24. **Per-workspace storage on Azure:** keep 5 GB (`DRAFTROOM_WORKSPACE_QUOTA_MB=5120`, set to stay inside R2's free
    tier) or raise it? Recommended: keep it at go-live and raise it when a team needs more (Blob storage costs about
    $0.02 per GB-month; UNVERIFIED for DBC's agreement).
25. **Chat hooks:** carry `DRAFTROOM_WEBHOOK_SECRET` over (hooks keep working), or let admins paste their hooks again?
    Recommended: carry it over as the previous key and rotate ([section 6](#the-secrets)).
26. **Outbound policy:** does DBC filter outbound traffic from Azure? If so, the hosts in
    [Outbound network](#outbound-network-egress) need rules; link previews need general outbound HTTPS. Recommended: allow
    outbound 443 from the main VM, and from the worker VM only to the file store.

---

## 9. What the owner's developers do vs. what Claude can do

The owner's split (2026-10-19). Claude works in the repository under `AGENTS.md`: it writes code, tests and docs, runs the
checks it can run locally and against fakes, and never touches DBC's tenants, secrets or production.

| Work | Who | Notes |
|---|---|---|
| The OIDC provider code: `apps/api/src/auth/oidc.ts`, config, migration `0040`, the multi-source creator lookup, refresh-token storage, the legacy link window and dry run, the sign-in page, Clerk removal, the invitation path without Clerk | **Claude** | Built against the existing `AuthProvider` seam ([section 3](#how-it-will-work)); the migration and lockfile changes serialized. |
| Its tests against a fake IdP: fake Okta and Microsoft servers (discovery, JWKS, token, userinfo, refresh, revoke) for the api tests and the e2e stack, including the trust rules (`xms_edov`, `acct`, listed tenants, the personal-account tenant, `+clerk_test`) | **Claude** | The real tenants are never called by a test. |
| The CSP and config changes: the single-origin CSP, the Caddy config and header file, `__Host-` cookies, the smoke script and CSP harness for one origin, the worker compose changes, `.env.example` and the new `docs/DEPLOY-AZURE.md` | **Claude** | Checked with `csp:cutover`, `excalidraw:prod` and the smoke script's own tests. |
| The Okta app integrations and the Entra app registrations (production and rehearsal), their credentials, optional claims and `removeUnverifiedEmailClaim` | **DBC** | [Section 3](#what-to-set-up-in-okta-dbc-it). Claude cannot and must not do these. |
| Azure provisioning: subscription, VNet, both VMs, disks, Postgres, Key Vault, storage, registry, monitoring and alerts | **DBC** | Claude can draft the Bicep or Terraform files for DBC to review and run; running them is DBC's. |
| DNS records and certificates on darkburn.com | **DBC** | [Section 4](#4-domain-and-dns). |
| Secrets: generating, storing and carrying them (including the webhook secret and the backup verification secrets), and placing the model file | **DBC** | Values never pass through chat or git. |
| Real-tenant checks: Okta and Microsoft test users, a disabled user, a personal Microsoft account, a locked-down tenant | **DBC** (with the owner) | Claude writes the checklist and reads the results. |
| Running the rehearsal and the cut-over | **DBC** | Claude prepares the runbook and the verification scripts, and reviews the evidence. |
| Not assigned yet: the Azure Blob driver, the deploy pipeline, the invitation email sender | either | A decision for the owner; each fits the "code in the repo" side. |

---

## Sources

Microsoft, Okta and other external pages: read 2026-10-05 unless noted, not re-read for the 2026-10-19 refresh. Prices
added in the refresh: Azure Retail Prices API, 2026-10-19.

**Microsoft (Azure):**

- Managed disks: <https://learn.microsoft.com/en-us/azure/virtual-machines/managed-disks-overview>
- AKS with Azure Disk: <https://learn.microsoft.com/en-us/azure/aks/create-volume-azure-disk>
- Container Apps storage: <https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts>
- App Service storage mounts (SQLite warning): <https://learn.microsoft.com/en-us/azure/app-service/configure-connect-to-azure-storage>
- Container Instances with Azure Files: <https://learn.microsoft.com/en-us/azure/container-instances/container-instances-volume-azure-files>
- Front Door WebSocket and SSE: <https://learn.microsoft.com/en-us/azure/frontdoor/standard-premium/websocket>
- Static Web Apps API limits: <https://learn.microsoft.com/en-us/azure/static-web-apps/apis-overview>
- Application Gateway and SSE: <https://learn.microsoft.com/en-us/azure/application-gateway/use-server-sent-events>
- Public IP idle timeout: <https://learn.microsoft.com/en-us/azure/virtual-network/ip-services/public-ip-addresses>
- B-series v2 VMs: <https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/bsv2-series>
- Disk Backup: <https://learn.microsoft.com/en-us/azure/backup/disk-backup-overview>
- PostgreSQL versions: <https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/concepts-supported-versions>
- PostgreSQL backup and restore: <https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore>
- PostgreSQL TLS: <https://learn.microsoft.com/en-us/azure/postgresql/security/security-tls-how-to-connect>
- Blob SAS: <https://learn.microsoft.com/en-us/azure/storage/common/storage-sas-overview>
- Put Blob size limit: <https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob>
- Retail prices (East US 2): <https://prices.azure.com/api/retail/prices>

**Microsoft (identity):**

- Publisher verification and consent: <https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview>
- ID token claims: <https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference>
- Optional claims, including `xms_edov`: <https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference>
- Auth code flow: <https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow>
- Refresh tokens: <https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens>
- `removeUnverifiedEmailClaim`: <https://learn.microsoft.com/en-us/graph/api/resources/authenticationbehaviors?view=graph-rest-beta>
- Personal-account sign-up block on verified domains: <https://techcommunity.microsoft.com/blog/microsoft-entra-blog/cleaning-up-the-azuread-and-microsoft-account-overlap/245105>

**Okta:**

- Authorization servers: <https://developer.okta.com/docs/concepts/auth-servers/>
- Refresh tokens: <https://developer.okta.com/docs/guides/refresh-tokens/main/>
- Auth code with PKCE: <https://developer.okta.com/docs/guides/implement-grant-type/authcodepkce/main/>
- Microsoft as a social login: <https://developer.okta.com/docs/guides/social-login/microsoft/main/>

**Others:**

- CSP `connect-src` and WebSocket schemes: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src>
- Caddy reverse proxy: <https://caddyserver.com/docs/caddyfile/directives/reverse_proxy>
- SQLite WAL: <https://www.sqlite.org/wal.html>
- `openid-client` on npm: <https://registry.npmjs.org/openid-client/latest>

**Repo (read at `e1942f75`):**

- Configuration and sign-in: `apps/api/src/config.ts`, `apps/api/src/app.ts` (`defaultProvider`),
  `apps/api/src/auth/{provider,identity,session,users,creator-sql,creators,clerk,email,google-id-token}.ts`,
  `apps/api/src/features/dashboard/{email-invites,clerk-directory}.ts`, `packages/contracts/src/{index,domain-access}.ts`,
  `packages/db/migrations/0025_open_signin.sql`
- Live connections: `apps/api/src/events/routes.ts`, `apps/web/src/board/ticket.ts`,
  `apps/web/src/canvas/sync/transport/socket.ts`
- Egress: `apps/api/src/egress/rules.ts`, `packages/contracts/src/{miro-import,chat-hooks}.ts`,
  `apps/api/src/features/link-preview/fetch.ts`, `apps/api/src/features/ai/config.ts`, `apps/api/src/crypto/sealed.ts`
- Worker: `apps/worker/src/ops/{capabilities,bg-model}.ts`, `apps/worker/models/MODELS.json`, `apps/worker/src/config.ts`,
  `packages/contracts/src/formats.ts`, `deploy/nas/worker/docker-compose.yml`, `deploy/nas/README.md`
- Storage and backups: `packages/blob-store/src/r2-store.ts`, `apps/sync/src/backup/*`,
  `apps/api/src/features/history/checkpoint-all-cli.ts`, `apps/api/src/features/backup/restore.ts`
- Deployment: `docker/*`, `deploy/nas/theater/{nginx.conf,README.md}`, `render.yaml`, `scripts/smoke/live-smoke.mjs`
- Rehearsal tools: `docs/research/excalidraw/rehearsal/*`
- Docs: `docs/DEPLOY.md`, `docs/PROGRESS.md`, `docs/EXCALIDRAW-CUTOVER.md`, `docs/CUTOVER-LOG.md`,
  `docs/DOMAIN-ACCESS-CONTRACTS.md`, `docs/WAVE-R-CONTRACTS.md`, `docs/WAVE-W-CONTRACTS.md`, `AGENTS.md`
