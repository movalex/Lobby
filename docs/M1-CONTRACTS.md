# Milestone 1 contracts: accounts, workspaces, boards, permissions, tickets

Integration owner: main session. Builds on `docs/M0-CONTRACTS.md` (sync/lease/file/worker contracts stay valid unless changed here). Plan reference: build plan §6–§7, §11; handoff "Milestone 1 prompt".

Local-first constraint: no paid or external services exist yet (no Clerk keys, no Render, no R2, no Docker/Postgres on the dev PC). Therefore:
- **Postgres** is real Postgres via **PGlite** (in-process WASM build of Postgres) for dev and tests, and `pg` against `DATABASE_URL` in deployments. One SQL dialect, one migration set.
- **Sign-in** is an `AuthProvider` interface. `dev` provider (only with `DRAFTROOM_DEV_AUTH=1`) is fully working; the `clerk` provider is written against the real `@clerk/backend` types but is **UNVERIFIED** until keys exist, and must say so in the UI/docs.
- Object storage stays the M0 local-disk store (`packages/dev-assets`) behind the same URL contract.

## 1. Processes

| Process | Port | Owns |
|---|---|---|
| `apps/api` (Fastify 5) | `127.0.0.1:5859` | Postgres (users, workspaces, boards, ACLs, invitations, and later comments/snapshots/workshops), sessions, board tickets, **file routes** (moved from sync), SSE events |
| `apps/sync` | `127.0.0.1:5858` | canvas rooms only (no file routes after M1), ticket verification, access re-validation, internal snapshot/seed endpoints |
| `apps/worker` | — | previews (unchanged) |
| `apps/web` | `127.0.0.1:5173` | SPA; Vite proxies `/api` and `/files` → api, `/connect` (ws) → sync |

Env (all processes refuse to start on invalid config; `dev.env` files hold dev-only values):
- `DRAFTROOM_DATA_DIR` (shared), `DRAFTROOM_DEV_AUTH=1` (dev only)
- `DRAFTROOM_TICKET_SECRET` (api signs, sync verifies; ≥32 chars), `DRAFTROOM_INTERNAL_SECRET` (api↔sync internal calls; ≥32 chars). With `NODE_ENV=production`, the dev defaults are rejected.
- api: `PORT`, `HOST`, `DATABASE_URL` (optional; else PGlite at `${DATA}/pg`), `DRAFTROOM_SYNC_INTERNAL_URL` (default `http://127.0.0.1:5858`), `PUBLIC_ORIGIN` (default `http://127.0.0.1:5173`, used for Origin checks and invite links), `AUTH_PROVIDER=dev|clerk`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`.
- sync: `DRAFTROOM_API_INTERNAL_URL` (default `http://127.0.0.1:5859`), `ACCESS_RECHECK_MS` (10000).

## 2. Database (`packages/db`)

- `openDb(config)` → `Db` with `query<T>(sql, params)`, `one/maybeOne`, `transaction(fn)`; implementations: PGlite (file or memory) and `pg.Pool`.
- Migrations: `packages/db/migrations/NNNN_name.sql`, applied in order in one transaction each, recorded in `schema_migrations`. Numbers are pre-allocated: `0001_core` (M1), `0002_comments`, `0003_snapshots`, `0004_workshops`, `0005_share_links`. Never edit a shipped migration.
- Ids: `usr_`, `wsp_`, `prj_`, `inv_`, `thr_`, `cmt_`, `snp_`, `wks_`, `vot_` + 20 base62 (same generator as dev-assets). Board ids keep the sync format `b-` + 10 lowercase base36.
- Every tenant row carries `workspace_id`; every board-scoped query filters by it.

`0001_core` tables: `users(id, name, handle unique null, color, avatar_url, created_at)`, `identities(provider, subject, user_id, unique(provider, subject))`, `sessions(id_hash pk, user_id, created_at, expires_at, revoked_at)`, `workspaces(id, name, created_by, created_at)`, `workspace_members(workspace_id, user_id, role owner|admin|member|guest, pk(workspace_id,user_id))`, `projects(id, workspace_id, name, created_at, archived_at)`, `boards(id, workspace_id, project_id null, title, visibility private|workspace_view|workspace_edit default private, status active|archived|trashed, trashed_at, created_by, created_at, updated_at, last_opened_at)`, `board_members(board_id, user_id, role owner|editor|commenter|viewer, added_by, pk)`, `invitations(id, token_hash unique, workspace_id, board_id null, role, created_by, expires_at, redeemed_by null, redeemed_at, revoked_at)`, `audit_events(id bigserial, workspace_id, actor_id, action, target, detail jsonb, at)`.

## 3. Permissions (`packages/permissions`, pure functions, exhaustively unit-tested)

`resolveBoardRole({ workspaceRole, boardGrant, visibility, boardStatus })` → `owner | editor | commenter | viewer | null`:
1. Workspace `owner`/`admin` → `owner` on every board in the workspace.
2. Explicit board grant → that role.
3. Else workspace `member` + `visibility` `workspace_edit` → `editor`; `workspace_view` → `viewer`; `private` → `null`.
4. `guest` never gets access without an explicit grant.
5. `trashed` boards → `null` for everyone except owners (who may restore). `archived` boards are read-only (`viewer` cap) until restored.

