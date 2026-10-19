# Lobby: developer handoff

For an experienced developer who is new to this codebase. Written 2026-10-19 against `main` at `e1942f75`. Every path
below exists at that commit. The rules in [`AGENTS.md`](../AGENTS.md) are binding; this guide summarizes them and points
to the detail. The move to DBC's Azure with Okta and Microsoft sign-in is planned in
[`docs/GO-LIVE-AZURE.md`](GO-LIVE-AZURE.md).

## 1. What Lobby is

Lobby is Dark Burn Creative's internal Miro-style whiteboard: live multi-user boards with sticky notes, frames,
connectors, files with page previews, comments, templates, facilitation (votes, timers, polls, breakouts), client review,
AI helpers and sharing with outside guests. Every DBC project gets a workspace ("a lobby") with its boards. About 100
people at most: DBC staff (creators) plus invited outsiders and name-only guests. User guide:
[`docs/team/Welcome-to-Lobby.md`](team/Welcome-to-Lobby.md).

The code name is **draftroom**: the repo, `@draftroom/*` packages, `DRAFTROOM_*` variables and the `dr_session` cookie keep
it (`README.md` "Naming"). The canvas engine is **Excalidraw** (a pinned nightly, `0.18.0-1118751`); it replaced tldraw on
2026-10-01, and tldraw's tables were dropped from every board on 2026-10-09 (`docs/CUTOVER-LOG.md`). Text about tldraw in
older docs is history.

## 2. Monorepo map

pnpm workspace (`pnpm-workspace.yaml`, versions pinned through its `catalog:`), Node 24, TypeScript run directly by Node
(no build step for the servers).

| Path | One line |
|---|---|
| `apps/web` | React + Vite SPA. The Excalidraw canvas lives behind `CanvasPort` in `apps/web/src/canvas/` (the only web folder that may import `@excalidraw/*`); features in `apps/web/src/features/`; sign-in in `apps/web/src/auth/`. |
| `apps/api` | Fastify API: sessions and sign-in, workspaces, boards, permissions, files (streamed to the blob store), the board event stream (SSE), AI, imports, chat hooks, feedback, the worker routes. Postgres (PGlite in dev). |
| `apps/sync` | Node WebSocket server: one `ElementRoom` per board (`apps/sync/src/room/element-room.ts`), one SQLite file per board, text-edit leases, signed backups (`apps/sync/src/backup/`). |
| `apps/worker` | Preview worker (thumbnails, PDF/Office/PSD/TIFF pages, video posters) and wave W ops (`apps/worker/src/ops/`); the Office sidecar (`apps/worker/src/office-sidecar.ts`). An HTTP client of the api, with no database or storage keys. |
| `packages/canvas-schema` | Element schemas, field groups, `customData` classes, invariants, limits, the wire protocol, `CONTRACTS_REV`, migrations; `src/engine/` wraps Excalidraw's pure functions. Used by web, sync, converters and imports. |
| `packages/contracts` | Zod contracts shared by api and web (`AuthConfig`, domain access, formats, chat hooks, Miro import, …). |
| `packages/db` | Postgres/PGlite access and the checksum-guarded migration runner; `packages/db/migrations/0001`–`0039`. |
| `packages/permissions` | Pure workspace/board role rules (owner, admin, member, guest; board roles). |
| `packages/auth-tickets` | Short-lived board connection tickets and the api↔sync internal-secret check. |
| `packages/blob-store` | Object storage: a local directory (dev, e2e) or Cloudflare R2 (S3 SigV4, presigned GET/PUT). |
| `packages/dev-assets` | Asset ids, limits, URL builders and the worker's scratch layout. |
| `packages/board-ops` | Framework-free board logic over Excalidraw elements. |
| `packages/board-archive` | The `.lobby` backup ZIP writer and reader. |
| `packages/templates` | Board templates (engine-neutral plans and their Excalidraw scenes). |
| `packages/icon-sets` | The pinned icon sets (lucide-static, @tabler/icons) behind the Elements panel. |
| `packages/miro-import` | Miro board → Lobby elements converter (untrusted input). |
| `packages/tldraw-import` | tldraw → Excalidraw converter; the only place tldraw code is allowed. |
| `e2e` | Playwright suites (`e2e/excalidraw/`), build checks, CSP harness, load and perf scripts. |
| `docker`, `render.yaml`, `deploy/nas` | Images, the Render staging Blueprint, the NAS worker and the separate theater Lobby. |
| `scripts` | Licence and audit gates, the live smoke, NAS test runners, the protocol-fixture freezer, `miro-probe.mjs` (owner-only). |

