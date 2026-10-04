# Lobby backlog (after the 2026-10-03 run)

This is the single open list. It replaces the 2026-09-28 list, which described the tldraw build (see section 5 for what became of its rows).

State: staging runs `main` code `48510b1` (docs on top: `b10aefa4`). Sources: the 2026-10-02 backlog map (92 items), the wave A-E and C6 entries in `docs/PROGRESS.md`, and `docs/CUTOVER-LOG.md` §7. Of the map's 92 items: **71 are closed**, **12 wait on the owner** (section 3), **8 are partly open** (section 2: SEAMS, ARROW, SEC-deps, CI-1, XB-1, FLAKE-1, CAP-L1; the eighth, the SMK-2 revoke screen, is a real-sign-in check in section 3) and **1 was reverted and is accepted as a limit** (polygon outlines, section 4). The rest of section 2 comes from the wave follow-up lists.

How to read it: ids are the map's ids or a wave follow-up's name. Sizes (S, M, L) are estimates from the map, not measurements. Every "shipped" line names the commit that deployed it and a spec or test that covers it; each such test failed without its fix, proved by its implementer and again by a reviewer (the wave entries in PROGRESS say how).

## 1. Shipped on staging 2026-10-03

Times are UTC. All six deploys fell on 2026-10-03 Pacific time (wave E is 01:43Z on 10-04 UTC). Each deploy was followed by the live smoke (`scripts/smoke/live-smoke.mjs`, 33 or 34 passed, 0 failed) and 0 `error` or `FATAL` log lines (CUTOVER-LOG §7).

Earlier the same day: the CSP went from report-only to enforced at about 05:10Z, and `render.yaml` was checked against the live services with 0 differences (C19), both lead work (CUTOVER-LOG §7).

- **Wave A, `0644365`** (08:02-08:07Z; api, sync, web).
  - Sync rules: one 6,000-item budget for all guests on a board (`apps/sync/test/negative/guest-board-budget.test.ts`); a +1 and slide order on locked template notes and frames, and tags for workshop guests (`lock-exempt-keys.test.ts`, `e2e/excalidraw/locked-customdata.spec.ts`).
  - Presence: follow keeps working past 41 sessions, `CONTRACTS_REV` 10 (`people-list.spec.ts`); other people's selections are drawn (`apps/web/src/canvas/presence/remote-selection.test.ts`, `board-presence.spec.ts`); gather centres on the leader (`people-follow.spec.ts`).
  - Undo and session: a +1 is not an undo step, and redo of Ctrl+G works (`apps/web/src/canvas/history/skip-undo.test.ts`, `long-sequence.test.ts`); viewers copy where export allows (`viewer-copy.spec.ts`).
  - Images and templates: zoomed images keep their display copy (`apps/web/src/canvas/sync/core/local-file-suffix.test.ts`); template prompt notes stay out of AI grouping (`packages/templates/src/scene/prompt-notes.test.ts`); sign-out purges the offline queue (`sign-out-purge.spec.ts`).
  - API: guest join refuses a trashed board (`apps/api/test/features/guests/trashed-board.test.ts`), `/internal` is guarded (`internal-secret.security.test.ts`), pending Clerk sessions are refused (`auth-session-status.security.test.ts`); audit advisories went from 12 to 5 (`docs/SECURITY-REVIEW-2026-10-02.md`).
- **Wave B, `99d902c`** (10:55-10:59Z; api, sync, web).
  - Undo restores the selection (`apps/web/src/canvas/history/undo-selection.test.ts`) and mind-map steps are not doubled (`invisible-steps.test.ts`, `mindmap-structure.spec.ts`).
  - Input: pinch below 0.1, an Input device preference, connector kind, sharp new rectangles (`input-touch-wheel.spec.ts`).
  - Presence and export: edge markers for off-screen people (`board-presence.spec.ts`); a late joiner lands on the presenter's slide (`present-live.spec.ts`); a PDF vote-results page and comments appendix (`present-export-files.spec.ts`).
  - History and connection: a restore re-attaches connectors (`apps/sync/test/room-internal/deleted-reattach.test.ts`, `history-deleted.spec.ts`); old checkpoints show a preview (`apps/api/test/features/history/checkpoint-v1-preview.test.ts`); the board ticket left the URL (L7: `board-ticket-transport.spec.ts`, `apps/sync/test/http/ticket-transport.test.ts`).
  - Members and paste: workspace member PATCH and DELETE (`apps/api/test/workspace-members.test.ts`); a paste that this board cannot show is filtered (`apps/web/src/canvas/board/content.test.ts`, `navigation-paste.spec.ts`).
