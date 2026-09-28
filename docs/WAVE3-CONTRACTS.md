# Wave 3: contracts

Integration owner: main session. Builds on docs/M1-CONTRACTS.md, docs/FEATURES-M2-CONTRACTS.md (§1 extension points still bind: feature folders, events published after commit with payloads safe for every viewer, `requireBoardAction` / `requireWorkspaceRole` for every decision, 404 = no existence leak, styles only through `--dr-*` tokens) and docs/M3-STORAGE-CONTRACTS.md (blob store, asset tables). Security baseline: docs/SECURITY-REVIEW-2026-09-27.md; do not reopen anything it fixed.

Product context: the app is **Lobby**, Dark Burn Creative's internal whiteboard (one lobby per DBC project). User-visible text says "Lobby"; code names stay `draftroom`. Every new UI works in light and dark themes and at phone width (390 px).

## 1. Shared rules for this wave

- **Branch base**: main with the Lobby rename, the security fixes and M3. If your worktree starts older than the commit that adds this file, fast-forward it to `origin/main` before you change anything.
- **Migrations** (numbers pre-allocated; never edit a shipped one): `0009_guests` (guests), `0010_private_notes` (private-notes), `0011_board_thumbnails` (thumbnails), `0012_board_export_policy` (export-control). Add yours to the shipped list in `packages/db/test/migrate.test.ts`; integration merges the four list edits. Every tenant row carries `workspace_id`.
- **Contracts**: each owner has `packages/contracts/src/<owner>.ts`, already created empty and re-exported from `index.ts` (do not edit `index.ts`). Extend other contract files only where §2 allows it, append-only.
- **Registries** (pre-registered stubs; do not edit the registries): api `apps/api/src/features/{guests,thumbnails,export-control}/index.ts` export `register<Name>(app, ctx)`; web `apps/web/src/features/thumbnails/index.tsx` exports `thumbnailsFeature`. Private notes live inside the existing workshops feature.
- **Tests**: unit/API tests next to your code (`apps/api/test/features/<owner>/**` for api features), one browser suite `e2e/tests/<owner>.spec.ts`. Run the whole affected project suites, not just yours. `E2E_PORT_BASE` is assigned per owner in the task, so parallel runs never share ports.
- **Deviation list**: every file you change outside your owned paths must be one §2 allows, and your report lists it with the reason. Keep those edits minimal and additive.
- **No secrets**: never read `.env.deploy.local` or any `.env*` file with real values. Live R2 tests stay opt-in (`DRAFTROOM_LIVE_R2=1`) and are not required.
- **Out of scope for everyone**: email delivery (Resend comes later), Office previews, mind maps/Kanban, DBC Ops integration.

## 2. Owners

