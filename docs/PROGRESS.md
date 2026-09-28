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

## Current state (2026-09-28)

- **Live on staging** (Render, https://draftroom-staging-web.onrender.com): the milestone-3 layout, with the api on `0.5c-512mb` with no disk, files in Cloudflare R2, and previews made by the NAS worker. Clerk (dev instance) sign-in is branded Lobby. Verified live: sign-in, boards and sync, the tldraw key, uploads to R2 with NAS previews, and light and dark themes.
- **Built and verified locally**:
  - milestones 0, 1 and 3 (storage);
  - the Miro-style feature set (canvas UX, comments, history, present/export, workshops, dashboard/sharing) and the persona-review fixes;
  - wave 2: reactions, +1 and raise hand; dark mode; arrange as grid and select by type; the owner start view; the PDF page viewer and animated GIFs; invite by email through Clerk;
  - the Lobby rename;
  - the fixes from docs/SECURITY-REVIEW-2026-09-27.md.
- **Wave 3** (docs/WAVE3-CONTRACTS.md): name-only guests, private brainstorming, dashboard thumbnails, a per-board export policy, offsite board backups to R2, and the "Lobby tour" demo board.
- **Not built**: email notifications (Resend, later); browser edit latency and big-board frame rate (partly inside tldraw); a presenter session; Office previews; mind maps and Kanban; DBC Ops integration.
- **Unmeasured**: a real WAN, the agreed laptop, iPad/Safari, Firefox and phone frame rate; `FOR UPDATE SKIP LOCKED` contention on real Postgres.

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