## 3. Running it locally

Needs Node 24 LTS (`.node-version`: 24.19.0), pnpm 10 (`packageManager`: 10.34.5) and ffmpeg/ffprobe on PATH.

```bash
pnpm install
pnpm fixtures      # the worker's test fixtures
pnpm dev           # api :5859, sync :5858, worker, web :5173 (all in parallel)
```

Open <http://127.0.0.1:5173>. Each server reads its own `dev.env` (`apps/api/dev.env`, `apps/sync/dev.env`,
`apps/worker/dev.env`): **dev auth** (`DRAFTROOM_DEV_AUTH=1`, `AUTH_PROVIDER=dev`) gives password-less development
identities (`<handle>@dev.invalid`, creators only under the dev provider). Dev identities are refused under
`NODE_ENV=production`, and the web build must never get `VITE_DRAFTROOM_DEV_AUTH` outside tests. Data goes to `./.data`
(`DRAFTROOM_DATA_DIR`): board SQLite files under `rooms/`, PGlite under `pg/`, files under the fs blob store. The Vite dev
server proxies `/api`, `/files` and `/connect` (`apps/web/vite.config.ts`), so the page is one origin, as in production.
Manual walkthrough: [`docs/DEMO.md`](DEMO.md).

**The owner's Windows PC** (from `AGENTS.md`): in Git Bash, Node and pnpm may be missing from PATH. Prefix:

```bash
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"
```

