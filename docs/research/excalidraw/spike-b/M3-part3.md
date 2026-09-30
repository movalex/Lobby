# Spike B: part-3 integration (lead)

The lead's integration of O1's and O2's part-3 branches (docs/EXCALIDRAW-MIGRATION.md §8.6.4): the review,
the merges, the change request, the gate, and **one run of every spike-b spec on the integrated tree**
(except B8's staging rows and B9's NAS half). It follows `M3.md`, which stays as the record of the first M3
pass; this file is the current integrated state. **These are single runs, not the 3-run evidence and not a
quiet window** (§8.6.8). Each owner's part-3 result (3 runs on the owner's branch and ports, not a quiet
window either) is quoted from the owner's evidence file.

Inputs: wave 2's result on `engine/excalidraw` (2C's, 2D's and 2F's requests and the integrator's
"Blocking the cut-over" list: the drag-recolour overwrite, the lost-edit/lost-create race, the offline-queue
window), `M3.md`'s open O2 defect, `O2-part3.md` and `O1-room.md` "Part 3".

| | |
|---|---|
| Branch | `spike/excalidraw` |
| Base | `92b1098` (the M3 report; both owners branched from it) |
| Merged (`--no-ff`, in this order) | `spike/b-room` `d856e89` (`2e250c8`), `spike/b-engine` `716a5b2` (`e2d7be3`). No conflict. |
| Not merged in this round | `spike/b-convert` `de3dc40` (O4's B8 two-browser and drill specs through conversion on open), still possibly running when this round started |
| Change request | O1's `6055baf` (`engine-switch.ts`, CR 2F-2's declarations), accepted in `122995b`; `CONTRACTS_REV` 5 |
| Frozen files | only the CR changed one (`engine-switch.ts`). Every other changed file is in its owner's row of §8.6.3 (`git diff --name-only <merge>^1 <merge>`): O1 `apps/sync/src/room/**` (not `schema.ts`, not `migrate/**`), `apps/sync/test/element-room/**`, `O1-room.md`; O2 `canvas/sync/**` (not `types.ts`), `canvas/history/**`, `port-impl.ts`, `spike/board/**`, `b2-*`, `b4-client-*`, its evidence files. No lockfile, workspace or catalog change. |
| Lead's own changes (`122995b`) | `protocol.ts` `CONTRACTS_REV` 5; `CONTRACTS.md` (change-log row 5, row 4's O2 OK, the part-3 decisions); `e2e/spike-b/playwright.config.ts` `VITE_LOBBY_BOARD_PAGE=spike` (wave 2's request); `scripts/integration-p3-checks.sh` |
| Tree under test | `122995b` (the two merges and the lead's commit; nothing else) |
| Gate | at `122995b`, 2026-09-30 04:38:59-05:01:43Z (`scripts/integration-m3-gate.sh`, unchanged) |
| Spec pass | at `122995b`, 05:01:55-07:21:33Z, base 7850 (`scripts/integration-p3-checks.sh`) |
| Machine | Windows 11 workstation, Node 24.19.0, pnpm 10.34.5, Playwright 1.63.0, headless Chromium only; a fresh worktree (`pnpm install --frozen-lockfile`). No other spike B run was active (no node or Chromium process of `Draftroom-spike`, `-sb-harness` or `-sb-convert`; nothing listening in 7850-7999 at the start). Other sessions' long-lived processes stayed up (three `node --watch` servers from 2026-09-26, the user's Chrome). No quiet window was posted, so every timing number is informational. |
| Ports | 7850-7852 (the stack; the spike A suite's `SPIKE_WEB_PORT` 7850 and its files server 7851), 7853 (A8 probe), 7858 (B8's stand-in and corpus sync). Nothing listened in 7850-7859 before or after any spec. Every stack ran with `DRAFTROOM_BACKUP_STORE=off`; no R2 write; `.env.deploy.local` never read. Nothing is left running. |
| Logs | the lead's scratchpad `lead2/gate/` and `lead2/checks/` (`summary.txt`, one log per spec, each spec's Playwright folder); never committed |

## Review before the merges

