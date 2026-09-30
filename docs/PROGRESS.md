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
  - the tldraw production license. **The owner decided to move the canvas to Excalidraw (MIT) instead**, so Lobby runs with no licence fee. The plan is `docs/EXCALIDRAW-MIGRATION.md` (revision 3.5). Staging stays on tldraw, under the trial key, until a rehearsed cut-over that the owner signs off;
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
- **Canvas engine decision.** tldraw 4.x/5.x needs a paid production licence (quote-only), and 200+ DBC staff would use Lobby, so **the owner chose to move to Excalidraw** (MIT).
  - The migration plan went through three revisions, each checked by an independent reviewer against the installed `@excalidraw/*` 0.18.0-1118751 packages and this repo. The third revision resolved all the open musts. It is committed as `docs/EXCALIDRAW-MIGRATION.md` on branch `excalidraw`, with the recheck's remaining gaps tracked in its "Open items" section.
  - Design: Lobby-owned server-authoritative sync (`ElementRoom`) in `apps/sync`, one SQLite file per board as today. Last writer wins per field group; a server-enforced text lease; Lobby's own field-level undo. Conversion of tldraw boards runs inside the sync process, and a reversible rollback goes through a tldraw bridge release.
  - Estimate ≈261 pd, about 20 working days to cut-over (26 with buffer). No cut-over date is set before the spike's go/no-go.
  - **Next: spike A (engine checks)** on branch `spike/excalidraw`.