`can(role, action)`: `view` (all), `comment` (owner, editor, commenter), `edit` (owner, editor), `rename` (owner, editor), `manage_access` / `archive` / `trash` / `restore` / `change_visibility` (owner). No existence leaks: callers without `view` get 404.

DEVIATION (as implemented in `packages/permissions`): status is not an input of the role. `resolveBoardRole({ workspaceRole, boardGrant, visibility })` returns the role ignoring status, and status is applied by `can(role, action, status = 'active')` / `canEditCanvas(role, status)`. Why: the role is a property of (user, board) while the status changes on its own, and the dashboard needs the uncapped role to offer owners Restore on archived/trashed boards. The rule 5 effect is the same, made exact:
- `archived`: `view` for every role; owners may also `restore`, `trash` and `manage_access`; nothing else (no canvas edits, rename or visibility changes).
- `trashed`: nobody can open it, owners included (`GET /api/boards/:bid`, tickets and file routes answer 404); owners see it in their Trash list and may only `restore` it.
- The connection role (ticket route and `GET /internal/access`, one function `connectionRole()` in `apps/api/src/access.ts`) is `null` for trashed boards, `viewer` for archived boards, and the resolved role otherwise. `GET /api/boards/:bid` returns the resolved (uncapped) role together with `board.status`, so the UI computes `can(role, action, status)` itself.

## 4. Sessions and CSRF

- Cookie `dr_session` (random 32 bytes; DB stores sha256), `HttpOnly; SameSite=Lax; Path=/` (+ `Secure` when `PUBLIC_ORIGIN` is https), 30-day expiry.
- Mutating requests (`POST/PUT/PATCH/DELETE`) must carry `Origin` equal to `PUBLIC_ORIGIN` (403 otherwise) and a JSON body or no body.
  DEVIATION: the file upload `POST /api/boards/:bid/assets` takes the raw file bytes (any `Content-Type`), so it is exempt from "JSON body or no body"; it still needs the `Origin` check and `edit`. Every other mutation with a non-JSON body gets `415 UNSUPPORTED_MEDIA_TYPE`. Why: M0-CONTRACTS §5 (kept unchanged here) streams uploads as the request body.
- Authorship always comes from the session, never from the request body.

## 5. HTTP API (JSON; errors `{ error: { code, message } }`)

| Method + path | Who | Result |
|---|---|---|
| `POST /api/auth/dev/login {handle, name?}` | dev only (404 otherwise) | upsert dev user (identity `dev:<handle>`), session cookie. First login also joins the shared **Dev Studio** workspace (first user = owner, later = member) and gets a personal workspace. |
| `POST /api/auth/logout` | any | 204, session revoked |
| `GET /api/me` | signed in | `{ user, workspaces: [{id, name, role}] }`; 401 otherwise |
| `GET /api/auth/config` | public | `{ providers: ['dev'] | ['clerk'], clerkPublishableKey? }` |
| `GET /api/workspaces/:wid/boards?status=&q=&projectId=` | member/guest | boards the caller can view, with `role`, sorted by `last_opened_at`/`updated_at` |
| `POST /api/workspaces/:wid/boards {title, projectId?}` | member+ | new private board, creator = board owner |
| `GET /api/boards/:bid` | view | `{ board, role, workspace: {id,name} }`; touches `last_opened_at` |
| `PATCH /api/boards/:bid {title?, projectId?, visibility?}` | rename / change_visibility | updated board |
| `POST /api/boards/:bid/{archive,trash,restore}` | owner | updated board; access change pushed to sync |
| `GET /api/boards/:bid/members` | view | `[{ user, role, source: 'grant'|'workspace' }]` |
| `PUT /api/boards/:bid/members/:uid {role}` / `DELETE …/members/:uid` | manage_access | grant/change/revoke; pushes `access-changed` to sync; the last owner cannot be removed |
| `GET/POST /api/workspaces/:wid/projects`, `PATCH /api/projects/:pid` | member+ | projects |
| `GET /api/workspaces/:wid/members` | member+ | workspace members (name-only guests left out): `{ members: [{ user, role }] }`, owners first |
| `PATCH /api/workspaces/:wid/members/:uid {role}` | ws admin+ (authz-006) | change a member's workspace role; answers the updated `{ members }` list. 404 for an id that is no member (a name-only guest account included), 403 `OWNER_ONLY` when a caller who is not an owner changes, removes or makes an owner, 409 `LAST_OWNER` / `PERSONAL_WORKSPACE_OWNER` when the workspace would lose its last owner or its personal workspace's person. Domain access: raising a role is creator-only (403 `CREATOR_REQUIRED`) and admin or owner go to creators only (409 `ROLE_REQUIRES_CREATOR`); lowering is open to every manager. A change that moves someone's access on a board is pushed to sync and the event streams (`accessChanged`, at most 500 boards, most recently opened first). The identity provider is asked about the target only for a raise to admin or owner by a creator, and only after the target is known to be a member. |
| `DELETE /api/workspaces/:wid/members/:uid` | ws admin+ (authz-006) | remove a member (same 404/403/409 rules; a manager may remove themselves unless they are the last owner); answers the updated `{ members }` list. In the same transaction: every board grant the person holds in the workspace is deleted (trashed boards too), the unused single-use invitations they sent are revoked, their pending access requests are denied, and `accessChanged` is pushed for every board they could open. Multi-use links they made stay open and are named in the audit entry. Audited as `workspace.member.remove` (`boardGrantsRemoved`, `invitationsRevoked`, `accessRequestsDenied`, `linksKept`, `linkIdsKept`) and one `invitation.revoke` (`via: 'member_removed'`) per revoked invitation. |
| `POST /api/workspaces/:wid/invitations {role}` / `POST /api/boards/:bid/invitations {role}` | ws admin+ / manage_access | `{ id, url, expiresAt }` — token shown once, 7-day expiry |
| `GET /api/invitations/:token` / `POST /api/invitations/:token/accept` | public / signed in | preview / redeem (idempotent for the same user; expired/revoked/used-by-other → 410). Board invitations add a `guest` workspace membership when needed. |
| `DELETE /api/invitations/:id` | creator or manager | revoke |
| `POST /api/boards/:bid/ticket` | view | `{ ticket, expiresAt, role, user: {id, name, color} }` — 404 without access |

