# Spike A report: engine checks A1-A17 (integrated)

**Result: 14 PASS, 2 PARTIAL (A12, A14), 1 FAIL as written (A16).** Every result below was measured again on
the merged branch, 3 runs in a row. Each check passes or fails as it did on its owner branch, and the numbers
agree except where noted: A13 is +1.0 KiB, and A14 has a wider spread in how soon visible images appear.

- **Two security claims of the first version of this report were wrong (section 0).** An independent
  verification found that Ctrl+Alt+S and Cmd+Alt+S inside the text editor still opened the board save
  picker (A6, open item 1 was not closed), and that an editor Excalidraw opened on another note while a
  Lobby lease request was pending was writable without any lease (A16). Both are fixed in `f17ce48`, with
  regression specs that fail on the old code and pass 3 of 3 runs on the new. A6 is PASS after the fix.
- **A16 fails on the plan's wording (3 points, section 3.4).** After the fix, every editor-open path is held
  by the lease or the guard, including a second editor while a request is pending: 20/20 per case in every
  run, no key or text lands and nothing is pushed before a grant. The corrected criteria pass 3/3.
- **A12 is PARTIAL** because one CSP fix is Lobby app code that was emulated, not committed; the whole-dist
  grep cannot pass while tldraw is in the build; and the Clerk origins are unverified.
- **A14 is PARTIAL** because the laptop half was not run. On the workstation, both engines are below 24 fps
  at fit, so the §8.5 fit conditional (the level-of-detail pass) applies.
- **Stop and re-plan (§8.5): none of spike A's results hits that condition.** Convergence, durability,
  capacity and the real lease server belong to spike B.

| | |
|---|---|
| Branch | `spike/excalidraw`: scaffold `b9252d9` + merges of `spike/a-node` 4581fd8 (576df0f), `spike/a-host` 11a5d6d (c733cd2), `spike/a-render` 1a489c2 (7eccb51). The runs below are at 7eccb51 plus this report and the two integration scripts; the corrections of section 0 were run at `f17ce48`. |
| Engine | `@excalidraw/excalidraw`, `element`, `common`, `math`, `fractional-indexing` 0.18.0-1118751 (pinned by the catalog) |
| Machine | Windows 11 workstation (Threadripper 9970X, RTX 5090), Node 24, pnpm 10.34.5, Vite 8.3.1 (rolldown), Playwright 1.63.0, headless Chromium shell 153.0.8010.12 |
| Date | 2026-09-28 / 29 (UTC) |

Per-check evidence is in `docs/research/excalidraw/spike-a/<id>.md`, written by the owners on their branches.
This report adds the merged-branch runs. Where a merged number differs from the owner's file, the table
says so.

## 0. Corrections after the independent verification (2026-09-29)

An independent verifier re-ran the suite (it reproduced 50 passed / 2 skipped, 1,389 unit tests, A3, A8
and the builds) and then tried to break A6, A16 and A17. Two of this report's security conclusions were
wrong. They are corrected here, plainly:

1. **Wrong: "Ctrl/Cmd+S inside the text editor ... Lobby's capture listener closes this (A6)"** (section
   3.1 item 1 of the first version), and with it "open item 1 is closed". Lobby blocked only Ctrl/Cmd+S
   and Ctrl/Cmd+Shift+S inside a granted editor, and its test required no Alt; Excalidraw's save key test
   ignores Alt (X 11606, used at 25388). **Ctrl+Alt+S inside a granted editor called `showSaveFilePicker`
   and closed the editor, 20 of 20** (Cmd+Alt+S the same under macOS emulation). The same rule let the
   textarea's other actions through: canvas zoom (Ctrl/Cmd+= / - / 0), the label's font size
   (Ctrl/Cmd+Shift+< / >), submit (Ctrl/Cmd+Enter), indent (Ctrl/Cmd+[ ]) and the Ctrl/Cmd+P toast. The A6
   criterion as written passed only because it named three chords.
2. **Wrong: "A16 fails on the plan's wording, not on the security property. Every editor-open path is
   held by the lease or the guard"** (also in the table and in A16.md). The guard ran only when Lobby had
   no session. **While Lobby's request for note A was pending, a double-click (or P5) on note B's label
   opened B's editor writable, with no acquire for B, 20 of 20**; text sent with no keydown (`insertText`,
   as an IME commit or dictation sends it) was written into B's label; afterwards Lobby's session and
   Excalidraw's `editingTextElement` disagreed, and A's lease was released before A's text was written. No
   spec had opened a second editor while a request was pending.
3. Minor: the engine-flag build **without** the dev-auth guard still emitted `dist/excalidraw-assets` (233
   font files, 14 MB): the assets plugin checked only `VITE_LOBBY_ENGINE`, and the integration script's
   no-guard check grepped `assets/` only, so section 2's "0 marker files" missed it. No engine code or
   route shipped. The A16 cold-open test's title claimed the label was "measured before Nunito loaded";
   its own log showed `document.fonts.check` true, so that cause was never shown.

Neither defect is an engine path Lobby cannot hold, so §8.5's "stop and re-plan" condition is not hit.
Both were guard bugs in Lobby's own code.

**The fixes (`f17ce48`):**
- **A6.** Inside a granted text editor the keys are an allowlist (`keymap.ts`, `classifyTextEditorKey`).
  Kept: every key without Ctrl, Cmd or Alt (typing, Enter, Shift+Enter, Tab/Shift+Tab indent, Escape,
  caret keys, Backspace, Delete); caret moves with Shift/Ctrl/Cmd (with Alt only on macOS, where it moves
  by word; elsewhere Alt+Left is Back); Ctrl/Cmd/Alt+Backspace/Delete; Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z,
  Ctrl+Y (native undo); Ctrl/Cmd+A; Ctrl/Cmd+C, X, V, Shift+V (clipboard events, where the export policy
  applies). AltGr and macOS Option characters are typed by the browser with their keydown stopped. Every
  other chord with Ctrl, Cmd or Alt is stopped in the capture phase and prevented, whatever the other
  modifiers. A6.md enumerates every branch of the textarea's handler and the decision for each; a unit
  test mirrors the handler and checks that no delegated key triggers one of its actions except Escape and
  Tab.
