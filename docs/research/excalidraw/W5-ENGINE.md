# Excalidraw migration, wave 5: the engine integration (2A, 2B, 2C)

The engine half of wave 5: the three engine owners' branches (2A sync room and contracts owner, 2B sync
edges, 2C web engine and board page) merged onto `engine/excalidraw`, their change requests reviewed with
both ends, the fixes the merged tree needed, the gate, and then the merge with the feature half of wave 5
(3a-3i and 2D, integrated by its own workflow and pushed meanwhile, `WAVE-3.md` §8). The owners' evidence is
theirs: `docs/research/excalidraw/wave5/2B.md` and the wave-5 2A, 2B and 2C entries of `docs/PROGRESS.md`.
Runs are **single runs** (plus reruns of what failed) on a workstation shared with other agents' runs;
durations are informational.

| | |
|---|---|
| Branch | `engine/excalidraw`. Worked on in two worktrees of the integrator's own: `Draftroom-engine-w5-int` (branch `engine/w5-int`: the engine merges and the gate) and `Draftroom-engine-w5-int2` (branch `engine/w5-int2`: the merge with the feature integration, pushed to `engine/excalidraw`), because the feature integrator was running its gate in `Draftroom-engine` at the same time |
| Base | `f336ae4` (the early wave-5 review synthesis; every engine owner branched from it) |
| Engine merges (`--no-ff`, in this order) | `engine/w5-2a` `11a6e6c` (`9ed99d9`), `engine/w5-2b` `4d8ecf8` (`524c881`, one conflict: both PROGRESS entries kept), `engine/w5-2c` `564f595` (`6f93706`, no conflict; 2C had merged 2A through `8bbac32`, which is `CONTRACTS_REV` 8) |
| Feature merge | `origin/engine/excalidraw` `1a85d5c` (the wave-5 feature integration) merged as `17bca79`: conflicts in `EXCALIDRAW-CONTRACTS.md` §12 (rows kept in order: W5-1, W5-2, W5-3G-1, W5-F1, W5-ENG-1, W5-ENG-2) and `PROGRESS.md` (every entry kept); no code conflict (§7) |
| Change requests | 2A's two `CR:` commits (`b3ce1a7` rev 7, `cb030b2` rev 8), 2B's CR-2B-1 to CR-2B-4, 2C's requests; recorded in `docs/EXCALIDRAW-CONTRACTS.md` §12 as W5-ENG-1 (accepted) and W5-ENG-2 (not applied) (§2) |
| Integration commits | engine half: `a6c578d`, `344990a`, `3b768c6`, `9051294`, `d23ec31` (docs); after the feature merge: `c419ed2`, `f3d30b9`, `27622e6`, `ca9c192`, and this report (§3, §7) |
| Lockfile, `pnpm-workspace.yaml`, catalog | unchanged by every owner and by the integration |
| Feature workflow's folders | not edited (`apps/web/src/features/**`, `file-card/**`, `assets/**`, `dashboard/**`, `packages/templates/**`, board-ops); what the merge needs there is a request (§7) |
| Machine | Windows 11 workstation (64 threads), Node 24.19.0, pnpm 10.34.5, Playwright headless Chromium (one branded-Chrome test in the default suite). Every stack ran with `DRAFTROOM_BACKUP_STORE=off`; `.env.deploy.local` was never read |
| Ports | 6520-6559 only: the Excalidraw specs in two shards (bases 6520 and 6524, with their fake OpenAI on +3, +10, +23), the spike-b suite on 6535, the default suite on 6550, the spike A suite on 6555, B8's R0 stand-in on 6520 and its Excalidraw stack on 6525. Nothing was left listening in 6520-6559 |
| Logs | the integrator's scratchpad `w5-int/` (`lint.log`, `typecheck.log`, `unit*.log`, `arrows.log`, `excal-*.log`, `default.log`, `spikeb.log`, `spikeA.log`, `b8*.log`, `m-*.log` for the merged tree, `*-grep.txt`); never committed |

## 1. What merged