### guests: name-only guests
Owns `apps/api/src/features/guests/**`, `apps/api/test/features/guests/**`, `packages/contracts/src/guests.ts`, `0009_guests.sql`, `apps/web/src/invite/**`, `e2e/tests/guests.spec.ts`. May change (minimal): `apps/api/src/auth/{session,users}.ts`, `apps/api/src/routes/{auth,invitations,workspaces,boards}.ts` (guest refusals), `apps/api/src/features/dashboard/review-links.ts` + an append to `packages/contracts/src/dashboard.ts` (the `allowGuests` flag), the review/workshop link UI in `apps/web/src/features/sharing/**` or `apps/web/src/board/ShareDialog.tsx`, `apps/web/src/App.tsx` (routes), `apps/web/src/dashboard/**` (a guest's dashboard), `apps/web/src/auth/UserMenu.tsx`, and the ticket/presence name, if that is where the guest marker goes.

- A manager creating a review link (viewer/commenter) or a workshop link (editor) can tick **"Anyone with the link can join with just a name (no account)"**. Off by default; stored on the invitation.
- The invite page for such a link offers "Join as a guest" (a name, 1–40 characters after trimming, no control characters) and "Sign in instead". `POST /api/invitations/:token/guest {name}` creates a guest user with no identity, a `guest` workspace membership and the board grant at the link's role. It goes through the same redemption path as accept, so the 0005 use counter, max uses and expiry apply. It then starts a session (`dr_session`) that expires at the link's expiry or after 7 days, whichever comes first. `/api/me` reports `kind: 'guest'`.
- Guests reach only the boards they were granted through guest links, and nothing else:
  - They cannot create workspaces, projects or boards, or invitations and links.
  - They cannot request access to other boards, or redeem a normal (non-guest) invitation. That returns 403 "Sign in with an account to accept this invitation".
  - They cannot list workspace members beyond the people on their boards.
  - A guest who opens a second guest link gets that grant on the same guest user.
- People can tell a guest from a member wherever names show (cursor label, people list, comments, share dialog member list), for example "Sam (guest)". The raw name is stored; the marker is added at display.
- Revoking the link with removal, the link expiring (the existing sweeper) or removing the guest from the board ends their access. Board access ends through the existing M1 revocation push; any guest session left with no board grants is revoked too.
- Abuse limits: guest creation limited per client IP (for example 10 per 10 minutes, reusing `apps/api/src/rate-limit.ts`) and at most 200 guests per link.
- UX: a guest lands straight on the board. Their dashboard lists only their boards, with "You're a guest. Sign in with an account to keep access." The user menu shows "Guest", and sign-out explains they need the link again.
- Tests:
  - an API matrix of every refusal above;
  - an e2e run in a fresh browser context: join with a name, see the board, the marker shows for the other user, a commenter guest can comment, revoking the link ends the guest's view within seconds.

### private-notes: private brainstorming (workshops)
Owns `apps/api/src/features/workshops/private-notes*.ts` (registered from `workshops/index.ts`), `apps/api/test/features/workshops/private-notes*.test.ts`, `apps/web/src/features/workshops/private-notes/**` (wired into the workshops index, bar and CSS), an append to `packages/contracts/src/workshops.ts`, `0010_private_notes.sql`, `e2e/tests/private-notes.spec.ts`. On the sync side it owns a new `apps/sync/src/http/place-notes.ts` and its tests. It may change one entry in `apps/sync/src/http/router.ts` and one client method in `apps/api/src/sync-internal.ts`.

The build plan rule (§9): drafts live in a private server namespace and are revealed into the board in a controlled operation. Never hide already-broadcast text with CSS.

- **Start**: an editor starts "Private brainstorm" with a prompt, a target (the selected frame, or a new frame named "Private ideas" placed in view) and an **Anonymous** toggle. One active session per board. Every client sees the session, its prompt and live counts ("7 notes from 4 people"); the counts come from events.
- **Drafting**: editors write notes in a "My private notes" panel, backed by Postgres rows readable only by their author, with text ≤ 500 characters and a color from the note palette. They can add, edit and delete them. Other people, the facilitator included, never receive another person's draft text before reveal: not in events, and not from any route.
- **Reveal** (the starter or a board owner):
  - The api marks the session revealed in one transaction.
  - The sync server then puts every draft into the board as real note shapes, laid out in a grid inside the target frame, grouped by author unless anonymous. This goes through the new internal endpoint, in one storage transaction, validated like the existing restore endpoint, and TLSocketRoom broadcasts it.
  - Shape ids are derived from the draft ids, so a retried or doubled reveal never duplicates notes. If the sync call fails, the session shows "Place notes" to retry.
  - Placed drafts are deleted from Postgres.
  - **Anonymous**: no author in shape meta, no author color, and no route that reveals who wrote what, before or after. Stay compatible with the existing "Hide note authors".
- **Cancel** discards every draft.
- **Tests**:
  - API: author-only reads, count-only events, reveal idempotency, the anonymous rules;
  - the sync endpoint;
  - e2e with two users: B cannot see A's text, checked in B's DOM and through B's API calls; the reveal places every note in the frame for both users; an anonymous reveal carries no author; a double reveal places each note once.

### thumbnails: dashboard board thumbnails
Owns `apps/api/src/features/thumbnails/**` and tests, `packages/contracts/src/thumbnails.ts`, `0011_board_thumbnails.sql`, `apps/web/src/features/thumbnails/**` (the capture BoardFeature) and `e2e/tests/thumbnails.spec.ts`. May change: `apps/web/src/dashboard/{BoardCard.tsx,dashboard.css,dashboard-api.ts,model.ts}`, and an append to the board-list response in `packages/contracts` (`thumbnailVersion`) plus its producer in `apps/api/src/routes/boards.ts` / `serialize.ts`.

- **Capture**: an editor's client captures the board when it changed:
  - 20 s after local changes settle, at most every 2 minutes;
  - when the editor leaves (tab hidden or navigating to the dashboard).
  
  It renders the owner's start view if one is set, otherwise the page content bounds, at 480×300 at most, as WebP (PNG fallback), ≤ 200 KB. Viewers, commenters and guests never upload. Capture must never block editing or visibly stall the canvas.
- **`PUT /api/boards/:bid/thumbnail`**:
  - edit permission; a raw body capped at 256 KB;
  - magic-byte check (PNG/WebP/JPEG only), and header dimensions ≤ 1024×1024;
  - rate limit of 1 per board per 30 s;
  - stored in the blob store under `thumbnails/<workspaceId>/<boardId>/<version>`, recorded in `board_thumbnails`; the previous blob is deleted after the swap.
- **`GET /api/boards/:bid/thumbnail`**:
  - view permission, 404 otherwise;
  - an ETag;
  - `Cache-Control: private, max-age=0, must-revalidate` (a versioned `?v=` may be cached longer);
  - `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`.
- **Board lists** include `thumbnailVersion` (null if none).
- **Card**: the dashboard card shows the thumbnail (lazy-loaded, 16:10, cover, a theme-aware background), with today's placeholder when there is none or it fails to load.
- Thumbnails are board content: only people who can view the board ever get one. Private-brainstorm drafts are never in them, because they are not on the canvas.
- **Tests**: the API (permissions, validation, rate limit, replace deletes the old blob); e2e: edit, go back to the dashboard, the card shows a thumbnail; a viewer's upload is refused.

### export-control: "viewers can export and download" per board
Owns `apps/api/src/features/export-control/**` and tests, `packages/contracts/src/export-control.ts`, `0012_board_export_policy.sql`, `e2e/tests/export-control.spec.ts`. May change (minimal, a policy check or UI gate only):
- api: `apps/api/src/files/serve.ts` or `apps/api/src/files-auth.ts` (original downloads), `apps/api/src/features/history/index.ts` (board JSON / archive export);
- web: `apps/web/src/features/present-export/**` (export and copy entries), `apps/web/src/file-card/**` (Download), the share dialog (`apps/web/src/features/sharing/**` or `apps/web/src/board/ShareDialog.tsx`) and `apps/web/src/features/canvas-ux/**` (copy actions).

- **Setting**: board setting `exportPolicy`: `everyone` (default, today's behaviour) | `editors`. Board owners change it in the share dialog: "Viewers and commenters can export, copy and download files". Help text: like Miro's, this is not a data-protection feature, because people can still take screenshots.
- **Server enforcement** when the policy is `editors`, for viewers, commenters and guests:
  - original file downloads get 403 `EXPORT_DISABLED`, while previews and derivatives that render on the canvas keep working;
  - board JSON and archive export get 403.
- **Client**: the Export PDF/PNG, Copy as PNG and copy (Ctrl/Cmd+C) entries and the file-card Download are hidden or disabled, with "The board owner turned off exporting for viewers".
- A change publishes a board event, so open clients update without a reload.
- **Tests**: an API matrix (role × policy × route); e2e: the owner flips it, the viewer's export entries disappear live, and the viewer's original download is 403.

### offsite-backups: board backups to R2
Owns `apps/sync/src/backup/**`, `apps/sync/test/backup/**`. May change: `apps/sync/src/config.ts` (backup store settings), `apps/sync/package.json` (dependency on `@draftroom/blob-store`, scripts), the sync service's envVars in `render.yaml`, and the backups section of `docs/DEPLOY.md`.

- **Upload**: after each successful local backup (the existing consistent `backup()` flow), upload the file to the blob store under `backups/sync/<boardId>/<stamp>-c<clock>.sqlite`, streamed and never buffered whole (the sync service has 512 MB, shared with every open room). Also upload a per-board `manifest.json` with, per entry: sha256, document clock, schema, size, time, and the asset ids the board references (file-card shapes). That is the build plan's "coordinated manifest with board, schema and asset versions".
- **Offsite retention**: the newest 12, plus one per day for 14 days. Delete the rest.
- **Failures**: an upload failure never breaks the local backup and is retried on the next pass. `GET /internal/backups/status` (internal auth) shows the last offsite success per board and a failure count. Logs never contain credentials.
- **Configuration**: `DRAFTROOM_BACKUP_STORE=off|fs|r2`. Off by default in dev. The e2e stack and tests use the fs driver under the data dir; staging uses `r2` with `R2_*` (`sync: false` in `render.yaml`).
- **Restore drill**: `pnpm --filter @draftroom/sync backup:restore-drill --from=store [--board <id>]` downloads the newest backup, checks its sha256, restores it into a clean temp data dir, opens it with SQLiteSyncStorage and checks the records. Add a runbook to DEPLOY.md for restoring a board on Render from R2, and state what Render's managed Postgres backs up on our plan.
- **Tests**: fs-driver tests for upload, manifest, retention, failure and retry, and the drill; a memory check that a 50 MB board backup uploads without its size showing up in RSS.

### sample-board: the "Lobby tour" demo board
Owns `packages/templates/src/templates/lobby-tour.ts` (plus its registry entry and tests), `apps/web/src/dashboard/{template-catalog.ts,TemplateGallery.tsx}` (the sample first, and an empty-dashboard "Start with the sample board" button), `docs/DEMO.md`, `e2e/tests/sample-board.spec.ts`.

- **The board**: a polished guided tour for showing Lobby to DBC leadership. Six named frames, left to right, in presentation order:
  1. Welcome: what Lobby is for DBC, plus three "try this" notes.
  2. Brainstorm: note clusters with a few bound connectors.
  3. Plan: a small process diagram, with shapes and arrows bound at both ends.
  4. Mood board: image slots with captions.
  5. Retro: Went well / To improve / Actions.
  6. Tips and shortcuts.
- **Visual quality**: use DBC-feeling colors from the tldraw palette (orange, the dark tones), and keep the text inside its shapes. Check with Playwright screenshots in light and dark, at fit-to-screen and per frame, and fix whatever overflows or overlaps.
- **Updated DEMO.md**: a 5-minute demo script on staging (https://draftroom-staging-web.onrender.com). It covers two browsers, share and invite, the tour, vote, present, export and history, plus wave-3 items marked "if merged".
- **Tests**: template tests (valid records, bindings resolve, no overlaps between frames); e2e: create it from the dashboard, six frames in order, Present walks them.

## 3. Integration (main session)

Merge the branches in this order: offsite-backups, export-control, thumbnails, sample-board, private-notes, guests. Resolve the `migrate.test.ts` list, then run the full battery (lint, typecheck, test, e2e). Review the deviation lists, deploy api → sync → web, and set the sync `R2_*` and `DRAFTROOM_BACKUP_STORE` through the Render API. Then run live checks on staging.
