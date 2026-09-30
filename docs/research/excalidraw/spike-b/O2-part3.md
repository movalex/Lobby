# Spike B part 3 (O2, web engine): no lost local change, drag-recolour, offline window, message order, mergeTop, insert

Owner O2. Branch `spike/b-engine` (merged `origin/spike/excalidraw` `92b1098` first). Inputs: M3's open O2
defect (`M3.md`: B7 mood board 3/200 creates lost, L10 6, the two owner probes), wave 2's result on
`engine/excalidraw` (2C's and 2D's requests, the integrator's "Blocking the cut-over": the drag-recolour
overwrite, the lost-edit/lost-create race, the offline-queue window). Code: `apps/web/src/canvas/sync/core/engine.ts`,
`sync/adapter/offline-idb.ts`, `port-impl.ts`, `history/{stack,controller}.ts`, `spike/board/session.ts`,
the protocol fake `sync/testing/fakeRoom.ts`.

## Results at a glance

| # | Defect / request | Root cause (short) | Fix | Regression tests (fail before → pass after) |
|---|---|---|---|---|
| 1 | Lost edit / lost create, Saved showing (M3 B7 3/200, B9, wave 2 burst-11, plausibly L10 6) | a server frame applied between a scene write and Excalidraw's `onChange` rebuilt the scene from the last scan | the core scans the live scene before it acts on it; Saved never reads over an unscanned write; `transact` and undo scan at once | 6 core tests (`engine-races.test.ts`, "a local write … is never lost"); probes `b7-probe-lost-create`, `b9-probe-lost-edit` |
| 1b | (found by D7) adopted offline copies not in the scene | `applyScene` installed only elements that changed, adoption changed only the core's view | an element the scene has not seen is always installed | `engine-races.test.ts` "…loaded after its welcome…"; B4 D7 |
| 1c | (found by D7) queued edits dropped behind a stale snapshot | a reset welcome may carry the room's cached snapshot (5 s) and the rows since it as `changes` right after; `afterWelcome` dropped queued changes whose element that snapshot lacked | such changes wait for that catch-up (`awaitingCatchUp`), dropped after 3 s if none brings the element | 2 tests "a stale reset snapshot…"; B4 D7 |
| 2 | Drag-recolour overwrite (wave 2 `collab-conflicts`, `test.fail`) | a remote change held back from a dragged element was diffed as a local change at every scan of the drag | `heldRemote`: groups the server changed while held count as local only if the user changed them too | 4 tests "…held back by a gesture…"; B2 U12 (real pointer drag) |
| 3 | Offline queue written 100 ms after a change (a reload inside it loses the change) | a 100 ms persist timer; the IndexedDB write then waited for a later microtask and the end of the task | written at once outside a gesture (coalesced per 100 ms during one), `persistNow()` on pagehide / hidden / unmount, IDB transaction started and committed in the call, never before the previous page's queue is loaded | 2 tests "the offline queue is written as soon as…"; B4 D7 (edits + `location.reload()` in the same task, online and offline) |
| 4 | `message` events emitted before the core applied them (2C) | `receive()` emitted first | emitted after the handler | "roster, lease table and doc are up to date when the message event fires" |
| 5 | `LobbyHistory.mergeTop()` (2C) | 2C's `history-join.ts` merged through the live `undoEntries` array | `mark()`, `mergeTop(since?)`, `UndoController.joinPrevious()` | `history/merge-top.test.ts` (6) |
| 6 | CR-2D-2: install prepared elements as given | neither C0's `CanvasTx` nor the spike's port had a write path for prepared elements | `LobbyEngineCore.prepareInsert()` / `insert()`, `LobbyCanvasTx.insert()` on the port | `engine-insert.test.ts` (6) |

Unit tests: the three new files hold 28 tests; with the new sources stashed (tests and the fake kept) 27 fail
and 1 passes (a control: "B moves X while A drags it", already right before); with them all 28 pass.