- **Held release, `e2cb709`** (21:09-21:12Z; api, sync, web; after the 48 h rollback window closed at 20:55Z, so the R0 rollback path is retired).
  - Migration 0024: a vote over a selection, and the access-granted bell item (`packages/db/test/vote-selection-0024.test.ts`, `apps/api/test/features/workshops/vote-selection.test.ts`, `apps/api/test/features/dashboard/access-granted.test.ts`).
  - Push receipts, `CONTRACTS_REV` 11, the last known lost-edit path (`apps/sync/test/element-room/receipts.test.ts`, `apps/web/src/canvas/sync/core/receipts.test.ts`, `doc-key-lost-write.spec.ts`).
  - The merged live smoke script (`scripts/smoke/live-smoke.mjs`). The lead reverted CR-2B-2 in this release (`841d6dc9`).
- **Wave C, `9627f29`** (15:18-15:19Z; api, web).
  - Look: next-note and next-text style, one selection accent, hover and editing outlines, frame names that do not overlap (`canvas-look.spec.ts`); arrow handles for a code selection (`navigation-links.spec.ts`).
  - Bundle: Mermaid stubbed out of the web bundle, closure 11.1 MB to 7.8 MB (`apps/web/build/mermaid-to-excalidraw-stub.ts`).
  - Reviewer and workshop polish (`c3-polish.spec.ts`): a plain People button for reviewers, Zoom to matches, readable tag chips, soft note shadows in PNG and PDF, a read-only PDF viewer, a GIF player (`apps/web/src/file-card/ported/gif-player.test.ts`).
  - Gates: a rebuilt CI workflow (never run, see CI-1), an axe audit (`a11y-audit.spec.ts`), a WebKit and Firefox smoke spec (`xbrowser-smoke.spec.ts`), eight gap-pass specs (`gaps-*.spec.ts`).
- **Wave D, `54ea729`** (23:49-23:51Z; api, sync, web). The presence relay ranks a recipient only when its shown set can change (NAS L1 steady CPU 62.4 to 49.9 % of the quota, event-loop p99 before the kill 56.5 to 35.1 ms; `apps/sync/test/presence/presence-rank.test.ts`). The B11 divergence fix (SYNC-4, `apps/web/src/canvas/sync/core/inflight-key-echo.test.ts`). The receipt-gap marker (`receipt-gap.test.ts`). An archived board no longer says "Change not saved" (DEF-GAPS-1, `start-scene.test.ts`, `gaps-board-status.spec.ts`). History re-key in one pass, 20,000 elements in about 110 ms instead of 15.5 s (`rekey-perf.test.ts`). API offboarding sweep, v1 preview cap and request timeouts (`workspace-offboarding.test.ts`, `request-timeouts.test.ts`). Also merged: C6's measured harness (B9 L2 p95 185 / 177 / 208 ms at 100 % zoom; heavy-board fit 58.7 fps, `docs/research/excalidraw/spike-b/B9.md`) and the honest docs refresh.
- **Wave E, `48510b1`** (2026-10-04 01:43-01:44Z; api, web). The removal-versus-redeem deadlock and orphan grant are closed (`apps/api/test/offboarding-races.pg.test.ts`). The v1 preview is bounded by stored size and label text as well as records. One board session per page shell and a per-page guest queue (`board-session-stable.spec.ts`). The heartbeat clears on the raw pong (`socket-busy.test.ts`). Undo restores groups (`history-selection.spec.ts`, `selected-groups.test.ts`). The access toast names who changed it, only for a real change (`events-access-actor-flows.test.ts`). The scaled-notch wheel guess is off on macOS (`zoom-wheel-ratio.test.ts`).

