# Lobby go-live on DBC's Azure (plan)

**Status: plan only.** Written 2026-10-05 from `main` at `bdb35b42`. Nothing in this document has been built, provisioned
or tested on Azure. When something is marked **UNVERIFIED**, the text says what would verify it. The Microsoft and Okta
facts were read on 2026-10-05 from the pages linked next to them (full list in [Sources](#sources)). The document was then
reviewed against the code and the cited pages the same day; where a page does not state a claim, the claim is marked
UNVERIFIED instead of being left as fact.

**Nothing here is approved.** The owner has decided the direction only (the list below). No Azure resource, DNS record,
Okta or Entra app, rehearsal or cut-over is approved by this plan, and no spend is. Each of those needs the owner's explicit
yes in chat (and DBC IT's own approvals where it is DBC's tenant). Earlier approvals (for example the 2026-10-01 rehearsal
dump from Render Postgres) covered only what they named and do not carry over.

**Who this is for:** Chase (the owner), and whoever runs DBC's Azure, Okta and DNS.

**Related docs:**

- `docs/DEPLOY.md`: today's staging on Render.
- `docs/EXCALIDRAW-CUTOVER.md`: the runbook pattern this plan reuses.
- `docs/DOMAIN-ACCESS-CONTRACTS.md`: who may create boards.

**The owner's decision (2026-10-05):**

- Production moves to DBC's Azure, on the darkburn.com domain.
- Sign-in is through Okta and Microsoft accounts ("MSA").
- Fewer than 100 people: DBC staff plus invited outside reviewers.

---

## 1. What changes and why

Today Lobby runs as staging on Render. Sign-in goes through Clerk, files sit in Cloudflare R2, and file previews are made
on Chase's NAS. For go-live, Lobby moves into DBC's own Azure, at one darkburn.com address (we suggest
`lobby.darkburn.com`). Staff sign in with Okta. Outside reviewers sign in with a Microsoft account. The board engine,
live sync, backups and permissions stay as they are. Three things change:

- **Where it runs.** One Azure virtual machine, plus Azure's managed Postgres. Lobby's board files need a real disk
  attached to one machine, and a VM is the simplest Azure option that gives one.
- **The address.** One darkburn.com hostname serves everything. That lets us remove two workarounds that only exist
  because of Render.
- **Sign-in.** Clerk is replaced by Okta and Microsoft. This is the only part that needs substantial new code: about
  2.5 to 3 weeks of work for one engineer (an estimate, not measured).

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
  api keeps its event hub and rate limits in memory. So: no autoscaling, and no blue/green deploys that would run two
  sync servers against one disk.

**(b) The live connections must pass through without buffering.**

- Lobby keeps two long-lived connections per open board:
  - the board **WebSocket** (`/connect/<board>`, for edits and cursors);
  - the board **event stream** (Server-Sent Events, SSE, under `/api/...`, for votes, timers, comments and access
    changes).
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
    WebSocket. The NAS rehearsal edge served sync on its own port (`docs/research/excalidraw/rehearsal/edge.mjs`), so
    `/connect/*` on the same hostname as the page has not been exercised anywhere yet.

**A design rule that follows from the code: one origin.**

- The session cookie is host-only and `SameSite=Lax` (`apps/api/src/auth/session.ts`), and the api has no general CORS.
  So the page, `/api/*`, `/files/*` and `/connect/*` must all be served from the same hostname.
- That also retires the two Render workarounds, `VITE_DRAFTROOM_SYNC_ORIGIN` and `DRAFTROOM_EVENTS_ORIGIN`. Once they are
  unset, the code already falls back to the page's own origin (`apps/web/src/board/ticket.ts`,
  `apps/api/src/events/routes.ts`).

### The setup

| Part | Azure service | Why |
|---|---|---|
| Front end: HTTPS, the web page, routing | **Caddy** container on the VM: the only thing listening on ports 80/443 | Automatic HTTPS. Streams SSE and WebSockets as Caddy documents (**UNVERIFIED** here, see above). Serves the built page itself, including `/excalidraw-assets/*` (a miss is a hard 404, not a fallback to `index.html`). Proxies only an allow-list: `/api/*` and `/files/*` go to the api, `/connect/*` goes to sync. `/internal/*` and `/healthz` are never published. `/api/worker/*` is published only if the NAS worker is kept ([question 14](#8-open-questions-for-chase--it)); with the worker on the VM it uses the compose network, so Caddy blocks it. |
| api | container on the VM (`docker/api.Dockerfile`, unchanged) | No disk of its own: its state lives in Postgres and blob storage. Exactly one instance. |
| sync (live boards) | container on the VM (`docker/sync.Dockerfile`, unchanged). Its data folder is a separate **64 GiB Premium SSD managed disk** (P6), ext4, host caching **None**, mounted at `/srv/lobby` and bind-mounted as `/var/data` | Meets constraint (a): block storage attached to one machine, never a share. Exactly one container. **Mount guard (a design requirement, UNVERIFIED until rehearsed):** mount by UUID and start the sync container only when `/srv/lobby` really is the disk (for example a systemd `RequiresMountsFor=/srv/lobby` unit), and make the empty mount point immutable (`chattr +i`). Otherwise a failed mount lets Docker create an empty folder on the OS disk and sync starts with no boards (`docker/entrypoint.sh` only creates and chowns the directory; nothing checks it is the disk). |
| Preview worker + Office sidecar | containers on the VM (the NAS compose file `deploy/nas/worker/docker-compose.yml`, reused) | Removes the dependency on Chase's NAS. That file sets the worker to `cpus: 3` and the Office sidecar to `cpus: 2`; the VM has 2 vCPUs, so **both** must be lowered to **1** or less, or conversions can starve sync. The sidecar keeps `network_mode: none`. |
| Postgres | **Azure Database for PostgreSQL Flexible Server**, PostgreSQL 18, Burstable B1ms, 32 GiB, 35-day point-in-time restore, **private access (VNet)** | PostgreSQL 18 is supported, current minor 18.6 (<https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/concepts-supported-versions>), the same version the api tests passed against. No extensions are needed. Public vs private access **cannot be changed after creation**. |
| Files (uploads, previews) | **Azure Blob Storage**, Hot LRS (new driver, [section 5](#bigger-code)), or keep Cloudflare R2 at first | Keeps DBC files in DBC's tenant. About $2 a month. |
| Offsite board backups | a **separate** storage account or container with its own identity, **new and empty** (needs the Azure driver, [section 5](#bigger-code); until it exists, a new R2 bucket) | The api must not be able to delete backups (`docs/DEPLOY.md` "Separate backup bucket and token"). Never Render's bucket: the key prefix `backups/sync` is fixed in code (`OFFSITE_PREFIX`, `apps/sync/src/backup/store.ts`), so two syncs on one bucket would share the manifests of the same board ids, and the 90-day held set would stop being read-only. |
| Secrets | **Key Vault**, read by the VM's managed identity into a `0600` env file at deploy time | No secrets in git or in images. |
| Container images | **Azure Container Registry** Basic (or GitHub's free registry) | Builds come from a pipeline, not from the VM. |
| Network | one VNet, a static Standard public IP, a network security group that allows only 80/443 from the internet; SSH limited to DBC IPs, just-in-time access or Entra login | The VM is closed by default. |
| Disk safety net | **Azure Disk Backup** snapshots of the data disk (hourly or daily) | A fast whole-disk rollback. These snapshots are crash-consistent, so Lobby's own signed backups stay the primary board backup. |
| Monitoring | Azure Monitor alerts: VM CPU credits, disk latency and free space, Postgres CPU and storage, and the api and sync `/healthz`, probed from inside the VM (Caddy does not publish them) | Someone at DBC gets told when something breaks. |

```
browser --HTTPS--> lobby.darkburn.com (static public IP)
                     |
                     |  one Azure VM (B2s_v2), docker compose:
                     v
                   caddy --/api/*, /files/*--> api  --> Postgres (Flexible Server, private)
                     |                              --> Blob Storage (files)
                     +----/connect/*---------> sync --> /var/data (Premium SSD managed disk)
                                                    --> backup storage (signed copies)
                   worker --> api (private network)
                   office sidecar (no network at all)
```

### Size: why one small VM is enough

- **Measured on the NAS** (`docs/EXCALIDRAW-MIGRATION.md` 2.13, `docs/research/excalidraw/spike-b/B9.md`):
  - 260 concurrent sessions on 0.5 CPU and 512 MB;
  - sync memory at most 147 MB (310 MB with the conversion worker);
  - about 0.3 of a CPU on average (mean 62% of the 0.5 CPU quota).
- That test was a **mixed** result, not a clean pass: memory and acknowledgement latency met their targets, but the server
  event-loop p99 (56 to 115 ms against a 50 ms target) and the CPU windows (maximum 92%, restart and conversion windows
  over 97% of the quota) were missed. It is still a stress test of 260 sessions on half a CPU, so
  under 100 people on a 2-vCPU VM should be well below that load; the claim is an expectation, not a measurement on Azure.
- **Recommended VM:** `Standard_B2s_v2`, with 2 vCPU, 8 GiB and Ubuntu LTS, running Docker Engine and compose.
- **Two caveats**, both **UNVERIFIED**:
  - **CPU credits.** B-series VMs run at a 40% baseline on burst credits. A heavy day of PDF and video previews could use
    the credits up. A credit-balance alert would show it; if it happens, move to a D-series VM.
  - **Disk speed.** A P6 disk has a small guaranteed IOPS figure, with bursting. Measure SQLite commit times on the Azure
    disk with the repo's L1/L2 load harness before sign-off. The NAS baseline is a commit p99 of 10.8 ms. A larger disk
    is an online resize away.

### Rough monthly cost

**Not approved.** This is an estimate for the owner and DBC IT to decide on. Nothing is provisioned, and nothing here
authorises spend; the rehearsal VM (the same size, kept for a few days) would add a few dollars on top.

**Pricing basis:** Azure retail list prices for East US 2, pay-as-you-go, from the Azure Retail Prices API on
2026-10-05 (the VM, the P6 disk, Postgres B1ms compute and Application Gateway lines were re-read on review; the rest are
as first written). **UNVERIFIED for DBC:** check them in the Azure Pricing Calculator under DBC's own agreement and region.

| Item | Per month |
|---|---|
| VM B2s_v2 | $60.74 |
| OS disk P6 (64 GiB) | $9.28 |
| Data disk P6 (64 GiB) | $9.28 |
| Disk snapshots | about $1 |
| Static public IP | $3.65 |
| Postgres B1ms + 32 GiB storage | $12.41 + $3.68 |
| Blob storage for files and backups (about 100 GB) | about $2–4 (R2 stays $0 inside its free tier) |
| Key Vault, monitoring, container registry | about $0–10 |
| Internet egress (first 100 GB free) | $0 at this size |
| **Total** | **about $100–115** |

- **Savings:**
  - A 1-year VM reservation takes off roughly $25 a month (not checked against the price API).
  - A leaner variant (a 4 GiB VM, Postgres in a container on the data disk) is about $55–65, but loses managed
    point-in-time restore.
- **For comparison**, Render staging today is about $20–27 a month (`docs/DEPLOY.md` "Cost"). Azure costs more mainly
  for the managed database, the Premium disks and a VM with room for the preview worker.

### What DBC IT takes on

- One VM is a single point of failure. OS patches, Docker updates and reboots are DBC's job.
- Plan a monthly reboot window of a few minutes. Open boards reconnect by themselves: all 260 sessions came back in
  about 5 to 8 s after a forced restart on the NAS (5.0–7.6 s across the B9 runs, `docs/PROGRESS.md`).
- The time to rebuild from a disk snapshot is **UNVERIFIED** (estimated about an hour). Rehearse it once on a scratch VM.

### Alternatives considered

- **AKS** (one node, Azure Disk volume for sync): works, about $130–160 a month. Worth it only if DBC already runs AKS.
- **Container Apps or App Service for the api, plus a VM for sync**: no gain. You would need two hostnames, or an
  Application Gateway, and sync still needs the VM.
- **Front Door or a WAF in front of the VM**: WebSockets would work, but the event stream would not. You would need a
  second hostname that bypasses Front Door (the wave-H `DRAFTROOM_EVENTS_ORIGIN` mechanism), plus Front Door's fixed fee.
  Only if DBC policy requires it.
- **Static Web Apps**: rejected (no WebSockets, 45-second limit).

---

## 3. Sign-in with Okta and Microsoft

### How it will work

- **Two buttons on the sign-in page:** "DBC staff: sign in with Okta" and "Guests and reviewers: sign in with
  Microsoft".
- **The flow:**
  1. Clicking a button goes to Okta or Microsoft (a plain redirect that carries `state`, a `nonce` and a PKCE challenge).
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
  - A refresh that proves the account is gone or disabled ends all of that person's Lobby sessions. A provider answer that
    is merely an expired token (Okta: unused for 7 days; Microsoft: 90 days) is not proof of that, so it sends the person
    through sign-in again instead.
  - Creator rights lapse when the stored address is older than 24 hours and cannot be confirmed. That is the "within 24
    hours" bound: it applies to creator status, not to boards a person was invited to.
  - Removing a leaver from workspaces is still the manual offboarding step in `docs/DOMAIN-ACCESS-CONTRACTS.md` §13 (a
    disabled account is not removed from boards by itself).
  - **UNVERIFIED:** that a disabled or deleted account's refresh token is refused (expected as `invalid_grant`; the
    pages read do not say), and that Okta's *org* authorization server issues refresh tokens for this app type (the
    Okta refresh-token guide does not state it). Both need a test with a real disabled user in each tenant. If the org
    server issues none, the fallback is a shorter Lobby session plus a silent re-authentication (`prompt=none`) instead.
  - Microsoft replaces the refresh token on every use (<https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens>),
    so Lobby must store the new one each time and discard the old.
- **Name-only guests** (workshop and review links) need no sign-in and work exactly as today: they are created and given
  their session by the invitation code (`apps/api/src/features/guests/join.ts`), which does not use the sign-in provider,
  so removing Clerk does not touch them.
- **One person, two sign-in buttons, two accounts.** Accounts are keyed by provider and subject
  (`apps/api/src/auth/users.ts`). Someone who signs in with Okta once and Microsoft another time gets two separate Lobby
  accounts, and there is no merge by email (matching by email is unsafe, see below). Tell staff to use only the Okta
  button; a manual identity-link step is a decision for the owner if it turns out to be needed.
- **Under the hood:** this is a new sign-in adapter, behind the existing `AuthProvider` seam in
  `apps/api/src/auth/provider.ts`. It replaces the Clerk adapter, and the session, permission and domain-access code stays
  as it is ([section 5](#bigger-code)).

### Who can do what

"Creator" means someone who may create workspaces and boards. Everyone else sees only what they are invited to.

| Person | Signs in with | Becomes |
|---|---|---|
| DBC or Trailer Park Group staff | Okta | **Creator**: a verified `darkburn.com`, `trailerparkgroup.com` or `trailerpark.com` address from DBC's Okta |
| DBC staff using their Microsoft work account | Microsoft | **Creator** only if DBC IT lists DBC's tenant ID, the person is a member (not a guest) of that tenant, and Microsoft marks the email's domain as verified (`xms_edov` = true) |
| Outside reviewer with a work Microsoft account | Microsoft | **Invited outsider**: sees only what they are invited to. Email-locked invitations match their verified address. |
| Outside reviewer with a personal Microsoft account (outlook.com, or one created with any email address) | Microsoft | **Invited outsider**. Whether an email-locked invitation can match a personal account is **UNVERIFIED**, see below. |
| A personal Microsoft account that shows an `@darkburn.com` address | Microsoft | **Never a creator**, only an outsider. Old personal accounts with company addresses exist, for example a leaver's. |
| Someone on the exceptions list (`DRAFTROOM_CREATOR_EMAILS`) | either | **Creator**, by exact verified address |
| Workshop or review guest | no sign-in (link) | **Name-only guest**, unchanged |

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
which protects against one provider's answer being passed off as the other's.

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
| Okta | `name` | display name |
| Microsoft | `tid` + `sub` | the permanent account key |
| Microsoft | `oid` | stored for a future remap; never used to sign in |
| Microsoft | `iss` | must match the `tid` in the token |
| Microsoft | `email` + `xms_edov` | the verified address, stored only when `xms_edov` is true |
| Microsoft | `acct` | 0 = tenant member, 1 = guest; only members of a listed tenant count toward company-domain creator status |
| Microsoft | `name` | display name |

Scopes requested: `openid profile email offline_access`. No profile photos, so no Graph call.

### Moving existing users

- **Everyone signs in once more.** The address changes, and cookies don't move between hostnames.
- **Staging holds very little.** At the 2026-10-01 cut-over there was 1 real account (plus a throwaway guest) and
  1 workspace. To keep that account's boards and memberships, the new code links a first Okta or Microsoft sign-in to
  the existing account. It does this only inside a short dated window (`DRAFTROOM_LEGACY_LINK_UNTIL`, for example
  7 days), and only when all of these hold:
  - exactly one existing account has the same verified address;
  - that account has no identity for this provider yet;
  - the address comes from a trusted source (Okta, or a listed DBC tenant for company addresses).
- **A dry-run script runs first.** It lists what would be linked, showing domains only, and an operator reviews it.
- Ambiguous or missing matches create a new account. After the window, the Clerk rows and all Clerk code are removed.
- **Without this step**, every existing person's first sign-in creates a new, empty account, because accounts are looked
  up by provider and subject only (`apps/api/src/auth/users.ts`).
- **Starting fresh** is a real option too ([question 12](#8-open-questions-for-chase--it)).
- **Old links break.** Invitation, guest and workshop links shared from the `onrender.com` address stop working when
  Render is retired. A redirect on the old Render site can carry them over
  ([section 7](#switch)), or they can be re-issued.

---

## 4. Domain and DNS

**Hostnames:**

| Hostname | Points to | Record |
|---|---|---|
| `lobby.darkburn.com` | the production VM's static public IP | `A`, TTL 300 seconds around the cut-over (can be raised afterwards) |
| `lobby-rehearsal.darkburn.com` | a rehearsal VM (deleted after the rehearsal, or kept as staging) | `A` |

- **darkburn.com's DNS doesn't need to move into Azure.** One record per hostname in the current DNS is enough. An Azure
  DNS zone would cost $0.50 a month if DBC wants one.
- **HTTPS certificates:**
  - **Caddy gets and renews them by itself**, from Let's Encrypt. This needs two things: the `A` record must exist and
    ports 80 and 443 must be open before the first start, and any CAA record on darkburn.com must allow
    `letsencrypt.org` (**UNVERIFIED**: the CAA records haven't been checked).
  - **Or DBC supplies its own certificate**, for example a wildcard, from Key Vault. Renewal is then DBC's job.
- **Security headers stay as on Render.** Caddy sends the same set as today (`render.yaml` headers), and adds
  `Strict-Transport-Security` with a 1-year max-age itself (Render's edge used to add it), **without** `includeSubDomains`
  or `preload`: darkburn.com is a shared company domain and this must not change the rules for its other sites. It applies
  the headers **only to the page's own files**, as Render does. The api's `/files` answers keep their own stricter policy.
- **The page's security policy gets shorter.** Every Clerk and Cloudflare entry goes, and so do the separate api and
  sync hosts:

  ```
  default-src 'self'; script-src 'self'; connect-src 'self' blob: wss://lobby.darkburn.com;
  img-src 'self' blob: data:; font-src 'self'; style-src 'self' 'unsafe-inline';
  worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self';
  form-action 'self'; frame-ancestors 'none'
  ```

  The board WebSocket is named explicitly (`wss://lobby.darkburn.com`, as today's policy names the sync host) rather than
  left to `'self'`: MDN notes that `connect-src 'self'` does not resolve to WebSocket schemes in all browsers
  (<https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src>; WebKit
  bug 201591 is one such case), and only one smoke spec runs on WebKit and Firefox (`e2e/playwright.config.ts`; the rest of
  the suite is Chromium). **UNVERIFIED** for this build: the enforced-CSP
  production test (`e2e/excalidraw-builds/prod-build.spec.ts`) must show zero violations, and a board must be opened in
  Safari under the enforced header before sign-off.
- **Cookie protection on a shared company domain.** Any other `*.darkburn.com` site could set a cookie that Lobby would
  read. So in production Lobby's cookies get the `__Host-` prefix, which browsers refuse to let other subdomains set
  (a small code change, [section 5](#small-code-new-files-or-small-edits)).
- **Later: invitation email.** If Lobby ever sends invitation email from a darkburn.com address, that needs the usual
  mail records (SPF and DKIM). It is not part of go-live ([question 15](#8-open-questions-for-chase--it)).

---

## 5. What changes in the code

All estimates are for one engineer and are **UNVERIFIED** (not measured). The sync engine, the canvas, permissions,
board tickets, the worker protocol, the backup and restore tools, and the AI feature don't change.

### Config only

| Setting | Azure value |
|---|---|
| `PUBLIC_ORIGIN` (api), `ALLOWED_ORIGINS` (sync) | `https://lobby.darkburn.com`, exactly |
| `PORT` | set explicitly per service. Render injected it; the images don't. |
| `DATABASE_URL` | the Flexible Server URL with `?sslmode=verify-full`. If Node's built-in roots don't accept Azure's chain, add `NODE_EXTRA_CA_CERTS` with Microsoft RSA Root CA 2017 and DigiCert Global Root G2 (<https://learn.microsoft.com/en-us/azure/postgresql/security/security-tls-how-to-connect>). **UNVERIFIED** until a test connection. |
| `DRAFTROOM_SYNC_INTERNAL_URL`, `DRAFTROOM_API_INTERNAL_URL` | `http://sync:<port>`, `http://api:<port>` on the compose network |
| `TRUST_PROXY` | `1` (Caddy is the one proxy), instead of Render's `3`. **UNVERIFIED** until the two-network test in `docs/DEPLOY.md` "Client IPs" passes. |
| `DRAFTROOM_EVENTS_ORIGIN`, `VITE_DRAFTROOM_SYNC_ORIGIN` | **unset**: no longer needed on one origin |
| `VITE_TLDRAW_LICENSE_KEY` | removed (unused since the Excalidraw cut-over) |
| `DRAFTROOM_DATA_DIR` | sync: `/var/data` on the managed disk; api: a scratch path |
| `AUTH_PROVIDER` + the new Okta/Microsoft variables | once the sign-in code exists |
| `DRAFTROOM_CREATOR_DOMAINS` | default (`darkburn.com,trailerparkgroup.com,trailerpark.com`) |
| `DRAFTROOM_CREATOR_EMAILS` | in Key Vault only, never in git |
| Blob and backup store | files: `R2_*` carried over, or the new Azure values. Backups: `DRAFTROOM_BACKUP_STORE` with its **own new** bucket and credentials (`DRAFTROOM_BACKUP_R2_*` until the Azure driver exists), never Render's bucket |
| Worker | `DRAFTROOM_API_URL=http://api:<port>`, a new `DRAFTROOM_WORKER_TOKEN` and `WORKER_ID` |
| `OPENAI_*` | unchanged |

Size: about a day, including the `TRUST_PROXY` measurement.

### Small code (new files or small edits)

| Item | Size |
|---|---|
| Caddy config. Covers: the page with fallback to `index.html`, a hard 404 for missing `/excalidraw-assets/*`, the proxy allow-list, headers, CSP, HSTS, and `stream_close_delay` so a config reload doesn't drop open WebSockets (Caddy's docs name WebSockets; whether event streams survive a reload is not stated). Also: **no `encode` (compression) on `/api/*` or `/connect/*`** (the api sends `no-transform` for a reason, `apps/api/src/events/routes.ts`), and **no access-log line may carry a query string or the `Sec-WebSocket-Protocol` header**, because board tickets travel there (AGENTS.md: never log session tokens or private content; the NAS edge logged method, path prefix and status only). The NAS rehearsal edge (`docs/research/excalidraw/rehearsal/edge.mjs`) is the model for the routing, but it served sync on a separate port. | 0.5–1 day |
| A web image (or build stage) and a compose file for the VM. Includes health checks with `node -e fetch(...)` (the images have no curl), log rotation 10 MB × 3, and a pinned Caddy version and digest. | 1 day |
| One checked-in header file read by Caddy, the smoke test and the e2e CSP harness, so they can't drift (today `render.yaml` is the source). Also: adapt `scripts/smoke/live-smoke.mjs` to one origin. Dropping the Clerk allowances is the smaller part: it derives `<name>-api` and `<name>-sync` hosts from `--base`, checks that `connect-src` names the api and sync origins literally, probes `/healthz` on both (Caddy does not publish it), reads the expected headers from `render.yaml`, and only reports the stream through the web origin as information (the strict first-byte check is on the api origin). | 1 day (likely more) |
| Infrastructure as code (Bicep or Terraform): VM, disks, IP, network security group, Postgres, Key Vault, storage | 1–2 days |
| Deploy pipeline: GitHub Actions builds the images, pushes them to the registry, then runs compose on the VM in the order api, sync, web, as in `docs/DEPLOY.md` | 1–2 days |
| `__Host-` cookie prefix in production, with tests (the name lives in `SESSION_COOKIE`, but about 35 files, mostly tests and e2e helpers, write `dr_session` literally; the prefix also needs `Secure`, `Path=/` and no `Domain`, which the cookie already has) | 0.5–1 day |
| Add the Azure and Okta secret names to the worker and sidecar deny-lists (`apps/worker/src/env.ts`, `office-sidecar.ts`) | 1 hour |
| Docs: a new `docs/DEPLOY-AZURE.md`, `.env.example`, README, `PROGRESS.md`; mark the Render-era comments in `docker/*` as history | 1 day |

Subtotal: about 6–9 days.

### Bigger code

| Item | Size |
|---|---|
| **Okta and Microsoft sign-in, replacing Clerk.** | **12–14 days** |
| **Azure Blob storage driver**, only if files leave Cloudflare | **3–5 days** |
| Invitation email sender (optional, after go-live) | 2–3 days |

**Okta and Microsoft sign-in (12–14 days)** covers:

- a new `apps/api/src/auth/oidc.ts` using the `openid-client` library (MIT licence; 6.8.8 is the latest on npm as of 2026-10-05, to be
  pinned exactly in the catalog);
- migration `0025`, which allows the new provider names (both `identities.provider` and `user_emails.source` have CHECK
  constraints that list only `dev` and `clerk` today) and adds the identity columns and a sign-in transaction table;
- creator status from several providers, with the trust rule from [section 3](#who-can-do-what), in
  `apps/api/src/auth/creator-sql.ts`;
- encrypted refresh tokens for the hourly check;
- the legacy link window and its dry-run script;
- a new sign-in page;
- an invitation lookup that no longer depends on Clerk;
- removal of both Clerk packages, in one serialized lockfile change;
- mock Okta and Microsoft servers for the e2e tests;
- checks against real test tenants;
- the repo's independent security review.

It needs DBC IT's app registrations before the last steps.

**Azure Blob storage driver (3–5 days)** covers:

- a new `packages/blob-store` driver next to `r2-store.ts`, plus config;
- offsite backups to Azure;
- a check after each worker upload: an Azure upload link can't pin a file's type and size the way R2's can;
- tests: the shared `packages/blob-store/test/suite.ts`, a local emulator (Azurite), and one live run.

Until it exists, files stay on R2.

**Invitation email sender (2–3 days, optional).** Without Clerk, "invite by email" gives the inviter a link to send
themselves. Sending the email would go through Microsoft Graph from a DBC mailbox, or Azure Communication Services
Email.

### Total and order

- **Total:** about **24–32 engineer-days** for config, small code, sign-in, the Azure Blob driver, the rehearsal and the
  cut-over (an estimate).
- **Order:**
  1. Answer the open questions.
  2. Build sign-in, the Blob driver and the Azure infrastructure in parallel, each with its own files. The changes to
     shared schemas and to the lockfile are made one after another.
  3. Rehearse.
  4. Cut over.

---

## 6. Moving the data

**What there is to move:**

| What | Where today | How it moves |
|---|---|---|
| People and their sign-in identities (`users`, `identities`, `user_emails`, `sessions`), workspaces, the board list, permissions, invitations and link tokens, comments, the history rows (`board_snapshots`), asset records, the search index | Render Postgres 18 | `pg_dump` → `pg_restore` |
| Board content (one SQLite file per board, WAL mode), trashed boards included | Render sync disk, `rooms/` | through the signed offsite backups, then the restore tools. Those backups are made with SQLite's online-backup API on the live connection, so the `-wal` content is inside the copy (`apps/sync/src/backup/backup.ts`). Never copy a live `.sqlite` file by hand |
| File bytes: uploads and previews (`assets/`), the **history checkpoint bodies** (`snapshots/<board>/<id>.json`, the restore points) and the **board thumbnails** (`thumbnails/<workspace>/<board>/<version>`) | R2 bucket | nothing to move if R2 stays; otherwise a key-for-key copy of **all three prefixes**. The Postgres rows only hold these keys: a copy of `assets/` alone would leave every checkpoint and thumbnail pointing at nothing |
| Old offsite backups, including the 90-day disaster set held until 2026-12-30 | R2, `backups/sync/` | not copied: kept read-only in R2 until the hold ends |
| Two secrets that verify the old backups: `DRAFTROOM_INTERNAL_SECRET`, `DRAFTROOM_BACKUP_SIGNING_SECRET` | Render | copied into Key Vault (never printed or committed), used only by the one-off restore commands below and later to read the old held set |

**How much:** 4 real boards and 2 trashed test boards, 1 workspace and about 1 real account (`docs/CUTOVER-LOG.md`).
Every step below takes minutes.

**The secrets:**

- Generate **new** production values on Azure for `DRAFTROOM_TICKET_SECRET`, `DRAFTROOM_INTERNAL_SECRET`,
  `DRAFTROOM_BACKUP_SIGNING_SECRET` and `DRAFTROOM_WORKER_TOKEN`, so that Render's values die with Render, plus the
  refresh-token encryption key and the Okta and Microsoft credentials. The two **old** values above are kept only to verify
  Render's backups.
- The four Lobby secrets must stay different from each other and at least 32 characters long (the code requires the ticket,
  internal and backup-signing secrets to differ from one another and the worker token to differ from the first two:
  `apps/api/src/config.ts`, `apps/sync/src/config.ts`).

**Recommended: move the data rather than start fresh.** It keeps the 4 real boards and their history, and the same tools
have already done this once (the NAS dress rehearsal, `docs/research/excalidraw/rehearsal/`).

**Recommended timing: after drop-legacy** (due about 2026-10-08 and needing the owner's OK, `docs/CUTOVER-LOG.md`), so the
copied board files no longer carry the old tldraw tables.

### Step by step

The commands are the existing ones from `docs/DEPLOY.md` "Backups" and `docs/EXCALIDRAW-CUTOVER.md` C4–C6.

1. **Copy most of the files early** (only if files move to Azure). The day before, copy the R2 prefixes `assets/`,
   `snapshots/` and `thumbnails/` key-for-key into the Azure files container (not `backups/`). A bulk copier such as rclone
   can do it (**UNVERIFIED**: the tool hasn't been tested here). Compare object counts and total bytes. A top-up copy runs
   after the freeze (step 7).
2. **Freeze.** On the Render sync, turn maintenance on with `POST /internal/maintenance {"on":true}`. Every open board
   closes with "Lobby is updating". Check that `GET /internal/maintenance` answers `{"maintenance":true}`. This stops
   board edits only; the Render api still accepts uploads and checkpoints until step 4 suspends it.
3. **Final board backups.** In the Render sync Shell, run
   `node apps/sync/src/backup/run-all-cli.ts --expect-maintenance > /var/data/cutover/final-backups.json`. It makes a
   signed offsite copy of every board file on the disk (open or not, trashed ones included), held for 90 days. Keep the
   report, and copy it off Render's disk (the services are suspended later): each board's `documentClock`,
   `recordCount` and `recordsSha256` are the reference for step 8. (On 2026-10-01 the same CLI ran from the workstation
   with `--url` and the secret in its environment, `docs/CUTOVER-LOG.md`; either works.)
4. **Restore points.** In the Render api Shell, run `node apps/api/src/features/history/checkpoint-all-cli.ts`: one
   checkpoint per board (its body goes to R2 under `snapshots/`). Then **suspend the Render api**, so nothing more is
   written to Postgres or R2.
5. **Postgres.**
   1. Temporarily allow the Azure VM's IP on Render Postgres (its allow-list is empty on purpose). The tool is
      `docs/research/excalidraw/rehearsal/pg-allowlist.mjs add|restore`. The owner's 2026-10-01 approval covered the
      rehearsal's dump only: get a fresh OK for this one, and restore the empty list straight afterwards.
   2. On the VM, in a `postgres:18` container, run
      `pg_dump -Fc --no-owner --no-privileges`, then
      `pg_restore --no-owner --no-privileges --exit-on-error` into a fresh UTF8 database on Flexible Server.
   3. Put Render's allow-list back to empty.
   4. Start the Azure api. It applies migration `0025` by itself. Migrations `0001`–`0024` must be byte-identical, or the
      api stops on a checksum mismatch.
6. **Boards.**
   1. Start the Azure sync **in maintenance** (`DRAFTROOM_BOOT_MAINTENANCE=1`).
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
8. **Verify:**
   - Postgres row counts per table equal Render's (the rehearsal's `stack.sh` has a `pg-counts` helper).
   - Each board's element count (`recordCount`) matches step 3's report. The clock and digest do **not** match, by design:
     applied onto an empty disk, a staged restore raises the board clock by 1,000,000 and writes a new epoch
     (`UNKNOWN_LIVE_BUMP` in `staged-restore.ts`, `apps/sync/src/backup/restore.ts`), and `recordsSha256` covers `lb_meta`
     where the clock and epoch live. Expect `documentClock` = step 3's clock + 1,000,000 (read it from
     `GET /internal/boards/<id>/snapshot`, counts only, as on 2026-10-01). The exact-digest proof is step 6.2's drill
     PASS, which restores with no bump and compares to the manifest.
   - Open each real board: shapes, file cards and previews show; open a board's History and a dashboard thumbnail.
   - Then turn maintenance off on the Azure sync, and **remove `DRAFTROOM_BOOT_MAINTENANCE` from its environment**, so a
     reboot starts open (the 2026-10-01 cut-over deleted the flag at C16 for the same reason).
9. **New backups.** The Azure sync's periodic backup only copies boards that are open and have changed
   (`apps/sync/src/backup/backup.ts`, `BACKUP_DEFAULTS`: every 15 minutes), so boards nobody opens would have no offsite
   copy at all. Run `run-all-cli.ts` once on the Azure sync (it backs up every board file, open or not, and holds the set
   90 days) to give the new store a first set signed with the new secrets. Then run `restore-drill.ts --from=store` against
   the **new** store with the **new** secrets: it must PASS for every board, and the status endpoint must show
   `failuresTotal` 0.

---

## 7. Cut-over checklist

### Before the day

- [ ] The open questions in [section 8](#8-open-questions-for-chase--it) are answered.
- [ ] Okta and Entra app registrations exist for both the rehearsal and production hostnames.
- [ ] The sign-in code (and the Blob driver, if chosen) is merged, security-reviewed and green on the full suite.
- [ ] Azure is built from the infrastructure-as-code files, not by hand.
- [ ] Postgres connects with `sslmode=verify-full`.
- [ ] Drop-legacy has run on staging.
- [ ] The DNS records exist, with a TTL of 300 s.

### Rehearsal (on lobby-rehearsal.darkburn.com)

- [ ] Steps 1 and 5–9 of [section 6](#6-moving-the-data) run end to end and timed, on copies taken from live staging
      **without freezing it**. The board copies are the newest regular offsite backups (taken every 15 minutes), and
      the database copy is a `pg_dump`, which is a consistent snapshot by itself. Steps 2–4 are timed on the real day.
- [ ] The smoke script adapted to one origin ([section 5](#small-code-new-files-or-small-edits)) passes against the
      rehearsal host:
  - [ ] headers, CSP and HSTS;
  - [ ] the board WebSocket;
  - [ ] the event stream's first byte under 1 second (section 5b);
  - [ ] a 500 MB upload and file range reads through Caddy.
- [ ] A real board opened in Safari and in Chrome under the enforced CSP: no violations, and the socket connects.
- [ ] A 30-minute board session with two users, then `docker restart` of sync: the board reconnects. Same after a
      `caddy reload`.
- [ ] Reboot the VM: everything comes back by itself, in the order api, then sync. With the data disk deliberately left
      unmounted (on the rehearsal VM only), sync does not start and writes nothing to the OS disk.
- [ ] Sign-in:
  - [ ] staff via Okta becomes a creator;
  - [ ] a reviewer via a personal Microsoft account is an outsider, and the token carries `xms_edov` or the result is
        written down;
  - [ ] a reviewer from a locked-down company tenant can reach the consent step;
  - [ ] an email-locked invitation is accepted with the matching address and refused with another;
  - [ ] a name-only guest link works;
  - [ ] Okta's org authorization server returns a refresh token, and a disabled test user (Okta and Microsoft) is cut off at
        the next hourly check;
  - [ ] after a sign-out, the next sign-in asks again.
- [ ] Revoking access disconnects an open board within 15 s.
- [ ] SQLite commit times on the Azure disk under the L1/L2 load harness are recorded.
- [ ] A disk-snapshot restore onto a scratch VM, and a Postgres point-in-time restore to a new server, are tried once
      each. Write down how long they took.
- [ ] Everything is written up as evidence, then the rehearsal data is wiped.

### The window

**Announce it first:** about 1 hour, boards closed throughout.

1. [ ] **Freeze**: [section 6](#step-by-step), steps 2–4. Render sync goes into maintenance, then the final backups and
   checkpoints run, then the Render api is suspended.
2. [ ] **Copy**: steps 5–7 (Postgres, boards, the file top-up).
3. [ ] **Verify**: step 8, then the live smoke against `lobby.darkburn.com`, then the owner signs in through Okta and the
   account is linked, a creator, with all 4 boards. Then a two-user test, as on 2026-10-05.
4. [ ] **Go / no-go.** Decide here. Rolling back up to this point loses nothing.

### Switch

- [ ] Tell people the new address: `https://lobby.darkburn.com`.
- [ ] Replace the Render web site's rules with a redirect of every path to `https://lobby.darkburn.com`, so old
      invitation and guest links land on the new host. **UNVERIFIED**: Render static sites support redirect rules, but
      this hasn't been tried on this site.
- [ ] Run step 9 (the drill of the new backup store).

### Rollback

- **Before the switch:** resume the Render api and turn maintenance off on the Render sync. Render is unchanged and
  nothing is lost. The Azure copy is simply discarded.
- **After the switch:** going back to Render loses whatever was done on Azure, unless it is copied back with the same
  tools in reverse. That reverse copy is **not rehearsed** (**UNVERIFIED**), so make the go/no-go call in step 4, not
  later.
- **On Azure itself:** a bad board can be restored from its signed backups (`docs/DEPLOY.md` "Restoring a board").
  Postgres has point-in-time restore for up to 35 days, and the data disk has its snapshots.
- **Keep for 30 days:** the suspended Render services, the R2 bucket and the Clerk dev instance. Keep the R2 backup
  prefix until its hold ends (2026-12-30).

### After

- [ ] Watch for 48 hours. Run a daily check like the ones in `docs/CUTOVER-LOG.md`:
  - [ ] api and sync answer 200;
  - [ ] backup status shows `failuresTotal` 0;
  - [ ] no error lines in 24 h;
  - [ ] no unexpected restarts.
- [ ] Once the link window closes: remove Clerk (code, packages, CSP, the dev instance), the Render services and
      `render.yaml` (or keep them as staging, [question 17](#8-open-questions-for-chase--it)).
- [ ] Retire the NAS worker.
- [ ] Update `docs/PROGRESS.md`.

---

## 8. Open questions for Chase / IT

Each question comes with a recommended answer. A recommendation is not a decision, and silence is not approval: the owner
(and DBC IT, for anything in DBC's tenant) answers each one explicitly before the work or the spend it implies starts.
Questions 10, 11, 13, 14 and 21 carry a cost, and 6, 8 and 9 need changes in DBC's Entra, Okta and DNS.

1. **What does "MSA" mean here?** Recommended: Microsoft accounts for outside reviewers, both personal accounts and other
   companies' work accounts. DBC staff use Okta.
2. **Is DBC's Okta tied to DBC's Microsoft 365 (federated), so that staff could use either button?** Recommended: staff
   use Okta. The Microsoft button also makes staff creators only if IT lists DBC's tenant ID.
3. **Which Microsoft accounts may sign in at all?** Recommended: any Microsoft account (the `common` sign-in), because
   reviewers at companies on Microsoft 365 can't make personal accounts with their work address.
4. **Which Okta org, and does it allow self-sign-up or users brought in from other identity providers?** Recommended:
   DBC's existing org, with neither enabled.
5. **Are trailerparkgroup.com staff in DBC's Okta, or in their own Microsoft tenant?** Recommended: in DBC's Okta.
   Otherwise, give us TPG's tenant ID.
6. **Who creates the Okta app and the Entra app registration, and in which tenant?** Recommended: DBC IT, in DBC's
   tenant, as described in [section 3](#3-sign-in-with-okta-and-microsoft).
7. **May Lobby store encrypted refresh tokens, to check hourly that people are still active?** Recommended: yes, with the
   key in Key Vault. The alternative needs admin-approved Graph and Okta API access.
8. **Which hostname?** Recommended: `lobby.darkburn.com`, plus `lobby-rehearsal.darkburn.com`.
9. **Who controls darkburn.com DNS, and is there a CAA record?** Recommended: IT adds the two `A` records and allows Let's
   Encrypt, or provides a DBC certificate.
10. **Which Azure subscription and region, and what rules apply (allowed regions, public IPs, required agents, tags,
    budgets)?** Recommended: DBC's production subscription, the region nearest the staff, a VM with one public IP open
    only on 80/443.
11. **Is one VM acceptable, or must it be AKS, or behind Front Door or a WAF?** Recommended: one VM with Caddy. Front
    Door can't carry the event stream.
12. **Move the staging boards and accounts, or start fresh?** Recommended: move them (4 boards, minutes of work), with a
    7-day account-link window.
13. **Files: keep Cloudflare R2, or move everything into Azure Blob Storage?** Recommended: Azure Blob, so all DBC data
    sits in DBC's tenant. Use R2 only if go-live can't wait the 3–5 days, and then only in a DBC-owned Cloudflare
    account (opening one is a new vendor account, so it needs the owner's explicit OK). Either way the three file prefixes
    (`assets/`, `snapshots/`, `thumbnails/`) move together or stay together ([section 6](#6-moving-the-data)).
14. **Where do previews run after go-live: Chase's NAS or Azure?** Recommended: on the Azure VM, CPU-capped. Retire the
    NAS a week after go-live.
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
    DBC's GitHub org. GitHub Actions builds the images and deploys to the VM.
20. **Who gets alerts and who has deploy rights?** Recommended: DBC IT and Chase get the Azure Monitor alerts by email.
    Only the pipeline deploys.
21. **Pay-as-you-go or a 1-year VM reservation?** Recommended: pay-as-you-go for the first 2–3 months, then reserve once
    the VM size is confirmed.

---

## Sources

Read 2026-10-05 unless noted.

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

**Repo:**

- Configuration and sign-in: `apps/api/src/config.ts`, `apps/api/src/auth/{provider,session,users,creator-sql,clerk}.ts`
- Live connections: `apps/api/src/events/routes.ts`, `apps/web/src/board/ticket.ts`,
  `apps/web/src/canvas/sync/transport/socket.ts`
- Storage and backups: `packages/blob-store/src/r2-store.ts`, `apps/sync/src/backup/*`,
  `apps/api/src/features/history/checkpoint-all-cli.ts`
- Deployment: `docker/*`, `deploy/nas/worker/docker-compose.yml`, `render.yaml`, `scripts/smoke/live-smoke.mjs`
- Rehearsal tools: `docs/research/excalidraw/rehearsal/*`
- Docs: `docs/DEPLOY.md`, `docs/EXCALIDRAW-CUTOVER.md`, `docs/CUTOVER-LOG.md`, `docs/DOMAIN-ACCESS-CONTRACTS.md`,
  `AGENTS.md`