- **A16.** Any editor Excalidraw has open that is not the editor of a granted Lobby lease is unrequested,
  whatever the session's phase (`lease/openRule.ts`, pure and unit-tested; `lease/editorLease.ts`). Its
  textarea is read-only from the task it appeared in (a MutationObserver); `beforeinput`, `paste` and
  `drop` into it are prevented; it is then closed unchanged when another request or editor is in flight,
  or re-queued as its own lease request when Lobby is idle (the plan's P5 guard). Lobby's session follows
  `editingTextElement`, and a lease is released only after its editor is gone (its text written). While
  fixing, the regression spec found one more engine detail: Excalidraw's submit removes the textarea
  before it clears `editingTextElement` (X 25487/25543, then 49870-49900), so for a moment it names an
  element with no textarea; the rule waits then.
- **Minor.** The assets plugin follows the engine route's gate (`VITE_LOBBY_ENGINE=excalidraw` and the
  dev-auth guard; unit test `build/excalidraw-assets.test.ts`); the integration script greps the whole
  no-guard dist and fails on an `excalidraw-assets/` folder. The cold-open test states only what it shows.

**Regression specs that would have caught both** (they fail on `5203e41` and pass on `f17ce48`):
- `host-a6-editor.spec.ts`: every letter, digit and punctuation key with every Ctrl/Meta/Alt(/Shift)
  combination that includes Ctrl, Meta or Alt (658 presses) inside a granted editor, on Windows and under
  macOS emulation, plus the kept keys still working. On `5203e41`: 637 of 658 presses flagged on each
  platform (non-kept chords reached the textarea's handler), 2 save-picker calls each, zoom on 8 presses,
  the label's font size on 8, the Ctrl/Cmd+P toast.
- `host-a16-pending.spec.ts`: pending A plus a double-click on B's label, P5 on B, or type-to-edit on B,
  each with a timed grant, a manual grant, a deny and Escape (12 x 20 cases); text without a keydown
  (insertText, IME composition, keyCode 229, paste, drop) into a guarded editor; a live control of those
  channels; A granted, then a double-click on B. host-lab's new monitor checks, independently of Lobby's
  own state, that no textarea is ever writable or receives input without a held lease, that Lobby and
  Excalidraw agree after every change, and that each release follows the label's final text write. On
  `5203e41` (3 repetitions per case): every double-click and P5 case fails, 0/3 each (B's editor
  writable, `IME` written into B's label, no acquire for B, disagreement after every step); the
  type-to-edit cases pass on both codes (the key goes to A's pending buffer, as planned).

**Runs at `f17ce48`** (`scripts/fix-run.sh`, port 7770, fresh build per run):

| Gate | Result |
|---|---|
| `pnpm lint` (Biome, 1,124 files) | PASS |
| `pnpm -r typecheck` (14 packages) + `tsc -p apps/web/test/engine-probe` | PASS |
| vitest `web` + `engine-probe` (includes `keymap.test.ts` and the new `openRule.test.ts`) | 1,396/1,396 |
| Plugin node tests (host rewrite 8, assets gate 1) | 9/9 |
| `VITE_LOBBY_ENGINE=excalidraw` without dev auth, the WHOLE dist: marker files / `excalidraw-assets/` | 0 / absent (95 files; the old plugin emitted 233 font files, 14 MB) |
| Old + new A6 and A16 specs, 3 runs back to back (42 tests each, fresh build) | 42/42, 42/42, 42/42 (653, 652, 654 s) |
| Whole spike suite once (fresh build) | 69 passed, 2 skipped (the opt-in A14 specs), 12.8 min |

In each of the 3 runs, with identical numbers: the A6 sweep 0 of 658 presses acted on Windows and 0 of 658
under macOS emulation (0 picker calls; the 15 kept chords reached the textarea, none of the other 643);
the kept keys 16/16; the pending-lease regression 12 x 20/20; text without a keydown into a guarded
editor 20/20; A granted then B 20/20; the first version's A6 (140 presses, 0 acted; control 89 acted) and
A16 (every path 20/20, deny 40/40) unchanged. The per-check files give the details: A6.md and A16.md,
"Runs after the correction". In the whole-suite run, the 50 tests of section 2 passed again, plus the 19
new ones (their pass/fail only; their metric lines were not compared number by number with section 1).
A14 laptop, A12's CSP harness and the A13 dist report were not re-run: the fix does not touch them.

## 1. Results

"Runs" means the runs on the merged branch; every check passed or failed the same way in all 3.

| # | Status | Runs | Key number | Finding | Evidence |
|---|---|---|---|---|---|
| A1 | PASS | 3/3 | Footer ink pixels: Lobby note 0, control 171; Ctrl+D copy 0 (created null), control 171; Alt-drag copy 0, control 171 | `created: null` hides the date footer. Lobby's `onDuplicate` stamp gives Ctrl+D and Alt-drag copies `created: null`. `convertToExcalidrawElements` needs `regenerateIds: false`, or it overwrites `created`. | A1.md, `e2e/spike/tests/host-a1.spec.ts` |
| A2 | PASS | 3/3, 20/20 each | 217 keys per run, 165-167 buffered and replayed; grant delays 135-409 ms; 1 acquire per case; labels created 10/10 | A synthetic Enter after the grant opens the label, or creates it. Buffered keys replay in order at the end of the text. | A2.md, `host-a2.spec.ts` |
| A3 | PASS | 3/3 | Line breaks differ in 0/208 labels (criterion ≤ 3); 0 font-size differences. The plan's per-character table without kerning: 6/208 | Server layout in Node matches Chromium only with measured pair kerning. The plan's plain per-character table would fail. | A3.md, `apps/web/test/engine-probe/a3/` |
| A4 | PASS | 3/3 (commenter, viewer, guest, editor control) | Presence 11-12 samples (15-16 Hz), `onPointerUpdate` 0 with no tool; keys, clipboard and drop 0 | The interaction config behaves as planned. Excalidraw refuses even `setActiveTool('selection')` for read-only roles, so Lobby sets the tool through `appState`. | A4.md, `host-a4.spec.ts` |
| A5 | PASS | 3/3 | 0 visible matches for 33 selectors in 6 states; 0 off-background pixels outside Lobby's toolbar | `ui={false}` hides every engine control. Lobby's toolbar drives all 9 tools. | A5.md, `host-a5.spec.ts` |
| A6 | PASS after the fix (section 0) | 3/3 at `f17ce48` | Allowlist on: 140 presses, 0 acted, 0 downloads, dialogs or pickers. Control: 89/140 acted (54 keys). Inside a granted editor: 658 chords per platform, 0 acted, 0 reached the textarea except the 15 kept ones | First version (wrong): only Ctrl/Cmd+S and Ctrl/Cmd+Shift+S were blocked in the editor, and Ctrl+Alt+S / Cmd+Alt+S still saved. Now an allowlist inside the editor; every other Ctrl/Cmd/Alt chord is stopped. | A6.md, `host-a6.spec.ts`, `host-a6-editor.spec.ts`, `keymap.test.ts` |
| A7 | PASS | 3/3 | Engine path: 1 op (`status`, v2→v3), never retried. Lobby loader: 0 ops, 0 drift, loaded after 15.9 s; 30 images: 6 in flight at most, the 4 visible first | E1 is confirmed. Lobby's loader with a local-only status pushes nothing. | A7.md, `render-a7-images.spec.ts` |
| A8 | PASS | 3/3 Node (13/13) + 3/3 browser | Without the pre-pass, confirmed `c2` goes v3→v4. With the pre-pass, `X0` is re-keyed a1→a1V and 0 confirmed versions change | The pre-pass keeps `syncInvalidIndices` away from confirmed elements. Excalidraw does not enforce E3 in the npm builds. | A8.md, `apps/web/src/canvas/sync/index-keys.test.ts`, `engine-probe/a8/` |
| A9 | PASS | 3/3 | 17 elements, 27 font files: 0 ops, 0 drift, 0 size changes, 0 foreign requests | Font loading bumps no version. Labels are not re-measured after a late font load. | A9.md, `render-a9-fonts.spec.ts` |
| A10 | PASS | 3/3 | After a drag offset, the label's dark pixels are 322 at the new spot and 0 at the old. With the guard, clicks, double-clicks, drags and menus on hidden elements do nothing | Offsets move a note and its label together. Opacity must name the label and frame children explicitly (9 ids). The hover cursor stays `move` over hidden elements. | A10.md, `render-a10-overrides.spec.ts` |
| A11 | PASS | 3/3 | Heavy board overview 271-274 ms; open with 200 images 939-950 ms. Two instances: A misses 10/20 repaints (0 with the throttle off) | The `exportToCanvas` preview works. Two `<Excalidraw>` on one page share state (recorded, not asserted). | A11.md, `render-a11-*.spec.ts` |
| A12 | PARTIAL | 3/3 dist report + 3/3 CSP | Engine-route hosts 68 → 41, 0 of them from the engine's 266-package tree. The plan's CSP: 2 violations per flow; final policy: 1 (zod); with zod jitless: 0. 0 foreign requests | See section 5 for why it is not PASS. | A12.md, `apps/web/build/excalidraw-host-rewrite.ts`, `e2e/spike/csp/` |
| A13 | PASS (reported, no gate) | 3/3 | tldraw board route 1086.2 KiB gzip; Excalidraw engine route 1306.9 KiB (+1.0 KiB against the render branch: `ExcalidrawHost` now imports `tools/notes.ts`); run time 1308.4 KiB | The plan's ≈881 KiB baseline does not reproduce. About 1066 KiB is projected after cut-over. | A13.md, `e2e/spike/csp/dist-report.ts` |
| A14 | PARTIAL | Workstation 3/3 for each engine (+3 more Excalidraw runs); laptop UNRUN | Median fps, fit / 0.25 / 1. Excalidraw: 17.7 at its own fit (clamped to zoom 0.1), 13.9 at the true fit (0.054) / 53.7 / 60. tldraw: 18.2 at fit (0.05) / 56 / 59. Open: Excalidraw 666-701 ms without a sync server; tldraw 3,700-3,916 ms | Excalidraw's own fit stops at zoom 0.1. At fit, both engines are below 24 fps; at 0.25 and 1, both are above 30. Details in the note below the table. | A14.md, `render-a14-*.spec.ts` |
| A15 | PASS | 3/3, 31/31 | `record()` at 20,000 elements: about 5 ms | Field-level undo: every §2.8 case passes, and probe2's loss reproduces on Excalidraw's own `ElementsDelta`. The CAS unit is refined (section 4). | A15.md, `apps/web/src/canvas/history/` |
| A16 | FAIL as written (plan wording) | 3/3 at `f17ce48` (16 + 15 tests per run) + static 3/3 (23/23) | Call sites: 7 `startTextEditing` and 2 `handleTextWysiwyg`, in dev and prod. P1, P2, P3a, P3b, P4, P5 and P6: 20/20 each; deny 40/40; group and line forwards 20/20. A second editor while a request is pending: 12 cases x 20/20; text without keydown into a guarded editor 20/20 | First version (wrong): "the security property holds"; an editor opened while another request was pending was writable without a lease. Fixed; the property now holds. The plan's wording still fails on 3 points (section 3.4); the corrected criteria pass. | A16.md, A16-static.md, `host-a16.spec.ts`, `host-a16-pending.spec.ts`, `openRule.test.ts`, `engine-probe/editor-open-paths.test.ts` |
| A17 | PASS | 3/3, 20/20 | Textarea moved exactly (120, 40). The note grew to 392 px while typing, stayed 200 after a remote shrink, and re-fit to 652 as a `fit` write | `updateScene` with the editor open keeps the textarea, caret and text. Native Ctrl+Z stays in the textarea. The holder's auto-fit rewrites bound arrows (open item 3). | A17.md, `host-a17.spec.ts` |

**A14 on the merged branch: what differs from the render branch.** The code under test is identical; only
`ExcalidrawHost` changed, and only by the `onDuplicate` wiring.

| | Render branch (A14.md) | Merged, runs 1-3 | Merged, runs 4-6 |
|---|---|---|---|
| Excalidraw true fit (zoom 0.054) | 13.3 / 14.6 / 14.5 | 13.7 / 13.9 / 15.9 | 13.4 / 13.9 / 13.7 |
| tldraw fit (zoom 0.05) | 17.6 / 16.4 / 18.8 | 18.8 / 18.2 / 17.3 | not run |
| Visible images drawn after first paint | 0.76-1.83 s | 0.75-4.24 s (median 1.77 s) | 0.89-3.98 s (median 1.72 s) |
| `addFiles` calls in the measured tab | 4-8 | 4-32 | 3-43 |

- **Fit.** Excalidraw is about 24% below tldraw at the whole-board fit here (13.9 against 18.2 fps). The
  owner measured about 18%.
- **Images.** In runs 1-3, 3 of 9 opens took 3.6-4.2 s to draw the visible images; in runs 4-6, 2 took
  3.0-4.0 s. Batching per animation frame caps `addFiles` at one call per frame, but when images trickle
  in over many frames each call is still a full repaint (X 43789-43796). This is a likely cause, not a proven one.
- **Machine load.** During these runs, three unrelated `node` processes from other worktrees each held one
  core at 100%: two `--watch` dev servers started 2026-09-26 and a vitest process. They were not started
  or stopped by this work.
- **Other numbers.** 100-note drag preview 60 fps (one pan 58.7); echo 0 ops; heap 39-99 MB.

## 2. Integration and gates

**The merge.** The three owner branches merged with no textual conflict. The two shared files merged
automatically:
- `apps/web/vite.config.ts` has both plugins: `excalidrawAssets` from the scaffold and `excalidrawHostRewrite`
  from render.
- `vitest.config.ts` gained node's `engine-probe` project.

`ExcalidrawHost.tsx` was changed only by host. Render's pages use it unchanged, and they now get Lobby's
duplicate stamp by default. No file under `e2e/spike/support` was changed by any owner.

`pnpm install --frozen-lockfile` left the lockfile unchanged. **No integration fix was needed: the merge
itself changed no code.**

**Gates on the merged tree.** The script is `scripts/integration-run.sh`. Runs 1, 2 and 3 went back to back
and took 418-421 s each.

| Gate | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| `pnpm lint` (Biome, 1,119 files, with the `@excalidraw/*` import rule) | PASS | PASS | PASS |
| `pnpm -r typecheck` (14 packages) + `tsc -p apps/web/test/engine-probe` | PASS | PASS | PASS |
| vitest `web` + `canvas-schema` + `engine-probe` | 1389/1389 | 1389/1389 | 1389/1389 |
| Host-rewrite plugin tests (`node --test`) | 8/8 | 8/8 | 8/8 |
| Whole spike Playwright suite (`SPIKE_WEB_PORT=7730`, fresh build each run) | 50 passed, 2 skipped (the opt-in A14 specs) | 50 / 2 | 50 / 2 |
| A8 browser probe | PASS | PASS | PASS |
| Normal tldraw build (no `VITE_LOBBY_ENGINE`), 84 assets: files matching any of 14 engine markers | 0 | 0 | 0 |
| `VITE_LOBBY_ENGINE=excalidraw` without dev auth: files with spike or engine markers | 0 | 0 | 0 |

Correction to the last row (section 0): it grepped `assets/` only. The same build also emitted
`excalidraw-assets/` (233 font files, 14 MB). The assets plugin now follows the route's gate, and the
script greps the whole dist and counts that folder: 0 marker files, no folder, 95 files at `f17ce48`.

Of the 1,389 unit tests, 256 are spike code: the engine wrappers 13, index keys 13, history 31, the engine
probes 23, input 134, lease 13, tools 7, overrides 9, loader 10 and interaction 3.

**The normal build contains no engine code.** Two checks:
- **Markers.** Each run greps the built normal app for 14 markers; each marker matches 0 files, and no
  `excalidraw-assets/` folder exists. The markers:
  - the engine globals: `EXCALIDRAW_ASSET_PATH`, `EXCALIDRAW_THROTTLE_RENDER`;
  - asset and class names: `excalidraw-assets`, `excalidraw__canvas`;
  - hosts and packages: `esm.sh`, `@excalidraw/`, `excalidraw-room-persistence`, `oss-collab.excalidraw`;
  - font names: `Xiaolai`, `Excalifont`;
  - spike names: `__lobbySpike`, `spike-engine`, `host-lab`, `render-lab`.

  The bare word `excalidraw` is not a marker, because tldraw 5.4.2 contains it for its paste support.
- **Source maps.** The same build with `--sourcemap`, 3 times: 1,548 module sources in 12 maps, with 0
  under `@excalidraw/` and 0 under `apps/web/src/canvas/` or `apps/web/build/`. The control, the engine
  build with maps, has 93 `@excalidraw` sources and 30 Lobby canvas sources.

Owners' own gates before the merge (in their notes): lint and typecheck passed on each branch; host and
render ran their full web suites.

## 3. Engine behaviour that contradicts or refines the plan

File shorthand: **X** = `@excalidraw/excalidraw/dist/dev/index.js`, **F** = `…/excalidraw/dist/dev/chunk-FN755BR4.js`,
**E** = `@excalidraw/element/dist/dev/index.js`, **C** = `@excalidraw/common/dist/dev/index.js`, all 0.18.0-1118751.
I spot-checked X 44727, 51679-51686, 44741-44746, 47091, 44343-44350, E 18947-18952, C 2944-2946 and F 642-644
against the installed files; they match.

### 3.1 Host, keys, tools (§2.3)
1. **Ctrl/Cmd+S inside the text editor downloads the board.** The textarea's handler runs
   `actionSaveToActiveFile` through `executeAction`, which skips predicates (X 25388-25391, 23095-23106).
   Measured: 1 `showSaveFilePicker` call per press. Ctrl+Shift+S is inert there: its key test requires no
   Shift (X 11606), and the container's `onKeyDown` returns for writable targets (X 44005-44011). **The
   key test ignores Alt**, so Ctrl+Alt+S and Cmd+Alt+S save too. The first version of this report said
   Lobby's capture listener closed this; it blocked only the chords without Alt (section 0). The
   textarea's handler also zooms, changes the font size, submits and indents (X 25367-25409, enumerated in
   A6.md). Lobby now applies an allowlist inside the editor.
2. **Keys the plan does not name act without the allowlist.** 54 of 70 probed keys act. Tab arms a
   type-conversion popup, a jotai atom that `appState` does not show (X 43960-43977). The next Shift+Tab
   then converts the shape's type. Q toggles the tool lock (X 43673-43695).
3. **Read-only roles cannot set any tool through the API.** Under `interaction`, `setActiveTool` refuses
   every tool except laser and custom, the selection tool included (X 44343-44350; `isToolSupported`
   42465-42479). A drag pans only when no capturing tool is active (X 28808-28815, 48043-48048).
4. **Read-only editors have no clipboard and no drop guard.** `addEventListeners` returns at X 49327,
   before the copy, cut and paste listeners and the drop guard (X 49346, 49390, 49396, 49416), and
   `onDrop` is undefined (X 48682). The browser's default drop is not prevented; Lobby's listener prevents
   it.
5. **`ui={false}` still leaves a full-size, empty `div.SVGLayer > svg`** (X 39927-39941) and empty wrappers.
   Nothing is painted.
6. **Fonts always get an esm.sh fallback source** (F 1225-1249, 1277), and Chrome checks every FontFace
   source against the CSP when the FontFace is constructed. Rewriting only the host still gave 230
   `font-src` violations, so the fallback must be same-origin (A12).
7. **`onExcalidrawAPI` fires before the editor is initialised** (X 49154). **`onInitialize` fires after the
   first scene** (X 49441). From the scaffold.

### 3.2 Index keys and echo (§2.5.4-2.5.5)
1. **Confirmed: `updateScene` re-keys the later of two colliding elements and bumps its version.** The path
   is X 43825-43846 → `syncInvalidIndices` (E 19079-19085, 12728). It happens in a real browser too (A8).
2. **E3 is not enforced in the npm builds.** The plan's "dev builds throw otherwise" is false:
   - `validateIndicesThrottled` runs only when `isDevEnv()`/`isTestEnv()` is true or
     `window.DEBUG_FRACTIONAL_INDICES` is set (E 18947-18958);
   - common's `import.meta.env` has no `MODE`, so `isDevEnv()` is always false (C 34, 2945);
   - `syncInvalidIndices` never fixes label order (E 12713).

   Lobby's pre-pass and the server's step 11 are the only guards.
3. **`Scene` cannot run in the sync process.** In plain Node its first `replaceAllElements` throws
   `window is not defined` (E 18949), and its throttle keeps the process alive for 60 s.
4. **Editor open writes the label before any key.** `handleTextWysiwyg` ends with `updateElement`
   (X 49918), and `updateWysiwygStyle` writes x/y on every scene update (X 25212, subscribed at
   25600-25607). A label measured with other metrics gets `x`/`width` rewritten, with a version bump, on
   open (A16, cold open).

### 3.3 Presence (§2.7)
1. **Confirmed: `onPointerUpdate` is silent for read-only roles with no tool.** `savePointer` returns
   before `onPointerUpdate` when neither interaction nor the tool is enabled (X 47780-47801). It also
   returns when `clientX` or `clientY` is 0 (X 47787-47789). Lobby's own listener: 11-12 samples per 30
   moves, `onPointerUpdate` 0 (A4).

### 3.4 Text lease and editor-open paths (§2.9)
1. **The 7 + 2 call sites match the plan's table** in dev (27824, 44176, 44864, 46350, 46374, 51313, 51681;
   `handleTextWysiwyg` 44685, 51250) and in prod (the names survive minification).
2. **P3 on the label is really P5.** The second pointer-up of a double-click on a selected note's label
   calls `startTextEditing` (X 51679-51686) before `dblclick` fires. `handleCanvasDoubleClick` then
   returns (X 44727), and all the text is selected (X 25613-25614). A capture `dblclick` stop cannot
   prevent this, so the guard catches it: the editor is read-only from its first frame. (In the first
   version only when Lobby was idle; while another request was pending it stayed writable. Section 0.)
3. **A plain double-click on a simple arrow edits the arrow's label** (X 44838-44864). The linear editor
   toggles only for a line, or on Ctrl/Cmd+double-click on an arrow (X 44741-44744). Elbow arrows go to
   segment editing (X 44746).
4. **Touch.** `onTouchStart` deselects before `handleCanvasDoubleClick` (X 43506-43516), so a double-tap is
   always a text path. Excalidraw calls `preventDefault` only on iOS (X 43481-43483). Elsewhere, the
   compatibility mousedown steals focus from the new textarea 1-2 ms after `touchend`: 1 of 5
   Excalidraw-opened editors closed at once in each run.
5. **Auto-fit rewrites bound arrows from the holder's copy (open item 3, confirmed).** For a sticky note,
   `updateElement` replaces the container with `getStickyNoteLayout`'s output (X 49806-49838); for an
   unrotated note only the height changes. It then runs `updateBoundElements` for the container (X 49845)
   and for the text (X 49864-49868). Non-sticky containers do the same (X 25133, 25147).
6. **An open editor survives `updateScene(NEVER)`.** `editable.value` is set only at creation (X 25247),
   and Ctrl+Z/Y inside the textarea never reach `actionManager` (X 44005-44011). `updateScene` itself runs
   no re-layout (E7 holds).
7. **Focus timing.** The textarea is appended synchronously (X 25633) but focused in a `setTimeout`
   (X 25545-25561). `updateScene({appState})` only schedules a React update (X 43825-43851), so a
   synthetic Enter needs the selection flushed with `flushSync` first.
8. **Excalidraw keeps one editor's submit handler** (`textWysiwygSubmitHandler`, X 49849). A second
   editor opened while one is still in the document orphans the first: its textarea stays, with no
   `editingTextElement`, and its text is written only when something submits it later. And **its submit
   removes the textarea before it clears `editingTextElement`** (`handleSubmit` -> `cleanup`, X 25487,
   25543; `onSubmit`, 49870-49900); the label write in between renders, so for a moment Excalidraw names
   an editing element with no textarea. Lobby's session must follow both (section 0).
9. **Excalidraw's own paste into its editor writes the value by script** (`editable.onpaste`, X
   25303-25320, for Excalidraw-clipboard data), so `readOnly` does not stop it; Lobby's capture `paste`
   listener does. Excalidraw's container prevents every dragover and drop (X 43022, 49404-49416), so text
   cannot be dropped into its editor at all.

