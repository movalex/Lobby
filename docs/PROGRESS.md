# Draftroom progress log

Plan: `docs/Miro_Clone_Build_Plan.md` · Handoff: `docs/Cursor_Start_Here.md` · Contracts: `docs/M0-CONTRACTS.md` · Evidence: `docs/FEASIBILITY.md` · Verified engine facts: `docs/research/SYNTHESIS.md`

## Milestone 0 — engine feasibility: COMPLETE (2026-09-26)

Recommendation: engine suitable — proceed, conditional on the tldraw license quote (see docs/FEASIBILITY.md).

| Gate | Status | Evidence |
|---|---|---|
| Versions verified and pinned | done | pnpm-workspace.yaml catalog; docs/research/SYNTHESIS.md §2 |
| Two sessions see each other and their edits | done | e2e/tests/collab-lifecycle.spec.ts (1) |
| Reload preserves content | done | collab-lifecycle.spec.ts (2) |
| Killed/restarted server preserves acknowledged changes | done | collab-lifecycle.spec.ts (3); apps/sync/test/protocol/durability.test.ts (0 acked-but-missing, 3 rounds) |
| Network interruption + reconnect does not restore an old board | done | e2e/tests/network-interruption.spec.ts; protocol/reconnect.test.ts |
| Same-note typing, edit/delete, undo-after-remote documented | done — server-enforced text lease shipped; undo limitation pinned | e2e/tests/conflicts.spec.ts; protocol/text-lease.test.ts, conflicts.test.ts |
| Custom file-card shape with shared schema + migration | done | packages/canvas-schema; apps/web/src/schema.test.ts; protocol/schema.test.ts |
| Image / multipage PDF / MP4 preview path | done | e2e/tests/files.spec.ts (7); apps/worker/test/*; docs/screenshots |
| Engine recommendation | done | docs/FEASIBILITY.md |

Checks at completion: pnpm verify — lint 0 errors, typecheck 11 projects, vitest 183 passed / 1 skipped, Playwright 10/10 (3 consecutive runs).

## Milestone 1 — accounts, permissions, deployment foundation: COMPLETE locally (2026-09-26)

| Gate | Status | Evidence |
|---|---|---|
| Postgres schema + migrations | done (PGlite locally; pg driver smoke-tested against Postgres 18.6 on the NAS) | packages/db (0001_core, checksum-guarded runner) |
| Sign-in | dev provider done; Clerk adapter written, UNVERIFIED (no keys) | apps/api/src/auth |
| Workspaces, projects, boards, members, invitations | done | apps/api/test/* (tenancy, members, invitations) |
| Server-enforced roles (owner/editor/commenter/viewer) | done | packages/permissions; e2e permissions.spec.ts (forged writes never land) |
| Board tickets (60 s, board-specific) | done | packages/auth-tickets; apps/sync/test/protocol/auth.test.ts |
| Revocation / downgrade within 15 s | done — 65 ms via push; 9.5 s via periodic re-check alone | e2e permissions.spec.ts; protocol/access.test.ts |
| Dashboard (create/rename/archive/trash/restore/search) | done | e2e dashboard.spec.ts |
| Wrong-workspace access, forged read-only mutation | done | e2e permissions.spec.ts; apps/api/test/tenancy.test.ts |
| CI + Render/Docker config | written; Docker images built and smoke-run on the NAS; Render Blueprint schema-valid; not deployed | render.yaml, docker/, .github/workflows/ci.yml, docs/DEPLOY.md |

Checks at completion: pnpm verify — lint 0 errors, typecheck 13 projects, vitest 812 passed / 1 skipped, Playwright 14/14 (6 consecutive runs).

Before any staging deploy (needs your decisions/accounts): Clerk keys; a tldraw key listing the staging host; publishing the repo. WebSocket routing, internal-URL wiring/loopback refusal, trustProxy and /healthz were resolved in the features phase (platform section, docs/DEPLOY.md); Render itself is still unverified.

## Miro-style features phase (milestones 2, 4, 5 scope): built and integrated (2026-09-27)

Per-feature checklist coverage: docs/FEATURES-M2-CONTRACTS.md §3 "As built".

- **Canvas UX**: Miro shortcuts (L connector, P pen, Alt+1/2, Ctrl+0, Ctrl+Shift+L, PgUp/PgDn, M minimap, Ctrl+F search), guides on by default, type-to-edit notes, paste-as-sticky-notes prompt, Draftroom 13-colour WCAG-AA note palette, Miro-style toolbar, template picker/insert (one undo), frame outline with reorder, board search, copy link to selection, start view, 20k shape cap.
- **Comments**: comment tool (C), shape-anchored pins that move with shapes, threads with replies/edit/delete, resolve/reopen, read/unread/mentioned states, @mentions (in-app notifications; no email), comments panel with filters, notifications bell, orphaned threads, Shift+C.
- **History**: named checkpoints, restore as new private board, duplicate, board JSON export/import, board-wide "recently deleted" with restore (captured server-side), periodic consistent SQLite backups + restore drill.
- **Present & export**: frame-by-frame presentation (hides chrome/cursors/pins), PNG/SVG/PDF (raster pages + text layer)/CSV export.
- **Workshops**: server-timed timer, voting with transactional budgets and ballots hidden until reveal, results, "gather everyone" (follow).
- **Dashboard & sharing**: starred, grid/list, template gallery on New board, duplicate/move/import, sharing-state badge, review links (multi-use, expiring), access requests with owner approval, pending-invitation list.
- **Platform**: production refuses loopback internal URLs, TRUST_PROXY, sync Origin allowlist, separate sync origin for Render, render.yaml/Docker updated.

Checks: pnpm verify — lint 0 errors / 0 warnings, typecheck, vitest 1245 passed / 1 skipped, Playwright 14/14 (M0/M1 suites; feature e2e suites are the next phase); integration smoke 53/53 in branded Chrome with four users.

## Validation phase (feature e2e + collaboration quality): COMPLETE locally (2026-09-27)

Seven engineers proved the features in real browsers (two or three contexts, fresh contexts and the API as the second witness) and fixed what failed; an integration pass ran everything together. Per-ID status with the e2e test names: docs/FEATURES-M2-CONTRACTS.md §3; scenario map: docs/E2E-PLAN.md (66/66 covered, 4 with a stated deviation).

- **Collaboration quality**: truthful save indicator (Saved / Saving… / Offline / Offline — changes will sync / Change not saved / View only) and per-property undo (WRK-03, WRK-05), plus a guard for a tldraw rebase that wiped the redo stack.
- **Bugs found and fixed**: viewer/commenter user-record push loop; "Saved" while an image was uploading; event stream dead after an api restart (proxy + data ping + watchdog); edits lost when leaving a board within a second (leave guard); ballots leaking through selection presence; workshop timer offset; no new vote after "End without results"; PNG exports with two pHYs chunks; restore summary counting binding ends; comment Esc/focus; share badge and Share dialog not live for M1 changes; import title; start view not observable; right-click "Unlock all" missing.
- **One-command dev flow** re-checked from an empty `.data`: `pnpm dev` → sign in → New board → a note placed with N shows Saving… then Saved → a second browser loads it; one event stream per board under StrictMode; stopping the tree left nothing listening.

Checks: pnpm verify — lint 0 errors / 0 warnings (504 files), typecheck 13 projects, vitest 1298 passed / 1 skipped (POSIX-only SIGINT test), Playwright 113/113 in 7.7 min; the full browser suite also passed 3 consecutive runs before that (113/113 each).

## Miro-user persona reviews and fixes: COMPLETE locally (2026-09-27)

Full report: [`docs/REVIEW-2026-09-27.md`](REVIEW-2026-09-27.md) (verdicts, performance gates, 78 findings with final status, remaining gaps). Checklist status changes: `docs/FEATURES-M2-CONTRACTS.md` §3, "Persona-review fixes".

- **Reviews**: four personas used the real stack in branded Chrome, with real mouse, keyboard, touch and drag-drop input:
  - Maya, a facilitator running a retro;
  - Jonah, a creative director building a mood board and storyboard;
  - Priya, a client reviewing on desktop, phone and tablet;
  - a performance reviewer measuring every §13 gate and PRF-01..05.

  All four said **not yet** for client-facing work; the performance reviewer said **mostly yes** for typical workshop boards.
- **Fixes**: four batches (media/assets, canvas UX, facilitation/review, shell/sharing/platform). Both blockers are fixed: the multi-file upload that lost an image inside a frame, and the 2,000-image metadata storm. Of the 22 majors, 14 are fixed, 7 partly fixed and 1 deferred (browser edit visibility, which is inside tldraw's sync client). Overall: 48 fixed, 14 partial, 15 deferred, 1 won't fix.
- **Performance gates** (loopback, one workstation, no agreed laptop):
  - pass: typical open, convergence, restart, the join storm (after the fix) and mood-board image loading (after the fix);
  - narrow fail: the heavy board at fit, 26–32 fps;
  - fail: browser edit visibility, p95 283 ms after the fixes (was 327 ms) against the 250 ms gate.
- **Integration**: fixed the lint errors in the new placeholder SVGs, the shipped-migration test for `0006_workshop_links`, and the `AuditAction` union (`invitation.extend`). Updated the docs.

Checks: lint 0 errors / 0 warnings (538 files); typecheck 13 projects; vitest 1,443 passed / 1 skipped (142 files); Playwright **152/152 in 9.2 min, twice in a row** on the default ports.

## Milestone 3 — storage (object store, assets in Postgres, remote preview workers): COMPLETE locally (2026-09-27)

Contract: [`docs/M3-STORAGE-CONTRACTS.md`](M3-STORAGE-CONTRACTS.md) (DEVIATION notes inline; §8 "As built"). Live-bucket evidence and memory: [`docs/DEPLOY.md`](DEPLOY.md), "Milestone 3 integration: live R2 from the dev PC".

| Gate | Status | Evidence |
|---|---|---|
| Blob store: fs + R2, streaming, Range, presigned GET/PUT | done | `packages/blob-store/test` against fs, against a fake S3 that re-checks SigV4 signatures, and (opt-in) against live R2: 25 tests |
| Asset metadata and job queue in Postgres | done | `packages/db/migrations/0007_assets.sql`; `apps/api/test/files/*`, `features/history/assets-db.test.ts` |
| Upload streams to the store; file routes proxy from it (Range, 206/416, every M0 header) | done | `apps/api/test/files/streaming.test.ts` (200 MiB, retained memory < 16 MiB); live R2 scripted run (59/59 checks) |
| Worker protocol: claim, leases, heartbeat, derivatives, idempotent complete, retry | done; the real-Postgres `SKIP LOCKED` test was **not run** (no Postgres here) | `apps/api/test/worker/*` (PGlite); `skip-locked.pg.test.ts` needs `DRAFTROOM_TEST_DATABASE_URL` |
| Remote worker over HTTP, no database or storage credentials | done | `apps/worker/test/remote.test.ts`, `transfer.test.ts`, `process.test.ts` |
| `pnpm dev` and e2e wired to the new flow | done | `e2e/tests/support/stack.ts`; a `pnpm dev` check from a scratch data dir |
| Live R2 end to end (browser suite + scripted uploads) | done locally | files suite 8/8 on `E2E_PORT_BASE=6500`; every object deleted, and the bucket lists 0 objects |
| api memory fits the 512 MB plan | measured locally: working set **+21 MiB** during a 200 MiB upload and **+35 MiB** during its download; UNVERIFIED on Render | DEPLOY.md evidence (PGlite alone peaks at 0.8–1.1 GB at startup, so `DATABASE_URL` is required there) |
| Render Blueprint without an api disk; NAS worker deploy | written and schema-validated; **not deployed**, images never built (no Docker here) | `render.yaml`, `deploy/nas/`, DEPLOY.md |

Checks: lint 0 errors / 0 warnings (581 files); typecheck 14 projects; vitest 1,628 passed / 5 skipped (the opt-in live R2 tests, the real-Postgres test and the POSIX-only SIGINT test); opt-in live R2 tests 26/26 with `DRAFTROOM_LIVE_R2=1`; Playwright **152/152** on three full runs on the default ports (9.8–9.9 min each; the last two on the final code).

## Current state (2026-09-28, after the overnight run)

- **Live on staging** (https://draftroom-staging-web.onrender.com), main 9814d8d, deployed 12:26–12:28Z. It holds everything below.
  - **Render**: api `0.5c-512mb` with no disk and 100 GB of file storage per workspace in R2; sync with offsite R2 backups; a static web site.
  - **NAS**: preview worker `nas-1` plus the LibreOffice sidecar.
  - **AI**: OpenAI gpt-5.4-mini.
  - **Checked live**: sign-in, boards, sync, thumbnails, the storage line, AI status, graceful shutdown on deploy, and backups written to R2.
- **Built and verified**:
  - milestones 0, 1 and 3; the Miro-style features; wave 2; the Lobby rename; and the security fixes;
  - **wave 3**: name-only guests, private brainstorming, thumbnails, the export policy, offsite backups and the Lobby tour;
  - **wave 4**:
    - automatic checkpoints, tags, mind maps, Office previews, search across boards;
    - AI actions with hard budgets and an owner switch;
    - present to everyone, follow and the people list;
    - a performance pass;
  - two polish rounds from four reviewers (the boss, a designer, a facilitator, accessibility).
  
  The gate on the deployed build: lint clean, 3,051 unit/API/protocol tests, 298/298 browser tests. The api suite also ran against a real Postgres 18.
- **Demo**:
  - `docs/DEMO.md` (5-minute script);
  - a narrated 2:18 video with real AI output, re-recordable with `pnpm --filter @draftroom/e2e demo:video` (see `e2e/demo/README.md`);
  - a Monday briefing doc for leadership.
- **Not built / open**:
  - email sending: the from-domain is undecided, and nothing is sent;
  - the tldraw production license (a quote is needed before a rollout);
  - DBC Ops integration;
  - Kanban;
  - edit latency and pan frame rate on very large boards: the remainder is inside tldraw 5.4.2;
  - full keyboard-only polish;
  - a separate least-privilege R2 bucket and token for backups (supported, not set up).
- **Unmeasured**: a real WAN, iPad/Safari, Firefox, real phones; signed-in flows on staging (the automated runs use local dev sign-in).

## Log

### 2026-09-26
- Repository created; plan documents copied to `docs/`. Repo rules in `AGENTS.md` (read by Cursor and, via `CLAUDE.md`, by Claude Code).
- Toolchain: Node 24.19.0 LTS (winget), pnpm 10.34.5, git 2.55, ffmpeg 9.0.1. Python not installed.
- tldraw / @tldraw/sync / @tldraw/sync-core latest = **5.4.2** — newer than model training data, so every API was verified from the published packages (six research reports + a critic synthesis in `docs/research/`).
- Hazards found in the research and fixed in our wiring (all in the official example pattern):
  1. `SQLiteSyncStorage`'s throttled tombstone prune crashes the process if the DB closes within 1 s of a delete → `pruneTombstones.flush()` before `db.close()`.
  2. Passing the raw `ws` to `handleSocketConnect` lets a stale socket's late `close` kill the reconnected session → wrapper without `addEventListener` + current-socket guard.
  3. Mixed-case board ids open two rooms on one SQLite file on case-insensitive filesystems (Windows/macOS) → lowercase-only ids.
  4. `new SQLiteSyncStorage({ snapshot })` on an existing DB wipes it → never pass `snapshot` to an initialized DB.
- Durability facts: each push commits in one synchronous SQLite transaction before `push_result`/broadcast; the library sets no pragmas, so we set WAL + `synchronous=FULL` + `busy_timeout`.
- Conflict semantics (documented, SYNTHESIS §8): per-prop last-writer-wins; same-note typing replaces the whole rich-text doc (characters lost when edits cross) → server-enforced text lease; delete beats edit; undo writes back the whole earlier record (can revert others' props / resurrect deleted shapes).
- License: dev on localhost is free (watermark). Any HTTPS production host without a domain-matching key blanks the editor after 5 s; price is quote-only (open question for tldraw sales; see `docs/research/license.md` §10).
- Workspace scaffolded from the verified skeleton; baseline two-browser e2e (edits, presence, reload, SIGKILL/restart, offline reconnect) passing through the same-origin Vite proxy.
- Milestone-0 build started with parallel owners (sync, web, worker, protocol tests) against `docs/M0-CONTRACTS.md`, followed by an integration/e2e pass.
- M0 build: sync file routes + text lease, preview worker, protocol test harness, branded web client, and browser e2e suites landed; e2e lease-test flake root-caused (caret placement on an already-selected note) and fixed.
- Integration fixes: worker file-type moved to runtime deps; web declares @draftroom/dev-assets; asset id validation aligned with the canvas-schema (10–40 chars); apps/sync typecheck now covers test/.
- M1 dependencies pinned and installed (Fastify 5.12.5, PGlite 0.5.8 = PostgreSQL 18.3 in-process, pg 8.23.0, zod 4.6.5, @clerk/backend 3.20.1, @clerk/react 6.17.2); PGlite smoke-tested (memory + file persistence).
- docs/FEASIBILITY.md, docs/DEMO.md written. Milestone 0 complete.
- Board logic packages: board-ops (bulk notes, search, frame outline/presentation order, CSV, archive import/export, id remap) and six templates; 372 tests; adversarial review fixed 7 defects.
- Miro UX research: official behaviors, user voices, and a 96-item P0 checklist (docs/research/miro-*.md).
- Milestone 1 built and integrated (api, db, auth, permissions, tickets, revocation, dashboard, share dialog, invitations, deploy config). Integration fixes: apps/sync and apps/web now declare @draftroom/permissions.

### 2026-09-27
- Miro-style features built by seven owners against docs/FEATURES-M2-CONTRACTS.md (canvas-ux, comments, history, present-export, workshops, dashboard-share, platform), then integrated: StrictMode-safe board event stream, SSE streams ended on api close, M2 migrations checked on fresh and M1 databases, one cross-feature keyboard map test, dashboard card-menu stacking fix, comment pins hidden while presenting, e2e ports configurable (E2E_PORT_BASE) with per-run build/output folders. As-built checklist status: docs/FEATURES-M2-CONTRACTS.md §3. Open: workspace dependency declarations for @draftroom/board-ops/@draftroom/templates (filtered Docker/Render installs).
- Engine spikes: truthful Saved indicator (88/88 browser checks) and per-property undo (verified with two clients) — recipes in docs/research/saved-indicator.md and undo-per-prop.md; found read-only viewers re-pushing their user record ~14×/s.
- Miro-style feature phase built by seven parallel owners + integration (fixed: SSE stream closed under StrictMode, card menu z-index, pins on slides, API shutdown hang with open streams). Integration owner: declared @draftroom/board-ops/templates dependencies (filtered installs for Docker/Render), cleared all lint warnings.
- Validation phase: seven engineers wrote the feature browser suites (canvas-ux, comments, history, present-export, workshops, dashboard-share, collab quality; the suite grew from 14 to 113 tests) and fixed the bugs they exposed in their features; integration fixed the cross-cutting ones (event stream after an api death, edits lost on in-app navigation, right-click Unlock all), converted the last expected-failure and fixme tests into passing ones, and re-checked `pnpm dev` from an empty data dir. Full suite 113/113 in 3 consecutive runs (~7.7 min each, one worker).
- Validation phase: Saved indicator, per-property undo, viewer fix adopted; e2e suites for every feature (113 tests); e2e now declares pdf-lib/pdfjs-dist itself.
- Persona reviews:
  - **Maya** (retro facilitator): anonymity, paste pile-up, N typing "n", one link per person, keyboard voting.
  - **Jonah** (mood board): uploads at native size in an 88k-unit row, one image lost in a frame, Space+drag moving shapes after a button click, originals downloaded while previews were made.
  - **Priya** (client review): typing into a new thread fired shortcuts, phone top bar and Comments panel unusable, revoked link a dead end, no inbox outside boards.
  - **Performance** (all §13 gates): typical open 1.9 s, convergence and restart pass; the 2,000-image storm left 463 images broken; the heavy board ran 10–16 fps at fit; browser edit visibility p95 327–471 ms; 30 joins stalled sync for up to 1.25 s.

  Triage split the 78 findings into four fix batches, with the rest deferred with reasons.
- Fix batches:
  - **media-assets**: drop layout (grid, on-screen size, frame-safe), capped and retried metadata fetches, no originals while processing, placeholder tiles, template image slots, locked template text.
  - **canvas-ux**: RETRO-01/02/09/14, F3, contrast, minimap closed by default, camera-moving timeout, locked hint, Frames panel, search by file name, double-click note.
  - **facilitation-review**: reply focus, phone sheet, keyboard voting, hide authors and cursors, PDF title bands and page sizes, results card, timer end.
  - **shell-sharing-platform**: phone overflow menu, gone-link handling, workshop edit links (migration 0006), sync join queue, dashboard bell, "Edited" from canvas writes, role copy, invite auto-accept.
- Integration:
  - lint: nested decorative SVGs marked `aria-hidden`;
  - `migrate.test.ts` expects `0006_workshop_links`;
  - `AuditAction` includes `invitation.extend` (cast removed).

  pnpm lint/typecheck/test green; e2e 152/152 twice in a row (9.2 min each). Re-measured on the final code: typical open 1.82 s cold, heavy open 3.36 s, heavy pan 26–32 fps at fit with the minimap closed; 20 sessions × 10 min converged with 0 of 866 acknowledged edits missing, and browser edit visibility is p95 283 ms (was 327 ms; tabs zoomed to one frame 209–216 ms), still above the 250 ms gate. Wrote docs/REVIEW-2026-09-27.md and the §3 persona-fix subsection.
- Milestone 3 (storage), built by four owners against docs/M3-STORAGE-CONTRACTS.md:
  - **blob-store**: `packages/blob-store` (fs + R2 via aws4fetch). It found that Node's `fetch` keeps a copy of a streamed request body unless `redirect: 'error'` is set.
  - **api-assets**: migration `0007_assets`, uploads streamed to the store, file routes proxied from it, `/api/worker/*`, and checkpoint bodies moved into the store.
  - **worker-remote**: an HTTP-mode worker with leases, heartbeats, release on shutdown and bounded downloads, plus `deploy/nas/`.
  - **deploy-config**: `render.yaml` with no api disk on `0.5c-512mb`, the worker token in its own group, the co-located api+worker image retired, and DEPLOY.md rewritten.
- M3 integration:
  - wired the e2e stack: the worker runs in HTTP mode with a random per-stack token shared only with the api, keeps its temp dir inside the stack, and the stack strips credential variables; `E2E_BLOB_STORE=r2` is opt-in;
  - `pnpm dev` checked end to end from a scratch data dir, and the api's dev watcher now also watches `packages/blob-store/src`;
  - `FeatureContext` declares `blobs`, so history no longer needs a cast;
  - idle worker polls log at debug level (they had filled the dev log every 2 s);
  - the blob-store live test is opt-in with `DRAFTROOM_LIVE_R2=1`, like the api's (before, it ran in every `pnpm test` on this PC);
  - Biome ignores `.claude/`, whose nested worktree configs had broken `pnpm lint`.

  Live R2 from the dev PC:
  - files e2e suite 8/8;
  - scripted PNG/PDF/MP4 uploads: previews ready, downloads and Range through the api;
  - a 200 MiB upload raised the api's working set by 21 MiB, and its download by 35 MiB;
  - all 91 objects written were deleted, the bucket lists empty, and no credential appears in any captured log.

  pnpm lint/typecheck/test green (1,628 passed); e2e 152/152 on each full run.
- Product renamed **Draftroom → Lobby** (DBC's whiteboard; one lobby per DBC project, holding its boards). Every user-visible string changed: titles (`<board> · Lobby`), errors, share/invite copy, PDF title/creator and export file names, and the archive error messages. The DBC "square L" brand replaced the set-square: an inline mark (`brand/Wordmark.tsx`, the L follows `--dr-mark-ink`), a navy/orange tile favicon with 16/32/180/192/512 PNGs (`apps/web/scripts/make-icons.mjs`), a `site.webmanifest`, and a sign-in page with the glowing hero and the "DBC Lobby" lockup. Code names stay `draftroom` (README "Naming"), including the `draftroom-board` format; board exports now download as `<title>.lobby.json` and older `.draftroom.json` files still import under their own title (review follow-up). Verified on its own branch (from the pre-M3 main): lint/typecheck/test green, e2e chromium 151/151; re-verified after merging onto M3 + wave 2 (see the next entry).
- Wave 2, built by six owners and integrated:
  - reactions, +1 on notes and raise hand (FAC-08);
  - dark mode (System / Light / Dark, app and canvas);
  - arrange as grid, select by type, note authors in the board menu, and the owner start view;
  - the PDF page viewer, placing pages on the board, and animated GIF playback;
  - invite by email from the Share dialog (Clerk invitations, with a link fallback).
  
  Merged with M3 into main (89332c7): lint 0 errors (636 files), vitest 1,792 passed, e2e 171/171.
- Staging switched to the milestone-3 layout (2026-09-28, see DEPLOY.md "What actually happened on staging"):
  - the api moved to `0.5c-512mb` with no disk and R2 for files;
  - the NAS worker was deployed (`nas-1`);
  - api → sync → web were deployed and all went live;
  - checked headless: the new build in both themes, no page errors.
- Security fixes from docs/SECURITY-REVIEW-2026-09-27.md, built on three branches and merged:
  - **api**:
    - caps on event streams and revocation of open ones (authz-003/005);
    - a per-workspace upload quota (FC-1);
    - auth rate limits that no longer lock out logout, invite previews or good Clerk exchanges (SCA-2);
    - "sign out everywhere" (SCA-4, migration `0008_session_revocation`);
    - the "Recently deleted" list is editors-only (authz-001).
  - **sync**: presence identity is bound to the verified ticket, so a forged name, color or cursor is corrected and the forger is closed (authz-004 / SYNC-01).
  - **web**:
    - sign-out also ends the Clerk session, so the sign-in page no longer signs the same person straight back in (SCA-1);
    - "Recently deleted" is hidden unless the user can edit;
    - "Sign out everywhere" in the user menu.

  Every fix has a test that failed on the unfixed code.
- Integration of the rename and the security fixes onto M3 + wave 2 (`integration/rename`): the conflicts were in index.html, ShareDialog, styles.css, ClerkSignIn and PROGRESS. The new user-facing strings from the security branches were renamed to Lobby, and the dark theme got a value for `--dr-mark-ink-on-dark`. lint 0 errors (658 files), typecheck clean, vitest 1,891 passed / 5 skipped, e2e 175/175 (11.4 min).

### 2026-09-28
- Deployed the rename and the security fixes (0e58e2e) to staging: api → sync → web all went live on the first try, and the live sign-in page reads "DBC Lobby". With the owner's go-ahead, deleted the unused 5 GB api disk and raised the per-workspace file storage to 100 GB (`DRAFTROOM_WORKSPACE_QUOTA_MB`, render.yaml). A Blueprint env change redeploys the api by itself.
- Measured on staging: requests through the static-site rewrite and straight to the api land in the same per-IP rate-limit bucket (DEPLOY.md "Client IPs"), so per-IP limits key on the real client.
- **Wave 3** (docs/WAVE3-CONTRACTS.md), built by six owners, with an adversarial reviewer on each of the three permission-heavy ones:
  - **Name-only guests** (migration `0009_guests`):
    - review and workshop links can let people join with just a name;
    - guests get a `guest` workspace membership and only their link's board;
    - every place a name shows adds "(guest)";
    - there is a server-side refusal list, per-IP and per-link join limits, and a sweep that ends guest sessions with no board.
    
    The reviewer fixed 7 issues: parallel joins getting past the rate limit, the marker being cut off on cursors, the per-link cap bypassed through accept, IPv6 /64 keying, HEAD requests skipping the guard, guests moving boards between projects, and a cross-workspace existence leak.
  - **Private brainstorming** (`0010_private_notes`): drafts live only in Postgres and only their author can read them; events carry counts. The reveal commits once and then puts real note shapes into the board through a new sync endpoint, in one validated storage transaction, with shape ids derived from the draft ids, so the reveal is idempotent. An anonymous reveal carries no author anywhere. The reviewer fixed a cancel-during-reveal race, added a start rate limit, fixed a double submit, and handled oversized frames.
  - **Dashboard thumbnails** (`0011_board_thumbnails`): an editor's client captures a thumbnail after edits settle and on leave. The api validates it by magic bytes and dimensions, rate-limits it, and swaps it in the blob store. GET needs view permission and sends nosniff and a sandbox CSP.
  - **Export policy** (`0012_board_export_policy`), where owners pick "Viewers and commenters can export, copy and download files":
    - limited viewers get 403 `EXPORT_DISABLED` on original downloads and board export;
    - previews and media elements keep rendering;
    - the client hides the export and copy entries.
    
    The reviewer closed an import bypass and a keep-sharing duplicate bypass.
  - **Offsite backups**: each consistent board backup is also streamed to the blob store (R2 on staging) with a manifest (sha256, clock, schema, referenced asset ids). Retention is the newest 12 plus one per day for 14 days, there is `/internal/backups/status`, and there is a restore drill from the store. The runbook is in DEPLOY.md.
  - **The "Lobby tour" sample board**: six frames in presentation order, first in the gallery, with an empty-dashboard button. DEMO.md was rewritten for a 5-minute leadership demo.

  Integration: only the migration lists conflicted. lint 0/0 (743 files), vitest 2,190 passed, e2e 192/192 (14.2 min).
- Wave 3 round 2 on the integrated branch:
  - G-R8 fixed: sync pins tldraw `user` records to the ticket identity. Forged names or colors close the session (terminal, so no loop), writes to other people's records are skipped, and the client builds its user from the ticket.
  - A seam security review: 12 findings, 3 medium (attribution forgery via note props, one guest using up the workspace quota, guest grants copied by keep-sharing duplicates).
  - A full walkthrough of DEMO.md on a local stack: 18 findings, 137 screenshots.
  - Two agents misread their task (the real-Postgres lens and the guest polish) and were rerun in round 3.
- **Wave 3 round 3.** Seven fix owners, a verifier on each of the three riskiest, and a real-Postgres lens.
  - **Attribution** (SEAM-01): a note's "last edited by" (`props.textLastEditedBy`) is server-checked. Typing must name the writer, undo is vouched by a per-room ledger, and forged creates are stored unattributed; no loops. The client shows "(guest)" on a guest's notes and locks attribution with the text in per-property undo.
  - **Guests**:
    - joins: 60 per 10 min per address and 60 per 10 min per link;
    - guests are left out of the Share picker and are not copied by keep-sharing duplicates;
    - they are limited like viewers under the "editors" export policy;
    - "Recently deleted" (list AND restore) is for account editors only;
    - per-link caps on streams, reactions and summons hold under concurrency;
    - workshop-link copy, Share dialog layout, and the guest-ended screen fixed.
  - **Storage**:
    - a report-first asset collector (`0013_asset_gc`). Deletion needs `DRAFTROOM_ASSET_GC=delete` and 30 days unreferenced, and every reference source is checked: canvas, "Recently deleted", checkpoints, trash, and uploads under 7 days old;
    - a per-guest upload allowance;
    - thumbnails count in the quota, and a per-workspace board cap;
    - `GET /api/workspaces/:wid/storage`, shown as the "Storage: X of 100 GB" sidebar line.
  - **Backups**: the offsite manifest and its entries are HMAC-signed with a key derived from the internal secret; tampering fails the drill and restore. An optional separate backup bucket and token (`DRAFTROOM_BACKUP_R2_*`).
  - **Workshops**:
    - hand names keep "(guest)";
    - History and vote-CSV export gates;
    - vote badges scale with zoom and stay under dialogs;
    - reveal placement finds free space, grows the frame only downward, and moves the revealer's camera;
    - the composer never loses typed text;
    - reveal and cancel are open to editors when the starter is gone.
  - **Demo polish**:
    - the gallery button is always visible;
    - the tour's Mood board has swatches and type samples, and its Brainstorm frame is a map;
    - DEMO.md corrected;
    - thumbnails framed on the start view at 16:10, with a fast leave-capture, and APNG refused;
    - the top bar keeps the title visible;
    - dark disabled selects, videos landing in image slots, and Export defaulting to the current frame at 1x;
    - phones open on the first frame.
  - **Real Postgres 18.6** (throwaway container on the NAS, removed afterwards; an opt-in harness, `DRAFTROOM_TEST_DATABASE_URL`, committed): the api suite passed (586 tests, about 33,000 transactions). Migrations 0009–0012 were checked on a database full of M1–M3 data. Found two deadlocks (PG-1 guest join vs link revoke/extend, PG-2 sweeper vs revoke) and a rollback gap (PG-3), all being fixed in wave 4b.
- **Wave 4a** (docs/WAVE4-CONTRACTS.md), five owners and three verifiers:
  - **Automatic checkpoints** (`0014_checkpoint_policy`): hourly while boards change, on the last editor leaving, and before restores and imports; skipped when the content is unchanged. Retention is hourly for 48 h, then daily for 30 days, then weekly for 6 months, and manual checkpoints are never pruned. Owners can delete checkpoints (audited), and there is a read-only preview. The verifier fixed a silent drop after repeated failures and viewers blocking the hourly checkpoint.
  - **Tags** on notes: chips, a picker, a filter, search, and a CSV column.
  - **Mind maps**: Tab/Enter/Shift+Tab, automatic layout, collapse, and an outline export.
  - **Office previews** (DOCX/PPTX/XLSX/ODF through a sandboxed LibreOffice sidecar on the NAS, then the PDF pipeline). The verifier closed a zip-bomb bypass (high), a macro-package bypass, unbounded PDF output and orphaned job files.
  - **Search across boards** (`0015_board_search`, Postgres full text): permission-filtered at query time, with an incremental indexer. The verifier fixed per-board result starvation and mention markup leaking into snippets, and found no permission leak.
- The live R2 offsite test (opt-in, random `test/` prefix, everything deleted and checked gone) passed against the staging bucket: upload, signed manifest, and the restore drill restoring an identical board from R2.
- Staging deploy of wave 3 plus round 3 plus wave 4a (main 87938de, 08:45–08:48Z):
  - api → sync → web went live, and the NAS worker was redeployed with the Office sidecar;
  - sync uploaded the existing board backups to R2 on start;
  - live-checked: a board loads with Saved/Live, the dashboard thumbnail is captured on leave, and the sidebar shows "Storage: 8 KB of 100 GB".
- **Graceful shutdown on Render was broken, and is now fixed.** Every deploy logged `[FATAL tini] Unexpected error when forwarding signal: 'Operation not permitted'`. Render runs containers without CAP_KILL, so the root tini could not signal the app, which runs as `node`. The entrypoint now drops to `node` first and then execs tini. Reproduced and verified on the NAS with `--cap-drop KILL`: old = tini FATAL; new = the app gets SIGTERM and exits 0.
- **Wave 4b**:
  - **AI on the board** (OpenAI gpt-5.4-mini; migration `0016_ai_usage`):
    - the actions: Summarize, Group into themes, Action items, Generate ideas;
    - the prompt is built from what the server reads through the sync snapshot, the output is validated with zod and mapped back only through aliases, and the result applies as one undo step;
    - hard limits, because the key has no provider cap:
      - per person: 30 requests/min and 20 calls/hour;
      - in flight: 2 per person, 3 per workspace, 4 in total;
      - daily token budgets per workspace (400k), per person (150k) and global (2M), reserved worst-case in Postgres under an advisory lock;
      - fail-closed, plus a kill switch;
    - guests are refused, and so are viewers limited by the export policy.
    
    Checked live with two real calls (themes 4.3 s, summarize 1.7 s, about 1.5k tokens in total).
  - **Postgres fixes**:
    - one lock order everywhere (board, then board rows, then the guest user, then members and sessions), fixing PG-1 and PG-2 plus an asset-GC vs worker-claim deadlock found in the audit;
    - `DRAFTROOM_ALLOW_NEWER_SCHEMA` for rollbacks, with a DEPLOY.md runbook;
    - opt-in real-Postgres lock-order and race tests, re-verified on a throwaway Postgres 18 on the NAS.
  - **Present to everyone**, the searchable people list, follow, "Bring to me" and hand-off. Followers start moving 6–8 ms after the presenter's key press. The verifier fixed sticky following after an api restart, a slide-change DoS by other editors, and a resume bypass.
- Final review by four reviewers (the boss, a designer, a facilitator, accessibility), then a seven-owner polish round with two verifiers:
  - **History**:
    - after a checkpoint Preview the board keeps the keyboard;
    - name-only guests see no History (API 403);
    - automatic checkpoints before a reveal and before AI grouping (`0019_checkpoint_reasons`);
    - auto-removed empty text is no longer listed as deleted by a person.
  - **Sharing**: one "Share with a client" block at the top (guests on, one click creates and copies), the other methods under "More ways to share", mentions refresh after sharing changes, and the Export dialog copy follows the policy.
  - **Comment notifications** for board owners (`0017_comment_notifications`), with a bell and dashboard badges, flood-capped per board and author, guest identities included.
  - **AI**:
    - an owner switch per board and per workspace (`0018_ai_settings`), enforced on the server, including the in-flight race;
    - Summarize opens a private panel with "Add to board";
    - results land inside frames;
    - the toast's Undo never undoes an unrelated edit;
    - Group into themes skips template prompts.
  - **Facilitation**:
    - reveals never widen into a neighbouring frame;
    - facilitator controls are for account editors;
    - everyone gets a "write your notes" prompt;
    - the timer and vote cards are usable on phones.
  - **Canvas and media**:
    - PDF and video posters in exports and thumbnails;
    - tags on images and mind-map topics;
    - boards open on the first frame;
    - several images dropped fill the mood-board slots.
  - **Accessibility**:
    - Enter on a note puts the caret at the end (no more wiping the text);
    - focus returns sensibly;
    - dock panels take focus and close on Escape;
    - visible focus rings;
    - the selection bar is keyboard-reachable, and Shift+F10 opens the context menu;
    - 3:1 input borders.
- Staging deploy of 2277660 (11:13–11:16Z): wave 4b plus the first polish round. OpenAI is configured on the api, and the live `/api/boards/:bid/ai` reports enabled with 0% of the budget used. A sync restart showed no tini FATAL (the graceful-shutdown fix works on Render). A confirmation e2e run passed 277/277.
- **Performance pass** (a repeatable harness in `e2e/perf/`, `pnpm --filter @draftroom/e2e perf`, with a budget check):
  - the canvas is memoized against save-indicator re-renders;
  - note label measurements are cached (a note util with the same schema);
  - the +1 scan skips notes without +1s;
  - pans are composited while the zoom is unchanged.
  
  The editing tab at fit went from 11.5–14.7 fps to 22.7–37 fps. Still open, and inside tldraw 5.4.2: edit visibility p95 at fit is 249–338 ms against the 250 ms gate (it passes at 100%), and the 600 px sweep pans at 16–21 fps against 30.
- **Polish round 2** (four owners):
  - **Canvas**: uniform-cell arrange, a consistent scale for mixed drops, "Processing…" tiles for watchers, framed thumbnails on the dark dashboard, wide boards framed on their first frame, and no opacity slider on frames.
  - **Shell**:
    - "Project lobbies" copy;
    - the Language menu removed;
    - a readable storage line with a breakdown popover;
    - the dashboard shows boards first at 390 px and 200%;
    - skip links, and focus on the main heading after sign-in.
  - **Accessibility**: a keyboard "Add a sticky note", focus-trapped AI and tag popovers, a quieter save live region, placeholder contrast, and the gallery tab order.
  - **Server edge cases**:
    - the notification flood cap holds under concurrency (an advisory lock, plus an opt-in real-Postgres test);
    - mention caps;
    - the workspace AI setting in one transaction;
    - duplicates keep the AI switch;
    - exports keep vote results and the CSV names colours right;
    - phone notices sit below tldraw's menu.
- DEMO.md: the script now uses "Share with a client", AI "Group into themes" and "Present to everyone". The "(if merged)" markers are gone, and the extras list covers the phone guest, private brainstorm, mind map, tags and search, and the safety answers.
- **Demo video**: a pipeline in `e2e/demo/` records the Lobby tour in real browsers (two people side by side plus a phone guest) and composes a 1080p MP4. It has title and outro cards, captions, and an ElevenLabs narration generated once (11 clips, about 1.2k characters). The final cut ran against the final build with real OpenAI output in the AI scene: 138 s, delivered as "Lobby demo (Sep 28).mp4". A critic pass watched the frames every 2 s, twice.
- Final deploy 9814d8d (12:26–12:28Z). It was the first deploy where both sides ran the tini fix, and neither printed a FATAL on shutdown. The gate: lint clean, typecheck, 3,051 unit tests, 298/298 browser tests.
- **Second review on the final build** (the same four lenses). Most earlier findings were confirmed fixed with evidence. The boss verdict: "Yes for internal project teams now; hold client-facing use until F10 and DANA2-01 land."
- **Fix round 3**, five owners with two verifiers:
  - **Team-only comments** (F10, `0020_comment_visibility`):
    - threads are "everyone" or "team";
    - team threads never reach name-only or workspace guests, in routes, SSE (the hub publishes per audience), the bell, badges or search;
    - "Team only" is on by default while a board has outside access;
    - outside the team, only a thread's author can resolve it.
    
    The verifier fixed the choice sticking for later comments, and an edit/resolve race.
  - **Client defaults**: "Share with a client" switches an unset export policy to editors-only and says so in the card (DANA2-01). Limited viewers get no enabled "Download original", and guest initials are fixed.
  - **Workshops**:
    - the "Private ideas" frame lands in free space, and Cancel removes it;
    - "Add your notes" focuses the draft box;
    - the phone timer is never hidden, and the panel closes on reveal;
    - Enter adds a note;
    - only the facilitator can pause the timer;
    - no +1 during anonymous votes.
  - **Canvas**:
    - mind maps start inside the frame in view;
    - uploads get a consistent page size;
    - template slots are cover-filled;
    - the sample board opens on Welcome;
    - the Frames panel no longer leaves the frame selected;
    - AI themes avoid an existing map.
  - **Keyboard safety**: board keys (Delete, letters, arrows, Ctrl+A/X/V, ",") act only while the board has the keyboard, and one Ctrl+Z undoes one real change (selection-only steps are skipped). A keyboard comment works on a note inside a frame. The verifier closed Ctrl+X reaching the board through the native cut event (high).
- Integration after round 3: Ctrl/Cmd+U joins the chrome-safe actions (the keyboard gate blocked it after an upload), and a mixed drop caps its cell at the largest card, so images and cards share one scale with page-space sizes. Final gate: lint clean, typecheck, 3,103 unit tests, 315/315 browser tests. **Deployed 5fe35f2 (14:54–14:56Z)**, healthy, with no errors or FATALs in the logs. Live checked: the threads API serves the team-only privacy fields, and AI is enabled.

### 2026-09-29

- **Domain access, step A (contracts) on `next`**: only verified `darkburn.com` / `trailerparkgroup.com` addresses (plus an env-only exceptions list) are creators; outsiders get only what they are invited to; single-use invitations are locked to one address. docs/DOMAIN-ACCESS-CONTRACTS.md was revised after the security and regression reviews (its §16 logs every item; the blocker was Clerk test mode, so `+clerk_test` addresses never count and the staging instance's test mode is turned off before the deploy). Committed: the shared contracts (`packages/contracts/src/domain-access.ts`, `Me.access`, invitation `email`, `PendingInvitation.email`, `ShareMember.canOwn`), the permissions predicates, migration `0021_domain_access` with its db tests, and step-A placeholders in the api (`access: ME_ACCESS_LEGACY`: nothing is gated yet). Checks: lint clean, typecheck, 3,143 unit tests (33 opt-in skipped). e2e not re-run for this step. Next: B1/B2 (API owner) and C (WEB owner) in parallel, per the contracts doc §12.
- **Domain access, steps B1 and B2 (API owner) on branch `da/api`**: the api now enforces the rule. B1 (pushed first, 1af29c4): the policy (`DRAFTROOM_CREATOR_DOMAINS` / `_EMAILS`, fail closed), verified addresses stored at sign-in (Clerk primary and secondary; never unverified, `transferable`, non-ASCII or `+clerk_test`), `Me.access` from the stored data, a personal workspace and Dev Studio for creators only, banned or locked Clerk accounts refused, a first sign-in without a Clerk profile refused (503). B2: identity freshness (awaited when unknown or older than 24 h, background after 1 h, 5 minutes for accepting a locked invitation; only Clerk's 404 `resource_not_found` or a ban signs someone out), the root guard over every create and hand-out route plus the in-route checks, the invitation email lock (preview hint, 403 mismatch, 409 for outsider workspace admins), non-creator managers limited to lowering, removing, revoking and denying (`url: null` for existing links), no outsider owners (PUT, transfer, keep-sharing duplicates capped at editor), `ShareMember.canOwn`, `PendingInvitation.email`, and invitation `email` required. Docs: the contracts doc §12 (contract changes) and §17 (as built), DEPLOY.md "Domain access" (variables, Clerk test mode off, deploy, rollback SQL, offboarding), `.env.example`. Checks: lint clean; typecheck all projects; `pnpm test` 3,274 passed / 36 skipped (api 980 passed / 31 skipped; packages 579 passed / 1 skipped). **Not run**: the opt-in real-Postgres tests (no Postgres here; the new 0021, race and lock-order cases are written and skipped) and e2e (the web is step C; flows 2 to 5 need this branch).
- **Domain access, steps C (web) and D (integration) on `next`**: `next` merged `da/api` (B1 + B2, db73946) and `da/web` (step C, 9ec92a8) with no conflicts and no integration fixes. Step C: the dashboard, landing, History, Share dialog, invite page and sign-in read `me.access` (creators create and hand out access; outsiders see an honest "nothing shared yet" landing with their address, no create or copy controls, and a Share dialog that only lowers, removes, revokes and denies; one-time links are locked to an address, with a masked hint and a wrong-account state that never auto-accepts), plus the new e2e spec `domain-access.spec.ts` (flows 1-5). Gate on the merged `next` (E2E_PORT_BASE 6800): lint clean (1,035 files); typecheck all projects; `pnpm test` 3,297 passed / 36 skipped (293 files, 9 skipped); `domain-access.spec.ts` 5/5 three runs in a row (15/15); the whole e2e suite 331/332 in 23.8 min, the one failure being `workshop-copy` R2-09's time-of-day artefact (run at 23:29 local, the 3-hour link crossed midnight and the unchanged badge rightly showed a date), which passed 2/2 unmodified when re-run at 00:00. Details in docs/DOMAIN-ACCESS-CONTRACTS.md §18; DEPLOY.md "Domain access" already carries the §13 rollout, rollback and offboarding steps. **Not run**: the opt-in real-Postgres tests (no Postgres on this PC), the demo video and perf smoke checks. **Next**: the independent security review (§14), Clerk test mode off on the staging instance (recorded in DEPLOY.md), `DRAFTROOM_CREATOR_EMAILS` on the staging api, then the lead deploys api → sync → web.
- **Domain access, verifier findings, fixer round 1 on `next`**: an independent verification of the merged `next` found one medium and eleven low defects, all fixed (docs/DOMAIN-ACCESS-CONTRACTS.md §19, with the contract changes marked "fixer round 1"). Api: the Share dialog's reads (GET …/invitations, GET …/sharing/members) freshen the caller like /api/me, so a removed company address stops multi-use link URLs and link minting about 1 h after any of them; a Clerk exchange that finds the account banned also ends its existing sessions; a stored check time more than 60 s ahead of the clock (a deploy overlap) no longer blocks newer addresses or refreshes, and every dev login replaces the dev address; the invitation preview gains `sentByYou`. Web: an `access-outside` dashboard notice for outside accounts whose role would create (their own workspace included); the Share note says "paused" for an unconfirmed account; the outside landing no longer promises an email; an inviter opening their own locked link is told whom it is for; "pick someone from the workspace" no longer offers Owner and a row says in words why Owner is off; History and the export setting stop promising what a non-creator cannot do. Tests: api `staleness.test.ts` (10) and new cases in contracts, invite-lock and the web models; `domain-access.spec.ts` grew from 5 to 11 tests (flow 6, the creator-side canOwn UI, request access, a locked workspace invitation, failure states rendered through `page.route`); 7 of the 11 fail on the pre-fix source. Gate (E2E_PORT_BASE 6800): lint clean; typecheck all projects; `pnpm test` 3,314 passed / 36 skipped; `domain-access.spec.ts` 11/11 three runs in a row; the 13 related e2e specs 65/65. **Not run**: the whole e2e suite, the opt-in real-Postgres tests, demo and perf. `ClerkSignIn`'s error rendering stays covered by unit tests only (the e2e stack cannot load Clerk).
- **Domain access, verifier findings, fixer round 2 on `next`**: a second verification found one medium and three low web findings, all fixed (docs/DOMAIN-ACCESS-CONTRACTS.md §20; the §9 changes are marked "fixer round 2"). The Share dialog says once, under "People with access", why Owner is off for people outside Dark Burn Creative and Trailer Park Group (round 1 had put the note on every outside row, which at 390 px grew each client row to about 209 px); an inviter opening their own locked link reads "Your invitation to a board", and its one action goes back to the board or workspace instead of signing them out; a 403 at accept re-reads the session so the page names the account's current address; the Clerk exchange-error markup (`auth/ExchangeStatus.tsx`) is rendered by a unit test. No api, contracts or schema change. Tests: web `share-model`, `invite/model` and the new `auth/exchange-status.test.ts` (3); `domain-access.spec.ts` changed in four tests, all four failing on the pre-fix source. Gate (E2E_PORT_BASE 6800): lint clean (1,038 files); typecheck all projects; `pnpm test` 3,319 passed / 36 skipped; `domain-access.spec.ts` 11/11 three runs in a row; 12 related e2e specs 66/66. **Not run**: the whole e2e suite, the opt-in real-Postgres tests, demo and perf.
- **Domain access, verifier findings, fixer round 3 on `next`**: a third verification (regression lens, 724ec3e; the creation and invites lenses stayed clean) found three low findings. All three are fixed (docs/DOMAIN-ACCESS-CONTRACTS.md §21, with the contract changes marked "fixer round 3").
  - The public invite page now shows the same "Can't reach Lobby" screen and retry as RequireSession (shared `UnreachableScreen`) when the invitation or session read gets no answer or a 5xx. Before, a signed-in person who was only cut off could see the signed-out "Sign in with …" state.
  - A creator can no longer lock a one-time link to one of their own verified addresses. The api answers 409 `INVITATION_TO_SELF`, and Share > Invite people and "Link for one person" say "That's your own address" while it is typed.
  - An invitation to a board in the trash now previews `boardInTrash`, and the page says so. Accepting answers 409 `BOARD_IN_TRASH` with nothing redeemed and no grant, and a restore makes a still-valid link work again. Workspaces have no trash.
  - A separate test-only commit makes `workshop-copy` R2-08 correct at any time of day. The old assertion failed, and the new one passed, with the browser in a timezone where the 3-hour link crossed midnight.
  - Gate (E2E_PORT_BASE 6800): lint clean (1,040 files); typecheck clean (14 projects); `pnpm test` 3,334 passed / 36 skipped; `domain-access.spec.ts` 14/14 three runs in a row; nine invitation, sharing and workshop specs 52/52; **the whole e2e suite 341/341** (24.1 min). All 3 new e2e tests, and 10 of the new unit and api tests, fail on the pre-fix source.
  - **Not run**: the opt-in real-Postgres tests, demo and perf.
  - **Left as is**: the guest join route (frozen by §10) still joins a trashed board's guest link when called by hand; the page no longer offers the join.
- **Domain access, real-Postgres run and fixer round 4 on `next`**: the first real-Postgres run of the api suite (Postgres 18.6 in a throwaway NAS container, 52f4214) gave 1023 passed / 6 failed; the regression verifier found two low wording defects. All fixed (docs/DOMAIN-ACCESS-CONTRACTS.md §22, marked "fixer round 4" in §3.4 and §9).
  - GET /api/me, /api/auth/me, GET …/invitations and GET …/sharing/members now read their whole answer before a due background identity refresh starts (`identity.freshenThen`), so "answers from stored data" (D12) holds on a connection pool as on PGlite, and one /api/me never mixes stored and refreshed data. A test helper (`refreshCommitsBefore`) makes PGlite behave like a pool for one read; the 4 affected tests fail on the old source with it and pass now.
  - Three older tests fixed without weakening them: `migrations.pg` lists 0017's `notifications_kind_check` change as the one expected change (so the 0021 checks after it run) and reads the export policy before and after the first client link (cdaf361); NC-V3 counts only its own board's advisory lock.
  - The wrong account opening a locked link to a trashed board is told whom the link is for, with no "works again once restored"; Share > Invite people says "That's your own address…" once (the hint empties while the alert shows it).
  - Gate (E2E_PORT_BASE 6800): lint clean (1,040 files); typecheck clean (14 projects); `pnpm test` 3,336 passed / 36 skipped (297 files, 9 skipped); e2e `domain-access`, `invite-email`, `dashboard-share` once: 36/36 (the two changed e2e tests fail on the old web source); **api suite on real Postgres 18: 1030 passed / 1 skipped (live R2)**, run from the repo root (the api project's 60 s timeout). The NAS container, image and password file were removed afterwards.
  - **Not run**: the whole e2e suite, demo and perf.
- **Deployed to staging 2026-09-29 11:48–11:49Z: `main` = `next` 380aa92.** This includes the 19 backlog fixes and domain access. `DRAFTROOM_CREATOR_EMAILS` was set on `draftroom-staging-api` through the Render API (one address, the owner's personal account; not in git). Domains are the code default. All three services are live on 380aa92. The api startup log shows `creators: { domains: [darkburn.com, trailerparkgroup.com], exceptions: 1 }`, with no error or FATAL lines in the api or sync logs. HTTP checks: web 200, `/api/me` 401 signed out, invite page 200, api `/healthz` 200, and the new access copy is in the live bundle. **Still open:** turning off Clerk test mode on the staging instance (the owner, in the Clerk Dashboard; Lobby ignores `+clerk_test` addresses regardless), and a signed-in check of `access.reason` by the owner.

- **Bridge release R0 on branch `r0/bridge` (from `main` 79f0125; not deployed).** The last tldraw release, built to `docs/EXCALIDRAW-MIGRATION.md` (branch `excalidraw`) §5.9, §5.10, §7.2 "R0 Bridge release", §7.5 and open item 9. Purely additive: tldraw boards behave as before. Deploy runbook, checks and the cut-over/rollback use: DEPLOY.md "Bridge release R0"; it must be live on staging at least 3 days before the cut-over.
  - **api**: migration `0022_engine_migration` (reason `engine_migration`, `board_snapshots.body_version` default 1, `boards.new_canvas` default false; the Excalidraw build must write 2 and true). v2 checkpoints are listed with `newCanvas` and "Made on the new canvas — preview and restore after the switch"; preview and restore answer 409 `NEW_CANVAS` with it, and a body that is not `draftroom-checkpoint` v1 is refused whatever its row says. Boards born on the new canvas carry `newCanvas` (dashboard badge "New canvas"); duplicate, export and "Save checkpoint" answer 409 `NEW_CANVAS` ("This board was made on the new canvas. It opens again after the switch."), automatic checkpoints skip them without asking sync, and sync's own 409 `new-canvas` maps to the same answer. A `lobby-board` archive import answers 400 `NEW_CANVAS_ARCHIVE`. Routes A1 `file-refs` and A2 `workshop-state` (GET, internal secret, fail closed) and `packages/contracts/src/sync-internal.ts`, reviewed from `spike/excalidraw` (O5); the A2 push and A3 guest claim stay with the Excalidraw build.
  - **sync**: the born-after refusal runs in `RoomRegistry.open()` before any writable handle (`apps/sync/src/r0/`, reviewed from the spike's O4 stand-in): a file with `lb_*` tables is refused unless `lb_meta.converted_from` and the tldraw tables exist; sockets 4099 `NEW_CANVAS_BOARD`, every internal board route 409 `new-canvas`, no tldraw table created, file byte-identical. R0 never writes, trims or alters any `lb_*` table. Maintenance mode (`POST`/`GET /internal/maintenance`; pending pushes commit, sockets closed and refused with 4099 `MAINTENANCE`, internal reads work, board-writing internal routes 503; runtime only). `POST /internal/backups/run-all` (every board file, local + offsite, per-board key and `recordsSha256`; closed boards read through a read-only connection). Open item 9: backups, the drill and `readBoardDb` handle files with only `lb_*` tables (copied whole, `format: "lobby-elements"` in the signed manifests, the drill checks what it can, staged restores refuse them).
  - **web**: the MAINTENANCE ("Lobby is updating") and NEW_CANVAS_BOARD sync messages, the "New canvas" badge, the v2 checkpoint line, the `engine_migration` label.
  - **Tests added**: sync `apps/sync/test/r0/` (born-after, lb_* byte identity in-process and in the real process through sockets, internal routes, maintenance, run-all, a crash and a restart; open item 9 gate; maintenance; run-all: 23 tests); api `engine-internal.test.ts` (A1/A2, 10) and `features/history/new-canvas.test.ts` (11); contracts `sync-internal.test.ts` (4); db 0022 (2); web (4); e2e `bridge-r0.spec.ts` (maintenance and a born-after board in the browser, 2).
  - **Gate** (E2E_PORT_BASE 6200): lint clean (1,058 files); typecheck clean (14 projects); `pnpm test` 3,390 passed / 36 skipped (306 files, 9 skipped; baseline on 79f0125: 3,336 / 36); the checkpoint, history, backup and board specs (11 files) 39/40, the one failure a `net::ERR_CONNECTION_TIMED_OUT` of a PUT that never reached the api (export-control), which passed alone right after; **the whole e2e suite once: 342/343** (26.0 min), the one failure `storage-2` "storage check": `bridge-r0.spec.ts` had left its born-after board file in the shared Dev Studio, which R0 rightly cannot read, so the collector's pass was incomplete; the spec now removes the file after the test, and `bridge-r0` + `storage-2` then passed 4/4 in one run.
  - **Not run**: the opt-in real-Postgres tests (no Postgres here), demo and perf. **Not in R0** (the Excalidraw build's job): open item 10 (mirror R0's restores and trims into `lb_deleted` on roll-forward) and open item 11 (boot in maintenance from an env flag). **Next**: the owner's OK to deploy R0 to staging (api → sync → web), then the checks in DEPLOY.md.

- **R0 fixer round 1 (verifier findings, data and regression lenses) on `r0/bridge`; not deployed.**
  - **Fixed (sync)**: run-all's backups are held 90 days outside local and offsite retention (`holdUntil`, signed; the final pre-cut-over set no longer ages out after 12 newer backups); every run-all answer comes from a run started after the call, and the report says `inMaintenance`; seed, deleted/restore and place-notes re-check maintenance once the body is read; a staged restore over a converted board carries its lb_* tables, indexes and counters into the restored file unchanged (digest-checked, else not applied); offsite manifests keep entries in a format R0 does not know (the drill and restore refuse them by name); asset-refs of a converted board says `newCanvasTables: true`.
  - **Fixed (api/web)**: the asset collector counts a v2 checkpoint (row or body) as unread and never records it as scanned, and a converted board as not fully read (passes incomplete, nothing new marked or deleted); a sync snapshot without `documents` is refused as SYNC_UNAVAILABLE (no empty checkpoint, duplicate or export while a rollback's deploys overlap); the unchanged check compares with the newest v1 checkpoint only; a `new_canvas` board gets no ticket (409 NEW_CANVAS) and the web shows the message without a socket; the refusal screen offers "Go to your boards" instead of Retry and says what the switch is.
  - **Docs**: DEPLOY.md "Bridge release R0": the hold, fresh run-all, the maintenance re-check, converted restores, the backup-format contract both builds follow, the rollback deploy order, rolling R0 back to 79f0125 (before the cut-over only), and the `engine_migration` spelling the Excalidraw build must write.
  - **Not fixed here**: the plan on `origin/excalidraw` still spells the reason `engine-migration` (§5.5, §5.10) and should say `engine_migration`, `holdUntil` and the format contract; that branch is not this worktree's.
  - **Tests added** (each fails on c57358b and passes now): sync `apps/sync/test/r0/` `final-backup-hold` (3 unit + the verifier's real-process repro: a converted board's run-all object still in the store after 13 newer backups), `maintenance-body` (half-sent restore, seed and place-notes, real process), `run-all-fresh` (2), `restore-converted` (3), `manifest-format` (2), `asset-refs-converted` (1), and `run-all.test.ts` updated to the new semantics; api `features/history/r0-fixes.test.ts` (4) and 4 tests in `files/gc.test.ts`; web `sync-error.test.ts` (2) and `ticket.test.ts` (1); e2e `bridge-r0.spec.ts` checks the new refusal screen.
  - **Gate** (E2E_PORT_BASE 6200): lint clean (1,066 files); typecheck clean (14 projects); `pnpm test` 3,414 passed / 36 skipped (313 files, 9 skipped); the affected specs (bridge-r0, storage-2, checkpoints, history, backups-2, offsite-backups, private-notes, dashboard, export-control, server-edges) 34/34; **the whole e2e suite once: 343/343** (26.2 min).
  - **Not run**: the opt-in real-Postgres tests (no Postgres here), demo and perf.
