# Security review — 2026-09-27

This review was done before the Render staging site is shared with external clients. It covers the web app, the Fastify API, the tldraw sync server and the preview worker, as committed at `HEAD` `1910ad8`.

**Result.** No finding gives an unauthenticated attacker access to data, and none crosses tenants for reads or writes. Nine findings were confirmed, and two of them turned out to be the same presence issue, so there are **eight distinct issues**: **3 medium** and **5 low**. The mediums are:

- **Sign out does not sign out** when Clerk is the provider (SCA-1).
- **One uploader can fill the shared 5 GB disk** (FC-1).
- **One viewer can lock a board's live event stream** for everyone else (authz-003).

Fix these three before the site is shared, together with the "Recently deleted" exposure (authz-001) and the TRUST_PROXY two-network check. See [§6](#6-prioritized-fix-plan).

## 1. Scope and method

**Surfaces reviewed.** Five areas, each with its own reviewer:

| Area | What it covered |
|---|---|
| Authorization and tenancy (`authz-*`) | Every committed API route (51 route registrations), board and workspace roles, guests, invitations, review and workshop links, access requests, files authorization, the SSE event stream, tickets |
| Sync and realtime (`SYNC-*`) | The ticket-authenticated WebSocket upgrade, read-only enforcement, access re-validation, presence, the internal sync endpoints, "Recently deleted" restore |
| Sessions, CSRF and auth (`SCA-*`) | The `dr_session` cookie, the Clerk exchange, sign-out, CSRF (Origin), rate limits, `TRUST_PROXY`, dev-auth refusal in production |
| Files and content (`FC-*`) | Upload, serve, range, Content-Disposition, MIME and sniffing, the preview worker (sharp, pdf.js, ffmpeg), board-archive import, CSV export, comment and rich-text rendering |
| Config, secrets and deploy (`CSD-*`) | `render.yaml`, Dockerfiles, the static bundle, env refusals, logging, error bodies, CORS, supply-chain settings, git history |

**Method.**

- **The repository was read-only.** Reviewers read the committed code with `git show HEAD:<path>` or `git archive HEAD`. At review time other engineers had uncommitted storage-milestone (M3) work in `apps/api`, `apps/worker`, `packages/blob-store`, `docker/` and `render.yaml`. That work was treated as in progress and only skimmed. This file is the only repository change.
- **Findings were proved with local probes where possible.** Probes used:
  - `app.inject` against the committed API, following the `apps/api/test/helpers.ts` patterns;
  - real HTTP servers on `127.0.0.1` ports 6700–6799;
  - the repo's sync server run in-process with the repo's `NodeSyncClient` test harness;
  - a fake Clerk verifier.

  Probe scripts live in the session scratch directory (`…/scratchpad/security/<area>/`), not in the repo. They may be cleaned up with that directory. Every server was stopped after use.
- **Two skeptics checked each finding.** Two independent verifiers were each asked to refute the finding. A finding is **confirmed** when verification did not refute it. Its severity here is the **lowest rating from a verifier who judged it real**. Where the verifiers disagreed, the table says so. Findings that verification refuted are listed in [§3](#3-rejected-on-verification).

**Not covered.**

- **The live Render staging site.** It was not probed or attacked in any way. `.env.deploy.local` was not read.
- **Third parties themselves.** No testing of Render, Clerk, Cloudflare or the hosted Postgres, and no penetration of those platforms.
- **Edge behavior that needs the live deployment.** This includes the real `X-Forwarded-For` chain through the static-site rewrite, edge connection and body limits, and Clerk dashboard settings (for example, whether open sign-up is enabled).
- **Real Clerk flows.** No Clerk keys were used, so SCA-1 is proved by code reading only.
- **Real-browser rendering of UI effects.** The presence spoof was proved at the protocol level. Its on-screen effect is inferred from the tldraw 5.4.2 source.
- **Sync resource limits.** Message and record sizes, many rooms and very large boards were in scope, but the sync review stopped before it finished them. They need a separate pass.
- **The uncommitted M3 storage work.** This means `apps/api/src/worker/*`, `packages/blob-store` and R2. It was skimmed only, and nothing obvious was found. Review it again once it is committed.
- **Dependency vulnerability scanning.** No CVE scan such as `pnpm audit` is part of this report.

## 2. Confirmed findings

Findings are sorted by severity after verification. Locations are line numbers at `HEAD` `1910ad8`.

| ID | Severity | Title | Location | Attack scenario | Recommended fix | Proved by probe |
|---|---|---|---|---|---|---|
| SCA-1 | **Medium** | "Sign out" and "Switch user" leave the Clerk session alive, and `/signin` signs the same account straight back in | `apps/web/src/auth/session.tsx:106-116`; `apps/web/src/auth/ClerkSignIn.tsx:28-44` | A client signs out on a shared or meeting-room computer and walks away. `signOut()` revokes only `dr_session`. On `/signin`, `ClerkSignIn` sees the still-live Clerk session and exchanges it for a new 30-day `dr_session` without a click, so the next person to open the site is that user. | End the Clerk session in `signOut` (`clerk.signOut()` alongside `api.logout()`). After an explicit sign-out, require a click ("Continue as X") before any auto-exchange, for example with a sessionStorage flag. Show a logout failure instead of a signed-out screen. | No. Code reading only; no Clerk keys. Both verifiers agree. |
| FC-1 | **Medium** | No upload quota or rate limit, so one editor can fill the API's disk (outage for every tenant) | `apps/api/src/files/plugin.ts:52-61` (no `config.rateLimit`); `apps/api/src/app.ts:166-167` (`global: false`); `apps/api/src/files/upload.ts:64` (per-request size checks only); `render.yaml:114-115` (one 5 GB disk) | Any signed-in user who can edit a board repeats `POST /api/boards/:bid/assets`. That includes an external client on an editor workshop link, or any user on a board in their own personal workspace. About 10 videos fill the 5 GB disk. Uploads, preview derivatives and checkpoint creation then fail for every workspace until an operator cleans up by hand. | Add a per-user `config.rateLimit` on the upload route. Enforce a per-workspace (and/or per-board) byte and file-count quota before accepting bytes; answer 413 or 429. The M3 move to R2 removes the shared disk, but the quota is still needed. | Yes. Both verifiers: 80 × 4 MiB and 300 × 1 MiB + 4 × 249 MiB all returned 201, never 429 or 413. |
| authz-003 | **Medium** | One viewer (for example a review-link guest) can take every event-stream slot on a board and cut everyone off live updates | `apps/api/src/events/hub.ts:27,40` (2,000 per board, the new subscriber is refused); `apps/api/src/events/routes.ts:26-56` (only `view` needed, no per-user cap) | An outsider joins through a view-only review link. They open 2,000 `GET /api/boards/:bid/events` streams from a script with their own cookie, straight to the api hostname. Every later stream on that board, the owner's included, gets `TOO_MANY_SUBSCRIBERS`, so live comments, timer, votes, "Bring everyone to me" and sharing updates stop. | Cap streams per user per board (for example 5; close the oldest when a new one opens), per user overall (for example 50) and per process. Never let one user's streams push out others. Rate-limit stream opens. | Yes. The finder and both verifiers: owner's stream refused after the outsider held 2000/2000. |
| authz-001 | Low | Viewers and outside guests can read "Recently deleted": text of notes deleted before the board was shared | `apps/api/src/features/history/index.ts:332-337` (`GET /deleted` needs `view`); `apps/web/src/features/history/HistoryPanel.tsx:347-376` (shown to every role); `apps/sync/src/deleted/label.ts:34-44` (label is the first 80 characters) | An agency writes internal notes, deletes them, then shares the board with the client by a view-only review link. The client opens History (or calls the API) and sees each deleted note's first 80 characters, who deleted it and when, for up to the last 1,000 deletions. | Require `edit` for `GET /api/boards/:bid/deleted` (restore already needs it), and hide the section unless `perms.canEdit`. At minimum, deny workspace guests and review-link redeemers. This changes a specified behavior, so update `docs/FEATURES-M2-CONTRACTS.md:95`, `docs/E2E-PLAN.md:37` and `e2e/tests/history.spec.ts:502-537` at the same time. | Yes. The finder and one verifier: the client on the view link read both deleted notes' text. |
| SCA-4 | Low | No real session revocation: the 30-day `dr_session` is never re-checked against Clerk, and there is no "sign out everywhere" or admin revoke | `apps/api/src/auth/session.ts:9` (fixed 30-day TTL, no idle timeout); `apps/api/src/auth/clerk.ts:91-105` (Clerk `sid` not stored); `apps/api/src/routes/auth.ts:21-25` (revokes only the presented cookie) | An operator offboards a client, or reacts to a phished account, by banning the user or revoking their sessions in Clerk. Every `dr_session` already issued keeps working for up to 30 days. Ending another session requires SQL. | Store the Clerk `sid` with each session. Revoke on Svix-verified Clerk webhooks (`session.revoked`, `session.ended`, `user.deleted`, `user.banned`), or re-check the session periodically. Add "sign out all devices" and an operator script. Consider a shorter TTL or an idle timeout. | Yes (one verifier): after a ban and a logout on one device, the second session's `/api/me` returned 200 until +30 days. Verdict split: the other verifier rated it hardening, not a defect. |
| authz-004 / SYNC-01 | Low | Any board participant, read-only viewers included, can publish canvas presence under another user's identity | `apps/sync/src/app.ts:159` (ticket identity only in session `meta`), `:165-166` and `:170-181` (frames go to `room.handleSocketMessage` unchecked); consumers `apps/web/src/board/presence.ts:66`, `apps/web/src/features/workshops/follow.ts:17` | A guest viewer pushes presence with the facilitator's `userId`, name and a far-future timestamp. Everyone else's tldraw keeps only the newest presence per `userId`, so the real facilitator's cursor disappears. The guest's cursor, and any cursor-chat text, shows under her name. "Bring everyone to me" and "follow" then follow the guest. The victim's own tab hides the forgery. | Bind presence to the ticket in the sync server: before `handleSocketMessage`, reject or overwrite presence `userId`, `userName` and `color` with the ticket's values, and clamp `lastActivityTimestamp`. Cover both put and patch ops. Reassemble chunked frames first, or refuse them for presence. Cap `chatMessage` length. Add a protocol test beside `apps/sync/test/protocol/readonly.test.ts`. | Yes, at protocol level: four independent probes. The on-screen takeover is inferred from the tldraw source, not run in a browser. Three verifiers rated it low, one medium. |
| SCA-2 | Low | Per-IP auth rate limit of 30 per minute per route locks out invitees behind one NAT, and a 429 on logout leaves the session valid | `apps/api/src/app.ts:115` (30/min for Clerk); `apps/api/src/routes/invitations.ts:104,137,166` (preview and accept); `apps/api/src/routes/auth.ts:21` (logout is limited); `render.yaml:137` (`TRUST_PROXY` `"3"`) | 25 clients in one office open the same workshop link. The web fetches the invite preview about 3 times per person, so from roughly the 11th person on, everyone gets "Too many requests" for the rest of the minute. Anyone sharing that public IP can also drain the buckets on purpose. | Do not rate-limit logout, or always revoke and clear the cookie first. Raise the invite preview and accept limits substantially, or key them on the token or the user; the tokens are 256-bit, so brute force is not the threat. For the Clerk exchange, count failed verifications only. Reuse the invite preview in `SignInPage` instead of fetching it again. | Partly. The NAT lockout (invitee #11 blocked, 15 of 25 hit 429) and the logout 429 were proved locally. The global-drain variant is unverified; see below. Verdict split: one verifier rated it tuning, not a defect. |
| authz-005 | Low | Revoked users keep receiving board events (full comment bodies) for up to 30 s, and streams outlive logout | `apps/api/src/events/routes.ts:16` (`ACCESS_RECHECK_MS = 30_000`), `:58-68` (periodic board check only, no session check); `apps/api/src/notifier.ts` (access changes go to sync only, never to the in-process `EventHub`) | The owner removes a client reviewer, a workshop link expires, or the board is made private. The reviewer's open stream keeps delivering new comment threads in full until its next 30 s check. That misses the 15 s revocation target in M1-CONTRACTS §7, while the canvas socket is cut immediately. | Give `EventHub` an `accessChanged(boardId, userId?)` hook. Call it wherever `notifier.accessChanged` is called, and re-check the affected streams at once. Re-validate the session in the periodic check, and shorten the interval to 10 s or less. | Yes. The finder and one verifier: comments posted right after removal, and again 25 s after it, reached the removed user. |

### Notes on the confirmed findings

- **SCA-1.** Staging runs `AUTH_PROVIDER=clerk`. The only Clerk `signOut` call in the web app is the "Use another account" button at `ClerkSignIn.tsx:62`, which appears only after an exchange error. The server-side exchange (`apps/api/src/auth/clerk.ts:72-105`) has no freshness check and no block on re-exchange after logout. The attacker needs the same browser profile after the victim, which fits the workshop and meeting-room use case. The impact is full use of the victim's account.

- **FC-1.**
  - The attacker needs no workshop link. Every first Clerk sign-in gets a personal workspace in which the user can create boards and upload (`apps/api/src/auth/users.ts:65-86`, `routes/boards.ts:82`). So any signed-in account qualifies. Whether sign-up is open is a Clerk dashboard setting, which was not checked.
  - Nothing server-side ever deletes uploaded bytes, and there is no quota or free-space check anywhere.
  - "Can grow, never shrink" in `render.yaml` refers to an operator resizing the disk. Render disks do not grow on their own, so the result is an outage, not a runaway bill.
  - Board editing (the sync service has its own disk), Postgres and sign-in keep working.

- **authz-003.**
  - Canvas editing is unaffected; only the feature event stream is denied.
  - Slots come back only when the attacker lets go, or when the owner revokes the attacker's access and the 30 s re-check closes their streams. Request logs record route patterns only, so it is hard to see who holds the slots.
  - From code reading, not probed at scale: each stream re-checks access in the database every 30 s, which is about 67 queries per second per 2,000 streams. There is no process-wide cap, so repeating this across many boards (for example, boards the attacker creates in their own workspace) could degrade the single API instance and its small Postgres for everyone.

- **authz-001.**
  - This is specified behavior, not an authorization bypass: the contract says "(view)" and the E2E suite asserts that viewers see the rows.
  - Retention is by count (the last 1,000 deletions, plus the current room session), not by time. There is no route to purge the list, so notes deleted weeks before sharing are still listed. The only workaround today is to duplicate the board.
  - Workspace-member viewers can already restore any checkpoint as a new board, so the extra exposure is mainly to guests and review-link redeemers. `requireCreator` blocks them from restore-as-new, which makes this list their only view of past content.

- **authz-004 / SYNC-01.** These are the same defect, reported independently by two reviewers and merged here.
  - `@tldraw/sync-core` 5.4.2 never authorizes presence. Its presence lane forces only `id` and `typeName`, and it runs even for `isReadonly` sessions.
  - `instancePresenceValidator` accepts any `user:*` id, any name, color and chat text, and any finite timestamp.
  - The attacker needs the victim's user id. It is visible to every participant in the victim's own presence broadcast.
  - The effect is limited to what other participants see on screen while the attacker is connected: nothing is read beyond the attacker's access, nothing is written, and nothing persists. The server-side text lease and the read-only gate still hold.
  - Cursor-chat text is rendered as React text, so there is no XSS.

- **SCA-2.**
  - The windows are fixed and reset 60 s after their first request.
  - Spoofing does not work on the direct path: with `TRUST_PROXY=3`, extra `X-Forwarded-For` entries added by the client do not change the bucket (probed).
  - **Unverified global variant.** Whether requests that arrive through the static-site rewrite all resolve to one proxy address depends on Render's `X-Forwarded-For` chain. It could not be checked without the live site; the same question was raised separately as CSD-2 in §3. If the two-network check in `docs/DEPLOY.md` ("Client IPs and TRUST_PROXY") shows that browser requests share one `req.ip`, one anonymous client could lock sign-in and invitations for every user at 30 requests per minute. That would be **high**.
  - Under Clerk, the logout-429 part adds little on top of SCA-1, because the browser signs back in anyway.

- **SCA-4.** There is also no route that removes or demotes a workspace member (authz-006 in §3; `workspace_members` rows are only ever inserted). So for a workspace-level member, banning in Clerk is the only offboarding step that needs no SQL, and it takes effect only when their sessions expire, up to 30 days later. Board-level grants can still be removed and take effect quickly. A stolen cookie is the victim's own token, so the victim signing out also kills the attacker's copy. The gap is sessions the victim cannot reach: another device, or an attacker who signed in with phished credentials.

- **authz-005.** The window is bounded and needs a stream that was already open. The honest web client probably drops its stream once the canvas reports lost access, so abusing the window takes a deliberate client that keeps the stream open. The "outlives logout" half is defense in depth: sessions are revoked only by the user's own logout, so it matters only for a stolen cookie that still has board access.

## 3. Rejected on verification

| ID | Title | Why rejected |
|---|---|---|
| authz-002 | Removing a board owner does not revoke invite links they created; they can redeem their own link | The mechanics are as described: accept never checks `created_by`, and member removal leaves links alone. The verifier judged it not a defect in the code as written: the person regains at most the link's own role (editor at most), and managers can revoke outstanding links. **Operational note:** when removing someone, also revoke the links they created. |
| authz-006 | Workspace membership cannot be revoked (no remove or demote route) | The facts are correct, but it is a missing admin feature, not something an attacker can use. It makes SCA-4 worse, so it is in the fix plan. |
| SYNC-02 | A connection ticket can be reused for many sockets while it is valid | This is the documented design (M1-CONTRACTS §6): tickets are 60-second bearer tokens, used only at connect, never logged, and fetched fresh for every connect and reconnect. |
| SCA-3 | The Clerk exchange accepts `sts: "pending"` sessions, skipping Clerk session tasks | The code-level claim was proved locally: `verifyToken` accepted a pending token. But the verifier found that the attack does not work for any of the session tasks examined. Rejecting `sts !== "active"` in `clerk.ts` remains cheap optional hardening. |
| SCA-5 | Junk tokens with unknown `kid` trigger Clerk JWKS fetches under our secret key | Each junk token does cause a fetch, but according to Clerk's published system limits the JWKS endpoint does not count against the Backend API rate limit. So the claimed exhaustion does not happen. |
| FC-2 | Forged embed or bookmark records on the live canvas bypass the archive import's URL allowlist | The live sync path does not police URLs, but it gives an attacker nothing that editors cannot already do by design. For example, a local probe of tldraw's embed and sandbox logic showed a `data:` embed adds no capability. |
| FC-3 | The display-name sanitizer keeps Unicode bidi/RTL-override characters | A name can render reversed in the file card's name line. No working download-filename spoof was shown, because Content-Disposition escapes non-ASCII (probed with RTL names; see §4). Stripping bidi controls is optional polish. |
| CSD-1 | The co-located preview worker inherits every API secret | True of the committed `docker/api-and-worker.mjs`. It is a blast-radius concern that matters only if a decoder 0-day exists. The M3 work in progress splits the worker into its own image with its own env group. |
| CSD-2 | `TRUST_PROXY=3` behind the static-site rewrite may give all browser users one shared rate-limit bucket | Rejected as unverified: it depends on Render's `X-Forwarded-For` chain, which cannot be checked without the live site. `docs/DEPLOY.md` already records this and requires a two-network check. **That check is a must-do item in §6**, because the outcome, if positive, is high severity. |
| CSD-3 | The `.env.example` placeholder secrets are accepted under `NODE_ENV=production` | It needs an operator to ignore explicit instructions. `render.yaml` uses `generateValue` or `sync: false` for secrets. |
| CSD-4 | Fastify router-level errors (bad URL, parameter too long) skip the error handler and echo the URL | The behavior is as described. It is not exploitable: the body is JSON and repeats only the requester's own URL. Setting `frameworkErrors` is minor hardening. |
| CSD-5 | Rewrite destinations and the sync origin hard-code `onrender.com` names that someone else could claim | Render assigns these names first come, first served. Once the services exist under these names, nobody else can claim them. It is an operational concern only if a service is deleted or renamed. |

## 4. Checked and OK, by surface

These are summaries. The reviewers' lists name the specific files and probes.

**Authorization and tenancy.**

- **Board-scoped routes.** Every one goes through `requireBoardAction` / `loadBoardAccess` and `packages/permissions`: 404 without view (no existence leak), 403 for view without the right to act.
- **Cross-workspace access by id is closed** for threads, comments, votes, snapshots, access requests, review links, invitations and notifications.
- **Files.** Upload needs `edit`. Reads need `view` plus same-board ownership or a same-workspace `board_asset_links` row. Duplicate and restore drop foreign assets.
- **Read-only roles** cannot mutate, on the API or on the canvas (the sync server makes viewer and commenter sessions read-only).
- **Trashed and archived boards.** Trashed returns 404 on every read path. Archived is read-only.
- **Guests** see only explicit grants and cannot create, import, duplicate or restore as new.
- **Invitations and links.** Tokens are 256-bit and stored as hashes. Single use is enforced under a row lock. Invitations cannot grant owner, and accepting never downgrades a role. Review and workshop links have caps and lifetimes enforced by the database, and the expiry sweeper never touches owner grants.
- **Last-owner protection** holds.
- **Internal endpoints** require the internal secret, compared in constant time.
- **CSRF.** Every mutation requires `Origin === PUBLIC_ORIGIN`.
- **Clerk identity** is keyed on the Clerk `sub`, with no linking by email.

**Sync and realtime.**

- **Tickets.** HMAC compared with `timingSafeEqual` before parsing. Expiry, `iat` skew, board binding and the role allowlist are all checked. The ticket is verified before any room opens. Tickets and URLs are never logged.
- **Path traversal.** The board-id regex blocks traversal and case-split rooms.
- **Origin allowlist.** Required, https-only in production, and checked before the upgrade.
- **Read-only enforcement.** Holds, including refusal of `typeName` swaps, and the lease authorizer fails closed.
- **Session ids** are namespaced by the verified user id.
- **Access re-validation** closes sessions on revocation or role change.
- **Internal endpoints** are secret-gated, with body limits.
- **"Recently deleted" restore** validates ids and records and never overwrites existing shapes.
- **Outbound internal fetches** use `redirect: 'error'`.
- *Resource limits were not finished* (see §1).

**Sessions, CSRF and auth.**

- **Origin check on every mutation.** A probe of 142 routes got 403 on every POST, PUT, PATCH and DELETE with a missing, foreign or `null` Origin, or with a trailing-slash variant.
- **The `dr_session` cookie.** 256-bit random value, SHA-256 stored, strict format check, `HttpOnly`, `Secure`, `SameSite=Lax`, host-only. `onrender.com` is on the Public Suffix List, so sibling apps cannot set cookies for it.
- **Sign-in rotates the session.** It revokes the browser's previous session, so fixation fails. Cross-site logout and cross-site Clerk exchange are refused.
- **Clerk verification.** `authorizedParties` is set to `PUBLIC_ORIGIN`, and a missing `azp` is rejected. M2M tokens are rejected. Token length is capped. Tokens and claims are never logged.
- **Dev auth is impossible under `NODE_ENV=production`.**
- **`TRUST_PROXY=3` on the direct path** is not spoofable.
- **Invite URLs** are built from `PUBLIC_ORIGIN`.
- **`safeReturnTo`** blocks open redirects.

**Files and content.**

- **Paths.** Ids and keys are validated, so no user input reaches a path segment.
- **Inline serving.** Originals are served inline only for allowlisted MIME types; SVG is never inline. Every file response has `nosniff` and `CSP: sandbox; default-src 'none'`.
- **Headers and ranges.** Content-Disposition encoding and Range handling were probed with hostile inputs.
- **Upload size.** The body is streamed with an independent byte cap and an exact Content-Length.
- **ffmpeg.** Runs with an argv array (no shell), a file-only protocol whitelist and a minimal env.
- **pdf.js.** Runs in an isolated, memory-capped, credential-free child with a kill timeout.
- **sharp.** Uses a loader allowlist and a pixel limit.
- **Video containers** are pre-scanned before decode.
- **Archive import.** Hostile JSON is bounded, and prototype-pollution keys are blocked.
- **CSV exports** neutralize formula injection.
- **Comments and mentions** render as escaped React text. There is no `dangerouslySetInnerHTML`, `innerHTML` or `eval` anywhere.
- **Image and video assets** resolve only the app's own `/files/…` refs.
- **Rich-text links** filter `javascript:`.

**Config, secrets and deploy.**

- **`render.yaml` secrets.** All `sync: false` or `generateValue`, with independent ticket and internal secrets. The Postgres `ipAllowList` is empty, and `DATABASE_URL` uses the internal connection string.
- **Dockerfiles.** Base image pinned by digest. The container drops privileges with `no-new-privs`. No build args reach a layer, and `.dockerignore` excludes env files and `.git`.
- **Static bundle.** A production build inlined only the sync origin and the (public) tldraw license key. No source maps, and debug hooks are eliminated.
- **Env refusals.** Unsafe production env combinations are refused (probed).
- **Logs.** A probe with about 25 request shapes found no tokens, cookies, query strings or secrets in the logs.
- **Error bodies** are generic.
- **CORS.** None.
- **The sync upgrade** refuses a foreign or `null` Origin.
- **Static-site headers.** `nosniff`, `X-Frame-Options: DENY` and a strict Referrer-Policy. There is no CSP or HSTS; that is a hardening item, and no concrete injection vector was found.
- **Supply chain.** Pinned pnpm, frozen lockfile, `minimumReleaseAge`, strict dependency builds, and CI actions pinned to SHAs with read-only permissions.
- **Git history.** No real keys.

## 5. Residual risks accepted by design (not re-reported)

These are documented product decisions: transfer of ownership to a guest; a removed review-link guest can rejoin while the link is open; a viewer who is a workspace member can duplicate a board or restore a checkpoint as a new board; and sync fails open when the API cannot answer an access check (M1 §7).

## 6. Prioritized fix plan

**Must fix before external users**

1. **SCA-1: make sign-out end the Clerk session.** Call Clerk `signOut` and require an explicit click before any auto-exchange after a sign-out. Add an E2E test: sign out, reload `/signin`, and the user is still signed out.
2. **FC-1: upload quota and rate limit.** Add a per-user rate limit on `POST /api/boards/:bid/assets` and a per-workspace byte and file-count quota. Until the quota ships, add a disk-usage alert on the api disk.
3. **authz-003: per-user and process-wide caps on event streams.** Make sure one user's streams can never push out other users.
4. **authz-001: restrict "Recently deleted" to editors.** Change the route and the panel, and update the contract, `E2E-PLAN.md` and `history.spec.ts` with it. This is small, and it closes the one confirmed path by which external clients read content the owner believed was gone.
5. **Run the `TRUST_PROXY` two-network check** from `docs/DEPLOY.md` through the static site (SCA-2's global variant and CSD-2). If browser requests share one `req.ip`, switch `TRUST_PROXY` to an address list before sharing the site, because otherwise a single anonymous client could lock sign-in for everyone.
6. **Offboarding runbook (interim for SCA-4 and authz-006).** Document how to remove someone:
   - remove their board memberships;
   - revoke the invite and review links they created;
   - revoke their sessions with `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`.

   Banning in Clerk alone is not enough.

**Fix soon after (before a wider rollout)**

7. **authz-004 / SYNC-01: bind presence identity to the ticket** in the sync server, with a protocol test.
8. **SCA-2: tune the rate limits.** Stop rate-limiting logout. Raise or re-key the invite preview and accept limits. Count only failed Clerk exchanges. Stop the duplicate preview fetch.
9. **SCA-4 and authz-006: real revocation.** Store the Clerk `sid`, add Clerk webhooks or a periodic re-check, add "sign out all devices", add a route to remove or demote workspace members, and consider an idle timeout.
10. **authz-005: revoke event streams immediately** through an `EventHub` hook. Re-check the session, and use an interval of 10 s or less.

**Follow-up reviews and hardening**

- Finish the sync resource-limit review: message and record sizes, many rooms, very large boards.
- Review the M3 storage work (worker routes, `packages/blob-store`, R2 signed URLs) once it is committed.
- Optional hardening from §3: reject Clerk `sts !== "active"`; set Fastify `frameworkErrors`; strip bidi controls from display names; give the worker a minimal env if the co-located topology remains; add CSP and HSTS on the static site.
- Run a dependency vulnerability scan.