- **2A (sync room; contracts owner for the lead's canvas-schema files since §0a).** W5-02 (security
  blocker): no role receives a deleted element's content over the canvas socket (`redactTombstone`,
  `TOMBSTONE_KEYS`; rev 7, corrected by rev 8). W5-05: a locked element moved by exactly its frame's move in
  the same push moves with it; a frame op that does not land takes its members' moves back. V2's re-check
  (hello flood, guest cap through tombstones = D5, lease squatting, signed URLs failing closed, the
  `serverWrite` invariant scope, the drag TTL) and V3's room low (tombstone keys in the index cache). D3
  (`fontFamily` 7). R0's contracts on the api (`GET /internal/canvas`; `boards.new_canvas` and
  `body_version` 2 written on the new canvas, R0's refusals dropped there). Open item 11
  (`DRAFTROOM_BOOT_MAINTENANCE`).
- **2B (sync edges).** V3's medium (the roll-forward repairs a key share instead of refusing the board),
  open items 10 and 12, D4 (all 20 tldraw geo kinds from tldraw's own geometry, `CONVERTER_VERSION` 2),
  V3's polygon conflict listing, the leak check's blind spots and the B8 evidence wording, and R0's backup
  contracts 3 and 4 on the Excalidraw build (element-board local backups, `lobby-elements-converted`, held
  backups outside retention, drill and staged restore of lb backups).
- **2C (web engine and board page).** V1's re-check (lost pushes kept in the offline queue across reloads,
  decided by counting writes; doc writes; the queue merge; holdSaved on the real page), a 15 s socket
  heartbeat, DEF-3F-1, W5-02's client side, W5-01 (notes and texts join the frame under the point), D1 /
  W5-08 (bound connectors follow a remote drag, drawing only), W5-10 and W5-15 (frame and dark-mode colours),
  the transact defect, CR-3A-3, DEF-W3-2, CR 3b-5, 3b-7, 3b-8, 3b-9, CR-3A-8, CR-3A-9 (facade part) and
  CR-3A-10; five `test.fail` marks removed.

## 2. Change requests

