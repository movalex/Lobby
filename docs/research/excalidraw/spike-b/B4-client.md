# B4 client half: D1, D2, D5, D6 ("Saved" exactly, SIGKILL, offline queue, tab adoption)

Owner O2 (the client half; D3 and D4 are O1's server half). Plan: `docs/EXCALIDRAW-MIGRATION.md` §8.3 B4, §2.5.6 (offline queue), §2.5.7 ("Saved" exactly). Spec: `e2e/spike-b/tests/b4-client-durability.spec.ts`. Code: `apps/web/src/canvas/sync/core/**` (`saved.ts`, the offline queue in `engine.ts`), `sync/adapter/offline-idb.ts` (IndexedDB per tab, Web Locks adoption), the board page's indicator (`canvas/spike/board/SpikeBoardPage.tsx`, `save-state`).

**Status (spike B part 2): the M1/M2 integration's D1 stall is explained and fixed (`18254dd`); owner's
3-run pass on `spike/b-engine` after merging the integrated branch: see "Owner's 3-run pass" below.** D1–D6 are
not timing-gated (§8.6.4); the lead's final pass still reruns them on the merged tree.

## The D1 stall of the M1/M2 first run: cause, trace, fix

**What the lead saw** (`scratchpad/int/checks1/b4-client-durability.log`, `2a1944e`): D1's first iteration
stayed "Saving…" 30 s in `converge()` right after A's reload (`b4-client-durability.spec.ts:160`); the rerun
passed 4/4; the run's trace was lost (the browser was not named, the output folder was overwritten).

**Reproduced.** A probe repeated D1's first iteration in fresh rooms (a new board and two new browser
processes each time, one stack, base 7875; the probe is now the spec's "D1 (fresh rooms…)" test):

| Probe (at `76c937f` + the L10 fix, the old D1 code) | Rooms | Stalled |
|---|---|---|
| D1's own timing (ack in ~10–60 ms, `waitSaved` polling) | 25 | 0 |
| A's ack slowed through its socket relay (400 ms, as on a loaded machine), reload the moment the indicator says Saved (polled every 5 ms) | 6 | **6** |

The trace of every stalled room (`waitSaved` now reports the core's bookkeeping on a timeout; ids, groups,
seqs and clocks only):

```
A save {pending: 1, state: "saving", lastReject: {id: <rect>, code: "INVALID"}}   (for ever)
A coreLog  1 offline_adopted {entries: 1}                 (the reloaded page loaded 1 queued entry)
A events   1 welcome <A's sid> 0                           (a RESET welcome at clock 0 ...)
           2 ack 1 1 / 3 reject <rect> INVALID            (... A pushed a create, the room refused it)
A tracked  [{id: <rect>, dirty: [], isNew: true}]          (the core still counts it as an unsent create)
A pushes   [{seq: 1, base: 0, ops: [{k: "c", id: <rect>}]}];  A clock 1 (the catch-up came after the snapshot)
B save     saved, nothing tracked
```

**Cause** (three conditions, all true only in a fresh room's first iteration on a loaded machine):
1. The offline queue (IndexedDB) was written 100 ms after a scan and never on an ack. With a slow ack the
   write at +100 ms held the create in flight; the clearing write came only with the next scan after the
   ack. A reload right after "Saved" found the create still queued.
2. The room caches its reset snapshot for 5 s (O1's `snapshotFor`, `SNAPSHOT_CACHE_MS`) and sends the rows
   written since as a catch-up `changes` after it. In a fresh room the cached snapshot (made at the joins)
   predates A's create, so the reloaded page's snapshot did not have the rectangle.
3. The reloaded page adopted the queued create, did not find it in the snapshot, and pushed it. The room
   refused it `INVALID` (the id exists, `merge.ts` `applyCreate`), and the core then kept the element as
   `isNew` with nothing dirty, so pending stayed 1, "Saving…" for ever, the `INVALID` hidden behind it.

The same stale queue entry is also a content risk: had the snapshot been fresh, a queued entry older than
A's later commits would have been replayed over them (an older `x`). The prompt write below closes the
window in practice; see "Open" at the end.

**Fix** (`18254dd`, `apps/web/src/canvas/sync/core/engine.ts`):
- the queue is written on the tick after every ack (`schedulePersist(true)`), not on the next scan's tick;
- a create refused `INVALID` with a live stored element is this client's own create landing twice (element
  ids are random): the stored copy becomes the element, nothing is shown as refused (`create_exists`);
- a tracked create whose element arrives in `changes` with no create of ours in flight is settled
  (`create_settled`), so a stale snapshot plus catch-up cannot leave it "new";
- any other refused create goes back to the server's copy (it stayed "new" before);
- queue entries loaded before a welcome are adopted in `afterWelcome`, once the server's copies are known
  (adopted earlier, the next scan dropped the copy from the scene and a genuinely offline create was never
  pushed).

**Tests.** Core (`core/engine.test.ts`, each fails before the fix and passes after): "B4 D1: a queued create
the server already has (behind a reset snapshot older than it) settles: no refusal, Saved" and "B4 D1: after
the last ack the offline queue is emptied on the next tick, not 100 ms later". Browser: the spec's new test
"D1 (fresh rooms, a slow ack, the reload at once)" (5 fresh rooms, `SPIKE_B4_D1_FRESH_REPS`): **3/3 rooms
stalled on the old engine** (`engine.ts` of `76c937f`, the spec and the rest as committed in `18254dd`), exactly the trace
above; **5/5 pass** with the fix, and the probe 10/10.

## How the checks measure

Headless Chromium processes A and B on a real stack (`DRAFTROOM_BACKUP_STORE=off`). "Saved" is read where the user reads it: a MutationObserver on the indicator's `data-state` records every transition with its time. Push send times come from the engine's push log (`pushedOps`), ack and welcome times from the session's event log (`window.__lobbyBoard.session.eventLog`). A transition to "saved" is **too early** if a push sent before it has no ack before it; a push that was in flight when the socket died is never acked, but after the reconnect's welcome its content goes out again in a new push (the core turns what was in flight back into dirty groups), so a welcome after it settles it.

| Check | Pass |
|---|---|
| D1 | A creates a rectangle, moves it 5 times, recolours it, waits for "Saved", reloads: the content is kept (A's map and the snapshot); no transition to "saved" before the ack of every push sent before it; the last "saved" after the last ack |
| D1 (fresh rooms) | (part 2) the same edits in a fresh room (new board and browsers, so the room's cached reset snapshot predates them), A's ack slowed 400 ms through its relay, the reload the moment the indicator says Saved: the content is kept (A's map and the snapshot), both browsers Saved after the reload, no refusal shown, no "saved" before the last ack |
| D2 | A and B each create a rectangle every 200 ms (5 edits/s); sync is SIGKILLed 1–4 s into the round (random) and restarted 3 s later; 3 s more of edits; 3 rounds. Every edit covered by a displayed "Saved" (a "saved" transition after it) is in the snapshot and in both maps (0 missing; also 0 missing of all edits); no transition to "saved" between the process's death and the restart; no "saved" too early; each page ends "saved" |
| D5 | A's board socket is cut (the relay, §8.6.2) and A edits for 60 s (a create or a move every ~450 ms); the indicator says "Offline — N changes"; the socket is restored with the old page's reconnect held until it unloads (`restoreSocket({release: false})`), and A reloads. The old page pushed nothing after the cut; the reloaded page restores the queue from IndexedDB and replays it once (each edited element in exactly one push); B sees every element; the snapshot has them |
| D6 | tab 1 (a second tab of A, through the relay) edits for 10 s with its socket cut and is closed; tab 2 opens the board: it adopts tab 1's queue (its Web Lock is gone) and replays it once; A's first tab (open throughout) never replays it; B and the snapshot have every element |

## Owner's 3-run pass (part 2)

Branch `spike/b-engine` at **`396ebac`** (the fixes `18254dd` plus the runner; `origin/spike/excalidraw` `76c937f`
merged in). Command, 3 times in a row, each run a fresh build:
`SPIKE_B_PORT_BASE=7870 docs/research/excalidraw/spike-b/scripts/o2-checks.sh <repo> <logs> … b4-client …`
(the spec: `pnpm exec playwright test -c spike-b/playwright.config.ts b4-client` from `e2e/`), ports
7870–7872, default repetitions (D1 3, D1 fresh rooms 5, D5 60 s, D2 3 rounds), 2026-09-29: run 1 ~16:05Z,
run 2 ~16:23Z, run 3 ~16:40Z, each 5/5 tests passed (2.2 min). Not a quiet window (shared machine; D1–D6
are not timing-gated). Nothing listened in 7870–7872 before or after; no process left.

| Check | Run 1 | Run 2 | Run 3 | Status |
|---|---|---|---|---|
| D1 | 3/3: kept; 0 "saved" before an ack; last "saved" 2, 2, 2 ms after the last ack; 1 push each | 3/3 (1, 1, 1 ms) | 3/3 (1, 1, 2 ms) | **PASS 3/3** |
| D1 (fresh rooms, slow ack, reload at once) | 5/5: kept, 0 refusals, Saved in both browsers | 5/5 | 5/5 | **PASS 3/3** |
| D2 | 3 rounds: kills 1.26 / 2.25 / 1.70 s in, down 3.5 s; A 39 + 44 + 41, B 38 + 43 + 41 edits, all covered by "Saved", **0 missing**, 0 "saved" while down (indicator "offline"), 0 too early | kills 2.11 / 3.17 / 2.95 s; A 43 + 48 + 47, B 43 + 48 + 47; 0 missing, 0 while down, 0 early | kills 2.83 / 3.08 / 2.66 s; A 46 + 48 + 45, B 46 + 47 + 45; 0 missing, 0 while down, 0 early | **PASS 3/3** |
| D5 (60 s offline) | 128 edits on 43 elements; "Offline — 43 changes"; old page pushed 0 after the cut; each element replayed in exactly 1 push after the reload; B and the snapshot have all 43 | same numbers | same numbers | **PASS 3/3** |
| D6 | tab 1 queued 8; tab 2 replayed each once; A's first tab 0; all 8 stored | same | same | **PASS 3/3** |

## Part 1 dry runs (local integration, before the merge)

Local integration = worktree `Draftroom-sb-engine-int`, branch `o2-local-int` (never pushed) at `ce60cae` (`spike/b-engine` `ed73715` + `spike/b-room` `ed1e2a0` + `spike/b-harness` `8a0db6e` + `spike/b-features` `0f140cd`). Command: `SPIKE_B_PORT_BASE=7875 SPIKE_B4_D5_MS=60000 docs/research/excalidraw/spike-b/scripts/o2-checks.sh <int> <logs> b4-client` (the spec: `pnpm exec playwright test -c spike-b/playwright.config.ts b4-client` from `e2e/`), ports 7875–7877, 2026-09-29, one run. **4/4 passed** (1.9 min).

| Check | Result |
|---|---|
| D1 (3 repetitions) | **3/3**: content kept after the reload (A's map and the snapshot); indicator `saving → saved`; 0 transitions to "saved" before an ack; the last "saved" 1 ms after the last ack (A's 7 edits went out as one push: they fell in one 50 ms coalescing window) |
| D2 (3 rounds) | **3/3**: kills at 2.1 s, 2.4 s, 2.0 s into the round (SIGKILL took 9–10 ms), sync back 3.4–3.5 s later; A 43 + 44 + 42 edits, B 43 + 44 + 42: **0 missing** (covered by "Saved": all of them); **0 transitions to "saved" while down** (the indicator showed "offline"); 0 too early; both pages end "saved"; the pushes in flight at the kill were replayed after the welcome |
| D5 (60 s offline) | **pass**: 128 edits on 43 elements; the indicator said "Offline — 43 changes on this device"; the old page pushed **0** after the cut; after the reload each of the 43 elements went out in exactly one push; B and the snapshot have all 43 |
| D6 | **pass**: tab 1 queued 8 elements offline and closed; tab 2 replayed each exactly once; A's first tab replayed none; B and the snapshot have all 8 |

Earlier dry runs (same day, fewer repetitions) passed D1, D5 (10 s) and D6; D2 first "failed" on the spec's own measure: a push in flight when sync died never gets an ack, which the first version of the check counted as a "saved" too early forever after. The check now counts a welcome after such a push as settling it (its content is re-sent), and measures "saved while down" from the process's death (`killSync` returned), not from the kill call (an ack that left the process before it died is a real ack).

## Deviations

- D5 counts the old page's pushes from its own push log (0 after the cut); the relay's record of frames on held sockets (O3's `relayStats`) is not read, to keep the spec on the frozen harness contract.
- D6 uses O3's `newTab()` (a second tab with the relay attached), which is beyond the frozen `BrowserProcess` type; the spec calls it at runtime and fails clearly without it.
- D2's kill moment is `Math.random()` within 1–4 s; the rounds are not seeded.

## Open (for wave 3; not blocking the spike's checks)

- **A queued entry is not idempotent against this tab's own later commits.** The offline queue stores the
  element copy and its groups; a push that committed while its ack was lost (or before the queue was
  rewritten) is replayed from that older copy after a reload, and the room accepts it (its STALE rule only
  looks at other users' writes after the base). Part 2 narrows the window to the IndexedDB write after an
  ack (a few ms) and settles a replayed create, but a replayed patch older than a later commit of the same
  tab would still overwrite it. A per-entry key the room can deduplicate (a push id), or the confirmed
  version each entry was built on, would close it; both change the frozen protocol or the queue format, so
  they are a change request for wave 3, not a spike fix.
- The room's 5 s snapshot cache is correct by protocol (the catch-up `changes` follows the reset), but it
  means a reset welcome can be older than the joiner's own last commit; every client path that reasons
  about "the server has it" must wait for the catch-up (the core now does for creates).
