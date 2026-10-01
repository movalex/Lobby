# L13 verifier (K1–K5): the key and layout defects carried from spike A

Owner O2. Items: `docs/research/excalidraw/spike-b/OPEN-FROM-SPIKE-A.md` §"Keys and keyboard-layout verifier" (K1 medium, K2–K5 low). Fix: commit `7ea91e2` on `spike/b-engine` (`apps/web/src/canvas/input/keymap.ts`, `input/keyupGate.ts` new, `input/CanvasInput.ts`).

**Status: fixed; every regression test failed before the fix and passes after it. Spike B part 2: owner's 3-run pass of `b3-l13-keys-k` on O2's branch after the merge: PASS 3/3** (below).

## Owner's 3-run pass (part 2)

Branch `spike/b-engine` at **`396ebac`** (O2's part 2 fixes `18254dd` plus the runner; `origin/spike/excalidraw`
`76c937f` merged in). Command, 3 times in a row (each spec invocation builds the web app afresh; its
Playwright output kept in `<logs>/<spec>.results`):
`SPIKE_B_PORT_BASE=7870 docs/research/excalidraw/spike-b/scripts/o2-checks.sh <repo> <logs> b2-undo b3-l1-l5 b3-l7 b3-l9-l12 b3-l13-chords b3-l13-keys-k b3-l12-lease-l b4-client b5-r3`,
ports 7870–7872, default repetitions, 2026-09-29: run 1 15:50–16:08Z, run 2 16:08–16:26Z, run 3
16:26–16:43Z. Headless Chromium, `DRAFTROOM_BACKUP_STORE=off`. Not a quiet window (a shared machine; this
check is not timing-gated). Nothing listened in 7870–7872 before or after; no process left.

| Run | Result (`b3-l13-keys-k`) |
|---|---|
| 1 | **5/5 tests**: K1 9/9 rows, K2 3/3, K3 3/3, K4 3/3, K5 9/9 (15.6 s) |
| 2 | **5/5**, the same rows (14.2 s) |
| 3 | **5/5**, the same rows (14.2 s) |

## What changed

| Item | Defect (short) | Fix |
|---|---|---|
| K1 | Keyups typed outside the board (another input, the body) reached Excalidraw's document keyup listener, which re-binds selected arrows on an arrow keyup | A document bubble keyup gate (`keyupGate.ts`), installed when `CanvasInput` loads, before Excalidraw's listener: default-deny, except keys whose keydown CanvasInput delegated (keyed by `keyIdOf`, cleared on window blur) |
| K2 | Ctrl+Insert as NumLock-off Numpad0 (code `Numpad0`) in the granted editor reset the zoom | `classifyTextEditorKey`: a kept chord whose event the textarea's own handler would misread (`textareaKeyAction`, a transcription of X 25367-25409) goes to the browser, not to the handler |
| K3 | BÉPO/KOY Ctrl+Z (code `BracketLeft`) in the editor outdented | the same rule (outdent is `code === BracketLeft`) |
| K4 | A named key on a letter code (Neo layer 4: Enter on `KeyV`) was read as a letter chord and submitted the editor | `chordLetter` falls back to `code` only for a single-letter `key` (`\p{L}`) |
| K5 | Rules decided by `key` alone while Excalidraw tests `code` (copyAsPng, flip, zoom, font size) | outside the editor a plain key is delegated only when Excalidraw's code-based keyTests (`engineKeyActions`) could run nothing but the intended action; bare modifier keys likewise; in the editor, the `textareaKeyAction` rule |

## Regression tests

- Unit: `apps/web/src/canvas/input/keymap-verifier.test.ts` (K2–K5 with crafted events, and an independent transcription of the textarea handler compared on every crafted event), `input/keyupGate.test.ts` (K1).
- Browser: `e2e/spike-b/tests/b3-l13-keys-k.spec.ts` on `/spike/host-lab`, CDP `Input.dispatchKeyEvent` as the verifier did.

## Runs

| Run | Code | Command | Ports | Result |
|---|---|---|---|---|
| before | B0 = `93e3c3e` | `SPIKE_B_PORT_BASE=7875 SPIKE_REPS=3 pnpm --filter @draftroom/e2e spike-b b3-l13-keys-k` | 7875–7877 | **all 5 fail**: K1 0/9 (arrow a1 version 4 → 10; Space keyup cleared the selection), K2 0/3 (zoom 1.7 → 1), K3 0/3 (`    Note oneX` → `Note oneX`), K4 0/3 (editor submitted), K5 0/9 (clipboard write, flip, font size 20 → 18) |
| after | `7ea91e2` | `SPIKE_B_PORT_BASE=7870 SPIKE_REPS=20 … b3-l13-keys-k` | 7870–7872 | K1 **60/60**, K2 **20/20**, K3 **20/20**, K4 **20/20**, K5 **60/60** |

Spike A's A6/A16 host specs stayed green after the fix (`host-` 84 passed). A later keymap change (commit `c48e35c`: editors' Ctrl/Cmd+C and V go to the browser so copy/paste events fire, B5-R3.md) was re-checked against the same specs; see B5-R3.md for that run.

## Deviations

- Emulated, as the verifier's were: no BÉPO, KOY or Neo layout and no NumLock-off numpad was physically used.
- K5 pairs are reachable only with synthetic events or unusual remaps (the verifier found no real layout producing them).
