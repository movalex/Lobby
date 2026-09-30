# O1 room: the ElementRoom slice (spike B)

## Part 3: wave 2's change requests (CR 2F-2, CR-2D-1) and the items left from parts 1-2

Branch `spike/b-room`: `spike/excalidraw` `92b1098` (the lead's M3 report; a fast-forward from `d495f06`)
plus `6055baf` (CR), `61d3ad9`, `f98ce33`, `d22686f` and this file. The requests come from wave 2's owners
on `engine/excalidraw` (`5b9c87a`): 2F's CR 2F-2 (`8a7e7af`), 2D's CR-2D-1, and the integrator's list for
O1. Windows 11 workstation, Node 24.19.0, pnpm 10.34.5, Playwright 1.63.0, headless Chromium only. Ports
7860-7862 (O1's range); nothing listened in 7860-7869 before or after any run. Every stack ran with
`DRAFTROOM_BACKUP_STORE=off`; no R2 write; `.env.deploy.local` never read. NOT a quiet window.

### Built in part 3

| What | Where | Plan / request |
|---|---|---|
| **`prepareBoard(boardId)`** on the room service: the board's room opened after its conversion or roll-forward (the snapshot route's `existing`). `true` when open, `false` when the board has no file, 503 `unavailable` when it cannot be prepared | `room/index.ts` | CR 2F-2 |
| **`serverWrite(boardId, apply)`**: opens the board the same way (404 `board-not-found` without a file) and queues a server write in its room with the sessions' pushes. The drain runs `apply` in the batch's transaction, in its own SAVEPOINT, at the batch's next clock. Its changes go out in the batch's one `changes` frame (its doc keys as the frame's doc set), for every session; nobody is acked. The caller's promise settles after the COMMIT: the write's result; the write's own error, rolled back, when `apply` throws (a route's `HttpError` passes through: 2F's 409s); 503 `unavailable` when the COMMIT fails (every session then resyncs, as for a push) or the room closes first | `room/element-room.ts`, `room/server-write.ts` | CR 2F-2 |
| **The contract the room holds a server write to** (a violation rolls it back; the route answers 500): every reported element is stored at the write's clock exactly as reported, passes the element check and has a `version` above the stored one; nothing unreported is stored at that clock; every reported doc key is stored at that clock with a value its key allows, and no other; a live element has a valid index no other live element uses, and a label sorts after its container. A write that adds elements beyond the board caps is refused 409 `element-limit` | `room/server-write.ts` | §2.4.3, §3.5 |
| **Stamped as the server's**: `before` is the stored row as the write found it (read by `tx.store.upsert` before it writes), so a wrong `before` in a report cannot corrupt the patch ops; group clocks never go back and every group whose fields changed is at the write's clock (so a stale offline replay, a text write on an older base and the conditional fit see it); the writer ledger names the server for that clock (a session's STALE check treats it as someone else's write); a deletion gets its tombstone clock and time and an `lb_deleted` row by "Lobby" (`lobby-server`), unless `apply` wrote one. **Rule 7**: arrows bound to a target the write moved, and arrows it moved, rebound or brought back, are re-snapped in the same clock and frame (merge.ts `PushApplier`, the server's identity, no ops). The index, group and live-count caches follow; the snapshot cache is dropped | `room/server-write.ts` | §2.4.3 steps 8-12, §2.9.4 rule 7 |
| Test-only routes `POST /internal/test/boards/:bid/prepare` and `…/server-write` (a canned `apply`: puts, deletions, revivals, doc keys, and deliberate contract breaks), mounted with the room's routes only when `DRAFTROOM_TEST_HOOKS=1` | `room/test-routes.ts` | for the protocol tests |
| **CR-2D-1**: the LOCKED rule for a label applies to a container that was live and locked before the push. A label created with its new locked container (a template's locked slot, a pasted or imported locked card), with a container revived in the push or with one locked in the same push is kept; a new label for, or a text pointed at, an existing locked container is still LOCKED | `room/invariants.ts` | CR-2D-1 |
| **`lb_deleted` retention per room session** (§2.6: today's store's limits and rules): each row names the room session that deleted it (one id per room open, in `lb_deleted.epoch`, as `deleted/store.ts` does; converted rows keep their tldraw session's id); after every 100 deletions the newest 1,000 rows of any session plus the current session's are kept, up to 10,000, in whole batches. "Older" is by insertion order, never by batch number: a converted board's rows keep tldraw's batch numbers, which overlap the room's (a push's clock), so the old `batch <` rule could drop a newer row | `room/store.ts`, `merge.ts`, `element-room.ts` | §2.6 |
| The header of `room/http.ts` no longer says seed, place-notes, text, asset-refs and deleted are "not built": they are wave 2F's (`room-internal/` on `engine/excalidraw`), reaching an open board through `prepareBoard` and `serverWrite` | `room/http.ts` | integrator's note |

New tests (all in `apps/sync/test/element-room/`, inside the room suites below):
- `server-write.test.ts` (7, real server process): a write reaches two open sessions in one `changes` frame at
  its clock (doc set included), no ack to either, the answer after the COMMIT, a reconnect's catch-up
  carries it; a push and a write in flight take separate clocks, the stored group clocks are kept and the
  changed ones stamped, and a text push on a base older than the write is STALE (on a fresh base, ok); a
  thrown write (409), eight contract breaks (500: wrong clock, unreported row, an async `apply`, a version
  not raised, a live element's index, a label below its container, an invalid element, no index, a refused
  and an unknown doc key) and a failed COMMIT (503, both sessions 4000 RECONNECT) each leave the test
  snapshot byte-identical, send no frame, and the room keeps serving; a deletion's tombstone fields and
  its `lb_deleted` row by Lobby, a revival clearing them, a session's delete in the same session id; rule 7
  (a moved target's arrow re-snapped in the write's frame); `prepareBoard` on a tldraw board (one
  `convert` job, then the write; the joiner gets no PREPARING), `false` / 404 for a board without a file,
  a write to a board whose room is closed (after a restart), and 503 for a board whose conversion fails.
- `security.test.ts` "F6 (CR-2D-1)": fails on the old rule, passes on the new.
- `store-deleted.test.ts` (4, in-process): the limits pinned to today's `DELETED_LIMITS`; the per-session
  rule across three sessions; whole batches; the overlapping batch numbers never drop a newer row.
- `epochs.test.ts` (1, real server process): see "Epochs on restore".

### Change request

`6055baf` **CR: engine-switch.ts** (additive, optional): CR 2F-2's declarations taken verbatim from
`8a7e7af`: two of its four hunks (the `WireElement` and `BoardStore` type imports; `prepareBoard?`,
`serverWrite?` and the types `ServerWriteTx`, `ServerWriteChange`, `ServerWriteOutcome`,
`ServerWriteApply`). CR 2F-1 (the extension mount point, `loadEngine` importing `./room-internal/index.ts`,
the `app.ts` wrap) is NOT taken: `room-internal/` exists only on `engine/excalidraw`. The integrator has
already accepted 8a7e7af there; the spike lead records it (CONTRACTS change log, both CRs).

### A trial on `engine/excalidraw` (not a check; never pushed)

A throwaway worktree (removed afterwards): `origin/engine/excalidraw` `5b9c87a` with `spike/b-room`
`d22686f` merged. **The merge is clean**; `engine-switch.ts` and `app.ts` come out identical to
engine/excalidraw's (`git diff` empty), so this CR adds no conflict to the engine branch's next merge of
the spike.
- `vitest --project sync`: 662 passed, 1 skipped, **2 failed: 2F's two "503 on an open room" assertions**
  (`test/room-internal/deleted.test.ts:83`, `place-notes.test.ts:141`), which now answer 200. Every other
  2F test passes, and so does everything else in the project.
- A throwaway test of 2F's own routes on an OPEN board (kept in O1's scratchpad, `open-room.trial.test.ts`),
  2/2: the "Recently deleted" restore of a frame with its notes, a box and an arrow while two sessions are
  on the board answers 200 with 2F's expected body; both sessions converge on the snapshot with no schema
  error and no ack; 0 invariant violations; the list is empty after it; the restored note takes a push at
  once. The place-notes reveal of 12 notes answers 200; the frame grows, and **the arrow bound to the frame
  is re-snapped by the room** (version raised, `boundEndsOffEdge` within 0.5 px); the session converges;
  every note carries the session's `privateNote`; a retried reveal places nothing and moves no clock.

### Items left from parts 1-2

- **Epochs on restore: nothing to build in the room; now tested.** §2.6 says every restore writes a new
  epoch. The restore paths an element board has today: a lazy conversion (new epoch, O4's), a roll-forward
  (new epoch, O4's; conversion.test.ts checks it), and the staged restore of a CONVERTED board's backup:
  `restoreBackupFile` raises the tldraw clock, so the next open is a roll-forward, which writes a new epoch.
  `epochs.test.ts` runs that path end to end (a backup by SQLite's online backup, an element added after
  it, the restore with the server stopped, the restart): the stale client is held (`PREPARING`), then gets
  a reset with a new epoch and no ghost element; a client from the pre-backup epoch resets too; one
  `rollforward` job. The one restore without an epoch step, a board BORN on the new canvas, does not exist
  yet: the backup code (`apps/sync/src/backup/**`, frozen in the spike, 2B's in the waves) reads tldraw's
  `metadata` table to back up (`backup.ts:144`) and to restore (`restore.ts`), so such a board can be
  neither backed up nor restored. When 2B teaches it the element format, its restore step must write a new
  `lb_meta.epoch` (and a clock above the live file's) before the room opens; the room then resets every
  stale client (`baseline.test.ts`: another epoch gets a reset). No room change is needed for that.
- **`lb_deleted` retention per session: built** (above). It is what 3h's "Recently deleted" port will show.
- **Presence's "always included" peers: not built, because the protocol cannot carry them.** §2.7 says the
  followed peer, the presenter and anyone who summoned the recipient are always in its presence frames.
  The cap they bypass (40 cursors per recipient) applies only above 41 peers in a room; below that everyone
  already gets everyone. The room cannot know any of the three: the presence input (`protocol.ts`
  `Presence`: pointer, button, sel, view, idle, editing, drag) has no follow target, and no client or api
  message names a presenter or a summons. Once there is a CR for them (both ends, O1 and O2; the design is
  wave 3c's: e.g. presence `follow: sid | null`, and the presenter and summons pushed by the api the way
  the workshop state is, A2), the room change is a few lines in `presence.ts`: those sids are added to a
  capped recipient's shown set before the view-based choice.
- Not the room's: the internal routes (wave 2F's); CR-2D-2 `LobbyTx.insert` (contracts owner and 2C); O2's
  data-loss defects (the drag-recolour overwrite, the lost-edit/lost-create race, the offline-queue window).

### Handover (part 3)

- **Wave 2F**: `serverWrite` and `prepareBoard` now exist, so `writeBoard` and `readableBoard`
  (`room-internal/board.ts`) take the room path; the closed-room path is left for `create` (seed). Flip the
  two "503 on an open room" assertions (`deleted.test.ts:83`, `place-notes.test.ts:141`) to the open-room
  success. What an `apply` must do: write through `tx.store.upsert` (the room reads `before` there) at
  `tx.clock`, raise every `version`, report every row and doc key it writes, keep indices valid and
  unique; the room stamps group clocks, tombstones and `lb_deleted` rows, and re-snaps bound arrows
  (place-notes' grown frame included, so its `gclock: {}` for an existing frame is now harmless).
- **O4 and wave 2F**: converted `lb_deleted` rows keep tldraw's batch numbers (`convert-board.ts`,
  `rollforward.ts`), and the room's live rows use the push's clock, so the two ranges overlap. The room's
  trim no longer depends on batch numbers, but 2F's list and restore (`room-internal/deleted.ts` `byBatch`)
  read one batch number as one batch: a converted batch `n` and a live batch at clock `n` are grouped
  together (an entry can be hidden as "inside" the other's frame, or restored with it). Rare (it needs an
  element of one to name an element of the other), but real. Suggestion: O4 writes converted and appended
  rows with batch numbers outside the room's range (for example negative), or 2F groups by `(batch,
  origin)`.
- **Spike B lead**: record `6055baf` (CR 2F-2's declarations; CR 2F-1 not taken) in CONTRACTS.md.
- **Waves 3f and 3h**: the private brainstorm's reveal and the "Recently deleted" restore work on an open
  board (the trial above).
- **Wave 2D**: CR-2D-1 is in; the templates' expected failure can become a pass.

### Evidence, 3 runs on `d22686f`

`O1_OUT=<dir> RUNS=3 bash docs/research/excalidraw/spike-b/scripts/o1-checks.sh`, 2026-09-30 01:19:26-01:28:16Z
(logs and each spec's Playwright folder in O1's scratchpad `o1/p3/runs/`, never committed). Nothing
listened in 7860-7869 before or after any spec.

| Check | Spec or suite | Run 1 | Run 2 | Run 3 | Numbers |
|---|---|---|---|---|---|
| B3 L8 | `b3-l8-leased-forged` | PASS | PASS | PASS | 20/20 forged repetitions each; final convergence and 0 violations each |
| B4 D3 | `b4-server-d3-sigkill` | PASS | PASS | PASS | acked = stored at the 3 kills: 774/774/777, 786/786/780, 771/777/780 of 960 sent; 0 missing |
| B4 D4 | `b4-server-d4-commit` | PASS | PASS | PASS | Saved states seen: saving, offline, saved (never saved before the move was stored) |
| B5 R1 | `b5-r1-readonly-forged` (forged part, viewer + commenter presence, limited guest presence) | PASS 3/3 | PASS 3/3 | PASS 3/3 | presence p95 viewer / commenter / guest: 127/125/126, 127/126/126, 126/126/126 ms (informational: not a quiet window; the 200 ms gate is asserted only with `SPIKE_B_QUIET=1`) |
| B5 R4 | `b5-r4-downgrade` | PASS | PASS | PASS | 4000 on the downgrade, read-only reconnect, READ_ONLY for the queued edit |
| B6 | `b6-forged` (F1-F17 in 15 tests) | 15/15 | 15/15 | 15/15 | |
| Server half of L6/L10, and the room | `vitest run apps/sync/test/element-room packages/canvas-schema/src/engine packages/canvas-schema/src/invariants.test.ts` (19 files; part 2's 16 plus server-write, store-deleted, epochs; security gains F6 CR-2D-1) | 149/149 | 149/149 | 149/149 | 26.0 / 26.1 / 26.6 s (part 2: 136) |
| C0 arrow acceptance tests | `pnpm test:arrows` | 85/85 | 85/85 | 85/85 | 9.8 / 9.9 / 9.8 s |

Gate on `d22686f` (once): `biome check .` 1,433 files, 0 errors; `pnpm -r typecheck` (15 projects) pass;
`tsc -p apps/sync/tsconfig.node-safe.json --noEmit` pass; `pnpm test` 3,988 passed, 33 skipped, 0 failed
(the lead's M3 gate: 3,975 / 33; +13 new room tests). Not re-run here: the spike A suite, the A8 probe and
the normal-build marker check (no file under `apps/web` changed).

## Part 2: after the M1/M2 integration

Branch `spike/b-room`, on `spike/excalidraw` `76c937f` (the lead's M1/M2 integration; fast-forward, no
conflict) plus O1's commits `b5689e0` (CR), `c8cac73`, `34a69a1`, `b7ed554`, `eedc2c9`. Evidence on
`eedc2c9`. Windows 11 workstation, Node 24.19.0, pnpm 10.34.5, Playwright 1.63.0, headless Chromium only.
Ports 7860-7862 (O1's range); nothing listened in 7860-7869 before or after any run. Every stack ran with
`DRAFTROOM_BACKUP_STORE=off`; no R2 write; `.env.deploy.local` never read. NOT a quiet window (other agents'
runs shared the machine), so timing numbers are informational.

### Built in part 2

| What | Where | Plan |
|---|---|---|
| **Conversion on room open.** A board file with tldraw tables and no `lb_meta`, or a converted board whose tldraw side moved during a rollback, is prepared by O4's `MigrationService` before its room opens: one job at a time process-wide, in the capped worker behind the RSS gate (the rooms' snapshot caches are flushed first). Joiners are held: notice `PREPARING` first, their messages buffered (presence dropped as before hello; 64 messages / 1 MiB, then 4099 RATE_LIMITED), then admitted in order to the opened room. A failed job leaves the board on its tldraw tables; its joiners get 4099 `CONVERSION_FAILED`, and later joiners are refused at once with no new job (a transient failure, time budget or a worker crash, is retried after 5 min; out-of-memory, disk, limits, migration, diff and invariant failures only by a maintenance run or a restart). The access monitor and the session-end reporter see held joiners (`roomIfOpen`, `sessionsOf`, `openBoards`). The internal snapshot route and the test snapshot wait for the same preparation (503 `unavailable` on a failure). `service.routes()` (`POST /internal/migrate/convert-all`, `GET /internal/migrate/status`) are mounted with the room's routes; `closeAll` closes the service (held joiners get 4000 RECONNECT; the running worker is terminated). Test-only knobs `DRAFTROOM_TEST_MIGRATE_CAP_MB` / `DRAFTROOM_TEST_MIGRATE_TIME_MS` are read only with `DRAFTROOM_TEST_HOOKS=1` | `room/index.ts`, `room/http.ts` | §5.3 "Lazy", §5.9 step 3, §2.13 |
| **Rule 6 for rectangles, ellipses and diamonds.** The lease-expiry re-fit uses `redrawTextBoundingBox` (the helper the holder's client runs, rule 4) through `layoutBoundText` in `canvas-schema/engine` (copies over a stand-in scene: the engine's `Scene` validates indices through `window` in its dev build, index.js:18949). The label is re-wrapped for the container's current width, the container grows to hold it (derived, `gclock.fit` only), bound arrows re-snap | `room/merge.ts`, `engine/layout.ts`, `engine/raw.ts` | §2.9.4 rule 6 |
| **R1's limited guest runs.** The spec lets a dev-user browser in as a name-only guest through a view link with guests allowed (the A3 flow, as b5-r3 and b12-phone do) and checks its welcome says guest and read-only | `e2e/spike-b/tests/b5-r1-readonly-forged.spec.ts` | §8.3 B5 R1 |
| The headless suite's stub placeholder (a permanent "1 skipped") is gone: O2's client is integrated | `test/element-room/headless.test.ts` | |
| O1's check runner (3 runs, a fresh build per spec, each spec's Playwright folder copied, listeners checked) | `scripts/o1-checks.sh` | §8.6.8 |

Not built, because no check or the drill needs it on this room: the internal routes `seed`,
`place-notes`, `text`, `asset-refs`, `deleted` (the drill calls them on the R0 stand-in only; in
excalidraw mode the api's template, duplicate and restore flows still get 404); presence's "always
included" peers (no protocol fields). Epochs on restore: a lazy conversion and a roll-forward write a new
epoch (O4's worker; the roll-forward's new epoch is asserted in conversion.test.ts); a staged restore of an element board is not built (no check needs it).

### Change request

`b5689e0` **CR: protocol.ts** (additive): notice code `PREPARING` and terminal close reason
`CONVERSION_FAILED`. Why: the frozen set had no way to tell a held joiner that its board is being prepared
(§2.13 "Preparing this board…"), and no clear close for a failed conversion (`MAINTENANCE` means the
cut-over; `UNKNOWN_ERROR` is not clear, and a retryable close would re-queue the job). Touches O1 (this
room sends them) and O2 (the client should show "Preparing this board…" on the notice and a clear message on
the close; until then an unknown notice is dropped by the client's schema check, and any 4099 shows the
closed state). The room reads both lists at runtime, so if the lead declines the CR it sends no notice and
closes with `MAINTENANCE` instead. Needs O2's OK, the `CONTRACTS_REV` bump and the change-log line (the
lead's). protocol.test.ts gains the notice's round trip.

### Handover (part 2)

- **O2**: a held joiner gets `{type: 'notice', code: 'PREPARING'}` as its first frame, before its welcome
  (show "Preparing this board…"; the socket stays open, `hello` is answered when the board is ready). A
  failed preparation closes 4099 `CONVERSION_FAILED` (terminal; the board stays on the old canvas until a
  maintenance run). Both depend on the CR.
- **O3**: B9's conversion-under-load run: two unconverted boards opened at once queue in one process-wide
  queue (`GET /internal/migrate/status` shows `running` and `queued`); the planted over-cap board's joiner
  gets 4099 `CONVERSION_FAILED`, its status is `failed` / `out-of-memory`, and the board keeps its tldraw
  tables. For a quick over-cap test without a huge board, `DRAFTROOM_TEST_MIGRATE_CAP_MB=4` (test hooks
  only) makes any conversion run out of memory.
- **O4**: the room calls `prepare(boardId)` for `tldraw` and `rollforward-needed` files only (one read-only
  `boardFileState` per room open), with `roomsDir` = the rooms folder, so reports land in `<data>/migration`.
  A job that fails with `already-converted` is re-checked and opened. `b8-two-browsers` and `b8-drill` should
  now pass; I could not run them in O1's range (the stand-in's port check).

### Evidence, 3 runs on `eedc2c9`

`O1_OUT=<dir> RUNS=3 bash docs/research/excalidraw/spike-b/scripts/o1-checks.sh`, 2026-09-29 15:31-15:40Z (logs
and each spec's Playwright folder in O1's scratchpad `o1/runs/`, never committed).

| Check | Spec or suite | Run 1 | Run 2 | Run 3 | Numbers |
|---|---|---|---|---|---|
| B3 L8 | `b3-l8-leased-forged` | PASS | PASS | PASS | 20/20 forged repetitions each; final convergence and 0 violations each (the part-1 trial's nonce divergence did not recur) |
| B4 D3 | `b4-server-d3-sigkill` | PASS | PASS | PASS | acked at the 3 kills: 774/774/774, 789/777/777, 771/771/777 of 960 sent; 0 missing |
| B4 D4 | `b4-server-d4-commit` | PASS | PASS | PASS | Saved states seen: saving, offline, saved (never saved before the move was stored) |
| B5 R1 | `b5-r1-readonly-forged` (3 tests: forged part, viewer + commenter presence, limited guest presence) | PASS 3/3 | PASS 3/3 | PASS 3/3 | presence p95 viewer / commenter / guest: 126/125/127, 126/127/126, 126/126/125 ms (informational: not a quiet window; the 200 ms gate is asserted only with `SPIKE_B_QUIET=1`) |
| B5 R4 | `b5-r4-downgrade` | PASS | PASS | PASS | 4000 on the downgrade, read-only reconnect, READ_ONLY for the queued edit |
| B6 | `b6-forged` (F1–F17 in 15 tests) | 15/15 | 15/15 | 15/15 | |
| Server half of L6/L10, and the room | `vitest run apps/sync/test/element-room packages/canvas-schema/src/engine packages/canvas-schema/src/invariants.test.ts` (16 files, incl. conversion.test.ts, headless.test.ts, the rule-6 tests) | 136/136 | 136/136 | 136/136 | 24.0 / 24.2 / 24.5 s |
| C0 arrow acceptance tests | `pnpm test:arrows` | 85/85 | 85/85 | 85/85 | 10.3 / 10.1 / 10.3 s |

`apps/sync/test/element-room/conversion.test.ts` (real server process; in each run above): (1) two joiners of
a tldraw board (O4's kitchen-sink fixture) get `PREPARING` first, then welcomes with equal epochs and
hashes equal to the test snapshot; one `convert` job `done`; the report `ok`; a later joiner gets no
`PREPARING`; an edit lands; the tldraw `documents` digest is unchanged and `converted_from` is recorded; (2)
the internal snapshot route converts a board it opens, racing the test snapshot, one job; (3) after an R0
edit of the tldraw side (a shape moved 250 px), the next open rolls the board forward: the joiner sees the
move, a new epoch, `converted_from.cycle` 1, one `rollforward` job; (4) a 4 MB test heap cap: the joiner
gets `PREPARING` then 4099 `CONVERSION_FAILED`, the status says `failed` / `out-of-memory`, a second joiner
is refused at once with no second job, the snapshot route answers 503, another board keeps serving, and the
file is byte-identical with the same tables and no WAL.

Gate on `eedc2c9` (once): `biome check .` 1,421 files, 0 errors; `pnpm -r typecheck` pass; `tsc -p
apps/sync/tsconfig.node-safe.json --noEmit` pass; `pnpm test` 3,968 passed, 33 skipped, 0 failed (the lead's
M1/M2 gate: 3,957 / 34; +4 conversion, +2 rule-6 room tests, +5 layout unit tests, −1 placeholder skip).
Not re-run here: the spike A suite, the A8 probe and the normal-build marker check (no file under
`apps/web` changed; `canvas-schema/engine` gained `layoutBoundText` and `miniScene` and no new import; no file under
`apps/web` imports `canvas-schema/engine`).

### Conversion on open in two browsers (a trial, not a check)

A throwaway spec (never committed; base 7860; one run): four tldraw board files written by today's
`RoomRegistry` from O4's fixtures (kitchen sink, Lobby tour, mood board) and O4's HEAVY generator, placed
under new board ids made through the api, then opened by two browsers (dev users A and B) at the same time.
Each board was converted by the room on open; both browsers converged with the test snapshot, 0 invariant
violations, 0 pushes from either, the conversion report `ok`: kitchen sink 45 elements (open and converge
1.1 s), tour 167 (1.1 s), mood board 68 (1.0 s), heavy 9,220 (4.3 s). O4's `b8-two-browsers` and
`b8-drill` were NOT run here: their R0 stand-in only binds 7850-7859 or 7900-7909 (`b8/stand-in.ts`), O4's
and the lead's ranges.

## Part 1 (before integration)

Owner O1 (docs/EXCALIDRAW-MIGRATION.md §8.6.3). Branch `spike/b-room`, based on `spike/excalidraw` 93e3c3e
(C0 975b531 plus B0). Code on `c54d6ab` (the evidence below was run on that tree; an earlier 3-run pass on `071648d` gave the same results with 78 protocol tests). Windows 11 workstation, Node 24.19.0, pnpm 10.34.5. Ports: none
bound in O1's range 7860–7869 (every test here uses port 0, as §8.6.5 says for the sync protocol
harness); the listing before and after this phase was empty, and no process of this worktree was left
running.

## What is built

`apps/sync/src/room/**` (except `schema.ts`, `migrate/**`), `apps/sync/src/{file-refs.ts, workshop-state.ts}`,
`packages/canvas-schema/src/invariants.ts`, `packages/canvas-schema/src/engine/binding.ts`.

| File | Plan | What it does |
|---|---|---|
| `room/index.ts` | §2.4, §8.6.3 | the service behind the frozen seam: rooms opened synchronously on the first socket, idle eviction (`IDLE_EVICT_MS`), the routes, `/internal/metrics`, the global outbound budget (64 MiB, largest buffer closed with 4000 first), the snapshot-cache budget (64 MiB), the test hooks (`registerTestHooks`, only with `DRAFTROOM_TEST_HOOKS=1`), the metrics provider installed once |
| `room/element-room.ts` | §2.4.3, §2.4.5 | one board: hello/welcome (catch-up, or a reset with the gzip snapshot, tombstones included, cached 5 s, compressed off the event loop), stage 0 per session (the FIFO of pushes and lease messages; per-op parsing; one file-refs call per push; op and byte budgets), the drain (≤ 64 pushes or ~8 ms, at least 25 ms after this room's previous commit; BEGIN IMMEDIATE, SAVEPOINT per push, one clock per writing push), after COMMIT one `changes` frame serialized once for everyone then acks and lease events in queue order, the COMMIT-failure path, presence and lease ticks, the abuse close, version refusals |
| `room/merge.ts` | §2.4.3 steps 1–12 | the accept algorithm per push: READ_ONLY, GONE, caps, TYPE_CHANGE, lock (a label follows its container), lease (partial accept), customData classes, STALE, the merge (`path` whole, boundElements by id, customData per key, lobbyServer stamped), the conditional fit, rounding (§3.5), the element schema; then invariants, rule 7, index, the ack's `fix`/`fitDropped`/`denied` and `derived` rows, the writes (`lb_elements`, `lb_deleted`, `lb_doc`); the lease-expiry re-fit (rule 6, sticky notes) |
| `room/invariants.ts` | §2.4.4 | rejections (label container, a second label, lease and lock inheritance, frames, group nesting) and repairs (cascades, bindings nulled, boundElements kept symmetric, frameId of a deleted frame) |
| `room/fit.ts` | §2.9.4 rule 7 | re-snap triggers (a bindable element's x, y, width, height or angle, whatever group; an arrow's own `path`, bindings or creation), one re-snap per affected arrow after all ops, `gclock.fit` only, `fix` vs `derived`, the arrow label's derived layout (position only while leased) |
| `room/custom-data.ts` | §3.3 | the five classes' server rules; `file` canonicalized from file-refs, `pdfPage` from `.p<n>` |
| `room/lease.ts` | §2.9.2 | per-session leases, TTL from the last renewal (acquire, presence `editing`, the holder's pushes), the grant hook |
| `room/presence.ts` | §2.7 | 20 Hz in, 10 Hz out, 40 cursors per recipient preferring its view, `sel` dropped during a vote, the drag relay (ids once, deltas, end, drags in welcome; ≤ 500 ids, one active drag, read-only dropped), roster entries |
| `room/outbound.ts`, `rates.ts`, `store.ts`, `index-keys.ts`, `caches.ts`, `metrics.ts`, `http.ts`, `types.ts` | §2.4.5, §2.6, §2.4.6 | ordered queues with promises (the snapshot), 256 KiB / 8 MiB backpressure; token buckets; the `lb_*` store on `room/schema.ts` with compaction at open; the index cache; group-parent map, writer ledger, live counts; Prometheus text; the internal snapshot and workshop-state routes |
| `file-refs.ts`, `workshop-state.ts` | §2.10.2, A1, A2 | the api clients on `sync-internal.ts` (3 s timeout, fail closed), the per-room LRU (10,000; 10 min / 30 s) |
| `canvas-schema/engine/binding.ts` | rule 7 contract | `resnapArrow`, `resnapLinearArrow`, `routeElbowArrow` (Excalidraw's own follow: `updateBoundPoint` for both ends, rounded, then `movePoints`, which on an elbow arrow runs the router and assigns its whole output), `arrowLabelLayout`, and `boundEndsOffEdge` (new, a checker for code that may not import the engine) |
| `canvas-schema/invariants.ts` | §2.4.4 | `checkInvariants` (and `checkInvariantsOf`, `groupParents`) |

## Checks and evidence

| Evidence | Result (3 runs in a row, this tree) |
|---|---|
| **C0 arrow acceptance tests** `pnpm test:arrows` (85 tests, 13 files, against this room in-process) | **85/85, 3/3** (9.2–9.8 s per run; s1-sweep's 2,000 races 7.0 s, r35's 1,000 re-snaps 4.8 s). Per file: r33-freeend-rel 1, r33-label-node 2, r34-elbow-fixed 2, r35-drift 1, s1-freeend 7, s1-sweep 5, s2-midpoint 10, s3-elbow 30, s3-elbow-sweep 1, s4-frame 10, s5-freetext 6, s6-twotargets 8, s7-angle-mix 2. First passing run: `4c0a570` |
| Protocol suites `pnpm exec vitest run --project sync apps/sync/test/element-room` (real server process, raw WebSocket client, fake api) | **82/82, 3/3** (21.9–22.0 s). baseline 2, bound-arrows 10, conflicts 6, convergence 4, durability 3, lifecycle 14, presence 4, readonly 4, security 22, text-lease 13 |
| M2's gate "the headless client passes O1's protocol suites": `apps/sync/test/element-room/headless.test.ts` (O2's frozen `HeadlessClient` against the real server process: B10's receiving-only client, 2 × 50 concurrent creates at the top of the order, rule 7 through the core) | skipped on this branch (O2's module is the C0 stub; the suite says so). On a local trial merge with O2's `spike/b-engine` 8eec700 (never pushed): **3/3 runs pass**, and with it the whole room suite (85 passed, 1 skipped placeholder) and the arrow tests (85/85) |
| Unit: `packages/canvas-schema/src/engine/binding.test.ts` (11, incl. the elbow-in-Node and label-node probes), `invariants.test.ts` (16, incl. a 200-board property test) | pass |
| Whole unit suite `pnpm test` | 3,597 passed, 37 skipped (the 4 of headless.test.ts), 0 failed (C0: 3,466 / 33) |
| `pnpm lint` | 1,231 files, 0 errors, 0 warnings |
| `pnpm -r typecheck` (15 packages) and `tsc -p apps/sync/tsconfig.node-safe.json --noEmit` | pass |
| Specs `e2e/spike-b/tests/b3-l8-*`, `b4-server-*`, `b5-r1-*`, `b5-r4-*`, `b6-*` (22 tests, 6 files) | not runnable on this branch alone (O2's page and O3's harness are stubs here). On a local trial merge with O2, O3 and O5 (never pushed; port base 7860), 3 runs: **20 passed, 1 skipped, 1 failed each**: D3, D4, R1 (forged, viewer and commenter presence), R4 and B6 F1–F17 pass; R1's guest part is skipped (the harness cannot sign a guest in yet); L8's 20/20 forged part passes and its final convergence fails on A's label `versionNonce` (an O2 client finding, B3-L8.md) |

Per check: `B3-L8.md`, `B4-D3.md`, `B4-D4.md`, `B5-R1.md`, `B5-R4.md`, `B6.md`, and the server half of L6/L10
in `B3-L6-L10-server.md`.

Coverage of §6.2's spike subset by the protocol suites: `baseline`, `auth` (unchanged app.ts path; not
re-tested here), `access` (downgrade 4000, revoke 4099 FORBIDDEN), `validation`, `readonly`, `conflicts`,
`reconnect` (catch-up, epoch, STALE), `durability` (SIGKILL ×3 in group commits, SIGINT, COMMIT failure),
`text-lease` (grant/deny, second tab, renew, expiry, release after a parked push, just-created id, partial
accept, inheritance, L8), "Text lease, container fit" (stale fit, non-holder fit, re-fit, `gclock.fit` only,
a free text's own x as its fit), `attribution`, `presence` (identity refused, roster uncapped, cursor cap,
`sel` during a vote, the drag relay, read-only drag), `schema`, `join-order`, `room-lifecycle`,
`tags-merge`, `internal` (snapshot, workshop-state, metrics, test routes absent without the flag), the
negative security suite, "Prefix invariant" and "Convergence property" (random ops with reconnects and
one SIGKILL, raw clients), "Bound arrows" (subset: derived rows and fix, cases a/b, the barrier race 20×
per order, free text, labels leased and unleased, clocks, locked arrows, deleted targets, no-op writes).
Not covered here: "Epochs" (a restore's new epoch; no restore path in the spike room), "Conversion" (O4),
"Echo" (needs O2's engine-core client), and the bound-arrow cases d1–d3, e and f through the process (they
run in-process in the C0 arrow tests s3, s4, s5).

## Deviations from the plan (for the lead and the verifiers)

1. **The op and byte budgets delay before they refuse** (`rates.ts`). §2.4.5 says an op over budget is
   refused with RATE. The frozen C0 arrow tests burst far above that budget from one session (r35: 3,000
   ops at once; s1-sweep: 4,000 ops in about 1.5 s), so a room that refuses at the budget fails them. The
   room therefore parks a push the bucket cannot pay in the session's stage-0 FIFO (order kept) while the
   ops and bytes waiting there stay within one burst (2,000 ops, 4 MiB), and refuses with RATE and
   `SLOW_DOWN` beyond that; it never closes. A flood still gets RATE (the protocol suite and b6 F14 push
   12 × 500 ops and get ≥ 60 RATE rejects without a close). If the lead prefers the plan's strict rule, it
   is a change request on the frozen tests (pacing their bursts), not on the room's contract.
2. **The lease-hook `delay`/`hold` postpone the grant MESSAGE, not the decision** (`lease.ts`): the lease
   is the requester's in queue order (a competing acquire meanwhile is denied), and a postponed grant whose
   lease was released or taken over is never sent. L12 only needs the client to see a pending request.
3. **A read-only session's `lease.acquire` is denied with a synthetic holder** `{sid: 'read-only', …}` when
   nobody holds the id (`LeaseDeny.holder` is required by the protocol).
4. **Lease TTL**: 10 s (`LEASE_TTL_MS`) unless `TEXT_LEASE_MS` differs from tldraw's default 5,000 (tests
   shorten it that way).
5. **Presence frames**: with 41 sessions or fewer, one frame is serialized for everyone whose own entry is
   not in it (a recipient whose own presence changed gets a copy without itself); above that, per-recipient
   frames with the 40-cursor cap (sticky: a shown peer stays shown until it leaves). Spike B's comparison of
   shared against per-view frames under load is O3's B9.
6. **Order of the label rules**: a label created for (or pointed at) a container leased by another session
   or locked is refused LEASED/LOCKED before the one-label rule (INVALID), as B3 L8 expects.
7. **A create for an existing live id** is INVALID (TYPE_CHANGE when the type differs); a create for a
   tombstone is the undelete of §2.4.3 step 3.
8. **Self-loops are re-snapped to their fixed point** (at most 4 iterations per call), per CONTRACTS.md
   finding 3.
9. **Server ops in `changes`**: one op per element per batch (its state before the batch to its state after),
   a patch when a patch reproduces the stored element exactly (checked by overlaying it), else the full
   element (`c`).
10. **STALE's "someone else"** comes from an in-memory ledger of each clock's author (the push's uid),
    bounded to 200,000 clocks; after a restart, earlier clocks count as someone else's.
11. **The reset snapshot** is cached for 5 s across writes (a joiner gets it plus a catch-up `changes` since
    its clock); `welcome.snapshot.bytes` is the compressed frame's size.
12. **Stage 0 enforces the 3 s file-refs timeout itself** (on top of the HTTP client's), so an injected or
    hanging lookup can never block a session's FIFO; its ops get UNAVAILABLE.
13. **The caps count the push's own earlier creates and undeletes** (an undelete by a `life: false` patch
    counts like a create); a create's client `version` is capped at 2^31 before `max(stored, client) + 1`.
14. **A `presence` before `hello` is dropped**; a push or lease message before `hello` closes 4099
    INVALID_MESSAGE.
15. **After a failed COMMIT** the batch's lease replies are still sent (leases live in memory), then every
    session gets 4000 RECONNECT.

## Not built (not needed by a spike check, or another owner's)

- Internal routes `seed`, `place-notes`, `text`, `asset-refs`, `deleted` (§2.4.6); the tldraw ones are not
  mounted in excalidraw mode (CONTRACTS.md decision 11).
- Epochs on restore; the lazy conversion hook (built in part 2, above).
- Rule 6 (the lease-expiry re-fit) for rectangles, ellipses and diamonds (built in part 2, above).
- Presence's "always included" peers (followed peer, presenter, summoner): the protocol has no fields for
  them yet.
- `lb_deleted` trim: whole batches beyond 10,000 rows, every 100 deletions (not the tldraw store's
  per-session retention).

## Handover notes

- **O2**: the room sends `changes` before the ack; a reset welcome is followed by the binary frame and, when
  the cached snapshot is older than the room's clock, a `changes` catch-up (full `c` ops). Server patch ops
  carry `vn`. Presence frames may include the recipient's own entry only when it did not change; `drags`
  never include the recipient's own. A push that writes nothing has `ack.clock` = the room's clock.
- **O3**: `boundEndsOffEdge(arrow, elementsById)` in `@draftroom/canvas-schema/engine` measures "on the
  target's edge" without importing the engine; `checkInvariants` is implemented. The test hooks answer for
  a board whose room is not open yet (the hook applies when it opens).
- **O4**: the store refuses a file with tldraw tables and no `lb_meta` (`BoardNeedsConversion`); rule-7
  helpers and `checkInvariants` are ready for step g. (Part 2: the room now calls `prepare` before the
  store opens, so the store never sees such a file from the room.)

## The verifiers' fix round (part 3)

V2's and V1's room findings on `37bdfa9` are fixed on `spike/b-room` (`486a08e`, `46fea60`, `2f34836`),
with `apps/sync/test/element-room/verifier-fixes.test.ts` (14 tests, each failing on `37bdfa9`),
`e2e/spike-b/tests/b3-l8-bind-escape.spec.ts` and `b6-cross-workspace.spec.ts`: the lease also denies a
text's `bind`; a container never loses a live label to a `b.rm`; `hello` floods close RATE_LIMITED and
welcomes are built a slice at a time; a failed COMMIT restores the lease table and answers no lease message
of its batch (the "lease replies still sent" rule above is superseded); unrouted elbow arrows are routed;
server writes keep leases and invariants; and the lows (guest locks, the guest cap by uid, `file` values,
the lease cap, drag TTL). Per-defect results: `M3-fixes.md`.