### 3.5 Files (§2.10)
1. **E1 confirmed at X 47091-47111** (the plan cites 47089). `updateImageCache` marks an errored file's
   images `status: "error"` as a new version under `NEVER` (element `onerror` E 22646).
2. **A failed image is never retried in the session.** The error stays in the image cache (E 22637-22641),
   `addNewImagesToImageCache` skips cached ids (X 47113-47118), and `addMissingFiles` skips ids already
   in the files map (X 43789-43821). Never give the engine a file that has not loaded.
3. **Every `addFiles` call repaints the whole scene** (X 43789-43796). With one call per image, visible
   images appeared 4.9-6.5 s after open. Batching per frame brought that to 0.8-1.8 s on the render
   branch, but 0.75-4.24 s on the merged branch, with 3-43 `addFiles` calls in the measured tab (A14 note).
4. **SVG cannot go through a `blob:` URL.** `addMissingFiles` re-encodes `image/svg+xml` by parsing a
   `data:` URL (X 43806-43818).
5. **An image whose file is absent draws a placeholder** (#E7E7E7, E 13559-13572) and is never marked.

### 3.6 Notes, text, layout (§2.11)
1. **Kerning matters.** `getWrappedTextLines` measures whole lines (E 6085, 6113). A per-character table
   gets 6/208 labels wrong; with pair kerning, 0/208.
2. **In Node, text layout throws without a metrics provider** (`document is not defined`: E 5731-5735,
   created lazily at 5754-5758). The sync process must call `setCustomTextMetricsProvider` at start-up.
3. **`newTextElement` stamps `created` with the wall clock** (E 16371). Server-made labels must pass
   `created: null`, or they are not deterministic.
4. **Duplicates.** `duplicateElement` sets `created = updated` on every copy, even from null (E 17932-17939).
   `reconcileDuplicatedElements` merges the host's `onDuplicate` result (E 18139-18163), so Lobby's
   stamp works for Ctrl+D (X 3737) and Alt-drag (X 28491, 28547).
5. **Converter limits.** `convertToExcalidrawElements` cannot bind an arrow to a `stickynote` (it hits
   `assertNever`, then throws: E 24382-24441). It regenerates every id and `created` unless
   `regenerateIds: false` (E 24527-24528).
6. **Coordinates above ±1e6 log an error** (`_newElementBase`, E 16334-16343). §3.5 allows ±1e7.
7. **`charWidth` caches by the first UTF-16 unit** (E 5772-5796), so astral characters that share a high
   surrogate share one width. Both runtimes do this, so layouts still match.
8. **Late fonts leave labels stale.** Fonts load (F 3026-3054) without changing any version, and labels are
   not re-measured; the stale layout is fixed only when the editor closes (1 op). `fontFamily` 10 is not
   registered.

### 3.7 Rendering, preview, bundle (§2.12, §4.6, §8.5)
1. **Zoom is clamped to [0.1, 30]** (`getNormalizedZoom`, F 642-644; `MIN_ZOOM`, C 1898), including
   Excalidraw's fit (F 501). `updateScene({appState:{zoom}})` accepts less; the wheel does not.
2. **`exportToCanvas` ignores the camera.** It always exports the scene bounds (X 15391-15437), so the
   preview does its own camera: an anchor rectangle, an overview bitmap and a detail pass.
3. **Two instances on one page share state**: the jotai store (X 43955-43980, 52656), one `throttleRAF`
   static render (F 3786-3790, C 2662-2680) and i18n. `destroy()` cancels the shared throttle (X 24386).
4. **SVG font inlining needs `unsafe-eval`** (embind `Function(...)` in chunk-Z5NKEFVG). Use
   `skipInliningFonts: true`.
5. **rolldown hoists mermaid, d3 and marked into eager chunks** of the engine route: about 120 KiB gzip.

## 4. Corrections the plan needs

Consolidated from the owners' results, grouped by plan section. Each has evidence in the named check file.

1. **§2.3.3 keys** (A6):
   - blocked Ctrl/Cmd/Alt keys must also be `preventDefault`-ed, except browser chords (reload, tabs,
     windows, address bar, devtools);
   - an unhandled Tab must be stopped (`stopPropagation`) outside mind maps, or it arms the conversion
     popup;
   - the "Delegated while the text editor is focused" row ("every key except the mind-map keys") is
     wrong, and open item 1 is not closed by naming save chords: inside the editor, keep only keys without
     Ctrl/Cmd/Alt, caret moves (Alt only on macOS), Ctrl/Cmd/Alt+Backspace/Delete, Ctrl/Cmd+Z,
     Ctrl/Cmd+Shift+Z, Ctrl+Y, Ctrl/Cmd+A and Ctrl/Cmd+C/X/V/Shift+V; let AltGr and Option characters type
     with their keydown stopped; stop and prevent every other Ctrl/Cmd/Alt chord (section 0, A6.md).
2. **§2.3.4 / §2.7** (A4): for read-only roles, `CanvasPort.setTool('select')` must write
   `appState.activeTool`.
3. **§2.3.2** (host, scaffold): define "Lobby yellow" (`currentItemStickynoteBackgroundColor`); the spike
   used a placeholder, #ffd966.
4. **§2.4 / §2.11** (A3, A16-static): the sync server must never instantiate `Scene`; use only pure
   functions. It must install the metrics provider at start-up, and server-made labels must set
   `created: null`.
5. **§2.5.3** (A16-static): client rounding must cover arrow points too. 1,000 unrounded points are
   39.6 KB, over the 32 KiB element limit.
6. **§2.5.4** (A8): the pre-pass sorts the whole array (about 15 ms at 20k elements in Node). Skip it when
   no own element is unacknowledged, if B's perf runs show it on the apply path.
7. **§2.5.5 E3** (A8): delete "dev builds throw otherwise". Tests must not rely on Excalidraw throwing.
8. **§2.8 undo** (A15):
   - the CAS unit is per group for coupled geometry (pos, shape, layout) and per field elsewhere;
   - a no-op is not a "kept" skip, and `boundElements` skips are silent;
   - redo re-applies only what the undo applied;
   - known edge for wave 2: redo can revive an element someone else deleted again, so it needs a
     version check on the life field.
9. **B2 U10** (A15): "stack length equals A's real actions" should be "≤".
10. **§2.9.2 and the A16 criteria** (A16):
    - P3 on the label is guard-caught (it is P5);
    - a plain arrow double-click is a text path, leased on the arrow's id;
    - the forwarded cases are a line double-click and Ctrl/Cmd+double-click on an arrow;
    - "0 local element changes before the grant" should be "0 ops pushed before the grant", and guard
      step 3 must include the open-time layout writes;
    - Lobby must `preventDefault` a swallowed touchstart on every platform, not only iOS;
    - the Granted row must state the caret position: at the end for Lobby-initiated opens, Excalidraw's
      own for guard-caught opens;
    - the guard's trigger must be "any editor that is not the granted lease's editor, whatever the state
      of Lobby's own request", not "an open that did not follow a grant": while another request or editor
      is in flight, the unrequested editor is closed at once, unchanged; text that arrives without a
      keydown (beforeinput, paste, drop) is prevented as well as keys; Lobby's session follows
      `editingTextElement`, and a lease is released only after its editor is gone (section 0, A16.md).

    The proposed criterion is in A16.md. It reads: "P1, P2, P3 off the label, P4 and the T tool open only
    after the grant. P3 on the label and P5 are guard-caught: read-only from the first frame, no key
    lands, nothing pushed. P6-P8 are unreachable."
11. **§2.9.4 and open item 3** (A17):
    - a fit's bound-arrow rewrites must be fit-derived (dropped together with the fit), or the server
      recomputes bound-arrow endpoints whenever it applies a fit (simpler);
    - for an unrotated note only the height changes;
    - `baseHeight` does not need to be on the wire.
12. **§2.10.3 loader** (A7, A14):
    - `resolveUrl` needs the asset id, the derivative id and `?board=` (the real route requires it:
      `apps/api/src/files/serve.ts:58-63`);
    - batch `addFiles` per animation frame, and also across a short time window (or until the visible
      set is complete), because one call per frame still repaints once per frame while files trickle in;
    - never pass SVG as a `blob:` URL, and do not revoke blobs that the scene or exports may still use.
13. **§2.11 text metrics** (A3):
    - the table needs per-character advances plus measured pair kerning, per-class widths (Han, kana,
      Hangul, full-width, emoji) and regional-indicator advances;
    - re-measure it with `a3/calibrate-table.ts` on every engine or font bump;
    - it reproduces Windows Chromium only, and the lease holder's re-fit covers other platforms.
14. **§2.12 hosts and CSP** (A12):
    - rewrite every URL host in the engine's 266-package dependency tree and verify it at build time; the
      plan's host list is incomplete;
    - make the font fallback same-origin;
    - add the inline theme script's hash to `script-src`;
    - call `z.config({ jitless: true })` at bootstrap;
    - export SVG with `skipInliningFonts: true`;
    - scope the CI grep to the engine tree through source maps; a whole-dist grep cannot pass while
      tldraw (9 listed hosts) or pdf-lib are built.
15. **§3.5 limits** (A3, A9, A16-static):
    - refuse `fontFamily` 9 and 10;
    - either limit coordinates to ±1e6 or accept the console noise;
    - the `plusOne` budget holds 200 keys only for uids up to about 40 characters, so raise it to 16 KiB
      or cap the uid length.
16. **§4.6** (A11): two instances on one page are not viable. This confirms the `exportToCanvas` preview.
17. **§4.7 hit guard** (A10): three gaps are not covered yet: the hover cursor over hidden elements, the
    dead zone at a moving note's document position, and touch.
18. **§5 converter and server-made notes** (A1, A3): build arrow bindings to notes by hand; pass
    `regenerateIds: false`; set `created: null` explicitly.
19. **§8.2 A13** (A13): the ≈881 KiB baseline does not reproduce. The same method gives 1086.2 KiB
    (1045.7 JS). Stub mermaid (about 120 KiB eager).
20. **§8.5 and §6.4 fit fps** (A14):
    - Excalidraw never shows the whole heavy board through its own fit (the 0.1 clamp);
    - "today's median is 29" came from branded Chrome and a gentler pan, so use a same-method baseline
      (tldraw 16.4-18.8 at fit here);
    - the level-of-detail conditional applies.
21. **Open item 2** (A16): "a double-click on an arrow opens the linear editor" is wrong for simple
    arrows; see item 10.

**Lead actions not in any owner's files:**
- `packages/canvas-schema/package.json` exports only `.`, so `apps/sync` cannot import the engine
  wrappers yet. Add `"./engine": "./src/engine/index.ts"`.
- `apps/web/src/canvas/history` has its own copy of the §3.2 field-group map until
  `packages/canvas-schema/src/groups.ts` exists.

## 5. Not run, not verified

- **A14 laptop half: UNRUN.** No laptop was available. The workstation numbers come from the headless
  Chromium shell with GPU flags, not branded Chrome.
- **A14 open time is not comparable.** The Excalidraw heavy board opens from static JSON with no sync
  server, while tldraw's opens through the real stack.
- **A12 is not a PASS:**
  - the zod fix (`z.config({ jitless: true })`) is app code; the 0-violation result emulates it, and it is
    not committed;
  - the Clerk frontend-API origin for staging is UNVERIFIED: there are no Clerk keys and no real sign-in,
    and the host pattern comes from `@clerk/shared`;
  - the whole-dist grep cannot pass before cut-over.
- **Text input devices are emulated (section 0).** macOS is `navigator.platform` emulation on Windows
  Chromium: the Mac editing commands (Cmd+Z, Option+Left…) were checked as verdicts, not as native effects,
  and the key value a real Mac reports for Cmd+Option+S is UNVERIFIED (the rule does not depend on it: any
  chord with Alt and Ctrl/Cmd is stopped). IME composition and keyCode 229 were sent through CDP, not by a
  real IME or Android keyboard. AltGr was checked in unit tests only (Playwright cannot set the AltGraph
  state). By design, text an IME commits while a lease is pending is blocked, not buffered: the plan's
  "IME composition starts only after the grant"; nothing is lost silently, but the user types it again.
- **One browser engine only.** Every browser check ran in the headless Chromium shell: no Firefox, no
  WebKit, no Safari/iOS, no real touch device. P4 used Playwright touch emulation. A3's table reproduces
  Windows Chromium, and macOS/iOS font fallback for CJK and emoji was not measured.
- **The lease is a fake.** A2, A16 and A17 use an in-page fake lease server
  (`apps/web/src/canvas/lease/fakeServer.ts`). The real protocol, ordering (open item 5) and multi-browser
  behaviour are spike B (B3).
- **Some §6.5 probes do not exist yet.** No probe for:
  - `NEVER` keeping remote edits off Excalidraw's own stack;
  - `addFiles` keeping the first entry for an id (A7 shows the related never-retry behaviour);
  - embeddable z-order;
  - `restoreElements` on templates.

  The browser half is covered piecemeal by A1, A4, A7, A9, A16 and A17 and is not yet one standing
  upgrade suite.
- **Not measured here: §8.4's client numbers** (`updateScene` ms at 5k/20k elements, `onChange` diff at
  20k) and the typical 2k-object board open time. Spike B owns them. A8 measured only the pre-pass (about
  15 ms at 20k elements, Node).

