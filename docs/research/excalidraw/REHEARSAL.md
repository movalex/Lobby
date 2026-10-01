# Rehearsal of the Excalidraw cut-over, the rollback and the roll-forward (NAS, 2026-10-01)

Status: **run 2026-10-01 17:14–17:49Z on the rehearsal stack of `REHEARSAL-PREP.md`, with staging's real
data (1 user, 1 workspace, 4 boards). Every step of `docs/EXCALIDRAW-CUTOVER.md` C4–C17, the rollback §7
(B3–B9) and the roll-forward §8 (F3–F9) PASSED; the deviations are in §8 and the runbook was corrected in
the same commit (§9). The stack is left running on the new build.** The owner's parts are still open: a
real Clerk sign-in (R8) and the side-by-side comparison (R9); P3's sign-off is his.

Operator: an agent over SSH and headless Chromium, no human at a keyboard. It entered no password: the
restored user's session was **minted** (one `sessions` row holding the sha256 of a 32-byte token generated
on the workstation; the token itself never reached the NAS; the row expires in 2 days). This page carries
ids, counts, codes, timings and hashes only: no board text, no names. The reports named below live in the
cut-over log (the session's scratchpad, outside the repository) and under `reports/` on the NAS.

## 1. What ran

| Part | Value |
|---|---|
| R0 (the bridge release, "theirs" in the drill) | `main` ec344cd, images `draftroom-rehearsal-{api,sync}:r0`, web `web/dist-r0` (`REHEARSAL-PREP.md` §1) |
| The candidate ("ours") | `engine/excalidraw` **a39a1c5**, archived to `src-x/`, built on the NAS as `draftroom-rehearsal-api:excalidraw` (312 MB, 6 s), `draftroom-rehearsal-sync:excalidraw` (266 MB, 5 s) and the web in the pinned node image into `web/dist-x` (8 s incl. `pnpm install` from the warm store; `env/web-build-x.env` = `VITE_DRAFTROOM_SYNC_ORIGIN` only: no licence key and no `VITE_LOBBY_ENGINE`, exactly render.yaml at a39a1c5). `dist/excalidraw-assets/` holds 233 fonts; `index.html` has 0 inline scripts |
| The edge | `rehearsal/edge.mjs` with two additions (`rehearsal/` on this branch is what runs on the NAS): a 404 for a missing path under `/excalidraw-assets/` (always on) and the patch's `Content-Security-Policy` behind `EDGE_CSP` (`env/edge.env`, present on the Excalidraw build, absent on R0). `stack.sh` passes `env/edge.env` to the edge when the file exists |
| The sync's environment before C4 | `DRAFTROOM_BACKUP_STORE=fs` (`data/sync/blobs`; never R2: no `R2_*` value exists on the NAS, grep 0) and a rehearsal-local `DRAFTROOM_BACKUP_SIGNING_SECRET` (44 characters from `openssl rand`-equivalent, in `sync.env` only), both needed by C5 and by the new build (P15). R0's sync was recreated to read them (a Docker container's environment is fixed at creation) |
| Boards | b-0gazyr0d3e (41 records), b-7gw2v3e61a (64), b-e7mx42m5yt (4), b-esfzg8j7zo (33); sha256 of the four files before C4 in `reports/rooms-sha256-pre-cutover.txt` (identical to the restore's) |
| Postgres | users 1, workspaces 1, projects 0, boards 4, memberships 1+4, 22 migrations before C7; 23 after (0023 applied by the new api) |
| Disk (P4) | `/var/data` 1.97 TB free; rooms 368,640 B; the conversion's own check needed 52.7 MB per board (3.5 × + 50 MB) |

Baseline before the cut-over (headless, R0, 17:22–17:24Z): the dashboard lists 4 boards (1.9 s), each
board online and "saved" in 0.93–0.95 s on tldraw (30/51/1/29 `.tl-shape`, 3/7/0/0 frame headings), the
canvas still there after 7 s (no licence blank), 0 CSP violations (no CSP on R0), hosts requested:
`192.168.10.1` and one request to `cdn.tldraw.com` per board (R0's known host).

## 2. The steps, timed (UTC; "duration" = the step's commands, not the operator's pauses)

| Step | Start | Duration | Result | Evidence (ids, counts) |
|---|---|---|---|---|
| R3 archive a39a1c5 → `src-x` | 17:14:36 | 1 s | PASS | 18 top-level entries |
| R4 build api, sync, web | 17:15:05 | 19 s | PASS | 6 s + 5 s + 8 s; `logs/build-x.log` |
| R4 edge: 404 rule, CSP off; sync with `fs` store | 17:21:13 | 4 s | PASS | `csp=off`; `[backup] offsite backups: fs`; maintenance false |
| **C4** maintenance on (R0) | 17:25:49.1 | 0.3 s | PASS | `{"maintenance":true,"closedSockets":0}` |
| **C5** run-all `--expect-maintenance` | 17:25:49.4 | 5.2 s | PASS | exit 0; `ok` true, `inMaintenance` true, `offsite` fs; 4 boards, clocks 1/1/15/83, `holdUntil` 2026-12-30; the run itself 0.41 s, the rest the CLI's 5 s poll |
| **C6** checkpoint of every board (api) | 17:25:54.7 | 5.3 s | PASS | exit 0; 4 saved, 0 unchanged/skipped/failed; the runbook's clock comparison: `clocks match` |
| **C7–C9** new api + new sync booting in maintenance | 17:27:22.1 | 3.8 s | PASS | `docker rm -f api sync && ./stack.sh start excalidraw`; both listening at +3 s; api healthz 200, `schema_migrations` 23 (0023); sync log `[maintenance] on at start`, signing key ids logged; `int GET /internal/maintenance` true; `/internal/migrate/status` → `convertAll idle` |
| **C10** convert-all | 17:28:17.4 | 5.5 s | PASS | 202; poll: 1 running → 4 done; no FAILED line (§3) |
| **C11** check script | 17:28:23.0 | 0.08 s | PASS | "all 4 boards converted and checked" |
| **C12** engine-migration checkpoints | 17:28:23.1 | 5.6 s | PASS | exit 0; 4 saved, 0 skipped/failed, `body_version` 2 |
| step-4 checks in Postgres | 17:28:29 | 1 s | PASS | one `engine_migration` row (body_version 2) per board; `new_canvas` false ×4 |
| **C13/C14** web swap + CSP on | 17:29:16.3 | 2.9 s | PASS | `csp=on`; header served; missing font 404; 0 inline scripts; a real font 200 `font/woff2` |
| **C15** sync side | 17:29:21.9 | 0.6 s | PASS | backups status: 1 offsite success per board (C5's); `restore-drill --from=local --board b-e7mx42m5yt` PASS |
| **C15** browser, in maintenance | 17:29:42.8 | 15.5 s | PASS | dashboard 4 cards; each board shows `sync-error` MAINTENANCE on the mounted Excalidraw page in 0.89–0.92 s; 0 CSP violations; History of b-0gazyr0d3e through the api: 3 snapshots |
| **C16** maintenance off | 17:30:31.9 | 0.3 s | PASS | `{"maintenance":false}`; the boot flag removed from `sync.env` |
| **C17** boards open with sockets | 17:31:03.5 | 21.6 s | PASS | 4 boards online + saved in 0.90–0.93 s; one same-origin font request each; 0 CSP violations; metrics: 4 joins |
| **C17** `live-smoke.mjs --expect excalidraw` | 17:31:25.4 | 6.6 s | PASS | 34 passed, 0 failed, 0 warnings; socket refused 4099 NOT_AUTHENTICATED (not MAINTENANCE) |
| step 5: edits on the new build (§4) | 17:32:21.6 | 0.8 s | PASS | 5 commits, clock 1 → 6, 47 → 51 live elements |
| born-after board created and opened | 17:33:19.7 | 21 s | PASS | b-j85v169uw5, 201; `new_canvas` true; opened online + saved in 0.92 s; file 61,440 B, sha256 `1ded4ae7…` |
| **B3** maintenance on (Excalidraw) | 17:34:54.2 | 0.3 s | PASS | |
| **B4** safety copy | 17:34:54.5 | 10.7 s | PASS (see §8 D9) | first run: NOT refused, 5/5 ok; a second, forced run (my test) 5/5 ok; converted boards described `lobby-elements-converted` (51/76/2/33 records), the born-after one `lobby-elements` (0) |
| **B5** CSP off | 17:35:05.4 | 2.0 s | PASS | `csp=off` |
| **B6** R0 api | 17:35:07.4 | 8.3 s | PASS | `DRAFTROOM_ALLOW_NEWER_SCHEMA=1`; up at +3 s; log `newerMigrations: ["0023_export_policy_guests"]`; healthz 200; overlap check (R0 api + Excalidraw sync): checkpoint-all 0 saved, 4 failed, 1 skipped `new-canvas`; `board_snapshots` unchanged |
| **B7** R0 sync | 17:35:15.7 | 2.0 s | PASS | up at +2 s with maintenance **off**; manifests re-signed (§8 D11) |
| **B8** R0 web | 17:35:17.7 | 0.003 s | PASS | `mv`; no CSP header; 1 inline script (R0's theme boot); `/excalidraw-assets/` still 404 |
| **B9** NAS side | 17:35:18 | 2 s | PASS | R0 snapshots 41/64/4/33 records (C5's state; the Excalidraw edits hidden); born-after → 409 `new-canvas` |
| **B9** browser on R0 | 17:36:06.4 | 33.7 s | PASS | dashboard 5 cards, 1 "New canvas" badge; 4 boards online on tldraw, shapes 30/51/1/29 (= baseline), no licence blank at 7 s |
| **B9** born-after page on R0 | 17:41:54.3 | 1.0 s | PASS | `new-canvas-board` page (NEW_CANVAS_BOARD) before any socket; the api's ticket 409 `NEW_CANVAS`; a converted board's ticket 200 |
| **B9** edits on R0 (§5) | 17:37:26.8 / 17:40:09.3 | 8.4 s + 10.7 s | PASS (2nd pass) | frame F2 dragged; note N3 dragged; 2 notes added; R0 records 41 → 43, clock 9 |
| born-after file after R0's period | 17:40:5x | 1 s | PASS | sha256 `1ded4ae7…` unchanged, `-wal` empty |
| **F3** maintenance on (R0) | 17:45:42.8 | 0.3 s | PASS | |
| **F4** R0 run-all (`before-rollforward-*.json`) | 17:45:43.1 | 5.3 s | PASS | 5/5; b-0gazyr0d3e 43 records clock 9 digest `e0b9bcc1…`; the three others unchanged digests; born-after `lobby-elements` 0 records |
| **F5** new api | 17:45:48.4 | 2.9 s | PASS | flag removed; healthz 200; nothing to migrate |
| **F6** new sync in maintenance | 17:45:51.3 | 3.1 s | PASS | maintenance true; migrate idle; signing key logged |
| **F7** convert-all (the merge) | 17:45:54.4 | 5.9 s | PASS | 1 job: b-0gazyr0d3e `rollforward`, mode maintenance, `capMb` 256, 896 ms, peak 31.4 MB; F7's script: "roll-forward reports ok" (§6) |
| **F8** CSP on, Excalidraw web | 17:46:00.4 | 1.9 s | PASS | `csp=on`; header, 404, 0 inline, font 200 |
| **F9** C16 maintenance off | 17:46:02.2 | 0.1 s | PASS | boot flag removed from `sync.env` |
| **F9** C17 opens | 17:46:53.8 | 21.6 s | PASS | all 5 boards online + saved in 0.90–0.93 s; dashboard 5 cards, 0 badges; 0 CSP violations |
| **F9** smoke | 17:47:15.7 | 6.5 s | PASS | 34 passed, 0 failed, 0 warnings |

**Window numbers (R11).** C4 → C16 took 4 min 43 s wall-clock with the operator's pauses between steps;
the commands themselves sum to about 30 s (three of them are 5 s CLI polls). Rollback B3 → B8: 23.5 s.
Roll-forward F3 → F9: 19.6 s. On Render the three service deploys (C7, C9, C14; B6–B8; F5, F6, F8) will
dominate: the rehearsal's `docker rm -f … && ./stack.sh start` stood in for them at 2–4 s each.

## 3. The conversion (C10/C11), per board

| Board | Records in | Elements out | Lossy codes | ms | Peak heap (MB) | Digest = C5's `recordsSha256` | `sourceMatchesBackup` | Diff checks | Invariants |
|---|---|---|---|---|---|---|---|---|---|
| b-0gazyr0d3e | 41 | 47 | none | 136 | 30.1 | yes (`backupKey` = C5's object, `…17-25-49-628Z-c1`) | true | 8/8 pass | ran, 0 violations |
| b-7gw2v3e61a | 64 | 76 | none | 110 | 31.8 | yes | true | 8/8 | ran, 0 |
| b-e7mx42m5yt | 4 | 2 | none | 104 | 29.1 | yes | true | 8/8 | ran, 0 |
| b-esfzg8j7zo | 33 | 33 | `geo-approximated` 1, `geo-polygon` 1 | 146 | 33.3 | yes | true | 8/8 | ran, 0 |

The eight diff checks: shape-mapping, plain-text, asset-set, anchors, frame-membership, bounds, limits,
local-mode. Disk: `ok` on every board (needed 52.7 MB, 1.97 TB free). Files grew 90,112 → 204,800,
102,400 → 253,952, 69,632 → 122,880 and 106,496 → 258,048 bytes (2.3–2.4 ×); b-0gazyr0d3e is 311,296
bytes after the roll-forward (3.5 × its tldraw file). The status shows `runtimeCapMb: 98` (the cap of a
lazy conversion on open) and `capMb: 256`, `mode: "maintenance"` on each job. C12 saved one
`engine_migration` checkpoint per board (`body_version` 2, `documentClock` 1 on the new canvas, record
counts 47/76/2/33).

## 4. Step 5: edits on the new build (b-0gazyr0d3e, the Excalidraw side)

Through O2's headless client (`apps/web/src/canvas/sync/headless`, the engine core browsers run) from a
worktree of a39a1c5, over the edge's `wss://…:8444`, with a ticket from `POST /api/boards/:bid/ticket`
(role owner) and `ws` for the `Origin` header the sync requires (`rehearsal/x-edit.mjs`). Each step waited
for "saved": add a note NA inside frame F1 (115 ms), add a free note NB (70 ms), move F1 by (+40, +30)
with its 34 children (91 ms), move C2, a child of frame F2, by (+25, +15) (65 ms), move N3, a note in a
third frame, by (+30, +30) (102 ms). 514 ms in all; 5 commits; clock 1 → 6; 47 → 51 live elements (14
notes, 25 texts). The board reopened in the browser online and saved (0.93 s), 0 CSP violations.

Ids: F1 `YN7dxnofwNa61jUgZ9Hhb`, F2 `WRWEhUXZlXRHt8D7ymxsq`, C2 `k5W-VZMnux-KpDykMbKv2`, N3
`s-UVKSdxIU7D1rS3HmiA4`; NA and NB are `reh-note-…` ids (in the log's `11-x-edit.json`).

## 5. Step 6: the rollback drill (§7) and the edits on R0

R0 served the four converted boards from their tldraw tables at C5's state (41/64/4/33 records; shapes
30/51/1/29 in the browser, as before the cut-over: the Excalidraw edits of §4 were hidden, not lost), and
refused the born-after board three ways: the api's ticket route 409 `NEW_CANVAS`, the sync's internal
snapshot 409 `new-canvas`, the board page's "Made on the new canvas" screen with no socket; the dashboard
showed its "New canvas" badge. Its file stayed byte-identical through R0's period.

Edits on R0 through the tldraw UI in headless Chromium (`rehearsal/r0-edit.mjs`, then `r0-edit2.mjs`):
frame F2 dragged by its heading (screen delta 60, 40 px at zoom-to-fit; the record moved from (1494, 115)
to (1604, 188)); note N3 dragged (the record moved from (320, 100) to (420, 172) inside its frame); one
note duplicated with Ctrl+D and one added with the N tool. R0's records 41 → 43, clock 9, 14 notes. The
first pass only landed the frame drag: see §8 D14.

## 6. Step 7: the roll-forward (§8) and the merge

F7 ran one job (the three untouched boards and the born-after board needed nothing: `boardFileState`
converted/element). Report `b-0gazyr0d3e.rollforward.json`: `ok` true, cycle 1, counts created 2, deleted
0, changed 2, parentMoved 5, elementsWritten 15, elementsUntouched 40, deletedRowsAppended 0, pagesAppended
0; conflicts **1**: `{ elementId: s-UVKSdxIU7D1rS3HmiA4, group: pos }`; lossy none; resnap none;
invariants ran, 0 violations, 0 failures, 0 repaired; 108 ms merge inside an 896 ms job, peak 31.4 MB.
`converted_from` after: cycle 1, `documentClock` 9, `lbClock` 10, `sourceSha256` = F4's `recordsSha256`
for the board (`e0b9bcc1…`), `backupKey` still C5's. Tables: `lb_prev_1_{elements,deleted,doc,meta,source}`
(51 element rows = ours before the merge), `lb_source` 43 rows (= theirs), 55 live elements.

Read from the merged file next to ours (B4's safety copy, clock 6) and theirs (`lb_source`), positions
rounded (`rehearsal/verify-merge.tpl.js`):

| Element | What each side did | Base | Ours | Theirs (absolute) | Merged | Rule (rollforward.ts) |
|---|---|---|---|---|---|---|
| F1 (frame) | ours moved it with 34 children | (-266, 115) | (-226, 145) | unchanged | **(-226, 145) = ours** | ours only |
| F2 (frame) | theirs moved it | (1494, 115) | unchanged | (1604, 188) | **(1604, 188) = theirs** | theirs only |
| C2 (note in F2) | ours moved it (+25, +15); theirs moved its frame (+110, +73) | (1534, 295) | (1559, 310) | (1644, 368) | **(1669, 383) = ours + the frame's delta** | d: parent moved, both kept, no conflict |
| N3 (note) | both moved it (ours +30, +30; theirs +100, +72) | (1814, 975) | (1844, 1005) | (1914, 1047) | **(1914, 1047) = theirs**; ours in `lb_prev_1_elements` | c: `pos` conflict, theirs wins |
| NA, NB (+ labels) | ours created | — | present | — | present | kept |
| R0's two notes (+ labels) | theirs created | — | — | 2 records | 4 elements present | e: created |

Both sides' edits are present (51 + 4 = 55 live, nothing lost but the one listed `pos` conflict, whose
value is kept in `lb_prev_1_*`), and the conflict report names exactly that element and group. After F9
all five boards opened on the new build (0.90–0.93 s each), the dashboard showed 5 cards and no badge,
and the smoke passed again.

## 7. State left behind (the owner said: delete it after; `REHEARSAL-PREP.md` §7)

At 17:48:53Z: `draftroom-rehearsal-{pg,api,sync,edge}` up, api and sync on `:excalidraw`, 0 restarts,
memory pg 78 / api 73 / sync 78 / edge 24 MiB; the seven other containers untouched. `data/sync`: rooms
988 KB (5 files), backups 3.0 MB (4+4+4+4+3 held files: C5, B4 ×2, F4, and the born-after board's), blobs
25 files (3.1 MB), `migration/` 5 reports, `cutover/` 3 run-all reports; `/volume3` 8.7 GB used. `web/dist`
= the Excalidraw build, `web/dist-r0` = R0's. `env/`: `edge.env` (the CSP), `sync.env` with
`DRAFTROOM_ENGINE=excalidraw`, the `fs` store and the signing secret (no boot flag), copies `sync.env.r0`
(R0's), `sync.env.x`, `api.env.x`, `sync.env.r0-prep.bak`, `web-build-x.env`; all mode 600. Postgres:
boards 5 (the born-after one), 23 migrations, 2 live sessions (the restored ones; the minted session was
revoked at the end of the run and its token deleted from the workstation). Images: the four `draftroom-rehearsal-*` tags. The cleanup of §7 of the prep page applies as
written, plus `docker rmi` of the two `:excalidraw` tags.

## 8. Deviations from the runbook, and what was not exercised

- **D1 (R2).** Ports are published on `192.168.10.1`, not `127.0.0.1` through `ssh -L` (the owner's
  instruction, `REHEARSAL-PREP.md` §1). Runbook corrected.
- **D2 (R4).** The web was built **without** `VITE_LOBBY_ENGINE` (gone since G10, as `VITE_TLDRAW_LICENSE_KEY`;
  render.yaml at a39a1c5 has neither); `REHEARSAL-PREP.md` §4 step 2 still said to add it. The images are
  tagged `:excalidraw`, not `:x`. Runbook corrected.
- **D3 (R4).** "A container with any `R2_*` variable must refuse to start" was not exercised: no `R2_*`
  value exists in any env file (grep 0), so nothing could reach a bucket.
- **D4 (C5, C6, C12).** Each CLI took 5.2–5.6 s for a run of 0.2–0.4 s: the CLIs poll every 5 s.
  `--interval-ms 1000` shortens the window. Runbook notes it.
- **D5 (C9).** The new sync's startup log does **not** name the engine (it logs the `fs` store, the signing
  key ids and `[maintenance] on at start`); the engine is attested by `GET /internal/migrate/status`
  answering 200. Runbook corrected. The status also shows `runtimeCapMb: 98` (lazy conversions) next to
  `capMb: 256` on each maintenance job: not a wrong cap.
- **D6 (C16, rehearsal only).** A Docker container's environment is fixed at creation: deleting
  `DRAFTROOM_BOOT_MAINTENANCE` from `sync.env` does not reach the running container (a `docker restart`
  would boot in maintenance again until the container is recreated). Render reads the current environment
  at every start, so "delete the flag, then a restart starts open" could not be rehearsed here. Noted in R6.
- **D7 (R8, P5, C15, C17).** No human signed in (the agent enters no password): the session was minted (above).
  DEMO.md in Chrome with a real Clerk sign-in and the exact Clerk origins of a completed sign-in are still
  the owner's. Observed under the enforced CSP: the sign-in page (Clerk's widget rendered) requested only
  `splendid-flamingo-3744.clerk.accounts.dev` (16) and `img.clerk.com` (2) besides the edge, 0 violations;
  `challenges.cloudflare.com` and `clerk-telemetry.com` were not requested. P5 stays open for the
  completion of a sign-in.
- **D8 (C17).** "Two users editing" was one headless-client session plus browser sessions (no second person,
  no cursors seen); no phone guest; the History panel was checked through `GET /api/boards/:bid/snapshots`
  (3 snapshots) and Postgres rows rather than the UI.
- **D9 (B4).** Within 10 minutes of C5 the run-all was **not** refused with 409 `RECENT_HELD_SET`: the guard
  needs a held set of **every** board, and the board created in C17 (as the runbook asks) had none. The
  first run wrote a new held set at once; the forced second run was this operator's test and added a
  redundant set. Runbook corrected: `--force` only on a 409.
- **D10 (B6).** During the overlap (R0's api, the Excalidraw sync in maintenance) R0's checkpoint-all failed
  each converted board with "the sync server answered with a snapshot that is not a tldraw one" and skipped
  the born-after board as `new-canvas`; 0 saved, the `board_snapshots` counts unchanged. The runbook named
  503 `SYNC_UNAVAILABLE` for this; the effect is the same (nothing saved). Runbook corrected.
- **D11 (B7).** R0's sync re-signs the offsite manifests and index on start: `[backup] offsite manifest of
  board … is signed with another key (DRAFTROOM_INTERNAL_SECRET changed?); signing it with the current key,
  its older entries stay as they are` (×4 boards + the index). Expected: the Excalidraw build signed them
  with `DRAFTROOM_BACKUP_SIGNING_SECRET`. After the roll-forward the new sync reported `failuresTotal` 0 and
  no verification complaint. Runbook notes the lines.
- **D12 (R10).** One cycle only. Not exercised: a delete, a z-order change, an edit on a flattened page 2, a
  conflict in a group other than `pos`, a board created on R0 (F7's conversion of such a board and its
  digest check against F4), a second rollback and roll-forward (`converted_from.cycle` 2), and the
  `dr_deleted_*` byte-identity (no deletes happened). Observed and recorded in F7: the frame-moved-by-theirs
  plus child-moved-by-ours case merges with both deltas (`parentMoved`), not as a conflict.
- **D13 (the smoke).** `scripts/smoke/live-smoke.mjs` (`engine/smoke`) needed two switches for the
  self-signed single-origin edge, applied to a copy (`rehearsal/patch-smoke.cjs`): a `LOBBY_SMOKE_REPO_ROOT`
  for Playwright's checkout and `LOBBY_SMOKE_INSECURE_TLS=1` (`ignoreHTTPSErrors`, `rejectUnauthorized:
  false`; Node's fetch takes `NODE_EXTRA_CA_CERTS=edge.crt`). With `--api` pointing at the single origin,
  "api /healthz" hits the SPA (200 `text/html`) and passes vacuously; the api's health was read inside its
  container instead. Both are changes for `engine/smoke`, not made here.
- **D14 (B9, the tldraw UI).** The first R0 pass failed two of three edits: a click then a drag 300 ms later
  on a note read as a double-click (text editing), and R0's COL-04 rule (a printable key typed into the one
  selected note) swallowed the `n` meant for the note tool. The second pass dragged in one pointer gesture
  and pressed Escape before `n`. No text was changed by the stray key (N3's label length unchanged).
- **D15 (B6).** Migration 0023 made B6 the "otherwise" case, as P12 predicted: `DRAFTROOM_ALLOW_NEWER_SCHEMA=1`
  and R0's api logged `newerMigrations: ["0023_export_policy_guests"]`.
- **D16.** The runbook's C11 and F7 scripts, the C10 poll and the `int` helper ran verbatim from files
  (`rehearsal/c10-poll.js`, `c11-check.js`, `f7-check.js`, `tools/int.sh`) through `docker exec -i … node -`.
- **D17 (R9, P3).** The owner's comparison of 10 boards and his sign-off did not happen (an agent run).
  Screenshots, traces and videos were off throughout.

## 9. Runbook fixes made in this commit (`docs/EXCALIDRAW-CUTOVER.md`)

Status line and P3 (rehearsed, what stays open); P5 (the origins seen on the sign-in page; a completed
sign-in still needed); P11 (the measured peaks); R2 (the LAN address); R4 (the [BUILD] closed by
`rehearsal/`, no `VITE_LOBBY_ENGINE`, the `:excalidraw` tag); R6 (the rehearsal form of the deploy steps
and the fixed container environment); R10 (what the drill showed and what remains); R11 (the numbers);
C5 (`--interval-ms`); C9 (what the log says and what attests the engine; the two caps); B4 (when the 409
occurs); B6 (the overlap's observed failure); B7 (the re-signing lines); B9 (the three refusals); F7 (the
observed merge semantics); C17 (the smoke script and its rehearsal switches). Also updated here:
`rehearsal/edge.mjs` and `rehearsal/stack.sh` (the copies of what runs on the NAS) and the helper scripts
of this rehearsal under `rehearsal/`.

## 10. Files on this branch (`docs/research/excalidraw/rehearsal/`)

`stack.sh`, `edge.mjs` (with `EDGE_CSP` and the 404 rule), `edge.env.example` (the CSP line for the
rehearsal), `build-x.sh` (the three builds), `int.sh` (the runbook's helper through `docker exec`),
`c10-poll.js`, `c11-check.js`, `f7-check.js` (the runbook's scripts as files), `report-summary.js` (the
conversion and roll-forward reports as ids and counts), `verify-merge.tpl.js` (both sides of the merged
file), `open-boards.mjs` (headless opens with the minted session: dashboard, boards, the maintenance and
new-canvas screens, CSP violations), `api-get.mjs` (api reads with the session, privacy-scrubbed),
`x-edit.mjs` (the Excalidraw-side edits through the headless client), `r0-edit.mjs` and `r0-edit2.mjs`
(the tldraw-side edits through the UI), `patch-smoke.cjs` (the smoke's two switches), and the prep's
`nas-env.mjs`, `pg-allowlist.mjs`, `restore-boards.mjs`, `verify.mjs`. None holds a secret or content.