Gate on the wave E code (PROGRESS, wave E entry): lint 0 errors on 1,886 files; 15 typecheck projects; 5,221 unit tests passed; 563 of 565 e2e passed, 0 failed, 2 skipped (the heavy-board measurement specs); stale-client checks 64/64 and 67/67.

## 2. Open: engineering

Sizes: S small, M medium, L large.

### Sync and protocol

| Id | What is open | Size | From |
| --- | --- | --- | --- |
| SYNC-4 confirm | The B11 divergence fix is shipped (wave D), but B11 has not been run at the shipped head. Run it (`SPIKE_B11=1`, from a spike-b port range); close SYNC-4 only if it is clean. | S | C6, D, E |
| B11-tail | Add the headless client's `keepReceived:false` option, and make B11 assert `headlessPausedMs` (below about 10 %) and a `headlessOps` floor. The old rejoin stall was the test process, fixed in D5-2. | S | D5 |
| RCPT-1 | If a receipt write fails and the gap marker write fails too, the gap lives only in memory; after a restart that receipt reads "never landed" again. | S | D2 |
| RCPT-2 | No browser test for "landed, ack lost, someone wrote after" (needs a relay that drops the ack); it is covered in Node only. | S | C2 |
| DRAG-1 | A drag held on an element the server moved and someone created over is re-keyed mid-gesture. Unit-tested only; no browser drag test. | S | D2 |
| L7-tail | Remove `?ticket=`. The sync still reads it (`upgradeTicket` in `apps/sync/src/app.ts`). First move the headless client, the spike board session, the e2e forge sockets, `e2e/load` and the sync harness to the subprotocol, add a counter for old-style connects, and fix the `protocol.ts` header comment. | M | B4 |
| TAGS-1 | A guest's 10-tag budget resets when the room is evicted or restarted, and there is no member reserve inside `MAX_TAG_DEFS` 200 (`guestTagKeys` in `apps/sync/src/room/merge.ts` is in memory). | S | A1 |
| PRES-2 | Optional: share rank results between recipients with the same held set (about 110 ranks a tick under churn); re-measure on the NAS. | S | D1 |

### Capacity and performance

| Id | What is open | Size | From |
| --- | --- | --- | --- |
| CAP-L1 | After wave D, L1 on the NAS 0.5-CPU plan still misses the restarted process's first event-loop scrape (111.5 ms), the boot CPU sample (102.5 %) and, in C6, the conversion window (98.9-109.3 %). L1's client-side ack is bound by the load box. Whether to accept this or pay for a larger plan is an owner decision (section 3). | M | B9-RERUN (C6), D1 |
| CAP-5 | Render's commit and fsync latency has never been measured (a sync Shell check, DEPLOY.md). | S | C6 |
| PERF-g | At zoom 1 the main thread is about 90 % busy after fit and 0.25 were visited, against about 50 % when 1 is the first view. Not profiled; the LOD layer staying on is a suspect. | S | G11 (C6) |
| PERF-laptop | Every heavy-board number is from a 64-thread desktop with an RTX 5090. No laptop number exists. | S | A14 |

### API and data