## 6. How to re-run everything

From `C:/Users/Chase/Documents/GitHub/Draftroom-spike` (branch `spike/excalidraw`), in Git Bash:

```sh
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"
pnpm install --frozen-lockfile

# Gates + unit suites + whole spike Playwright suite + A8 browser + normal/no-guard build greps (one run,
# about 7 minutes; ports 7730-7733). Repeat with 2 and 3.
INT_OUT=<log dir> bash docs/research/excalidraw/spike-a/scripts/integration-run.sh 1
node docs/research/excalidraw/spike-a/scripts/integration-summary.mjs <log dir> --metrics   # per-test metric lines

# The corrections of section 0 (port 7770): gates, the old and new A6/A16 specs (repeat with 2 and 3),
# then the whole suite once. integration-summary.mjs reads <log dir>/run<n>/spike.json the same way.
FIX_OUT=<log dir> bash docs/research/excalidraw/spike-a/scripts/fix-run.sh gates
FIX_OUT=<log dir> bash docs/research/excalidraw/spike-a/scripts/fix-run.sh a6a16 1
FIX_OUT=<log dir> bash docs/research/excalidraw/spike-a/scripts/fix-run.sh suite

# A3 (3 runs inside; port 7734)
node apps/web/test/engine-probe/a3/run.ts --runs=3 --port=7734
# A12 / A13 dist report (5 builds; writes e2e/test-results/spike-a12-a13/run-<n>.json)
node e2e/spike/csp/dist-report.ts --run <n> --port 7735
# A12 CSP against the real api + sync + worker (ports 7830-7832)
node e2e/spike/csp/run.ts --run <n> --port-base 7830
# A14 (opt-in; about 2 minutes each for Excalidraw, 3-4 minutes for the tldraw baseline, which seeds the real stack)
SPIKE_A14=1 SPIKE_A14_RUN=<n> SPIKE_WEB_PORT=7730 pnpm --filter @draftroom/e2e spike render-a14-heavy
SPIKE_A14_TLDRAW=1 SPIKE_A14_RUN=<n> E2E_PORT_BASE=7830 SPIKE_WEB_PORT=7730 pnpm --filter @draftroom/e2e spike render-a14-tldraw
# Normal build source-map check (no engine sources)
(cd apps/web && pnpm exec vite build --outDir dist/int-normal-maps --sourcemap)   # then count @excalidraw in assets/*.map "sources"
```