DEVIATION: `GET /api/boards/:bid/members` answers `{ members: [{ user, role, source }] }` (`ListMembersResponse` in `packages/contracts`), not a bare array; `PUT`/`DELETE …/members/:uid` answer the same `{ members }` list after the change. Why: the shared zod schema was written that way and both apps use it.

DEVIATION (added route): `POST /api/auth/clerk/session` with `Authorization: Bearer <Clerk session JWT>` exchanges a verified Clerk token for a `dr_session` cookie and answers `Me` (only with `AUTH_PROVIDER=clerk`; **UNVERIFIED** until Clerk keys exist). Why: Clerk's own session lives in the browser; the API still needs its own first-party session cookie.

File routes move from sync to api with the **same paths and behavior** as `docs/M0-CONTRACTS.md` §5, except identity comes from the session: upload `POST /api/boards/:bid/assets` needs `edit`; meta `GET /api/boards/:bid/assets/:ast/:ver` and `GET /files/:ast/:ver/{original,d/:drv}?board=:bid` need `view` on that board (and the asset must belong to it). `devUser` query params are gone.

## 6. Board connection tickets

`v1.<base64url(JSON claims)>.<base64url(HMAC-SHA256(DRAFTROOM_TICKET_SECRET, "v1." + payload))>`; claims `{ bid, uid, name, color, role, iat, exp, jti }`, lifetime **60 s** (connect-time only). Sync: `GET /connect/:bid?sessionId=&ticket=` → verify with `timingSafeEqual`, `exp`, `bid === path`; failure → upgrade then `4099 NOT_AUTHENTICATED`/`FORBIDDEN`. Session meta `{ userId, role, name }`; `isReadonly = role ∉ {owner, editor}`. Session id stays `${uid}:${clientSessionId}`. Tickets and query strings are never logged.

The web `useSync` `uri` function fetches a fresh ticket on every (re)connect. A 404/403 from the ticket endpoint means access is gone: the board page shows "You no longer have access to this board".

## 7. Access re-validation (target: revoked/downgraded within 15 s)

- api → sync `POST /internal/access-changed {boardId, userId?}` (header `x-draftroom-internal: <secret>`) after every grant/revoke/visibility/status change → immediate re-check.
- sync → api `GET /internal/access?boardId=&userId=` → `{ role | null }` (same header). Sync re-checks every `ACCESS_RECHECK_MS` for each (board, user) with live sessions.
- Result `null` → `closeSession(sid, 'FORBIDDEN')` (terminal on the client). Role changed → `closeSession(sid)` without a fatal reason → the client reconnects with a new ticket carrying the new role. API unreachable → keep sessions (fail-open for availability, logged), because tickets already bound admission.

## 8. Internal canvas endpoints (sync, internal secret required)

- `GET /internal/boards/:bid/snapshot` → the room's current snapshot (opens the room if needed; for checkpoints/exports/templates).
  DEVIATION: for a board that has no storage yet, sync answers the empty default snapshot (document + page, current schema) WITHOUT opening a room or creating a database. Why: creating storage there would make a later `seed` of that new board fail with 409.
- `POST /internal/boards/:bid/seed {snapshot}` → initializes a **new** board's storage from a snapshot/record set; `409` if the board database already exists and is initialized (never overwrites a board).

## 9. Web

Routes: `/signin`, `/` (redirects to the last workspace dashboard), `/w/:wid` (dashboard: recent, all boards, projects, archived, trash; create/rename/archive/trash/restore; search by title), `/b/:bid` (board), `/invite/:token`. The board top bar gains: editable title (if `rename`), role badge, **Share** dialog (members + roles, invite link with role, visibility), and keeps presence/connection. Viewers/commenters get a read-only editor (`editor.updateInstanceState({ isReadonly: true })`) — UI only; the server is the enforcement.