| Id | What is open | Size | From |
| --- | --- | --- | --- |
| OFF-1 | Ownership transfer (`apps/api/src/features/dashboard/sharing.ts`: an unlocked `findTarget`, then the grant insert) and duplicate or restore with sharing (`apps/api/src/features/history/new-board.ts`, `shareLike`: no `workspace_members` join) still leave the orphan-grant window. Lock the membership first, and join `workspace_members`. | S | E1 |
| OFF-2 | A PATCH demotion does not revoke the admin's earlier workspace invitations. | S | D4 |
| PG-1 | Run every `*.pg.test.ts` once on PostgreSQL 18 at the shipped head (the NAS has `postgres:18`; use `scripts/nas-pg-api.sh`). One api test skipped in E1's PG run (1 of 1,214) was not investigated. | S | E |
| CONV-1 | The v1 checkpoint conversion still runs on the api event loop (about 285 ms worst case on the 64-core desktop; Render's core speed unmeasured; bounded, cached, 60 a minute per client). A worker would remove the stall. | M | B4, E1 |
| SEC-deps | 5 audit advisories are allowlisted in `scripts/audit-check.mjs`: nanoid 4.0.2 under mermaid-to-excalidraw (the fix is a major version) and braces 3.0.3 (no patched release). Re-run `pnpm audit:prod` after each Excalidraw bump. (Map item SEC-dependency-scan, partly open.) | S | A6 |
| SEC-edge | Consider an IP allowlist at the Render edge for `/api/worker/*`, and confirm Render's edge keeps the new 60 s stall and 60-minute ceiling (not checkable offline). | S | A6, D4 |

### Web canvas and session

| Id | What is open | Size | From |
| --- | --- | --- | --- |
| SEAMS | CR-3A-9: the caught-up signal (now possible on the C2 sync core) and moving the file-card uploads onto `canvas.files.track` (the `provideUploadTracker` seam in `apps/web/src/assets/board-media.ts` stays until then). | M | C1 |
| ARROW | W5-53: arrowheads are about twice tldraw's size and bound connectors stop 4-6 px short. Needs a pnpm patch of `@excalidraw/element` through the catalog (a dependency change, so lead-owned); guard it with `binding.test.ts` and `pnpm test:arrows`. | M | C2 |
| GQ-1 | A guest's in-memory queue map (`pages` in `offline-guest.ts`) is never evicted after an in-app navigation away (memory only). Add a test that `createSignOutPurge()`'s default calls `purgeGuestQueuesOf`. | S | E2 |
| SEL-1 | In `session.ts`, `select` should skip a group with a hidden member, so the group box leaves out hidden bounds. | S | E2 |
| HB-1 | A pong that arrives during one long synchronous task can still lose to the heartbeat timer. | S | E2 |
| NEXT-1 | Optional: the label path reads the note's size slot. | S | D6 |
| ARCH-1 | A board opened archived and then restored while open stays read-only until a reload (the session reads `archived` once). | S | E2 |

### Tests, CI and gates

| Id | What is open | Size | From |
| --- | --- | --- | --- |
| CI-1 | CI has never run on GitHub (the owner starts it, section 3). After the first green run, make `audit`, `xbrowser` and the A3 probe blocking; the `postgres` job and the A3 probe on Linux are the likeliest first failures. No job runs `node --test apps/web/build/*.test.ts scripts/smoke/render-yaml.test.mjs` (`ci.yml` has no `node --test`). | S | C4 |
| XB-1 | No Firefox result exists (Smart App Control blocks it on this PC). WebKit passes locally after a first failed launch (`xbrowser-smoke.spec.ts`, 6/6 in the wave C gate). Needs the CI job or a Mac or Linux machine. | S | C4 |
| AXE-1 | axe could not decide the contrast of the sign-in gradient text, the owner-filter select and the card menu button; the accepted "incomplete" lines are in `a11y-audit.spec.ts`. | S | C4 |
| FLAKE-1 | `media-files.spec.ts` "7) uploads" failed once under load and has never been reproduced; it was hardened, not proven fixed. | S | C5 |
| UPG-1 | After any Excalidraw upgrade, re-run `c3-polish` W5-37 (the note-shadow export patch depends on the engine's literal drawing) and the checklist in the `pnpm-workspace.yaml` comment. | S | C3, C4 |

### Docs and comments

| Id | What is open | Size | From |
| --- | --- | --- | --- |
| DOC-1 | Comments that now say the wrong thing: the "Not closed from here" header in `apps/api/src/routes/workspaces.ts` (~line 40), the `AccessActorHint` doc in `apps/web/src/board/access.ts` (~105-113) and the matching lines in `LobbyBoardPage.tsx` (~476-479), the "by hand" header of `apps/sync/tsconfig.node-safe.json`, and test 2's comment in `e2e/excalidraw/gaps-board-status.spec.ts` (~127). | S | E |
| DOC-2 | Docs that still describe the old state: the `DEPLOY.md` CI section (one pipeline; CI is now 9 jobs) and its backup-format row (cites a deleted test); `EXCALIDRAW-CONTRACTS.md` §2.2 (the C1, C3 and B2 members); `B11.md` and the SYNTHESIS SYNC-4 row (still "fix not merged"); `wave3/3D.md` deviations 1 and 4 (per PROGRESS C6, not re-checked); `docs/screenshots/*` (tldraw era). | S | C6, D, E |

## 3. Waiting on the owner (Chase)

| Item | What is needed from you |
| --- | --- |
| Clerk production instance | Staging runs on a development Clerk instance. Decide before about 100 users sign up whether the roughly 200 staff and outside reviewers join it or switch to production first. A switch changes every Clerk user id and needs an identity-remap plan (match by verified email), rehearsed on a copy. (OPS-clerk-dev-to-prod, L) |
| Email sending domain | Pick the domain and a free-tier provider. The configured Resend key belongs to another organisation's domain, so no mention, reply or access email can be sent. (RETRO-18, L) |
| Clerk webhooks | Add the webhook endpoint and its signing secret in the Clerk dashboard and in Render, so a ban or session revoke lands at once instead of at the hourly refresh. The code can ship off by default first. (SCA-4b, M; not in the lead's list, from the map) |
| GitHub Actions first run | Approve the first push that runs CI on the private repo. It uses Actions minutes (the full e2e runs 6 shards on each push to `main`, about 15-20 runner-minutes each, C4's estimate). (CI-1 above) |
| Real-device session | One scripted session of about 20 minutes on a real iPhone, iPad (Safari), Android phone and Mac: guest-link join, a note typed with an IME, a CJK note and an emoji note, pinch, comment, voting, timer, present follow, and Wi-Fi to cellular. This also tests the macOS wheel guess and the iPad pinch. Its results drive any text-metrics recalibration. (P10) |
| Separate backup bucket | Create a least-privilege R2 bucket and a write-only token in Cloudflare for offsite backups (they share the api's bucket and token today). Needs your Cloudflare account. (BACKUP-bucket) |
| Render build plan | Check the price of Render's "performance" build plan before choosing it. The only trace in the repo is `docs/DEPLOY.md` line 795 ("Build pipeline minutes. No price is shown on the pricing page (UNVERIFIED)"). |
| Bandwidth for 200-person workshops | Accept Render's outbound pricing ($0.15 per GB after 5 GB a month, DEPLOY.md), or approve the levers: permessage-deflate on changes frames, and 5 Hz cursors or Hide cursors by default above 50 sessions. The map estimates a 200-person, 2-hour session at several dollars; the L1 stress run sent 9.47 MB/s (about 34 GB an hour) before wave D. (APPB10) |
| Staging load test window | Approve a window for a 50-100 session load test against staging, or one deliberate sync restart with browsers connected. With the results, decide on the L1 misses (CAP-L1): accept them on the 0.5-CPU plan or pay for a larger one. The NAS re-runs need no approval. |
| Asset GC | Around 2026-10-31, after reviewing the report passes, approve `DRAFTROOM_ASSET_GC=delete`. (CUTOVER-D30) |
| DBC Ops integration | Define the project-to-lobby contract and the auth between DBC_ops and Lobby (Entra or Clerk). (DBC-ops-integration, L) |
| Kanban | Say whether it is wanted, and what a first slice contains. (Kanban, L) |
| "What changed since your last visit" | Build it now (it needs new per-user storage) or keep it deferred. (PRI-05c, L) |
| `schema_migrations` check | In the api Shell or the database, confirm `schema_migrations` lists 0023 and 0024. The start-up runner applies migrations and logs nothing, so this stays an owner check (CUTOVER-LOG §7, held release). |
| D7 drop-legacy, 2026-10-08 | The scheduled task `lobby-d7-drop-legacy` (enabled) fires 2026-10-08 14:07 Pacific. It checks 7 clean days, takes a fresh backup, drops the legacy tldraw tables and removes `VITE_TLDRAW_LICENSE_KEY`. It does not run your Shell checks, which the map lists as the condition: each board's conversion report (lossy codes, `diff`, `invariants`), `restore-drill --from=local`, `df -B1 /var/data`, and your sign-off of the lossy counts (CUTOVER-LOG §5 and §6). Do those before it fires, or disable the task. |

Also waiting on a person with a real sign-in (none recorded as done): the SMK-2 revoke screen (revoke a test user with a tab open; STG-2), a selection vote that names its frames in the Voting panel (shows `x-lobby-client` passes the `/api/*` rewrite), one real Clerk sign-in after the Clerk session-status check of wave A, and the W4 walk (a phone guest link, the History panel's two migration checkpoints, a new board, `DEMO.md`). `docs/WHATS-NEW-CANVAS.md` is a draft, not sent; it assumes readers used Lobby before the switch, and staging had 1 user and 4 boards at the cut-over. Optional: name the laptop that counts for the laptop half of the render numbers (PERF-laptop).

## 4. Known limits accepted

| Limit | Decision |
| --- | --- |
| The board's start view can be set only by its owner (`startView` has writer `owner` in `packages/canvas-schema/src/doc.ts`). | CR 3b-3 was closed keeping it owner-only, an accepted deviation under the detail-level rule (`docs/research/excalidraw/WAVE-3.md`, the "Start view" row). Say so if editors should set it. |
| Polygon tools draw Lobby's own outlines, which differ from converted shapes by up to 57 px (W5-33 D4). | The lead reverted CR-2B-2 (`841d6dc9`) before the held deploy: leaving tldraw was a licence decision, so code derived from tldraw's geometry stays in the server-side converter, not the web bundle (CUTOVER-LOG §7). Reopen only with a clean-room outline. |
| Mermaid text pasted onto a board is not turned into a diagram. | Mermaid is stubbed out of the bundle in wave C (PLAN-wave4); the closure fell from 11.1 MB to 7.8 MB. |
| All guests together can hold at most 6,000 items on one board (`GUEST_BOARD_ITEM_CAP`); deleted items count until trimmed; accounts are unaffected. | The lead set 6,000 (200 guests x 30, 30 % of `MAX_ITEMS`) before wave A shipped (PROGRESS, wave A follow-ups). |
| Cropped images stay on the 512 px thumbnail. | A known limit of the display-swap rule, "not a regression" (PROGRESS, wave A). |
| The stale-pv check on an undelete (P-W5) is a stale-write guard, not content hiding: an editor can resend with the current pv. | Shipped as is in wave A; no later decision recorded. |
| Receipts fall back to counting for the first flush after a reconnect (no receipt id yet), answers later than 5 s, and receipts trimmed from the ring (64 per user, 7 days). A write that never reached the room now beats a later write by someone else, with no notice, as an offline edit does. | Shipped in the held release `e2cb709`; the behaviour change is recorded in PROGRESS (held-release entry, "Behaviour change to note"). No owner decision is recorded. |
| Above 41 sessions each person sees at most 40 cursors; the person they follow and their followers are always sent. | Design of CONTRACTS_REV 10 (wave A). |
| A legacy v1 checkpoint with more than 1,000 records, 2.5 MiB or about 35,000 label characters shows "can't be previewed"; restoring it as a new board still works. | Wave E (E1-2). Raise `maxTextChars` knowingly if the demo uses a legacy board with long stickies. |
| Removing a member keeps the multi-use links they made (named in the audit entry) and does not remove sessions, their personal workspace or boards they created. A person removed while redeeming a link they already used is a guest again if the redeem commits second. | Wave D and E (E1 notes: a valid link, no orphan grant). A Clerk ban or deletion removes no membership (DEPLOY.md, Offboarding). |
| The Auto wheel guess is reasoned, not measured, on scaled displays and on a real Mac. | Preferences > Input device overrides it (wave B, D6-1, E3-2). A real Mac is part of the owner's device session. |
| Redo after "delete, then click something within 300 ms" selects that thing. | D3-2b's settle window; harmless, recorded in PROGRESS wave D. |
| A request with an unknown length (chunked) gets the strict 60 s total limit; large declared bodies are cut only after a 60 s stall. | D4's request-timeout design (PROGRESS wave D). |
| The R0 rollback is retired: rolling the api below 0024 needs `DRAFTROOM_ALLOW_NEWER_SCHEMA=1`. | The release waited for the 48 h window to close (20:55Z) and shipped at 21:09Z (CUTOVER-LOG §7). |

## 5. Older rows (the 2026-09-28 review of the tldraw build)

All 33 rows of the old list described the tldraw build. What became of them:

- **19 were fixed on the `next` branch and deployed** in `380aa92` (2026-09-29): A11Y2-03, A11Y-01, A11Y-08, A11Y-09, A11Y2-09, A11Y2-07, A11Y2-10, R2-11, R2-09, R2-08, A11Y2-06, R2-04, A11Y-06, R2-07, A11Y2-05, F2-03, F2-05, DANA2-05, DANA2-06 (the old list's own "Fixed" line and PROGRESS, 2026-09-29; not re-checked on the Excalidraw build). Two spot checks in the current code agree: auto-checkpoint reasons carry the prompt (`apps/api/src/features/history/checkpoints.ts`), and a revoked guest gets no "Go to your boards" button (`apps/web/src/invite/GuestNoAccessScreen.tsx`).
- **Carried into the map and shipped in wave C:** DANA-11 and F14 (a plain People button), R13 (cursor name tags hidden on phones), R2-10 (tag chips), F2-08 (Zoom to matches), F5 (read-only PDF viewer).
- **Gone with tldraw:** F2-07 (no text halo on the Excalidraw build, `REVIEW-W5-EARLY.md`), DANA-12 (the tldraw licence mark; staging has none).
- **Not re-checked on the Excalidraw build; treat as candidates, size S each:** A11Y2-08 (the keyboard way into a frame is only in the shortcuts dialog), F2-06 (square grid cells leave wide gutters for landscape photos: `arrange-grid.ts` has no median-aspect or justified-rows logic), F2-09 (comments and file cards do not say which file they refer to), F13 (the Mood board template's dashboard thumbnail), F15 (export polish: the SVG size, the title). F2-03 (arrange as grid on a subset can grow over neighbours) and F2-05 (download originals as one ZIP) were "fixed" on `next`; `arrange-grid.ts` has no neighbour check and the code has no ZIP, so the Excalidraw port may not carry those fixes. Check them before the next reviewer pass.

## How this page was checked

On 2026-10-03, in a clean worktree at `b10aefa4`: the six deploy commits exist on `main` (`git log`); `GUEST_BOARD_ITEM_CAP` is 6,000, `CONTRACTS_REV` is 11, `RERANK_EVERY_TICKS` is 50, the preview bounds are 1,000 records and 2.5 MiB, `DEFAULT_REQUEST_TIMEOUTS` exists, migration 0024 exists; the sync still reads `?ticket=`; `ci.yml` has 9 jobs and no `node --test`; the ownership-transfer `findTarget` and `shareLike` are unchanged (OFF-1); no spec in `e2e/excalidraw` carries a `test.fail` mark (only the unused `needs()` helper in `a11y-kit.ts` calls it); the scheduled task `lobby-d7-drop-legacy` is enabled for 2026-10-08 21:07Z. A sample of the cited tests was re-run here and passed: 15 unit files (152 tests: guest budget, lock-exempt keys, presence rank, receipt gap, in-flight key echo, start scene, socket-busy, selected groups, rekey-perf, request timeouts, v1 preview, access-actor flows, offboarding, limits, wheel ratio) and 10 e2e tests in 4 specs (`locked-customdata`, `history-selection`, `gaps-board-status`, `board-session-stable`). Not re-run: the rest of the cited tests, anything on staging, real Postgres, or any device. Items marked "not re-checked" come from the wave reports as written.