## 1. The lost edit / lost create

**Trace first.** A temporary trace in `applyScene` (not committed) logged, at every install, the elements
of the LIVE scene whose `(version, versionNonce)` the core had never scanned or applied, and which handler
was running. Run on `spike/b-engine` at `92b1098` (base 7870): 400 rectangles through the facade
(`CanvasPort.transact`) with 0–25 ms gaps, one editor.

```
creates 400, vanished 6, never pushed 6
trace_unscanned_apply: 6 entries, from the `ack` and `changes` handlers only, one id each
every vanished id is the id of one of them (6 of 6), and no other create was ever in one
```

**Root cause.** `CanvasPort.transact` (the facade, O5's `placeFile`, tags, +1, mind maps), undo's install
and Excalidraw's own pointer edits put the new element versions in Excalidraw's scene at once
(`updateScene`, `mutateElement`); the core scanned only at Excalidraw's `onChange`, which fires after React
commits, in a later task. A `changes` or `ack` frame (also `welcome`/snapshot, a lease message, an offline
adoption) handled in that window ran `applyScene`, which builds the whole array from `currentOrder` (the
scene as of the LAST scan) and installs it:

- a create not scanned yet is not in `currentOrder`: dropped from the scene, never pushed (B7, the probe);
- an edit installed as a new object (`transact`, undo) is replaced by the old object: reverted;
- an in-place edit (`mutateElement`: the object in `currentOrder` IS the edited one) is installed as it is
  and its new version recorded in `known`, so the late scan found "nothing changed": never pushed, while
  the scene shows it (B9: "A's edits with nothing pushed");

and in every case the tracked state had nothing dirty, so the tab said Saved.

**Fix.** Every entry point that acts on the scene first scans the live scene when it holds a version the
core has not seen (`syncLive`: an O(n) version check, a scan only when something differs): `receive()` for
`welcome`, `snapshot`, `changes`, `ack` and the lease messages, `flushNow`, `persist`, `adoptNow`. The
`saveStatus` getter (read-only) reports an unscanned write as pending, never "saved". `syncScene()` lets a
writer scan at once instead of at the next `onChange`: `transact` and the spike page's undo install call it,
so Saved and the offline queue know of the write in the same task.

The probes pass with the core-level check alone (the `transact` scan commented out for that run):
`b7-probe-lost-create` 0 of 400 lost (78 creates had an inbound frame before the next one), `b9-probe-lost-edit`
0/40 in both phases (writer 1,898 acked), the trace spec 0 of 400.

**1b, found by D7.** With the queue written at once, D7's reload found the queued edits but lost them at
adoption. When the queue loads AFTER the welcome (the reloaded page waits for the tab's Web Lock, which the
old page holds until it unloads), `adoptNow` put the copies in the core's view only: `applyScene` installed
an element only when its rebuild differed, so the scene kept the old copy until some later apply. The next
live-scene sync (and, before this work, Excalidraw's next `onChange`) took the old copy for the truth: a
queued create vanished and a queued edit was dropped (the unit test before the fix: the scene back to
the server copy, nothing dirty, nothing pushed). Now an element the scene has not
seen (`known` has no entry: only adoption does that) is always installed.

**1c, found by D7.** O1's room serves a reset snapshot cached for 5 s and sends the rows since it as one
`changes` frame right behind it (`element-room.ts` `hello`). A reload within 5 s of a create got a snapshot
without the element, and `afterWelcome` dropped every queued change (not a create) whose element was not
confirmed: D7 lost the queued move in 5 of 6 rows. Now such a change waits (`awaitingCatchUp`) when this tab
knew the element at a later clock than the snapshot's (`OfflineEntry.base`, or the clock before a
same-epoch reset): the next `changes` frame settles it (`catch_up_settled`) or drops it if that frame does
not bring the element either (`catch_up_gone`); a fallback drops what is still waiting after
`CATCH_UP_WAIT_MS` (3 s). While it waits it counts as pending (no Saved). The protocol fake models the cache
(`FakeRoom.snapshotCacheMs`).

## 2. The drag-recolour overwrite

**Root cause.** While A drags X, B's recolour arrives: it goes into `confirmed` but, by §2.5.4, not into
A's scene (the gesture holds X back). Every scan of the drag diffed A's scene copy (still the OLD colour)
against `base` (with B's colour), so `style` became dirty, and the pointer-up push carried `{pos, style}`:
the server stored A's old colour over B's, and every tab showed Saved. The unit test shows it exactly: A's
push groups `[["pos","style"]]` before the fix, `[["pos"]]` after.

**Fix.** `heldRemote`: for an element a gesture holds, the base its scene copy was built from (at the first
held server change) and the groups the server changed since (recorded from the server copies before and
after each `changes`, catch-up, snapshot and refused-op ack). Until the gesture ends such a group counts as
a local change only if the scene copy differs from that base in it (the user changed it too, e.g. B moves X
while A drags it: A's later drag still wins). At the gesture's end the rebuild takes the held groups from the
server's copy; undo's step then records only A's move (the `applied` event absorbs B's colour).

B2 U12 (new, real pointer drag through Chromium, 3 repetitions): B's colour held back during the drag
(`#1e1e1e` on A mid-drag), then `#e03131` everywhere and stored, A pushed `pos` only; A's undo moves X back
and keeps B's colour. Before the fix it failed at the first check (B's colour lost).

## 3. The offline-queue window

**Root cause.** `schedulePersist` wrote the queue 100 ms after a scan; before the scan there was also the
`onChange` lag. The IndexedDB write itself started only after `await dbp` (a later microtask) and
committed at the end of the task. A reload or a closed tab inside that window lost the change, while the
indicator already counted it ("Offline — N changes on this device": wave 2 lost offline-9).

**Fix.** The queue is written as soon as a change is known (in the scan's own call), outside a gesture;
during one at most once per 100 ms, and at its end at once. Identical writes are skipped (ids, versions,
groups). `persistNow()` scans the live scene and writes at once: the spike page calls it on `pagehide`, on
`visibilitychange` to hidden, and on unmount. The IDB store starts its transaction in the call once the
database is open and calls `commit()`; `save`/`clear` resolve when committed. A write never starts before the
previous page's queue is loaded (the old 100 ms delay hid this race: a write before the load replaced the
queue unread).

B4 D7 (new): an update and a create through the facade, then `location.reload()` in the SAME task (no
timer, no React commit in between), 3 repetitions each online and offline (the socket cut through the relay;
the reloaded page stays cut off and shows its queue from IndexedDB, then the socket is restored). Before the
fix: the offline row found nothing queued (0 changes). After: 6/6 rows kept both the move and the create,
locally and stored.

## 4. `message` events after the apply

`receive()` handles the message, then emits `{kind: 'message'}`, so `roster()`, `leaseHolders()`, `doc()`,
`confirmed()` and the scene hold its effect (the `applied`, `reject` and `refit` events it caused come first).
The spike page logs acks from `onAck` (called before the ack's apply and Saved), so D2's "Saved never before
its ack" keeps its reference. 2C's page can drop its microtask deferral. O3's B9 timeline reads B's `changes`
receipt from this event: it now includes the apply.

## 5. `LobbyHistory.mark()` / `mergeTop()` (2C's request)

`mark()` records the stack; `mergeTop(since?)` merges the top entry into the one below it: with a mark, only
when exactly one entry was recorded on top of the mark's top and the redo stack was empty at the mark;
without, whenever there are two entries and nothing to redo. A field in both keeps the earlier `before` and the
later `after` (a field back to its start is dropped), `groupIds` and `boundElements` are re-derived, pending
pushes of both stay pending (acks keep folding fixes), `lifeAt` resets. `UndoController.joinPrevious(write)`
wraps it (boundary, mark, write, merge) for `transact(label, fn, {joinPrevious: true})`; 2C's
`history-join.ts` can call it instead of editing `undoEntries`. The semantics are 2C's (`history-join.ts`),
now owned by the history.

## 6. CR-2D-2: installing prepared elements as given (the core API)

On `LobbyEngineCore` (`sync/core/engine.ts`), beyond the frozen `EngineCore` interface:

```ts
/** Checks a batch of prepared elements and returns the copies to install (installs nothing). */
prepareInsert(elements: readonly Readonly<Record<string, unknown>>[], above?: string | null): SceneElement[]
/** prepareInsert, installed through the core's scene and scanned at once; returns the ids in order. */
insert(elements: readonly Readonly<Record<string, unknown>>[]): string[]
```

On the port (`port-impl.ts`), the transaction is `LobbyCanvasTx extends CanvasTx` (C0's `CanvasTx` unchanged):

```ts
/** In `port.transact(label, (tx) => tx.insert(elements))`: one undo step with the transaction's other writes. */
insert(elements: readonly Readonly<Record<string, unknown>>[]): string[]
```

Rules (the doc comment on `prepareInsert` is the reference):
- every field is kept as given: nothing goes through the note or text tools, so `frameId`, colours, a
  label's size, ink and position stay (2D: `tx.create('note')` rebuilt them);
- `index` is not the caller's: the copies get fresh keys above the top of the scene (or above `above`: the
  port passes its transaction's last key) in the given order, so each label stays above its container; the
  server assigns the final keys (§2.4.3 step 11 keeps these unless they collide, e.g. with another tab's
  insert at the same moment, and puts labels after containers), and its `changes` copy and the ack's `fix`
  bring them back. Pushing `index: null` instead (the server places each at the top) was considered and not
  taken: the server gives nulls keys in op order with every label after every container, so the labels of a
  template's notes would all sit above all its notes;
- `version` / `versionNonce` kept when given (the server sets a create's version), else 1 and a fresh nonce;
- ids kept; the whole batch is refused (an `Error`, nothing installed) for a read-only session, a missing
  string `id` or `type`, a deleted element, an id twice in the batch, or an id the scene or the server already
  has, live or deleted (a template inserted twice must be re-id'd by the caller);
- once installed, the next scan (at once, through `syncScene`) finds them as local creates; each is pushed
  whole (`{k: 'c'}`) and validated by the server as any create (schema, invariants, caps, locks, leases); a
  refused one leaves the scene with "Change not saved", as any refused create;
- an offline-queued insert replays as ordinary creates (the queue format is unchanged).

2C's `LobbyTx.insert(elements: readonly WireElement[]): string[]` maps onto `tx.insert` of the port's
transaction it wraps. Tests: ids and fields kept, top keys in order, pushed whole, stored, seen by B; the
refusals; read-only; `above`; one undo step for B too (undo and redo); a create the schema refuses.

Other core additions of this part (also on `LobbyEngineCore` only): `syncScene(): boolean`, `persistNow(): void`,
the `saveStatus` getter's unscanned-write rule, `CATCH_UP_WAIT_MS` and the log events `catch_up_wait`,
`catch_up_settled`, `catch_up_gone`. The frozen `EngineCore` (`sync/types.ts`) and `OfflineQueueStore` are
unchanged.

## Checks: 3 runs

Tree: `spike/b-engine` at `319d532` (the fixes and tests; this file came after). Windows 11 workstation,
Node 24.19.0, Playwright 1.63.0, headless Chromium only, every stack with `DRAFTROOM_BACKUP_STORE=off`
(the harness sets it), ports 7870-7878 only, nothing left listening. NOT a quiet window: the three passes
ran side by side (bases 7870, 7873, 7876), with other owners' runs on the machine, so timing numbers are
informational. (A first start of passes 2 and 3 collided with a stopped wrapper's runner that kept going on
the same bases: its results are discarded; the table is the clean restart.) Command per pass: `SPIKE_B_PROBES=1 SPIKE_B_PORT_BASE=<base> docs/research/excalidraw/spike-b/scripts/o2-checks.sh <repo> <logs> b2-undo b3-l1-l5 b3-l7 b3-l9-l12 b3-l13-chords b3-l13-keys-k b3-l12-lease-l b3-l6-l10 b4-client b5-r3 b7-files b7-probe-lost-create b9-probe-lost-edit`
(default repetitions: 20 per L-case, 3 for B2 and B4). Logs in O2's scratchpad (`o2/run1`, `o2/q2`, `o2/q3`,
`o2/arrows1-3`, `o2/w2`), never committed.

| Check | Spec | Pass 1 (7870) | Pass 2 (7873) | Pass 3 (7876) |
|---|---|---|---|---|
| B2 U1-U12 | b2-undo | 12/12 | 12/12 | 12/12 |
| B2 U12 (new) | b2-undo | 3/3: held `#1e1e1e` mid-drag, stored `#e03131`, A pushed `pos` only | same | same |
| B3 L1-L5 | b3-l1-l5 | 5/5 (L1 p95 B 24, C 24 ms) | 5/5 (31/31 ms) | 5/5 (31/30 ms) |
| B3 L7 | b3-l7 | 3/3 | 3/3 | 3/3 |
| B3 L9, L11, L12 | b3-l9-l12 | 160/160, 20/20, 20/20 + 40/40 | same | same |
| B3 L13 | b3-l13-chords | 20/20 Windows, 20/20 macOS | same | same |
| B3 verifier K1-K5 | b3-l13-keys-k | 5/5 | 5/5 | 5/5 |
| B3 verifier L1-L4 | b3-l12-lease-l | 9/9 × 20 | 9/9 × 20 | 9/9 × 20 |
| B3 L6, L10 (20 repetitions) | b3-l6-l10 | 7/7, 580/580 rows (L6 1-2 40, 3a-3c 120, 4 40, 3d-3f 120; L10 1-2+4 60, 3-5 120, 6 80) | same, 580/580 | same, 580/580 |
| B4 D1, D1 fresh, D2, D5, D6 | b4-client | D1 3/3, fresh 5/5, D2 3 rounds 0 missing, D5 128 edits on 43 elements ("Offline — 43 changes on this device", old page pushed 0, each replayed once), D6 8/8 once | same (D5 128 edits) | same (D5 129 edits) |
| B4 D7 (new) | b4-client | 6/6 rows (3 online, 3 offline, queue 2 each) | 6/6 | 6/6 |
| B5 R3 | b5-r3 | 12/12 | 12/12 | 12/12 |
| B7 (all seven, the mood board included) | b7-files | 7/7; mood board 200 images, 0 lost creates | 7/7, 0 lost | 7/7, 0 lost |
| probe: lost create | b7-probe-lost-create | 0 of 400 lost (82 creates had a frame before the next) | 0 of 400 (78) | 0 of 400 (77) |
| probe: lost edit | b9-probe-lost-edit | 0/40 control, 0/40 at 50 Hz (writer 1,874 acked) | 0/40, 0/40 (1,934) | 0/40, 0/40 (1,895) |

**The b3-l6-l10 runs.** In the first attempt of the three passes the file did not finish: passes 1 and 2
reached `L10 3-5` after 1.0-1.1 h with every row so far passing (481 and 479 rows, 0 failed) and then the
Playwright TEST WORKER (Node, not a page and not a server) ran out of its 4 GB default heap
(`FATAL ERROR: Reached heap limit`); pass 3 failed one row of L6 1-2 (below). The worker's growth is not
O2's change: `L6 1-2` alone on base 7876 grew the worker ~120 MB/min at `319d532` and the same ~120 MB/min at
the pre-fix `92b1098`, back to back (O2's scratchpad `mem-new`, `mem-old`). The three `b3-l6-l10` runs above
were therefore rerun with `NODE_OPTIONS=--max-old-space-size=16384` (the heap of the run's Node
processes; the check itself unchanged), in parallel on 7870, 7876 and 7873: 7/7 and 580/580 rows each, L10 6 80/80 each (M3's acceptance
for L10 6: 20/20 in both orders and both modes).

**The one failed L6 row** (pass 3, first attempt, `L6 1-2` "resize", repetition 8 of 20): `stored route not
orthogonal: [[0,0],[320,330]]` for the elbow arrow E, with no op on any arrow from A, B or C during the row
(`aArrow 0, bArrow 0, cOps 0`), every browser equal to the snapshot and every bound end on its target. The
stored points are exactly the unrouted points A's setup creates E with (`[[0,0],[320,330]]`, before its
`routeElbow` step); the room's re-snaps (at the create and at every change of N) should have routed them, and
O1's test harness does route this geometry at creation (a scratch room test, not committed). Not diagnosed
further: the server's copy is gone with the run's stack. Not seen in the other 319 `L6 1-2` rows run in
this part (279 at `319d532`, 40 at the pre-fix `92b1098`). Reported to O1 (the server half of L6); not an engine push.

**Wave 2's specs that exposed the defects** (`e2e/excalidraw` on `engine/excalidraw` `5b9c87a` with
`spike/b-engine` `319d532` merged locally, never pushed; `collab-conflicts`, `sync-durability`,
`board-reload`; `E2E_PORT_BASE=7876`; the drag-recolour test's `test.fail` line removed in that scratch tree
only): 3 runs, 20/20 each. The drag-recolour test ("bob recolours while alice is still dragging; her undo moves
it back and keeps his colour") passes 3/3; the burst of 60 creates under a SIGKILL, the 10 offline edits and
reload, the reload/Saved tests pass 3/3; the two other `test.fail` cases (2E's undo defects, not in this
part) still fail as marked.

Unit: `pnpm test` 4,003 passed, 33 skipped (M3's gate: 3,975 / 33; the 28 new tests); lint, `pnpm -r
typecheck`, the engine-probe and Node-safety typechecks clean. On the merged scratch tree the canvas tests
pass 475/475 and the web typecheck is clean.

## For other owners

- **2C (the board page on `engine/excalidraw`):** its undo `install` should call `core.syncScene()` after its
  `updateScene` (as the spike page does) and the page should call `core.persistNow()` on `pagehide`, on
  `visibilitychange` to hidden and on unmount; the core-level check covers the loss either way, these make
  Saved and the queue exact at once. The `message` microtask deferral can go. `history-join.ts` can use
  `undo.joinPrevious()` or `history.mark()`/`mergeTop(mark)`. `LobbyTx.insert` can wrap `tx.insert`.
- **O3:** B9's timeline reads `changes` receipt from the core's `message` event, now emitted after the apply.
- **O1:** the one L6 1-2 row above (a stored elbow route left unrouted with no client op on the arrow).
  O2's OK for CR `b5689e0` (`PREPARING`, `CONVERSION_FAILED`): the core acts on `RESYNC` and
  `SLOW_DOWN` only and ignores other notice codes; the page's "Preparing this board…" state is still owed.
- **Lead:** the core API above is on `LobbyEngineCore`, not the frozen `EngineCore`; a CONTRACTS change-log
  line is the lead's call.

Not in this part (still open): the per-item "Offline — N changes" count (2C), 2E's two undo defects (undo
after typing into an empty note, redo of Ctrl+G in a long sequence), B11's one unexplained divergence, the
`CanvasPort.bounds` cost. A pointer edit still reaches the page's indicator at Excalidraw's `onChange` (one
React commit later); the core's `saveStatus` getter already reports it pending.
