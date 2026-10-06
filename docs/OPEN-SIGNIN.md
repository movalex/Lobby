# Open email sign-in and partner boards (the theater Lobby)

**Status:** built and tested locally on branch `theater/email-signin`, 2026-10-05. Not deployed. Nothing changes on a
server that does not set `AUTH_PROVIDER=email`: DBC's staging and the planned Azure production keep Clerk (or Okta) and
the domain-access rules unchanged.

**What it is for.** A second Lobby, run from this same code, for Banzerini House (the theater). Each production in the
theaitre-bot admin (`/admin/productions/<id>`) gets one shared planning board. Nothing on that server is private, so
sign-in is deliberately lax: **anyone can sign in with any email address and a name, with no password and no
verification.**

## What a server with open sign-in does

| | Clerk / Okta server (DBC) | Open email sign-in server (theater) |
|---|---|---|
| Sign-in | verified accounts | any address + a display name, `POST /api/auth/email/login` |
| Who is a creator | creator domains + exceptions (`DOMAIN-ACCESS-CONTRACTS.md`) | **everyone** who signs in |
| Workspaces | a personal workspace per creator | **one shared workspace** for everybody, no personal ones |
| Partner boards | none | `PUT /api/partner/boards/:ref` with a Bearer token |

- **The address is the account.** Typing the same address again (any case) signs in to the same account, so people find
  their boards again. Whoever types someone else's address becomes that account; that is the accepted trade-off.
- **The shared workspace** (`wsp_SharedLobby000000000`, `auth/shared-workspace.ts`) is owned by a built-in account with no
  sign-in identity (`usr_SharedLobbyOwner0000`). Everyone who signs in joins it as a **member**: members open every
  board shared with the workspace, create boards (private until they share them) and projects.
- **Partner boards** are created by the partner app, owned by the built-in account and set to `workspace_edit`: every
  member edits them; nobody who signs in can trash them or change who sees them.
- Domain-access code paths are unchanged. The open policy is the creator lookup for the `email` provider only
  (`creator-sql.ts`: domain `*`, which `DRAFTROOM_CREATOR_DOMAINS` can never contain), and `user_emails` rows with
  source `email` count only while the server runs the email provider.