**O1 (`spike/b-room`, 6 commits).** CR 2F-2 in the room: `prepareBoard` opens a board through the same
preparation as the snapshot route (`existing`); `serverWrite` queues a `server` entry in the room's drain,
run in its own SAVEPOINT at the batch's next clock, broadcast in the batch's single `changes` frame, acked to
nobody, settled after the COMMIT (503 on a failed COMMIT or a closing room, the write's own error rolled
back). `server-write.ts` holds a write to the contract (every stored row reported, at the write's clock,
version raised, valid element, valid unique index, labels after containers, allowed doc values, caps 409)
and stamps it as the server's (group clocks never go back, changed groups at the write's clock, tombstone
fields, a "Recently deleted" row, the writer ledger, rule-7 re-snaps through `PushApplier`). The test-only
routes mount only with `DRAFTROOM_TEST_HOOKS=1`. CR-2D-1 narrows the lock rule to containers live and
locked before the push. `lb_deleted` retention is per room session and by `seq`, not by batch number (the
`epoch` column holds the room session id, as today's `deleted/store.ts` does). The CR's `engine-switch.ts`
diff was checked against `engine/excalidraw`'s file: they differ only by CR 2F-1's lines, so the later
merge into `engine/excalidraw` is clean there (O1's trial merge agrees).

**O2 (`spike/b-engine`, 2 commits).** The core scans the live scene before any server-driven apply, flush,
persist or adoption when it holds versions it has not seen (`syncLive`), and `saveStatus` never reports
saved over an unscanned write; `transact` and the undo install call `syncScene()`. `heldRemote` keeps a
held-back remote change from being counted as local at the gesture's end. The offline queue is written at
once outside a gesture, `persistNow()` runs on `pagehide`, when hidden and on unmount, the IndexedDB
transaction starts and commits in the call, and nothing is written before the previous page's queue is
loaded. Queued edits behind a stale cached reset snapshot wait for the catch-up (`awaitingCatchUp`, 3 s).
`message` events follow the apply. `LobbyHistory.mark()`/`mergeTop()`, `UndoController.joinPrevious()`,
and CR-2D-2's `prepareInsert`/`insert`/`LobbyCanvasTx.insert` are additions on O2's classes; the frozen
`EngineCore`, `CanvasPort` and `CanvasTx` are unchanged, so no CR is needed (CONTRACTS.md, part-3 decision 3).

Neither branch touches a file of another owner.

## The gate (at `122995b`)

| Gate | Result |
|---|---|
| lint (`biome check .`) | PASS, 1,436 files |
| typecheck (`pnpm -r typecheck`, 15 projects) + engine-probe tsc | PASS |
| `tsc -p apps/sync/tsconfig.node-safe.json --noEmit` | PASS |
| `pnpm test` (every project, arrows included) | PASS: 4,016 passed, 33 skipped (M3: 3,975; +13 O1, +28 O2) |
| `pnpm test:arrows` | PASS 85/85 |
| asset/host-rewrite plugin tests; `hash.ts` in Chromium | PASS 9/9; PASS 1/1 |
| spike A suite (`SPIKE_WEB_PORT=7850`), once | PASS: 99 passed, 2 skipped (opt-in), 20.8 min, fresh build |
| A8 browser probe | PASS |
| normal web build | PASS, 0 engine markers (spike A's 16 plus spike B's 7), 0 source maps |
| engine flag without the dev-auth guard | PASS, 0 marker files |

## Every spike-b spec once (at `122995b`)

38 invocations: every spec in `e2e/spike-b/tests` except `b8-staging-*`, plus the guest self-test. 36
passed, 2 failed. "Owner" is the owner's latest 3-run result as its evidence file reports it (part 3 for O1
and O2, part 2 for O3, O4 and O5, from `M3.md`). PASS needs the owner's 3/3 and the lead's run (§8.6.8);
PARTIAL marks a timing-gated check that still needs the quiet window.

| Check | Spec (owner) | Owner, 3 runs | Lead, one run | Status |
|---|---|---|---|---|
| M1 | m1-walking-skeleton (lead) | | PASS 1/1 | PASS |
| B1 | b1-concurrent-fields (O3) | 3/3 (part 2) | PASS 4/4 | PARTIAL (quiet window) |
| B2 U1-U12 | b2-undo (O2) | 12/12 x 3 | PASS 12/12; U12 (B recolours while A drags): held `#1e1e1e` mid-drag, stored `#e03131`, A pushed `pos` only | PASS |
| B3 L1-L5 | b3-l1-l5-lease (O2) | 5/5 x 3 | PASS 5/5 | L2-L4 PASS; L1, L5 PARTIAL |
| B3 L6, L10 (20 repetitions) | b3-l6-l10-arrows (O2, O1's server half) | 580/580 rows x 3 | PASS 7/7, **580/580 rows**, L10 6 **80/80** (M3: 79/80), 1.3 h (runner heap 16 GB, as O2's runs) | PARTIAL (the races' quiet window) |
| B3 L7 | b3-l7-offline (O2) | 3/3 | PASS | PASS |
| B3 L8 | b3-l8-leased-forged (O1) | 20/20 x 3 | PASS | PASS |
| B3 L9, L11, L12 | b3-l9-l12-guard (O2) | 3/3 | PASS 4/4 | PASS |
| B3 verifier L1-L4 | b3-l12-lease-l (O2) | 9/9 x 3 | PASS 9/9 | PASS |
| B3 L13 | b3-l13-chords (O2) | 3/3 | PASS 2/2 | PASS |
| B3 verifier K1-K5 | b3-l13-keys-k (O2) | 5/5 x 3 | PASS 5/5 | PASS |
| B4 D1, D2, D5, D6, D7 | b4-client-durability (O2) | 3/3 (D7 6/6 rows each) | PASS 6/6; D7 6/6 rows (3 online, 3 offline) | PASS |
| B4 D3 | b4-server-d3-sigkill (O1) | 3/3 | PASS: acked = stored 780 / 771 / 771 of 960, 0 missing | PASS |
| B4 D4 | b4-server-d4-commit (O1) | 3/3 | PASS | PASS |
| B5 R1 | b5-r1-readonly-forged (O1) | 3/3 | PASS 3/3; presence p95 viewer 127, commenter 125, guest 127 ms (informational) | PARTIAL (200 ms p95, quiet window) |
| B5 R2 | b5-r2-commenter (O5) | 3/3 (part 2) | PASS | PASS |
| B5 R3 | b5-r3-keys (O2) | 12/12 x 3 | PASS | PASS |
| B5 R4 | b5-r4-downgrade (O1) | 3/3 | PASS | PASS |
| B6 | b6-forged (O1) | 15/15 x 3 | PASS 15/15 | PASS |
| B7 (all seven) | b7-files (O5; the mood board is O2's acceptance) | O5 3/3 (part 2); O2 7/7 x 3 (part 3) | PASS 7/7; **mood board 200 images, 0 lost creates** (M3: 3 lost), 34.0 s, max 6 in flight, 0 given up, heap 45.2 MB | PASS |
| B8 converter, semantic diff, migrate (unit) | inside `pnpm test` (O4) | 3/3 (part 2) | PASS | PASS |
| B8 restore fixed point, generated | b8-restore (O4) | 3/3 | PASS | PASS |
| B8 screens, generated | b8-screens (O4) | | PASS | PASS (lead's run) |
| B8 open in two browsers, generated | b8-two-browsers (O4) | on `spike/b-convert` (unmerged) | **PASS** 1/1 (the first pass on the integrated tree: M1/M2 failed it before conversion on open, M3 did not run it) | PASS on this tree once; O4's 3 runs are on its unmerged branch |
| B8 rollback drill, generated | b8-drill (O4) | on `spike/b-convert` (unmerged) | **FAIL 0/2**: the spec's `waitSaved` (`b8/excalidraw-side.ts`) reads `saveState().kind`, but the facade returns `SaveStatus` with `state`, so it can never see Saved and times out at 30 s on both boards. A spec defect, not a product failure (this spec has not passed before: M1/M2 failed it for want of conversion on open, M3 did not run it). O4's `de3dc40` rewrites that file (it uses the harness's `waitSaved`) | FAIL on this tree (spec); merge O4 next |
| B9 workstation half | b9-visibility, `SPIKE_B9_WS=1` (O3) | FAIL (part 2 diagnosis) | **FAIL**: A→B p95 1,509 ms at 100% (gate 250), 1,853 ms at fit; **0 local edits lost** at both zooms (30 + 30; M3's diagnosis runs lost 1-8). Stages at 100%: A's core 673 ms p95 before its push, B's `changes` receipt 1,037 ms, B's paint 1,509 ms; `lobby.updateScene` busy 168-189 ms per second on both pages | FAIL (performance; not a quiet window) |
| B9 NAS half | `scripts/nas-*` (O3) | not run | excluded by instruction | UNRUN |
| B10 | b10-echo (O3) | 3/3 (part 2) | PASS | PASS |
| B11 | b11-convergence (O3) | 3/3 (part 2), one open divergence | PASS (11.0 min): 3 browsers + 50 headless, browser ops 410 (0 failed), headless edits 11,588 and creates 2,324, 0 errors, 4 cuts, 2 drops, one SIGKILL (1,073 acked checked, 0 missing), 4,646 elements (3,675 tombstones) | PASS, with the open divergence |
| B12 collapse, guard, phone | b12-collapse, b12-guard, b12-phone (O5) | 3/3 (part 2) | PASS 1/1, 4/4, 1/1 | PASS |
| Harness guest sign-in | selftest guest (O3) | 3/3 | PASS | PASS |
| §8.4 bundle | perf-bundle, `SPIKE_PERF=1` (O3) | smoke | PASS: 1,390.5 KiB gzip (JS 1,350.8, CSS 39.6); A13's engine route 1,306.9, tldraw route 1,086.2 | reported (not a gate here) |
| §8.4 client numbers | perf-client (O3) | smoke | PASS: `updateScene` p50/p95 3.9/6.0 ms at 5k, 20.9/28.6 ms at 20k, 30.7/43.5 ms at 20k + 10k deleted; apply end to end p95 38 / 98 / 141 ms | informational |
| §8.5 fps | perf-fps (O3) | smoke | ran: pan fps 3.7-6.2 at fit / 0.25 / 1 idle and 3.9-5.6 with a remote writer (the heavy board) | the §8.5 gate would fail (O2/O5's `bounds` cost); quiet window |
| §8.4 open time | perf-open (O3) | smoke | ran: heavy 1,218 / 1,064 / 1,011 ms, typical 714 / 650 / 660 ms | informational |
| Probe: lost create | b7-probe-lost-create (O5; O2's acceptance) | 0/400 x 3 | **PASS: 0 of 400 lost** (86 creates had an inbound frame before the next), Saved at the end (M3: 5 lost) | PASS |
| Probe: lost edit | b9-probe-lost-edit (O3; O2's acceptance) | 0/40 + 0/40 x 3 | **PASS: control 0/40, 50 Hz writer 0/40** (1,931 writer acks) (M3: 2/40 lost) | PASS |
| Probe: pan | perf-probe-pan, `SPIKE_B_PROBES=1` (O3) | | PASS: 60 fps for every camera method on the notes-only board (181 scans, 156-165 ms in all) | informational; the heavy board's images are the difference |

**The M3 data-loss blocker is closed on this tree:** both owner probes pass (0 of 400 creates, 0 of 40
edits under a 50 Hz writer), B7's mood board lost 0 of 200 creates, L10 6 passes 80/80, B9 lost 0 local
edits, and B2 U12 and B4 D7 (the drag-recolour overwrite and the offline-queue window from wave 2's list)
pass. These are single lead runs; the owner's 3/3 is in `O2-part3.md`.

## M3

**M3 is still not reached, on two checks.** Every other check has passed once on the integrated tree.
- **B8's rollback drill** fails here on a spec defect that O4 has already rewritten on `spike/b-convert`
  (`de3dc40`, unmerged). The next step is to merge it and run the drill once.
- **B9's workstation half** fails on visibility time (1.5 s p95 against 250 ms). This is the open performance
  item (O2 with O5: `CanvasPort.bounds` and the per-change `updateScene` cost on the heavy board), not data
  loss: 0 local edits were lost. It needs the fix and then the quiet window. The NAS half is unrun.

## Wave 2's requests to spike B, where they stand on this tree

| Request (wave 2) | Status on `spike/excalidraw` |
|---|---|
| Drag-recolour overwrite (2E, blocking) | fixed (O2); B2 U12 passes here |
| Lost-edit / lost-create race (blocking) | fixed (O2); both probes, B7's mood board and L10 6 pass here |
| Offline-queue 100 ms window (integrator, blocking) | fixed (O2); B4 D7 passes here |
| `message` events after the apply (2C) | done (O2) |
| `LobbyHistory.mergeTop()` (2C) | done: `mark()`, `mergeTop(since?)`, `UndoController.joinPrevious()` |
| CR-2D-2 insert of prepared elements (2D, 3b) | done: `LobbyEngineCore.prepareInsert`/`insert`, `LobbyCanvasTx.insert` |
| CR-2D-1 lock scope (2D) | done (O1) |
| CR 2F-2 `serverWrite`/`prepareBoard` (2F, 3f, 3h) | done (O1); declarations accepted here as rev 5 |
| `room/http.ts` header (integrator) | done (O1) |
| `VITE_LOBBY_BOARD_PAGE=spike` in the spike-b config (2C, integrator) | done (lead) |
| Record CR 2F-1/2F-2 in spike B's CONTRACTS (integrator) | 2F-2 recorded (row 5); 2F-1 is `engine/excalidraw`'s only (decision 1) |
| Per-item "Offline — N changes" count (2C) | open (O2) |
| 2E's two undo defects (empty note typed then undone; redo of Ctrl+G in a long sequence) | open (O2's history and lease) |
| Presence "always included" peers | open: needs a `protocol.ts` CR with O1's and O2's OK (O1) |

These reach `engine/excalidraw` only when it merges `spike/excalidraw` again. 2C's page should then call
`syncScene()` after its undo install and `persistNow()` on `pagehide`, when hidden and on unmount, and drop
its microtask deferral of `message` events (`O2-part3.md` "For other owners"). The CR-2D-1 expected failure
and 2F's two "503 on an open room" assertions become passes there.

## Open problems, per owner

**O2 (web engine)**
- Performance with O5: `CanvasPort.bounds` and the heavy board's `updateScene` cost. Pan runs at 4-6 fps and
  B9's A→B p95 is about 1.5 s. The fps and visibility gates cannot pass until this is fixed.
- The per-item "Offline — N changes" count, 2E's two undo defects, B11's one unexplained divergence, and
  the spike page's "Preparing this board…" state.

**O1 (room)**
- One `L6 1-2` row in O2's runs had a stored elbow route left at its unrouted create points, with no
  client op on the arrow (`O2-part3.md`). It was not seen in this pass (40/40 `L6 1-2` rows here).
- Presence's always-included peers need a `protocol.ts` CR.
- For O4 and 2F: converted `lb_deleted` batch numbers overlap live ones, and 2F's `deleted.ts` groups by
  batch (`O1-room.md` "Handover (part 3)").

**O4 (conversion)**
- `spike/b-convert` `de3dc40` (the drill and the two-browser rows through conversion on open, and a
  roll-forward fix) is ready for the lead's next merge.

**O3 (harness)**
- B9's workstation half waits for O2's performance fix, then the quiet window. The NAS half and the
  `perf-*` gates are unrun in a quiet window.

**Lead**
- Next: merge `spike/b-convert`, run B8's drill and two-browser rows once, then post the quiet window.

## How to re-run

From the repo root, with `export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"`
and `DRAFTROOM_BACKUP_STORE=off`:

- The gate: `INT_OUT=<dir> bash docs/research/excalidraw/spike-b/scripts/integration-m3-gate.sh`
- Every spike-b spec once (base 7850, the B8 stand-in on 7858; B9's workstation half, the perf specs and the
  probes included): `INT_OUT=<dir> bash docs/research/excalidraw/spike-b/scripts/integration-p3-checks.sh`,
  or name one or more specs after it.