Windows Smart App Control blocks `biome.exe` there, so lint runs on the NAS (`scripts/nas-lint.sh`). Never put a SQLite
database on a network share (the NAS's `V:\`).

**The e2e stack** is started by the tests themselves (`e2e/tests/support/stack.ts`): a production web build served by
`vite preview` with the dev-auth guard, plus a real api, sync and worker per run. See [section 7](#7-how-to-test).

## 4. Architecture

```
                         one origin (dev: Vite proxy; staging: Render rewrites + direct hosts; Azure: Caddy)
 browser ──────────────────────────────────────────────────────────────────────────────────────────────┐
   │  page + /api/* + /files/*  (cookie dr_session, SameSite=Lax)          /connect/<board>?ticket=…   │
   v                                                                        (WebSocket, 60 s ticket)   v
 apps/api (Fastify, ONE instance) ── internal secret ──>  apps/sync (ONE instance)
   │  Postgres: users, sessions, workspaces,               │  ElementRoom per board = the canvas authority
   │  boards list, grants, comments, assets, jobs,         │  rooms/board-<id>.sqlite (WAL) on its own disk
   │  worker_ops, search, AI ledger, chat hooks …          │  signed offsite backups (backups/sync/…)
   │  blob store: assets/, snapshots/, thumbnails/         │  re-checks access with the api every 10 s
   │  SSE board event stream (votes, timers, comments,     │
   │  polls, access changes), 15 s heartbeat               │
   ^                                                       │
   │ /api/worker/* (Bearer DRAFTROOM_WORKER_TOKEN)         │
 apps/worker ── presigned GET/PUT ──> blob store
   └── Unix socket ──> office sidecar (LibreOffice, no network, no secrets)
```

**The sync authority.** Canvas state has one authority: the sync server's `ElementRoom`. Exactly one room owner per
board, one SQLite database per board, and only the sync process writes a board file. Acks go out only after COMMIT.
Every element write is validated server-side per op, with canvas-schema's rules. Clients apply every server change with
`CaptureUpdateAction.NEVER` through the sync adapter (`apps/web/src/canvas/sync/`), and a client that only receives
changes pushes nothing. There is no second merge layer (no Yjs, Liveblocks, Excalidraw collab or `reconcileElements`)
and no whole-board save loop. Text is edited only under a server-granted lease (`apps/web/src/canvas/lease/`,
`apps/sync/src/room/lease.ts`). Bound arrow endpoints are always derived by the server. Presence is never stored.

**The api** is the only Postgres writer and the permission authority for everything else: every API, WebSocket ticket,
file, worker, export and AI action is checked server-side, and authorship comes from the session, never from a body. It
keeps in-process state (event hub, stream tickets, rate limits, spotlight), so it runs as exactly one instance too.

**`CONTRACTS_REV`** (`packages/canvas-schema/src/protocol.ts`, now **14**) is the wire contract's revision. A tab of an
older build stays open for days and drops a whole frame it cannot parse, so the connect URL names the client's revision
and the room sends every frame through `frameForReader` at its one send point (`Session.send` in
`apps/sync/src/room/element-room.ts`); a write from an older revision keeps the fields it cannot know (`lobbyWriteOf`).
A bump freezes the deployed build's schemas as a fixture (`packages/canvas-schema/test/fixtures/`, made with
`scripts/freeze-protocol-fixture.mjs`) and proves both against it and against that real build in a browser
([`docs/EXCALIDRAW-CONTRACTS.md`](EXCALIDRAW-CONTRACTS.md) §0b). Separately, `LOBBY_CLIENT_REV` (3) versions the web's
own client contract. Sync keys can fail closed to an older revision: with `DRAFTROOM_PLANNING` off the room says 13.

**The worker.** Workers poll the api (`POST /api/worker/claim`; since wave W also the ops routes and a check-in every 2
minutes), get a 120 s lease, download originals by presigned URL, write results the same way, and report back. No worker
running is a safe state: jobs wait in Postgres. Each capability (`remove-bg:u2netp@1`, `extract-text@1`,
`render-pages@1`, `packages/contracts/src/formats.ts`) is reported only when the build has it, `WORKER_OPS` allows it and
its prerequisite holds (`apps/worker/src/ops/capabilities.ts`); the api offers a worker-backed feature to the web only
while a capable worker checked in within 10 minutes. Untrusted files are processed in child processes with heap caps,
Linux resident-memory caps (PDF 768 MB, PDF text 768 MB, background removal 640 MB) and kill timers. The background
removal model is never downloaded by Lobby: the owner places `u2netp.onnx` and the worker loads it only when its sha256
matches the pin in `apps/worker/src/ops/bg-model.ts` (listed in `apps/worker/models/MODELS.json`). File processing never
runs in the live sync loop.

## 5. Do not break (summary of AGENTS.md)

Read [`AGENTS.md`](../AGENTS.md) itself before the first change; each line below is one of its rules, shortened.

- **One canvas authority** (`apps/sync` `ElementRoom`), one SQLite per board, acks after COMMIT, no second sync or merge
  layer, no whole-board overwrite saves.
- **Remote changes** reach the editor only through the sync adapter with `CaptureUpdateAction.NEVER`; receive-only
  clients push nothing; every new echo source gets a rule and a test.
- **No base64, `data:`, `blob:` or signed/expiring URLs** in elements, `customData`, `link` or board settings; `fileId` is a
  Lobby version id.
- **Schemas live in `packages/canvas-schema`** and are used everywhere; every write is validated per op on the server; a
  test fails when an element field belongs to no field group. Test reconnects, restarts, stale clients and concurrent
  edits when those paths change.
- **Stale clients:** every frame goes through `frameForReader`; a `CONTRACTS_REV` bump needs the frozen fixture and a
  real old build in a browser.
- **Undo** is Lobby's own field-level stack; it never revives what someone else deleted.
- **Text leases and arrows:** only the lease holder writes a text's words and layout; bound arrow ends are server-derived;
  an arrow's whole geometry is written together and rebased only with Excalidraw's `movePoints`.
- **`@excalidraw/*` imports** only in `apps/web/src/canvas/**` and `packages/canvas-schema/src/engine/**`; keys reach
  Excalidraw only through the allowlist in `apps/web/src/canvas/input/`; every `canvasActions` flag stays off.
- **Engine pin:** all five `@excalidraw/*` packages at the same exact version; bump only in a dedicated PR that runs the
  engine probe suite (`apps/web/test/engine-probe`, `pnpm probe:browser`) and the full gate. Inspect the installed
  `.d.ts` files before relying on an API name.
- **No embeds or iframes** (`validateEmbeddable` returns false; the server refuses those types).
- **No browser request leaves Lobby's origins and the auth provider's:** self-hosted fonts, a 404 (not `index.html`) for
  missing `/excalidraw-assets/*`, CSP without `unsafe-eval`, the e2e network assertion.
- **Server egress exceptions** (reviewed): Miro import to `api.miro.com` through `apps/api/src/egress` with the token
  only in that job's memory; chat notifications to Slack and Teams Workflows webhook URLs, sealed at rest under
  `DRAFTROOM_WEBHOOK_SECRET`. Tests use fakes, never the real services. No agent runs `scripts/miro-probe.mjs`.
- **Models** (wave W): never downloaded; sha256-pinned; inference only in a worker child process; tests use a synthetic
  model.
- **Permissions server-side everywhere**; dev identities only behind the local-dev guard.
- **Only creators create** workspaces, projects and boards (in any form) and hand out or raise access. Clerk test-mode
  addresses never count; the rule fails closed. Contract: [`docs/DOMAIN-ACCESS-CONTRACTS.md`](DOMAIN-ACCESS-CONTRACTS.md).
- **Licences:** no paid or copyleft production dependency (`pnpm licence:check`); pin exact versions; serialize lockfile
  and shared-schema changes.
- **Secrets and logs:** never log session tokens, private content, signed URLs or OAuth tokens. Don't show "Saved"
  unless persistence supports it; don't call a flattened preview editable.
- **Ops:** keep code deployable in small steps; never publish an unreviewed deployment; never mark an unrun check as
  passing. On the NAS, touch only Draftroom's own containers (never `theaitre-bot`).

## 6. Auth today, and where Okta/Entra OIDC plugs in

### How it works now

- **Providers.** `AUTH_PROVIDER` (`apps/api/src/config.ts`, type `AuthProviderId = 'dev' | 'clerk' | 'email'`) picks one
  provider per api process; `defaultProvider` in `apps/api/src/app.ts` builds it.
  - `dev` (`apps/api/src/auth/dev.ts`): `POST /api/auth/dev/login`, local only.
  - `clerk` (`apps/api/src/auth/clerk.ts`, staging): the web signs in with Clerk (email code, optional password,
    sign-up; `apps/web/src/auth/ClerkSignIn.tsx`), then sends the Clerk session token to `POST /api/auth/clerk/session`.
    The api verifies it, reads the user's **verified** addresses from Clerk's Backend API and signs the person in.
  - `email` (`apps/api/src/auth/email.ts`): open sign-in for the separate theater Lobby only
    ([`docs/OPEN-SIGNIN.md`](OPEN-SIGNIN.md)); everyone is a creator there. Its optional Google button verifies a
    Google ID token with `node:crypto` (`apps/api/src/auth/google-id-token.ts`).
- **One session type.** Whatever the provider, `ctx.signIn` (`SignInContext` in `apps/api/src/auth/provider.ts`)
  provisions the user in one transaction (`findOrCreateUser` in `apps/api/src/auth/users.ts`: identity keyed by
  `(provider, subject)`, addresses stored in `user_emails`), revokes the browser's previous session and sets the
  `dr_session` cookie (`apps/api/src/auth/session.ts`: random token, only its SHA-256 stored, 30 days, host-only,
  `SameSite=Lax`). Every route then uses `ctx.requireUser(req)` (`apps/api/src/context.ts`). A session end is pushed to
  sync so open sockets close (`apps/api/src/auth/session-sync.ts`).
- **Creator status** (`ctx.identity`, the `IdentityService` in `apps/api/src/auth/identity.ts`): a creator has a stored
  **verified** address of the running provider whose domain equals one of `DRAFTROOM_CREATOR_DOMAINS` (default
  `darkburn.com,trailerparkgroup.com,trailerpark.com`) or is on `DRAFTROOM_CREATOR_EMAILS`, confirmed within 24 h
  (`IDENTITY_GRACE_MS`). The decision is one SQL fragment (`userColumns` in `apps/api/src/auth/creator-sql.ts`); matching
  is exact ASCII after the last `@`, no subdomains (`apps/api/src/auth/creators.ts`). Stored addresses older than 1 h are
  refreshed in the background through the provider's `refreshIdentity`; an account the provider says is gone or banned
  loses every session. `requireCreator` guards every create and share route.
- **Clerk test-mode addresses never count.** `normalizeEmail` refuses any address with `+clerk_test`
  (`isClerkTestAddress`, `packages/contracts/src/domain-access.ts`) for every source (profiles, invitations, config), and
  `DRAFTROOM_CREATOR_EMAILS` refuses such an entry at start-up. Keep this when Clerk goes.
- **Guests.** Name-only guests join through a link or join code (`apps/api/src/features/guests/join.ts`) and never touch
  the provider.

### What an OIDC provider must implement

The plan (two providers, Okta for staff and Microsoft for reviewers, server-side code flow with PKCE) is in
[`docs/GO-LIVE-AZURE.md`](GO-LIVE-AZURE.md) §3 and §5. The interface is `AuthProvider` in
`apps/api/src/auth/provider.ts`:

```ts
interface AuthProvider {
  readonly id: AuthProviderId
  readonly personalWorkspaces?: boolean            // leave unset: creators get a personal workspace
  publicConfig(): AuthConfig                       // what GET /api/auth/config tells the sign-in page
  register(app: FastifyInstance, ctx: SignInContext): void   // its routes: start + callback per IdP
  revokeProviderSessions?(db, userId): Promise<ProviderSessionsRevoked>  // "Sign out everywhere"
  refreshIdentity?(db, userId, fetchedAt): Promise<RefreshOutcome>       // 'ok'|'none'|'gone'|'banned'|'unavailable'
}
```

In the callback, call `ctx.signIn(req, reply, (tx, now) => findOrCreateUser(tx, { provider, subject, name, handle: null,
avatarUrl: null, refreshProfile: true, emails, fetchedAt }, now, ctx.creators).then((r) => r.user))`. `emails` holds only
addresses the IdP verified (Okta `email_verified`; Microsoft `xms_edov`), `[]` when there are none, and `null` only when
the IdP could not be asked (a first sign-in is then refused, a later one keeps the stored addresses). Use
`ctx.rateLimit` for failures and `ctx.endBannedAccount` for a disabled account. `refreshIdentity` makes its network calls
outside any transaction, then writes once with `replaceUserEmails`, and never throws for a provider failure.

Files to change (all exist except the new ones):

| Where | What |
|---|---|
| `apps/api/src/auth/oidc.ts` (new) | the provider for both IdPs: discovery, PKCE, `state`/`nonce`, token exchange, ID-token checks, userinfo, refresh, revoke |
| `apps/api/src/config.ts`, `apps/api/src/app.ts` | the `AuthProviderId` value, its variables and secret checks; `defaultProvider` |
| `packages/contracts/src/index.ts` | `AuthConfig.providers` (and what the sign-in page needs to draw the two buttons) |
| `packages/db/migrations/0040_*.sql` (new) | widen the `identities.provider` and `user_emails.source` CHECKs (last set in `0025_open_signin.sql`); `oid`/`tid`/`acct`; a per-address trust flag; the sign-in transaction table; encrypted refresh tokens |
| `apps/api/src/auth/creator-sql.ts` | `CreatorLookup.source` and `EmailSource` are **one** provider today; the SQL (`userColumns`, `qualifiesSql`, `originColumns`) must read a set of sources and honour the trust flag (a personal Microsoft account's address never satisfies the domain rule; only members of listed tenants do) |
| `apps/api/src/auth/users.ts`, `session.ts` | `findOrCreateUser`/`replaceUserEmails` per source; the `__Host-` cookie prefix; `clerk_session_id` |
| `apps/api/src/routes/auth.ts` | config, logout (optional Okta sign-out redirect), Sign out everywhere |
| `apps/api/src/features/dashboard/email-invites.ts`, `clerk-directory.ts` | invite-by-email uses Clerk today; replace with links (or Graph mail later) |
| `apps/api/src/crypto/sealed.ts` | the AES-256-GCM box to reuse for refresh tokens, with its own key |
| `apps/web/src/auth/` (`SignInPage.tsx`, `ClerkSignIn.tsx`, `clerkSession.tsx`, `clerk-options.ts`, `clerkAppearance.ts`, `session.tsx`, `signOut.ts`, `exchange-error.ts`, `ExchangeStatus.tsx`), `apps/web/src/api/client.ts`, `apps/web/src/board/ShareDialog.tsx` | the two buttons as plain links (the CSP has `form-action 'self'`), Clerk removed |
| `apps/api/test/features/domain-access/clerk-fake.ts` | the pattern for fake Okta and Microsoft servers; tests never call real tenants |

How creator access maps from claims: Okta `email` counts when `email_verified` is true and `iss` is DBC's org; Microsoft
`email` counts only when `xms_edov` is true, and for the company-domain rule only when `tid` is a listed DBC tenant and
`acct` is 0 (member). The personal-account tenant `9188040d-6c67-4c5b-b112-36a304b66dad` never satisfies the domain rule.
Every address still goes through `normalizeEmail`, so `+clerk_test` addresses never count. Accounts are never merged by
email (one person with both buttons gets two accounts).

## 7. How to test

| Command | What |
|---|---|
| `pnpm test` | vitest, all projects in `vitest.config.ts`: `canvas-schema`, `dev-assets`, `sync`, `worker`, `sync-arrows-acceptance`, `web`, `engine-probe`, `packages`, `e2e-load`, `scripts`, `api`. One project: `pnpm vitest run --project api` |
| `*.pg.test.ts` | real-Postgres tests; they run only with `DRAFTROOM_TEST_DATABASE_URL`. On the owner's setup: `DRY_RUN=0 bash scripts/nas-pg-api.sh <commit> [--only api\|db]` (throwaway PostgreSQL 18 on the NAS, its own run id and lock); in CI the `postgres` job |
| `pnpm test:arrows` | the arrow acceptance tests against the real room (`vitest.arrows.config.ts`) |
| `pnpm probe:browser` | the Excalidraw engine probes in a real browser (layout corpus, index collision, `addFiles`); required on every engine bump |
| `pnpm e2e:install`, then `pnpm e2e` | the whole Playwright suite on Chromium against a production build with dev auth; one test at a time (some kill the sync). `E2E_PORT_BASE=<n>` runs a second suite side by side |
| `E2E_DIRECT_EVENTS=1 pnpm e2e` | the same suite with the event stream on the api's own origin (Render's mode); the gate runs both |
| `pnpm --filter @draftroom/e2e xbrowser` | the WebKit and Firefox smoke (`e2e/excalidraw/xbrowser-smoke.spec.ts`) |
| `pnpm --filter @draftroom/e2e excalidraw:prod` / `excalidraw:dev` / `csp:cutover` | the production build without the guard (enforced CSP, `e2e/excalidraw-builds/prod-build.spec.ts`), the dev server, and the CSP audit (0 violations, 0 foreign requests) |
| compat specs | `e2e/excalidraw/*-compat-*.spec.ts` (for example `w-compat-7e5b4d6.spec.ts`) with `E2E_OLD_WEB_DIST` / `E2E_OLD_WORKER_ENTRY`: the previously deployed build against the new servers |
| `pnpm licence:check`, `pnpm audit:prod` | the licence gate (dependencies and models) and the production audit with its reviewed allowlist (`scripts/audit-check.mjs`) |
| `node --test apps/web/build/*.test.ts apps/web/test/bundle/*.test.ts scripts/smoke/render-yaml.test.mjs` | build gates: the bundle host scan and `render.yaml`'s expected keys |
| `pnpm lint`, `pnpm typecheck`, `pnpm verify` | Biome, TypeScript on every package, and lint + typecheck + test + e2e |
| `node scripts/smoke/live-smoke.mjs --base <url> --expect excalidraw` | the signed-out smoke against a live deployment (41 checks on staging) |

CI (`.github/workflows/ci.yml`) runs these jobs but is **manual-only** (`workflow_dispatch`) to save free Actions minutes.
A release gate in `docs/PROGRESS.md` lists what was run at which sha; copy that habit.

## 8. Deploys and kill switches today

**Staging on Render** ([`docs/DEPLOY.md`](DEPLOY.md), [`render.yaml`](../render.yaml)): a static site (web), api and
sync as Docker web services (`docker/api.Dockerfile`, `docker/sync.Dockerfile`, 0.5 CPU / 512 MB each, one instance),
Postgres 18, Cloudflare R2 for files. Autodeploy is off and the Blueprint is on Manual Sync. Settings are applied through
the Render API before each deploy, and `render.yaml` drift is checked (`scripts/smoke/render-yaml.mjs`). Order: **api
(migrations run at start), then sync, then web**, then any switch flips (each one an api redeploy, since a plain restart
did not pick up env changes). A wave's own section in `docs/DEPLOY.md` gives its exact steps. Render specifics: the board
socket goes straight to the sync host (`VITE_DRAFTROOM_SYNC_ORIGIN`) and the event stream straight to the api host
(`DRAFTROOM_EVENTS_ORIGIN`), because static-site rewrites carry neither.

**The NAS** (UGREEN, Docker over SSH, LAN-only): the preview worker `nas-1` and the Office sidecar, built and started by
`deploy/nas/deploy-worker.sh` (`check-env`, `deploy`, `status`, `logs`, `stop`, `start`) from
`deploy/nas/worker/docker-compose.yml`; the model sits read-only in the worker's `models/` folder. The worker reaches the
api's public URL and holds only `DRAFTROOM_API_URL`, `DRAFTROOM_WORKER_TOKEN` and `WORKER_ID`. The NAS also runs the
separate theater Lobby (`deploy/nas/theater/`), which is not part of DBC's Lobby.

**Kill switches** (each read at boot; `on` or `off`, anything else stops the process; off = the feature's routes answer as
unknown routes and Postgres keeps its rows):

| Key | Service | Turns off |
|---|---|---|
| `DRAFTROOM_DESIGN_PREVIEWS` | api | PSD/AI/TIFF page previews (they stay attachments) |
| `DRAFTROOM_LIVE_ACTIVITIES`, `DRAFTROOM_JOIN_CODES`, `DRAFTROOM_BREAKOUTS` | api | polls and word clouds; join codes; breakouts (wave V) |
| `DRAFTROOM_DOC_CARDS`, `DRAFTROOM_REMOVE_BACKGROUND`, `DRAFTROOM_FILE_SEARCH`, `DRAFTROOM_DECK_IMPORT`, `DRAFTROOM_WORKSPACE_ADMIN` | api | wave W formats; the middle three also need a capable worker |
| `DRAFTROOM_AI=off`, `DRAFTROOM_AI_VISION` | api | all AI; photo capture |
| `DRAFTROOM_EVENTS_ORIGIN` (unset) | api | the direct event stream (pages fall back to same-origin) |
| `DRAFTROOM_REACTIONS`, `DRAFTROOM_PLANNING` | sync | emoji reactions; planning keys (cards, storyboards, Kanban, timelines). Both must be `on` today |
| `DRAFTROOM_WS_DEFLATE` | sync | WebSocket compression (held `off`) |
| `DRAFTROOM_BOOT_MAINTENANCE=1` | sync | starts with every board closed (cut-overs only; delete afterwards) |
| `WORKER_OPS=none` | worker | every op kind (previews continue) |
| `RESUME_FROM_CACHE` (`apps/web/src/canvas/sync/adapter/snapshot-cache.ts`) and the flags in `apps/web/src/canvas/sync/flags.ts`, `apps/web/src/features/live/flags.ts`, `apps/web/src/features/formats/flags.ts` | web (build) | client-side holds and the web's half of each feature switch; a change is a web deploy |

**Rollback:** Render's *Rollback* for web and sync; for the api past a migration, `DRAFTROOM_ALLOW_NEWER_SCHEMA=1` and
*Deploy a specific commit* (`docs/DEPLOY.md` "Rolling the api back past a migration"). Migrations are forward-only and
must never be edited once shipped. Boards are restored from signed backups (`apps/sync/src/backup/restore-board.ts`).

## 9. Where the history lives

- [`docs/PROGRESS.md`](PROGRESS.md): the log of every milestone and wave, its gate and its open items. Read the top and
  the latest entries first; update it when a milestone or workflow finishes.
- [`docs/CUTOVER-LOG.md`](CUTOVER-LOG.md): what was actually deployed to staging, when, and the live checks.
- Contracts per wave (the frozen decisions each wave built on): [`docs/WAVE-Q-CONTRACTS.md`](WAVE-Q-CONTRACTS.md),
  [`WAVE-R`](WAVE-R-CONTRACTS.md), [`WAVE-S`](WAVE-S-CONTRACTS.md), [`WAVE-T`](WAVE-T-CONTRACTS.md),
  [`WAVE-V`](WAVE-V-CONTRACTS.md), [`WAVE-W`](WAVE-W-CONTRACTS.md); earlier: [`WAVE3`](WAVE3-CONTRACTS.md),
  [`WAVE4`](WAVE4-CONTRACTS.md), [`M0`](M0-CONTRACTS.md), [`M1`](M1-CONTRACTS.md),
  [`M3-STORAGE`](M3-STORAGE-CONTRACTS.md), [`FEATURES`](FEATURES-CONTRACTS.md), [`FEATURES-M2`](FEATURES-M2-CONTRACTS.md).
- The canvas engine: [`docs/EXCALIDRAW-CONTRACTS.md`](EXCALIDRAW-CONTRACTS.md),
  [`EXCALIDRAW-MIGRATION.md`](EXCALIDRAW-MIGRATION.md), [`EXCALIDRAW-CUTOVER.md`](EXCALIDRAW-CUTOVER.md), and verified
  engine facts in [`docs/research/excalidraw/`](research/excalidraw/); [`docs/FEASIBILITY.md`](FEASIBILITY.md).
- Product and plan: [`docs/Miro_Clone_Build_Plan.md`](Miro_Clone_Build_Plan.md),
  [`docs/Cursor_Start_Here.md`](Cursor_Start_Here.md), [`docs/BACKLOG.md`](BACKLOG.md).
- Security: [`docs/SECURITY-REVIEW-2026-09-27.md`](SECURITY-REVIEW-2026-09-27.md),
  [`docs/SECURITY-REVIEW-2026-10-02.md`](SECURITY-REVIEW-2026-10-02.md),
  [`docs/DOMAIN-ACCESS-CONTRACTS.md`](DOMAIN-ACCESS-CONTRACTS.md).
- Going live on Azure: [`docs/GO-LIVE-AZURE.md`](GO-LIVE-AZURE.md).