- **Spike A (engine checks A1-A17): done on `spike/excalidraw`** (not merged to main; reference code for waves 1-2). Report: `docs/research/excalidraw/SPIKE-A-REPORT.md`; per-check evidence in `docs/research/excalidraw/spike-a/`.
  - 14 PASS, 2 PARTIAL (A12 CSP: the zod fix is emulated and the Clerk origins are unverified; A14: laptop half unrun), 1 FAIL as written (A16: three statements of the check are wrong about the engine; corrected criteria proposed; every editor-open path is held by the lease or the guard only since the correction below).
  - Measured again on the merged branch, 3 runs in a row: lint, typecheck, 1,389 unit tests, 50 spike browser tests, and the normal tldraw build carries no engine code.
  - The plan needs about 20 corrections (report §4). The main ones: server text metrics need kerning, E3 is not enforced by Excalidraw, the fit clamp at zoom 0.1, the fit-fps conditional applies, auto-fit rewrites bound arrows, and the CSP needs same-origin fonts plus a zod fix.
  - **Corrected after the independent verification (2026-09-29).** Two security claims in the first report were wrong: Ctrl+Alt+S / Cmd+Alt+S inside the text editor still opened the board save picker (A6), and an editor opened on another note while a lease request was pending was writable without a lease (A16). Both are fixed (an allowlist inside the text editor; any editor that is not the granted lease's is read-only at once, then closed or re-queued), with regression specs that fail on the old code, 3 runs each; see report §0. The engine-flag build without the dev-auth guard no longer emits the fonts.
  - **Spike A done** on `spike/excalidraw` (5203e41; `docs/research/excalidraw/SPIKE-A-REPORT.md` there): 14 PASS, 2 PARTIAL (A12 CSP, A14 laptop half), 1 FAIL as written (A16). The independent verifier found two guard bugs in Lobby's code (Ctrl+Alt+S in the text editor; an editor opened during a pending lease request); a fix round is running.
  - **Plan revision 3.2** folds in spike A: bound arrows re-snapped by the server on a container fit, lease messages through the per-session FIFO, drag ids once per drag, R0's born-after check in the B8 drill, the editor's chord allowlist and the guard invariant, same-origin font fallback and a CSP without `unsafe-eval`, the level-of-detail pass (fit is below 24 fps on both engines), and the spike B execution plan (§8.6: contracts step, 5 owners + lead, 3 verifiers). Estimate ≈266 pd; the calendar is unchanged.
  - **Plan revision 3.3** applies the critic's result on 3.2 (5 blocking items) with the lead's decisions: bound-arrow endpoints are always server-derived (no client pushes an arrow change caused only by its target moving; the server re-snaps both ends, elbow routes and the label on every target write), owners and pd for the unowned measurements and go gates (O3), contracts frozen at C0 (a test snapshot with tombstones, the api↔sync internal contracts, registries' slots and installers, test hooks, Node-safety typecheck), B7 on the fs blob store (no R2 writes), and tighter privacy paths for B8's staging copies. Spike B 58.5 pd, total ≈270 pd; the calendar is unchanged. No checks were run for the revision beyond read-only probes.
  - **Plan revision 3.4** applies the recheck of 3.3 (3 blocking items, all about bound arrows) with the lead's decisions: an arrow's or line's `x`, `y`, points, size and fixed segments are one merge and undo unit (`path`), always sent whole, so a free end or midpoint lands where the user put it after the server re-snapped the bound start; "derived" arrow changes are decided by structure, so an arrow a frame drag translated is pushed; the server re-snaps on any change to a bindable target's position, size or angle, free-text layout included. Also: tombstones in the client numbers, no compaction purge in check windows, `DRAFTROOM_BACKUP_STORE=off` for every spike stack, O4 runs the B8 leak check, and B9 on the NAS builds no image (the pinned Node 24 base, a source copy and a throwaway install container). Spike B 59 pd, total ≈270 pd; the calendar is unchanged. No checks were run for the revision beyond read-only probes.
  - **Plan revision 3.5** applies the recheck of 3.4 (2 blocking items, both about arrow geometry) with the lead's decisions: the `path` unit is the arrow's whole geometry (`angle` and the elbow flags included; a line's `angle` and `polygon`), so a rotated target's elbow re-route no longer counts as the rotator's own write and a rotation racing a free-end drag keeps one whole version; the rebase is Excalidraw's own rotation-aware `movePoints`; fixed segments are matched by order, orientation and cross-axis position; every geometry compare and test uses a stated 0.5 px tolerance; the server rounds an unrotated linear element's `x`, `y` (a rotated one's stay unrounded, because rounding them made its free end creep 2.4 px over 1,000 re-snaps on the model; for the lead to confirm). The recheck's probes become acceptance tests at the contracts step, which the room must pass before M1. Also: a free text's own `x`, `y` while typing are a conditional fit, a dirty target change counts as a pending cause, and §2.8 no longer claims `updateScene` moves bound arrows. Spike B 60 pd, total ≈271 pd; the calendar is unchanged. No checks were run for the revision beyond read-only model probes (`scratchpad/lead-r35/`).
  - **Next: spike B**, after the fix round is re-verified.

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
- **Spike B, M1 and M2 integrated on `spike/excalidraw`** (lead; `docs/research/excalidraw/spike-b/M1-M2.md`). The five owner branches (room, web engine, harness, conversion, features) merged with no conflict; two change requests accepted (`CONTRACTS_REV` 3); eight small integration fixes in owners' files, each its own commit (the board page now installs the features' overrides seam, notes keep `customData`, the harness seeds frames first, and spec fixes).
  - M1: the arrow acceptance tests pass 85/85 against the real room, and two browsers create and move notes by facade and pointer with every map equal to the server snapshot and a watching third browser pushing nothing.
  - Gate at `9b6fb7e`: lint, typecheck, Node-safety typecheck, 3,957 unit tests, the spike A suite (99 passed), the normal build with no engine code.
  - First run of every B-check spec (one run, not a quiet window, not the 3-run evidence): 20 of 30 spec files (M1 included) passed as merged; after the fixes, B1, B4 client, B12 collapse and B12 phone pass, and L10 3-6 passed on a rerun. Still failing: B7 exports (one pixel check), B8 "two browsers" and the drill (the room does not yet convert a tldraw board on open), B9's workstation half, and B12's touch test. Open items per owner are in M1-M2.md.
- **Spike B, M3 integration on `spike/excalidraw`: M3 not reached** (lead; `docs/research/excalidraw/spike-b/M3.md`). The owners' part 2 branches merged with no conflict: the room now converts a tldraw board on open, and the engine fixes the L10 5 lost move and the D1 stall. The harness signs guests in and fixes B11's headless clients. B7's export and B12's touch failures were fixes in the specs. One change request accepted (`CONTRACTS_REV` 4: `PREPARING` notice, `CONVERSION_FAILED` close). No integration fix was needed.
  - Gate at `15dcd0e`: all green. Lint, typecheck, Node-safety typecheck, 3,975 unit tests with the 85 arrow tests, the spike A suite (99 passed), the normal build with no engine code.
  - One run of every B spec (not a quiet window): 25 of 27 check specs pass. B7's mood board lost 3 of 200 image creates and L10 6 lost one of B's rotations (1 of 80 rows). **Open data-loss defect (O2):** a local edit that a server frame overtakes before Excalidraw reports it is lost, while "Saved" shows. The owners' probes reproduce it here (5 of 400 creates, 2 of 40 edits). It blocks the report. Not run yet: B8's two-browser rows and drill, B9, the perf numbers, the quiet window, the verifiers.
- **Excalidraw migration, wave 1 (contracts) on `engine/excalidraw`** (`docs/EXCALIDRAW-CONTRACTS.md`). The owner chose the full plan (feature parity, bridge release, rollback, rehearsal), with more parallel owners and workshop tools and present mode first.
  - **Branch:** `engine/excalidraw` = `spike/excalidraw` 92b1098 with `main` 79f0125 merged (6210fc5: domain access and the 19 backlog fixes). The only conflict was this file (both sides added a 2026-09-29 section; both kept). No lockfile change was needed; "lockfile PR #1" is empty (every engine and `tldraw-import` edge came with spike B's C0).
  - **Gate on 6210fc5** (one run): lint, typecheck, Node-safety typecheck, 4,208 unit tests, the 85 arrow tests, the default (tldraw) build's **whole e2e suite 341/341** (`E2E_PORT_BASE=6400`, 25.5 min), the spike A suite (99 passed, 2 skipped), and the normal build with 0 engine markers.
  - **Frozen, the feature-facing canvas API** (`apps/web/src/canvas/api/`): `LobbyCanvas` = spike B's `CanvasPort` (unchanged) plus the members features need (camera, text through the lease, styles, hit testing, presence, follow, history, board document, export, files, settings, events), 99 members with one owner each: 26 C0, 7 composed, 66 stubs that throw `NotImplementedError(owner)` (2C 49, 3b 5, 3c 4, 3e 4, 3a 2, 3g 2); members owned by wave-3 owners live in their own `parts/*.ts`. `FeatureRegistries` (commands, keys, tools, context and board menus, selection bar, panels, top bar, overlay layers, host slots with one provider each, paste/drop handlers, cursor filter, menu state). `CanvasFeature` / `CanvasFeatureContext` (`ctx.editor` → `ctx.canvas`) with `installCanvasFeatures`; `lib/signals.ts` (replaces tldraw's atom/computed/react/useValue); geometry, element and key-chord helpers.
  - **The tldraw map** (`canvas/api/tldraw-map.ts`, tables in the doc §6-§7): all 137 `editor.*` members, 201 imported symbols and 168 files in `apps/web/src` mapped to a replacement and a porting owner; a test fails on a new unmapped use or a target the API lacks. Ported code goes in `**/ported/**` beside the tldraw code (both engines keep working until wave 4); `features/canvas-registry.ts` lists 15 empty ported features, one file per owner; a Biome rule keeps tldraw, `@excalidraw/*` and canvas internals out of ported code.
  - **e2e:** `e2e/tests/support/canvas.ts` (facade-based helpers and the `canvasSession` fixture), the wave-1 facade verbs (types; 2E implements them), `e2e/excalidraw/playwright.config.ts` (`pnpm --filter @draftroom/e2e excalidraw`), and `canvas-helpers.spec.ts`, 5/5 on the current Excalidraw board page.
  - **Gate on the freeze:** lint (1,500 files), typecheck, Node-safety typecheck, 4,242 unit tests (34 new), 85 arrow tests, normal build and the engine-flag build without the guard with 0 markers.
  - **Not done here** (doc §10): AGENTS.md (§10 of the plan needs the owner's own approval), the canvas-schema review (spike B still runs and owns it), the four missing engine probes, the facade verbs' implementation, and the Excalidraw board page that mounts `CANVAS_FEATURES` (2C).
- **Excalidraw migration, wave 2C (web engine: the board page) on `engine/w2-2c`** (from `engine/excalidraw` 0f17569). With `VITE_LOBBY_ENGINE=excalidraw` (still behind the dev-auth guard), `/b/:boardId` now opens Lobby's board page on Excalidraw (`apps/web/src/canvas/board/**`) instead of spike B's. The default build is still the tldraw app; `board/BoardPage.tsx` is unchanged.
  - **The page** has the tldraw page's load, access and error screens, real sign-in and tickets through the existing api, the same top bar (its layout is now shared as `board/TopBarFrame.tsx`), the dock (`features/FeatureHostCore.tsx`, shared by both engines), notices, the Share dialog, role-change and blocked-edit hints, the leave guard, the skip link, and a canvas named after the board that takes the keyboard.
  - **Inside the canvas:** the Excalidraw host with the board session (spike B's session as the starting point, plus the LobbyCanvas on board handles), the overlay root (scene and screen layers, focus mode, remote cursors filtered by `cursorVisible`, typing badges), the host slots, and CANVAS_FEATURES installed after the first welcome with the frozen `CanvasFeatureContext`. Paste and drop go to `contentHandlers`; keys go to `registries.keys` through an outer capture layer ahead of spike B's allowlist; pointer tools get their clicks, double-clicks and `onExit`.
  - **The Saved indicator** reads the engine core's status (`sync-quality/engineSave.ts`). It says "Offline — N changes on this device", gives the reject code's reason, says "Can't save right now — retrying", and never shows "Saved" while an upload is in flight (`canvas/board/uploads.ts`, for 3g's `files.insert`).
  - **2C's LobbyCanvas members are real on the board page.** Change request W1-2 (a "CR:" commit) adds status `board` to the member table: 10 of 2C's 49 members are composed from the port alone, and 39 need the page's engine. `transact(…, {joinPrevious})` folds a derived write into the previous undo step; on the real engine one undo reverts both, for everyone. `text.replace` takes the lease from code, writes one undo step, waits for the push, then gives the lease back.
  - **Spike B's board page** stays reachable at `?page=spike`, or as the default of a build with `VITE_LOBBY_BOARD_PAGE=spike`. Spike B's own suite needs that setting: a change request to its config.
  - **Gate** (one run each unless stated; E2E_PORT_BASE 6500 and 6510): lint (1,531 files), typecheck (15 projects), engine-probe and Node-safety typecheck, `pnpm test` 4,267 passed / 36 skipped (25 new tests); the Excalidraw specs (`e2e/excalidraw`, 19 tests: `canvas-helpers` and the new `board-open`, `board-saved`, `board-presence`, `board-reload`, `board-features`, `board-canvas`) **19/19 three runs in a row**; the default (tldraw) build's **whole e2e suite 340/341** (27.4 min). The one failure was `canvas-2.fix` F12: `tests/fixtures/generated/document.pdf` was missing in the fresh worktree. After `pnpm fixtures` it passed, together with `saving` and `collab-lifecycle` (15/15, at the final commit). The normal build and the engine-flag build without the guard have 0 engine markers, the board page's own included.
  - **Found on the way:** spike B's open O2 race (a write overtaken by the previous write's ack is lost) lost a facade-created arrow once in `board-reload`. Specs that seed several elements now wait for Saved between writes. Separately, the engine counts its offline queue per element: three notes read "3 changes", then "6 changes" once their labels are queued too.
  - **Not done here:** the wave-1 facade verbs (2E; the specs read `readOnly` through the page's dev-auth debug handle meanwhile), the spike B suite on this branch (its ports are outside this run's range, and it needs `VITE_LOBBY_BOARD_PAGE=spike`), the spike A suite (no spike A page changed), AGENTS.md (the owner's), and every ported feature (wave 3: CANVAS_FEATURES are still empty, so the dock, top-bar items and host slots show only what features register; a probe feature checks them in e2e).
- **Excalidraw migration, wave 2D (formats and templates) on `engine/w2-2d`** (docs/research/excalidraw/wave2/2D.md).
  - **Templates:** the seven templates (the Lobby tour included) are written once against an engine-neutral plan builder. The tldraw emitter makes exactly the records it made before (every template compared, ids and indices normalized). `@draftroom/templates/scene` emits the same plan as Excalidraw elements through canvas-schema/engine (`buildStickyNote`, `layoutBoundText`, `wrapText`, the room's `resnapArrow`). Every scene equals, field by field, what the converter makes of the tldraw build; the one deliberate difference is the tour's serif sample (the new canvas has no serif). `@draftroom/templates/plan` (no engine) feeds the dashboard gallery, whose output is unchanged and which no longer imports tldraw.
  - **board-ops:** `@draftroom/board-ops/elements` reads and writes elements: text, search, CSV, frame outline, presentation order, the palette, `remapElements`, archive v2 (`lobby-board`) export and import, pasted notes, file references. `@draftroom/board-ops/elements/v1` imports v1 archives through an injected converter (tldraw-import's `convertBoard`). The tldraw modules behave as before.
  - **Gate:** lint; typecheck (15 projects), engine-probe and Node-safety tsc; `pnpm test` 4,445 passed / 36 skipped; the 2D unit tests 698/698 in three runs; `e2e/excalidraw/templates-scenes.spec.ts` 4/4 in three runs (every scene a restoreElements fixed point in Chromium; every scene pushed as authored accepted with no server fix and converged on a second tab; an archive v2 round trip accepted; one test is an expected failure, below); the default build's specs near these files 104/104 once; 0 engine markers in the normal and the unguarded engine-flag builds.
  - **Findings:** CR-2D-1 (room): a label created with its new locked container is refused `LOCKED`, so labelled image slots lose their labels when a client creates them. CR-2D-2 (canvas API): `LobbyTx` has no way to insert prepared elements as given (`create('note')` rebuilds the note), and the template insert and paste-as-notes need one. The api (2F) needs `tldraw-import` as a dependency for v1 reads, and apps/sync (2B) needs `board-ops` for the search text: lockfile edges, not added.
  - **Not run:** the whole default e2e suite, the spike A and B suites.
- **Excalidraw migration, wave 2 integrated on `engine/excalidraw`** (integrator; `docs/research/excalidraw/WAVE-2.md`). 2C, 2D, 2E and 2F were merged `--no-ff`, with one conflict (this file: both entries kept). `spike/excalidraw` was already up to date at `92b1098`: spike B has pushed no fix since the freeze, and it still owns its folders. No lockfile or workspace change.
  - **Change requests:** all five CR commits were accepted and recorded in `docs/EXCALIDRAW-CONTRACTS.md` §12 (W1-2 to W1-7). They are: 2C's `board` member status; 2E's `engine: 'excalidraw'` config and `canvas.ts` bodies; 2F's room extension mount point and the optional `prepareBoard`/`serverWrite`; and 2F's v2 `CheckpointContent`. 2C's `App.tsx` route (a spike B C0 file) was also accepted (W1-8). CR-2D-1, CR-2D-2, the two importer edges and `mergeTop()` are recorded but not applied (W1-9).
  - **2E and 2F** (their results, not written here before):
    - **2E:** the element protocol harness and a 56-test negative security suite against the real server; an engine-aware e2e stack launcher; seven ported cross-cutting specs (lifecycle, network interruption, conflicts, permissions, durability, security, perf seed); an Excalidraw heavy seed.
    - **2F:** the sync internal routes outside the room (seed, place-notes, text, asset-refs, deleted); the api's element readers; checkpoints v1/v2 (preview, restore-as-new, duplicate); archive v2 export and import.
  - **Integration fixes (e2e only):** 2E's specs were written for spike B's page. They now read the board page's `save-status` indicator and notices, its no-access text, and the Saved indicator's hold. They also wait for the offline queue to be in IndexedDB before a reload.
  - **Gate:**
    - Static checks and builds: lint; typecheck with engine-probe, e2e and Node-safety tsc; `pnpm test` 4,573 passed / 36 skipped (wave 1 plus exactly the owners' 331 new tests); `pnpm test:arrows` 85/85; plugin tests 9/9; the hash check and A8. The normal build has 0 engine markers (39 markers, wave 2's included), and so does the engine-flag build without the guard.
    - **The default (tldraw) suite 341/341** (26.0 min, `E2E_PORT_BASE=6700`), and **the spike A suite 99 passed, 2 skipped**.
    - **Every Excalidraw-path spec once: 52/53.** The one failure is spike B's open lost-create race: `burst-11` was lost while Saved showed. The same test then passed 10/10 on repeat. The 52 include 4 expected failures (`test.fail`) that mark known defects.
  - **Open, blocking the cut-over (spike B's O2 unless noted):**
    - a remote edit is overwritten by a local drag's pointer-up push (data loss with Saved shown);
    - the lost-edit race;
    - the offline queue is written 100 ms after a change, and the indicator counts the change before that (found here);
    - two undo defects (typing into an empty note; redo of Ctrl+G in a sequence);
    - CR-2D-1 (O1);
    - `serverWrite` (O1): until it exists, restore and place-notes answer 503 on an open board.
  - **Wave 3 can start on the real board page,** with 82 real `LobbyCanvas` members and every registry. 3b's template insert needs CR-2D-2 (`LobbyTx.insert`). The spike B suite needs `VITE_LOBBY_BOARD_PAGE=spike` on this branch (a request to spike B). AGENTS.md is unchanged (the owner's).
- **Excalidraw migration, wave 3a (canvas tools) on `engine/w3-3a`** (from `engine/excalidraw` 5b9c87a). The ported `canvas-ux` feature (`apps/web/src/features/canvas-ux/ported/**`) puts Lobby's own chrome on the Excalidraw board page; the tldraw page and its files are unchanged.
  - **Host slots:** the toolbar (COL-07 order: Select, Hand, Note, Text, Rectangle, Pen, Connector, Frame, Media, features' main tools, Templates when navigation's panel exists; "More" with the last-used overflow tool in one extra slot), the style panel (RETRO-20/R16 visibility, COL-06 note palette, tldraw's colour, fill, dash, size, font, alignment, arrowhead and line-kind names mapped to engine fields by `style-vocabulary.ts`, the values the converter writes), the context and board menus (every feature's `contextMenu`/`mainMenu` entries in `MENU_GROUPS` order; the board menu folds `board`+`ai` into Board ▸, `clipboard`/`edit`/`arrange`/`select` into Edit ▸, `view` into View ▸, `export` into Export ▸), the keyboard shortcuts dialog (from the registries), and the selection bar (every feature's `selectionBar` items; order bands: below 100 the main row, copy link 10, lock 20, tags 30, AI 40; from 100 the arrange row, align/distribute 100, arrange as grid 200).
  - **Keys** (commands with `kbd` and deferring feature keys, pinned by `ported/keyboard-map.test.ts`): Ctrl/Cmd+Shift+L (lock, the selection kept; a frame locks what is inside it), PgUp/PgDn, Shift+PgUp/PgDn, ] [, Alt+] Alt+[, Alt+A/H/W/V/S and Alt+Shift+H/V (align, distribute), ?, Ctrl/Cmd+/ and Ctrl/Cmd+Alt+/ (shortcuts), Ctrl/Cmd+U (Media), Shift+F10 and the menu key, Alt+F10; deferring: RETRO-02 after an edit, Enter (rename a frame, A11Y-07 place a shape), Tab/Shift+Tab/Ctrl+Enter/Ctrl+Shift+Enter (the next note, RETRO-09), Delete on a selection with locked elements, Ctrl/Cmd+C/X while exporting is off.
  - **Also:** double-click on empty canvas makes a note (in the unlocked frame under it), a frame name renames on double-click or Enter, the locked hint and locked-frame badges (F8), the export gate on copy and the menus, snapping on by default (once per browser) and sans for new text, the focus guard, `registries.menusOpen`.
  - **`styles.of`/`styles.apply`** (`canvas/api/parts/styles.ts`): fields applied only where they mean something, a container's text fields on its label, one ink for a note and its label, text changes laid out again in the same transact (`redrawTextBoundingBox`, `relayoutStickyNotes`). CR-3A-1 (a "CR:" commit): the member table gains status `part` (`LANDED_PARTS`); other wave-3 owners add their paths there. CR-3A-2 (a "CR:" commit): 2C's `board-features.spec.ts` follows the toolbar slot's provider and deselects before its focus-mode click.
  - **Ported specs** (`e2e/excalidraw/canvas-ux-{toolbar,keys,menus,canvas,duplicate}.spec.ts`, 27 tests): toolbar, tools, RETRO-20, COL-06, styles, Miro keys, type-to-edit, RETRO-02, A11Y-12, RETRO-09, A11Y-07, RETRO-14, A11Y2-02, two-browser lock, context menu, FAC-07's menu half, export control's copy and menus, RETRO-21b, F8, MAK-03, A11Y2-06, MAK-02, and the onDuplicate rules (Ctrl+D, menu, Alt-drag, paste). MAK-06 is `test.fail` (CR-3A-3).
  - **Requests:** CR-3A-3 (port/2C: a transact's `index` writes never move the element in the scene array and Excalidraw renumbers every index in array order, so `tx.reorder` changes no paint order); CR-3A-4 (input layer: read-only roles cannot copy at all; let copy follow the export policy); CR-3A-5 (keymap: Alt+D, the address bar, is prevented though §2.3.3 lists it as a browser chord); CR-3A-6 (tools: `setTool('hand')` for read-only roles, and the `highlight` tool); CR-3A-7 (2C: the note and text tools ignore the next-element style, and `styles.next()` has no `strokeWidth`).
  - **Deviations** (each also in its module's header): stroke sizes are the engine's widths (1, 2, 4, 8; pen 0.5 to 4), not tldraw's; no in-place shape-type change, no elbow switch of an existing arrow, no serif; no style panel for the note tool and only a colour for the text tool (CR-3A-7); no highlighter and no Hand for read-only roles in the toolbar (CR-3A-6); Copy hidden for read-only roles (CR-3A-4); no Paste, flip, stack or stretch in the menus; align right has no key (Alt+D is the browser's); a lock of a frame also locks its contents (the engine's rule), so the hint names the frame; the export gate keeps its own policy store until 3e's ported one; F3's "dialog closed with the mouse" Space case is not handled (Lobby's buttons never take the keyboard on a click). The ported specs wait for Saved before typing into a note they just made (spike B's O2 race lost the first words once), check the toolbar order by test ids instead of tldraw's pixel snapshot, and fill rectangles they click (the engine picks a transparent shape by its outline).
  - **Gate** (E2E_PORT_BASE 6400 and 6410): lint (1,636 files); `pnpm -r typecheck` and the Node-safety tsc; `pnpm test` 4,613 passed / 36 skipped (40 new); the ported canvas-ux specs **27/27 three runs in a row** (26 passes and MAK-06's expected failure each run); the whole `e2e/excalidraw` folder once **80/80** (the 5 expected failures included); the default (tldraw) build's canvas-ux, canvas-ux.fix, canvas-ux-2, keyboard-safety, a11y-polish, a11y-2, a11y-3, export-control, canvas-2.fix and client-defaults specs once **61/61**; the normal build has none of the ported code. **Not ported here:** the zoom keys, M, Ctrl+F and every navigation feature (3b), the comment entry of the context menu (3c), exports and downloads (3e, 3g), FAC-07's label hiding (3f, 3e), phone flows (3i), and keyboard-safety's F11 undo-with-selection (2C's history).