| §12 | CR | Both ends | Decision |
|---|---|---|---|
| W5-1, W5-2 | 2A `b3ce1a7` (rev 7), `cb030b2` (rev 8): tombstones redacted on the wire; a delete's broadcast is the exact patch | **Producer** (2A): the reset snapshot (one for every role), catch-ups, `c` ops of tombstones and a refusal's `el` carry `redactTombstone(row)`; a delete reaches live holders as its exact patch; an undelete is a full `c` op; rows stay full. **Consumers:** 2C took rev 8, not rev 7 (`keepTombstoneContent` keeps a tab's content and takes exactly `TOMBSTONE_KEYS` from a redacted `c`, the keys `hash.ts` makes authoritative); 2B's roll-forward hashes its merged view through `canonicalElementList` (report digests only) and digests `lb_*` by stored bytes, which rev 7 leaves alone; spike B's `divergence` compares through `canonicalElement`; the facade's hash is `hash.ts` | **Accepted.** Checked on the merged tree by 2A's `sync-room-tombstones`, the mind-map undo specs (rev 7's regression) and `history-deleted` in the full Excalidraw runs, and by the spike-b suite's convergence checks |
| W5-1 (2) | D3: `fontFamily` 7 | server limits, the text-metrics table and the engine type (2A); readers are 2D's templates and 3e's SVG export (feature workflow) | **Accepted.** With the feature merge, 2D's headings switch to Lilita One by themselves, and 3e's `present-export-files` D3 (Lilita One embedded in SVG) passes |
| W5-1 (3), (4) | signed URLs fail closed; guest cap per uid | the same check on client and server (`isAllowedLink`); the cap is the room's | **Accepted** |
| W5-ENG-1 | CR-2B-1 (to 2A: tombstone keys in `IndexCache.usedByOther`) | 2A's V3 fix is the same rule | **Answered by 2A's fix.** It changed what 2B's real-process test could build through the room (§3) |
| W5-ENG-1 | CR-2B-3 (2E's `e2e/spike-b/support/ports.ts`: the `'2B'` range) | the harness and B8's stand-in | **Accepted**; the integration adds `'engine-int'` [6520, 6559] the same way, with a self-test |
| W5-ENG-1 | CR-2B-4 (to the lead: plan open items 10 and 12, §5.1 / §5.2, DEPLOY.md's format contract) | docs | **Applied by the integration** (`d23ec31`): open items 9, 10, 12 and "index collisions" marked closed with their tests; §5.1's geo rows and the binding mode as built (`isExact` → inside; `isPrecise` or elbow → orbit at the anchor; else orbit at the centre); DEPLOY.md names `lobby-elements-converted` and the new build's staged restore. The stale "backups off until 2B ports" comment in 2E's `e2e/tests/support/stack.ts` is left to 2E (the e2e stacks keep `DRAFTROOM_BACKUP_STORE=off` either way) |
| W5-ENG-1 | not frozen: 2A's `GET /internal/canvas`, the api's canvas probe and marks, `DRAFTROOM_BOOT_MAINTENANCE`, the room limits; 2B's `lobby-elements-converted`, `CONVERTER_VERSION` 2, `RollForwardReport` fields; 2C's additive interfaces and the heartbeat | api and sync are 2A's both; the heartbeat's `ping` is the protocol's, and the room answers it `pong` (`element-room.ts`) | **Accepted as built** |
| W5-ENG-2 | 2C: push receipts; CR-3CF-1 `view.z`; a skip-undo `TransactOptions` (CR-3F-1); 2B: CR-2B-2 (polygon outlines for 3a's tools); CR-3A-9's longer-term part | need the contracts owner (2A) | **Recorded, not applied** (§6) |

`CONTRACTS_REV` stays 8: the integration changed no frozen file. The feature workflow's CR-W5-3G-1
(`files.crop`) was accepted by its own integration (§12 W5-3G-1) and merges here unchanged.

## 3. Fixes the merged tree needed

Each with the test that fails before it and passes after.

| Commit | What broke | Fix | Evidence |
|---|---|---|---|
| `a6c578d` | 2A renamed `BoardStore.snapshotJson()` to `snapshotRows()` (rows with their deleted flag, for W5-02); 2B's restore drill, written on `f336ae4`, still called the old name: the merged tree did not typecheck, and an lb backup's drill and staged restore threw | `drill.ts` reads `snapshotRows()` | 2B's `excalidraw-backups.test.ts`: 2 of 7 fail on the merge commit, 7/7 after; the backup folder 77/77 |
| `344990a` | 2B's `rollforward-keys-open.test.ts` built its precondition (a live element on a tombstone's key) through the room; 2A's V3 fix now re-keys that push (2 of 2 failed) | the test checks that the room re-keys the push (2A), then writes the share into the file with the sync stopped, as an older room left it; the roll-forward on open must still repair it (2B) | 2/2 fail on the merge commit, 2/2 pass after; with `rollforward.ts` at `f336ae4` both fail again (no welcome: the conversion fails), so the test still pins 2B's fix |
| `3b768c6` | the spike-b harness and B8's stand-in refused any port outside spike B's ranges and 2B's | `'engine-int'` [6520, 6559] in `ports.ts` and the stand-in | `selftest/units.spec.ts` "the wave-5 owners' ranges are stack bases": fails without the range; 13/13 with it |
| `9051294` | `a11y-2` A11Y-14 (also failing on `f336ae4`; 3i's CR-3I-6 to 2C): every board open announced "Back online. All changes saved." V1 N20's fix counted the unread offline queue as one dirty element, so before the welcome the page was "Offline — 1 change on this device" for a few milliseconds and the announcer then spoke the recovery | `SaveInputs.unknown` (optional): the unread queue still keeps Saved away but is no offline change, so the page reads as connecting | `verifier-fixes.test.ts` "a queue not read yet keeps Saved away but is no offline change" (offlineChanges 1 before, 0 after; the N20 test still passes); `a11y-2` 24/24 over three runs |
| `c419ed2` | after the feature merge `apps/web` did not typecheck: 3a's `polygons.test.ts` (D4's tools) imports `polygonOf` from `tldraw-import/src/geometry.ts`, which 2B's D4 removed | `polygonOf` back under its name as the **v1 outlines**, documented as not used by the converter | typecheck fails on `17bca79`, passes after; `polygons.test.ts` passes. **This keeps the build green, not D4's promise**: 3a's tools still draw the v1 outlines while converted polygons use tldraw's geometry, and the two differ for pentagon (11.9 px at the worst vertex), hexagon, octagon (57.5 px), rhombus, star, cloud, heart and the arrows (triangle is the same; V3's wave-5 `v3w5-polycmp` probe measured pentagon and octagon). CR-2B-2 (§6) closes it |
| `f3d30b9` | `templates-scenes` "every template scene is a fixed point of restoreElements" failed on the merged tree: 4 brainstorm labels moved by up to 17 px. 2A's allowlist and 2D's display face together put Lilita One headings in the templates, and the browser check (`e2e/spike-b/b8/restore-check.ts`, 2B's) loaded each text's face by a name map that knew 5, 6 and 8 only, so the first template was measured before Lilita One had loaded | the map knows 7 (`Lilita One`), in both places | fails without the change (4 beyond tolerance), passes with it |
| `ca9c192` | `canvas/export/fonts.ts` `LOBBY_FONT_FAMILIES` said [5, 6, 8] after D3 allowed 7 (2A's follow-up for 3e / 2C) | it re-exports canvas-schema's allowlist | `export.test.ts` "the families an export may embed" fails before, passes after |
| `27622e6` | 10 expected failures passed on the merged tree ("expected to fail, but passed"): `a11y-contrast` ×5 (W5-10, W5-15), `a11y-2` A11Y-14 (CR-3I-6), `canvas-ux-review` W5-05, `present-export-files` D3, `workshops-voting` W5-01; and `templates-frames` W5-05 still failed, for a new reason: each frame is dragged down and left there, so the storyboard's Brief came to cover the panels' names, and the drag of "Panel 2" grabbed one of the Brief's notes (dy 0) | the marks are off; `templates-frames` moves each frame back after its check | the six specs 49/49 on the final code; `templates-frames` 6/6 (two runs), its W5-05 failing without the move-back (storyboard, Panel 2, dy 0) |

## 4. Gate

**The engine half** (the three merges and `a6c578d` to `9051294`; the e2e runs started on `3b768c6`, and
`9051294` touched only the web engine core, which `a11y-2` reran):

| Check | Result |
|---|---|
| lint (`biome check .`) | PASS, 1,972 files |
| typecheck (`pnpm -r typecheck`, 15 projects) + engine-probe tsc + Node-safety tsc | PASS (the merge commit failed: `drill.ts`, `a6c578d`) |
| `pnpm test` | PASS: 5,237 passed, 36 skipped (507 files, 9 skipped). On the merge commits: 2 failures (`rollforward-keys-open`, `344990a`) |
| `pnpm test:arrows` | PASS 85/85 |
| `e2e/excalidraw`, whole folder once (two shards) | 371 passed (8 of them expected failures), 2 skipped (opt-in measurements), **1 failed**: A11Y-14, fixed in `9051294`, then `a11y-2` 24/24 over three runs |
| `e2e/spike-b`, every spec once except B8's staging rows and B9 (base 6535) | **96 passed, 1 failed, 1 did not run, 5 skipped** (1.2 h): m1 1/1, b1 4/4, b2 12/12, b3-l1-l5 5/5, b3-l6-l10 5/7, b3-l7 1/1, b3-l8 (bind escape, leased forged) 2/2, b3-l9-l12 4/4, b3-l12 9/9, b3-l13 (chords, keys) 7/7, b4 (client, d3 SIGKILL, d4 commit) 8/8, b5 r1-r4 6/6, b6 (forged, cross-workspace) 16/16, b7 (files, lost-create probe) 8/8, b10 1/1, b12 (collapse, guard, phone) 6/6, perf-bundle 1/1. The failure was the Playwright **test worker** running out of its 4 GB heap 63 minutes into `b3-l6-l10-arrows` (L10 3-5; L10 6 then did not run): the spec keeps every row and trace of its seven tests in one worker. Both passed in a fresh worker on the final code (2/2, 200 rows ok, 21 min). Skipped as opt-in: B11 (`SPIKE_B11=1`, run separately on the final code: **1/1**, 3 browsers and 50 headless clients converge, 10.2 min), `perf-client`, `perf-fps`, `perf-open` (`SPIKE_PERF=1`, a quiet window, not available on this shared machine) and `perf-probe-pan` (`SPIKE_B_PROBES=1`) |
| B8's generated rows (2B's scripts, `B8_BASE=6520`, `RUNS=1`) | PASS. `o4-b8-rows.sh`: converter and migrate units 175/175, conversions 11/11 (17-18 checks each), the `restoreElements` fixed point on 10,024 elements (0 dropped, 0 added, 0 rewritten, max 0.0931 px, 0 beyond tolerance), `b8-restore` 1/1. `o4-b8-open.sh`: `b8-two-browsers` + `b8-drill` 12/12 on 11 fresh boards. `b8-screens` 1/1. Listeners 6520-6529 before and after: 0 |
| default (tldraw) suite once, `E2E_PORT_BASE=6550` | **PASS 344/344** (25.1 min) |
| spike A suite once, `SPIKE_WEB_PORT=6555` | **PASS: 99 passed, 2 skipped** (opt-in), 19.5 min, fresh build |
| normal web build, engine markers | PASS: **0** hits for 65 markers (the M3 gate's, wave 2's, 3's and 3b's, and wave 5's `lobby-drag-arrows-view`, `lobby-drag-arrows-theme`, `socket_heartbeat_dead`, `lost_held`); no `excalidraw-assets/`, 0 source maps. Positive control: the guarded engine build holds 58 of the 65 (the other 7 are minified names or old spike strings) |
| engine flag without the dev-auth guard | PASS: 0 of the 65 |

**After the feature merge** (`17bca79` and `c419ed2` to `ca9c192`, worktree `Draftroom-engine-w5-int2`):

| Check | Result |
|---|---|
| lint | PASS, 2,016 files |
| typecheck (all three) | PASS (the merge commit failed in `apps/web`: `polygonOf`, `c419ed2`) |
| `pnpm test` | **5,389 passed, 1 failed, 36 skipped** (523 files; at the push head `fd4f9ab`, with `ca9c192`'s test). The failure is 2D's `packages/templates/src/scene/hierarchy.test.ts` `it.fails("the server's element check accepts the display face")`: an expected failure that now passes, because 2A's allowlist takes family 7. Its own comment says to remove `.fails` when the allowlist lands; the file is in the feature workflow's folder, so it is a request (§7), not an edit here |
| `pnpm test:arrows` | PASS 85/85 |
| `e2e/excalidraw`, whole folder once (two shards) | 430 passed (12 of them expected failures, `templates-frames` W5-05 among them), 3 skipped, 10 failed: 9 expected failures that now pass and `templates-scenes` (§3). After `f3d30b9` and `27622e6`: the six specs concerned 49/49, `templates-frames` 6/6 (two runs) |
| default suite, the specs the merge touches (`comments`, `workshops`, `bridge-r0`, `dashboard`, `checkpoints`, `history`, `link*`) | PASS 83/83 |
| normal web build, engine markers | PASS: **0** hits for 79 markers (the 65 above and 14 of the feature integration's: `cux-polygon-preview`, `history-bar`, `cux-toolbar-more`, `dr-cnav`, `navigation.back-to-content`, `navigation.code-selection`, `dr-a11y-focus-ring`, `canvas-announcer-tool`, `lobby-link__title`, `lobby-ghost__chip`, `media-replace`, `media-crop`, `tag-guest-hint`, "Sticky note text"); no `excalidraw-assets/`, 0 source maps; the guarded build holds 71 of them |
| engine flag without the dev-auth guard | PASS: 0 of the 79 |
| spike-b specs that read Saved or B8's browser check, on the final code (`9051294` changed Saved; `f3d30b9` the browser check) | PASS: `m1-walking-skeleton` 1/1, `b1-concurrent-fields` 4/4, `b4-client-durability` 6/6, `b7-files` 7/7, `b10-echo` 1/1 (19/19, base 6538); B8's generated rows again (`o4-b8-rows.sh`, `RUNS=1`): units 175/175, conversions 11/11, fixed point on 10,032 elements with 0 beyond tolerance, `b8-restore` 1/1 |

**Expected failures left in `e2e/excalidraw` on the final tree: 11.** F11 (undo restores the selection;
spike B history), the two restores from Recently deleted marked DEF-W3-1, CR-3H-2 (template notes count as
typed), the redo of an own Ctrl+G in a long undo/redo sequence, CR-3C-1 (presence has no follow target),
CR-3D-5 (an editor guest's new tag), CR-3F-1 (+1 as an undo step), `people-follow` W5-25 (CR-3C-W5-1, the
leader's resize), `a11y-phone-reach` W5-31 and W5-50 (CR-3I-2, CR-3I-3, 2C's top bar and phone menu). The
feature integration counted 25; the engine merge resolved 14 (W5-10 and W5-15 ×5, W5-05 ×2, W5-01,
DEF-3F-1 ×2, DEF-W3-2, CR-3A-3, D3, CR-3I-6).

## 5. The spike verifiers' re-check (`beff59d`), after wave 5

| Verifier | Defect | Severity | Now | By |
|---|---|---|---|---|
| V1 | the lost-ack replay through the offline queue (a reload replays a push over a later write, revives a delete) | high | fixed: in-flight pushes are kept as lost pushes and decided like a reconnect | 2C |
| V1 | a change that never reached the server is dropped silently when another user wrote the group | medium | fixed for one other writer (replayed as an offline change); **still open** when two or more other writes landed in the window: needs push receipts (W5-ENG-2); the heartbeat shortens the window | 2C |
| V1 | ABA in the lost-ack rule | medium | fixed for elements (writes counted, not values); **still open** for doc keys (no version) | 2C |
| V1 | doc writes with a lost ack re-sent; a queued `#doc` re-sent unconditionally | low | fixed | 2C |
| V1 | `offline-idb` merge drops one tab's `#doc` | low | fixed (`offline-merge.ts`) | 2C |
| V1 | holdSaved missing on the real board page (P1) | low | fixed | 2C |
| V2 | a viewer delays every join (hello flood across sockets) | medium | fixed: sockets per user and board 12, per process 128; welcomes fair-queued per user with a row budget | 2A |
| V2 | the guest cap bypassed through tombstones | low | fixed (D5: per uid, tombstone creates count) | 2A |
| V2 | lease squatting per sid | low | fixed (8 per user per room, and the socket cap) | 2A |
| V2 | the signed-URL check gives up on a malformed escape; no GCS names | low | fixed (rev 7) | 2A |
| V2 | `serverWrite`'s invariant check keeps only violations on written ids | low | fixed: any new violation in the neighbourhood refuses the write | 2A |
| V2 | a drag kept alive by one frame every 10 s | low | fixed (`DRAG_MAX_MS` 60 s, no restart by re-sending ids) | 2A |
| V3 | the roll-forward fails a board on a key shared with a tombstone | medium | fixed (repaired in the merge's order) | 2B |
| V3 | the room stores a live element at a tombstone's key | low | fixed | 2A |
| V3 | leak-check blind spots | low | fixed | 2B |
| V3 | evidence wording (407/407, a run across a merge) | low | fixed | 2B |
| V3 (earlier round) | a both-sides recolour of a polygon lists no conflict | low | fixed (a geo from parts conflicts as one shape) | 2B |
| V3 (earlier round) | R0 runbook: checkpoint a board file before any copy | low | **open**: a sentence in `B8.md`, not in DEPLOY.md's runbook | lead |

No verifier has re-checked these fixes yet; the owners' runs and this gate are the evidence.

## 5a. The verifiers' third re-check (`5caee00`) and the engine fixer's round

One fixer acted for 2A, 2B and 2C on `engine/excalidraw`; every fix has a test that fails before it (`lost-pushes.test.ts`, `socket.test.ts`, `w5-fixer.test.ts`, `rollforward-repairs.test.ts`). The verifiers' probes (untracked, in their worktrees) were re-run on the fixed code, 3 reps, 3 runs.

| Verifier | Defect | Severity | Now | By |
|---|---|---|---|---|
| V1 | own pushes in flight counted as other users' writes: a push lost behind two acked nudges dropped silently (L0-L5, P20-P22) | high | **fixed**: the core keeps each ack's server versions and decides from the version the last acked predecessor left (`Sent.ahead`, `effectivePv`); the offline queue stores the corrected `pv`; a superseded group is reported (`superseded` event, the page's notice). L1, L1c, L1r, L2, L3, L5 pass; L0's pure call models the old inputs | 2C |
| V1 | the heartbeat only pings after silence: a dead upstream behind other users' frames is never found (H2) | medium | **fixed**: a ping every 15 s, the socket dropped when a ping stays unanswered (30 s); H1 and H2 pass | 2C |
| V1 | a note created inside a frame another user is dragging ends a member outside its frame (W2) | low | **fixed**: the room clears `frameId` when the created element does not overlap its frame as stored (the ack's `fix`) | 2A |
| V1 | doc-key ABA | low | **open** (push receipts, or a per-key clock in the welcome: contracts) | contracts |
| V2 | maintenance refuses sockets but not the engine's board-writing internal routes (P-M2, P-M4) | medium | **fixed**: every engine POST but `convert-all` answers 503 MAINTENANCE (the runbook runs `convert-all` inside the window, §7.5 step 6; P-M4 expects 503 there too, which would break the cut-over). The second check after the body is read needs a maintenance getter in `ElementRoomDeps` (a request to the lead) | 2A |
| V2 | the reset-snapshot cache keeps a deleted element's content for a join within 5 s of a client delete (P-W3c) | medium | **fixed**: the cache is dropped when a push deletes (not on every write: a reconnect storm keeps it) | 2A |
| V2 | a create over another user's tombstone id keeps that user's createdBy and lastEditedBy (P-W7, P-W8) | medium | **fixed**: new content under another user's deleted id is the writer's element; a same-content revive keeps the author. For a name-only guest the create is refused outright (below), so P-W8's guest rows now read GONE | 2A |
| V2 | a name-only guest editor reads every tombstone's content by reviving it (P-W6) | low | **fixed**: a guest revives only a tombstone it created or deleted itself (`lb_deleted.deleted_by`), GONE otherwise; P-W6 passes | 2A |
| V2 | the guest cap bypassed through labels detached into free texts (P-G2); a guest uid per cookie-less join (D5-uids) | low | **fixed** for the labels (the detach counts, and is refused at the cap); the probe's 12 flooding rounds now trip the room's abuse guard (4099) once the cap holds, so it ends before its own count. The per-join uid is the api's: **open** | 2A, api |
| V2 | the W5-05 lock rule is one-way (frame out with the heading, back alone) (P-K8) | low | **open**, a design limit: the client moves members with their frame; a raw client can leave a locked member behind | 2A |
| V2 | a 60 s drag restarted under a new drag id (P-DR) | low | **open**, a design limit (editors may drag) | 2A |
| V3 | ordinary edits on both sides of a rollback brick the board (A, A2, B, C, D, F, H) | high | **fixed**: the roll-forward repairs (`frame-cleared`, `label-orphaned`, `label-order`, `binding-cleared`); brick 10/10 variants, the real room opens the board | 2B |
| V3 | a binding record R0 created to a shape Excalidraw deleted fails the merge (open item 12's random case) | medium | **fixed** (the binding pass runs on every live arrow); bind 40/40 seeds | 2B |
| V3 | one R0 record beyond ±1,000,000 closes the board (huge-size, far-x-2e6, wide-2e6, moved-existing-far) | medium | **fixed**: clamped to the limits, lossy `coords-clamped`, in the converter and the merge; page bounds ignore such a corner; raw 18/18 | 2B |
| V3 | a geo kind change's new outline keyed above the whole board | low | **fixed** (the part goes after its holder's parts); rect→star, rect→cloud, rect→check-box, star→x-box pass. cloud→ellipse and diamond→heart still differ: the holder's type does not change across the merge (D4, pre-existing, open) | 2B |
| V3 | B8's stand-in refuses V3's ports 7940-7949 | low | **fixed** | 2B |
| V3 | leak-check counts an 8 MB single-line file unreadable | low | **open** (it fails safe; no such file in the outputs) | 2B |
| V3 | §3 wording: pentagon and octagon differ too | low | **fixed** | 2B |

Pre-existing, not from this round: V2's P-W5 (an account editor's revive of a tombstone with a stale `pv` lands and shows that editor the content: the room has no `pv` check on a patch) fails the same way on the unmodified head.

## 6. Open after the engine integration

- **Requests to the contracts owner (2A), not applied:** push receipts (the residual lost-push case and
  doc-key ABA); `view.z` in presence (CR-3CF-1, then `RemoteCursor.zoom`); a skip-undo `TransactOptions`
  (CR-3F-1); **CR-2B-2** (the converter's polygon outlines through canvas-schema or `canvas/api`, so 3a's
  tools draw what the converter draws and the v1 `polygonOf` of `c419ed2` can go; the style panel should not
  give a polygon's holder a stroke); CR-3A-9's port tool names and gesture-element hook.
- **2C, from the early review, not in this round:** W5-28 (other people's selections are not drawn), W5-32
  (edge markers for off-screen collaborators), W5-38 (the engine's accents and selection padding), W5-52 (new
  rectangles are rounded), W5-53 (arrowhead size and binding gap, with 2A), W5-55 (no outline on a note being
  edited), W5-57 (the `contentinfo` footer); the feature side's CR-3I-2, CR-3I-3, CR-3C-W5-1, CR 3b-10 to
  3b-12, CR-W5-3A-1, CR-W5-3G-2 to -4 and CR 3E-7 (`WAVE-3.md` §6). In dark mode a Paper note becomes dark
  paper with light ink (W5-15's one deviation). Media under template slots get `frameId` null in 3g's
  `insert.ts` (a request to 3g).
- **2E:** W5-34 (the heavy seed's images never load, so the heavy-board numbers are measured without
  images); B9 and its workstation half; `spike/b-harness-wip-b9`; `b3-l6-l10-arrows` run whole exhausts the
  Playwright worker's 4 GB heap after about an hour (§4: its rows and traces stay in memory), so a whole-suite
  run needs that spec split, or its evidence written out as it goes.
- **Not yet confirmed by a verifier:** B8's staging rows on the wave-5 code (2B ran them 3 times; the gate
  excludes them), and every fix in §5.
- **DEF-3F-1's server side:** the client now takes the welcome's document, so nothing waits on it; the
  cached snapshot still carries an old `lb_doc` for up to 5 s.

## 7. The feature merge

The feature workflow pushed its integration (`1a85d5c`, `WAVE-3.md` §8) while this gate ran; it was merged
as `17bca79` in a second worktree, so the running engine gate kept its code. What the two halves met on:

- **Code:** the `polygonOf` import (`c419ed2`), the Lilita One measurement in the browser check
  (`f3d30b9`), the 10 marks that the engine fixes turned into unexpected passes and `templates-frames`'
  frame order (`27622e6`). The DEMO.md note on 1:00 now says the connector follows the drag (D1 merged).
- **Requests to the feature workflow (its folders):**
  - **2D:** remove `.fails` from `packages/templates/src/scene/hierarchy.test.ts` "the server's element
    check accepts the display face" (the one red unit test on `engine/excalidraw` after this push; the
    test's comment asks for exactly that).
  - **3a:** move `features/canvas-ux/ported/polygons.ts` to the converter's outlines once CR-2B-2 exposes them;
    then `polygonOf` goes.
  - **3e / 2C (done here):** `canvas/export/fonts.ts`' family list still said [5, 6, 8]; nothing read it (the
    exporter takes its faces from the engine's registered fonts, so `present-export-files` D3 passes), and it
    now re-exports the server allowlist (`ca9c192`).
- **Docs:** `REVIEW-W5-EARLY.md` §11 gives the review findings' status after this merge (7 more fixed);
  the feature integration's `WAVE-3.md` §8.4 table of expected failures is superseded by §4 above.
