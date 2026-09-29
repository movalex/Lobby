# B4 client half: D1, D2, D5, D6 ("Saved" exactly, SIGKILL, offline queue, tab adoption)

Owner O2 (the client half; D3 and D4 are O1's server half). Plan: `docs/EXCALIDRAW-MIGRATION.md` §8.3 B4, §2.5.6 (offline queue), §2.5.7 ("Saved" exactly). Spec: `e2e/spike-b/tests/b4-client-durability.spec.ts`. Code: `apps/web/src/canvas/sync/core/**` (`saved.ts`, the offline queue in `engine.ts`), `sync/adapter/offline-idb.ts` (IndexedDB per tab, Web Locks adoption), the board page's indicator (`canvas/spike/board/SpikeBoardPage.tsx`, `save-state`).

**Status: written; dry runs pass on O2's local integration. NOT the official evidence** (the lead's quiet-window runs are).

## How the checks measure

Headless Chromium processes A and B on a real stack (`DRAFTROOM_BACKUP_STORE=off`). "Saved" is read where the user reads it: a MutationObserver on the indicator's `data-state` records every transition with its time. Push send times come from the engine's push log (`pushedOps`), ack and welcome times from the session's event log (`window.__lobbyBoard.session.eventLog`). A transition to "saved" is **too early** if a push sent before it has no ack before it; a push that was in flight when the socket died is never acked, but after the reconnect's welcome its content goes out again in a new push (the core turns what was in flight back into dirty groups), so a welcome after it settles it.

| Check | Pass |
|---|---|
| D1 | A creates a rectangle, moves it 5 times, recolours it, waits for "Saved", reloads: the content is kept (A's map and the snapshot); no transition to "saved" before the ack of every push sent before it; the last "saved" after the last ack |
| D2 | A and B each create a rectangle every 200 ms (5 edits/s); sync is SIGKILLed 1–4 s into the round (random) and restarted 3 s later; 3 s more of edits; 3 rounds. Every edit covered by a displayed "Saved" (a "saved" transition after it) is in the snapshot and in both maps (0 missing; also 0 missing of all edits); no transition to "saved" between the process's death and the restart; no "saved" too early; each page ends "saved" |
| D5 | A's board socket is cut (the relay, §8.6.2) and A edits for 60 s (a create or a move every ~450 ms); the indicator says "Offline — N changes"; the socket is restored with the old page's reconnect held until it unloads (`restoreSocket({release: false})`), and A reloads. The old page pushed nothing after the cut; the reloaded page restores the queue from IndexedDB and replays it once (each edited element in exactly one push); B sees every element; the snapshot has them |
| D6 | tab 1 (a second tab of A, through the relay) edits for 10 s with its socket cut and is closed; tab 2 opens the board: it adopts tab 1's queue (its Web Lock is gone) and replays it once; A's first tab (open throughout) never replays it; B and the snapshot have every element |

## Runs (dry runs, local integration)

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