One check alone:
- **Spike suite spec:** `SPIKE_WEB_PORT=7730 pnpm --filter @draftroom/e2e spike spike/tests/host-a16.spec.ts`.
- **Node unit checks:**
  - A8: `npx vitest run apps/web/src/canvas/sync/index-keys.test.ts`;
  - A15: `npx vitest run apps/web/src/canvas/history`;
  - A16 static and the §6.5 Node probes: `npx vitest run --project engine-probe`.

The owners' own run scripts are in `docs/research/excalidraw/spike-a/scripts/`: `host-run.sh`, `host-summary.mjs`
and `scaffold-run.sh`. Their per-check files give each owner's commands and ports.

**Where the output goes.** Per-run JSON goes to `test-results/engine-probe/` and `e2e/test-results/`,
both gitignored and regenerated by the commands above. The integration runs' logs are outside the repo.

**Runs behind this report.** Everything ran on the merged tree, in this order:
- the gate series, 3 runs;
- A3, 3 runs;
- the dist report, 3 runs;
- the normal-build source-map check, 3 runs;
- the CSP harness, 3 runs;
- A14 Excalidraw, 3 runs, then the tldraw baseline, 3 runs, then 3 more Excalidraw runs to check the
  visible-image spread.

The harnesses aborted every non-local request, and none was recorded. When the runs ended, no server was
left listening on 7730-7739 or 7830-7839.
