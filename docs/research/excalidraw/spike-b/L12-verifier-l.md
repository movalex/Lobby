# L12 verifier (L1–L4): the lease and editor-open defects carried from spike A

Owner O2. Items: `docs/research/excalidraw/spike-b/OPEN-FROM-SPIKE-A.md` §"Lease and editor-open verifier" (L1 high, L2 high, L3 low, L4 low). Fix: commit `7ea91e2` on `spike/b-engine` (`apps/web/src/canvas/lease/editorLease.ts`, `lease/openRule.ts`).

**Status: fixed; every regression test failed before the fix and passes after it. Spike B part 2: owner's 3-run pass of `b3-l12-lease-l` on O2's branch after the merge: PASS 3/3** (below).

## Owner's 3-run pass (part 2)

Branch `spike/b-engine` at **`396ebac`** (O2's part 2 fixes `18254dd` plus the runner; `origin/spike/excalidraw`
`76c937f` merged in). Command, 3 times in a row (each spec invocation builds the web app afresh; its
Playwright output kept in `<logs>/<spec>.results`):
`SPIKE_B_PORT_BASE=7870 docs/research/excalidraw/spike-b/scripts/o2-checks.sh <repo> <logs> b2-undo b3-l1-l5 b3-l7 b3-l9-l12 b3-l13-chords b3-l13-keys-k b3-l12-lease-l b4-client b5-r3`,
ports 7870–7872, default repetitions, 2026-09-29: run 1 15:50–16:08Z, run 2 16:08–16:26Z, run 3
16:26–16:43Z. Headless Chromium, `DRAFTROOM_BACKUP_STORE=off`. Not a quiet window (a shared machine; this
check is not timing-gated). Nothing listened in 7870–7872 before or after; no process left.

| Run | Result (`b3-l12-lease-l`, 9 cases × 20) |
|---|---|
| 1 | **9/9 cases, each 20/20** (L1 deny, Escape, click away, blur; L2 P5, double-click label; L3; L4 click away, blur; 2.0 min) |
| 2 | **9/9 × 20/20** (1.9 min) |
| 3 | **9/9 × 20/20** (1.9 min) |

## What changed

| Item | Defect (short) | Fix |
|---|---|---|
| L1 | A guard editor (P5, a double-click on a note's words) that closes before its grant wrote back the textarea's stale copy and undid the holder's typing | `mustNotSubmit` is true for any textarea that is not writable under a held lease: a read-only guard editor never submits, whatever the way out (deny, Escape, click away, blur) |
| L2 | On the grant, the guard's stale copy became writable and overwrote the previous holder's last edits | `finishOpen` refreshes the textarea from the label on the grant (`refreshOnGrant`), then dispatches an `input` event so Excalidraw re-measures it before the first key (the refreshed textarea was mis-sized without it; found by the L2 p5 case, see below) |
| L3 | A deny on a New-element open submitted the value the editor opened with, emptying (deleting) a label the holder had written | `denyNew` closes without a submit when the label is someone else's (`denyNewClose`); the engine resets the text from the server copy; what was typed is offered |
| L4 | Keys typed into a pending guard editor were dropped with no notice on a click away or blur, and on `giveUp` | `leaveWithoutSubmit` raises a `left-pending` notice with the typed text; `giveUp` raises `open-failed` with it |

## Regression tests

- Unit: `apps/web/src/canvas/lease/openRule-verifier.test.ts` (the pure open rule: `bufferText`, `refreshOnGrant`, `denyNewClose` per L1–L4 case).
- Browser: `e2e/spike-b/tests/b3-l12-lease-l.spec.ts` on spike A's `/spike/host-lab` (no api or sync): the verifier's repros, 9 cases (L1 × deny/escape/click-away/blur, L2 × p5/dblclick-label, L3, L4 × click-away/blur).

## Runs

| Run | Code | Command | Ports | Result |
|---|---|---|---|---|
| before | B0 = `93e3c3e` (worktree `Draftroom-sb-engine-pre`) | `SPIKE_B_PORT_BASE=7875 SPIKE_REPS=3 pnpm --filter @draftroom/e2e spike-b b3-l12-lease-l` | 7875–7877 | **9/9 cases fail, 0/3 each** (log `before-L-K.log`: e.g. L1 deny writes `["memo by alice","memo"]`, L2 stores `memo!`, L3 deletes the label, L4 0 notices) |
| after 1 | `7ea91e2` less the L2 re-measure | `SPIKE_B_PORT_BASE=7870 SPIKE_REPS=20 … b3-l12-lease-l` | 7870–7872 | 8/9 cases 20/20; **L2 p5 0/20** (the refreshed textarea kept its old width, so the first key landed mid-word: `memo !by alice`) |
| after 2 | `7ea91e2` | the same, L2 cases | 7870–7872 | L2 p5 **20/20**, L2 dblclick-label **20/20** |

Spike A's host specs stayed green: `SPIKE_WEB_PORT=7870 pnpm --filter @draftroom/e2e spike host-` → **84 passed** (18.7 min) after the fix; re-run after the later keymap change (see L13-verifier-k.md).

## Deviations

- Host-lab's fake lease server stands in for O1's room here (as in the verifier's repros). The same guard paths run on the real board in B3 L9 and L12 (`b3-l9-l12-guard.spec.ts`, B3.md).
- 20 repetitions per case, one run, outside the quiet window.