- **Wave J's outside markers** (External tags, Shared outside, the one-time outside confirm, Internal only, the
  owner's "outsider joined" notice) never fire because of the open policy: every account that signs in qualifies
  (`creator-sql.ts` `qualifiesSql` and `isOpenLookup`), and the built-in owner is neither "unconfirmed" nor a reason to
  start comments "Team only". Name-only guests from links are still guests. `DRAFTROOM_FEEDBACK_ADMINS` is refused at
  startup with the email provider (anyone could type a reader's address); feedback can still be sent.

## Configuration (api)

| Variable | Value |
|---|---|
| `AUTH_PROVIDER` | `email` |
| `DRAFTROOM_OPEN_SIGNIN` | `1`. Required with `AUTH_PROVIDER=email` (and refused without it), so open sign-in is never one typo away. Allowed under `NODE_ENV=production` on purpose. |
| `DRAFTROOM_SHARED_WORKSPACE_NAME` | the shared workspace's name, 1-120 characters (default `Lobby`), e.g. `Banzerini House`. Shown on the sign-in page. |
| `DRAFTROOM_OPEN_SIGNIN_METHODS` | `email` (default), `google`, or `email,google` ([Google](#google-continue-with-google)). |
| `DRAFTROOM_GOOGLE_CLIENT_ID` | required exactly when the methods include `google`: `<number>-<id>.apps.googleusercontent.com`. |
| `DRAFTROOM_PARTNER_TOKEN` | optional, at least 32 characters, different from the ticket, internal and worker secrets. Unset: no `/api/partner` routes. |

`CLERK_*` and `DRAFTROOM_CREATOR_*` are not used. Everything else (Postgres, R2, sync, worker token) is as on staging
(`docs/DEPLOY.md`). The web build needs nothing new: it reads the provider and the workspace name from
`GET /api/auth/config`.

## Google ("Continue with Google")

`DRAFTROOM_OPEN_SIGNIN_METHODS` chooses the ways in: `email` (type any address and a name; the default), `google`, or
both. With `google` the sign-in page shows Google's own "Continue with Google" button (Google Identity Services,
`apps/web/src/auth/GoogleSignIn.tsx`). Google hands the page an ID token, and `POST /api/auth/google/login` verifies
it (`apps/api/src/auth/google-id-token.ts`: RS256 against Google's published keys, `aud` = our client id, issuer,
expiry, `email_verified`; no dependency, no client secret). **Any Google account from any domain** is accepted.

- The account is keyed by the verified address, the same key as a typed address, so a person who signed in by email
  before lands in the same account with Google.
- Google-only (`DRAFTROOM_OPEN_SIGNIN_METHODS=google`) closes the typed-address route (404), so nobody can sign in as
  someone else.
- `DRAFTROOM_GOOGLE_CLIENT_ID`: a **Web application** OAuth client whose *Authorized JavaScript origins* include the
  Lobby's origin. It is public by design; no client secret and no redirect URI are used. The OAuth consent screen must
  be *In production* (in *Testing* only listed test users can sign in). Only the basic scopes are asked for (openid,
  email, profile), which need no Google verification.
- The page's CSP allows exactly `https://accounts.google.com/gsi/*` (script, button frame, style).

## Partner API

```
PUT /api/partner/boards/:ref
Authorization: Bearer <DRAFTROOM_PARTNER_TOKEN>
Content-Type: application/json

{ "title": "James and the Giant Peach (Fall 2026)" }
```

- `:ref` is the partner's stable key, `^[a-z0-9][a-z0-9:._-]{0,119}$` (theaitre-bot sends `theaitre:production:<id>`).
- The first call creates the board (201); later calls return the same board (200) and rename it when the title changed.
  Two first calls at once make one board. Answer (`PartnerBoard` in `@draftroom/contracts`):
  `{ boardId, ref, title, url, created }`, where `url` is the board page on `PUBLIC_ORIGIN`.
- Not a browser route (like the worker protocol): exempt from the Origin check, any request with a cookie is refused
  (403), a missing or wrong token is 401, and it has its own rate limit (600 a minute with the token, 60 without).
- Call the **api's own URL**, not the static site's `/api` rewrite.
- The board key lives in `boards.external_ref` (migration `0025_open_signin`), unique per workspace.

This contract is the only thing theaitre-bot depends on (`services/lobby/client.py` there). Change it only additively,
or change both repositories together.

## Deploying a theater instance

The theater Lobby runs on the home NAS at no cost (owner's decision 2026-10-05: no new spending, the NAS or
theaitre-bot's existing Render resources only). Runbook: `deploy/nas/theater/README.md`. Summary:

- **One compose project, `lobby-theater`**, with Postgres, api, sync, a preview worker and nginx (`docker/web.Dockerfile`
  serves the built web app and proxies `/api`, `/files` and `/connect` to api and sync: **one origin**, so no
  `VITE_DRAFTROOM_SYNC_ORIGIN` and no `DRAFTROOM_EVENTS_ORIGIN`). Uploads go on a local volume (`DRAFTROOM_BLOB_STORE=fs`).
- **Reached through a Cloudflare Tunnel** (`cloudflared` in the project, outbound only; banzerinihouse.org's DNS is on
  Cloudflare) at `https://lobby.banzerinihouse.org`. No published ports.
- **Deploy and update**: `bash deploy/nas/theater/deploy-theater.sh` from the PC. It uploads the working tree's sources, builds
  on the NAS, creates the secrets there on the first run (the partner token is in `secrets/api.env`) and starts the project.
- theaitre-bot gets `LOBBY_API_URL=https://lobby.banzerinihouse.org` and `LOBBY_PARTNER_TOKEN` = that partner token.

Sharing DBC's staging was considered and not done: one server would then run open sign-in next to DBC's verified
sign-in, which needs per-account providers in the identity service and changes to the domain-access rules that were
security-reviewed for DBC. The theater instance stays a separate server running the same code.

Updates follow the code: re-running the deploy script after changing Draftroom is all it takes for every production
board to run the new Lobby. Nothing is copied into theaitre-bot.

## Tests

- `apps/api/test/open-signin.test.ts`: sign-in, the shared workspace, creators past the 24-hour grace period, no personal
  workspace (also through `GET /api/me`), partner idempotence and the concurrent first call, the partner refusals, and
  the configuration rules. Wave J under open sign-in: nobody outside (tags, Shared outside, the notice, the address
  check, Team only), feedback sent but no inbox readers, a sign-in on a shared computer ending the previous person's
  session for the sync (RT-01).
- `packages/db/test/open-signin-0025.test.ts`: the migration's constraints and the upgrade from 0024;
  `packages/db/test/outside-markers-0026.test.ts` applies wave J's 0026 and 0027 on top of it.
- `apps/api/test/features/domain-access/creation-matrix.test.ts` lists the new INSERT sites
  (`auth/shared-workspace.ts`, `routes/partner.ts`).
- Checked by hand in a browser on a local stack (api 6859, sync 6858, web 6173): theaitre-bot's "Open board" →
  partner call → board → open sign-in page → back on the board, "Saved", workspace edit access.
