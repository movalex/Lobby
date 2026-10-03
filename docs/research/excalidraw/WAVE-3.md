# Excalidraw migration, wave 3: integration

The wave-3 integration of `docs/EXCALIDRAW-MIGRATION.md` §7.2 (row "3 Features"): the nine feature owners'
branches merged onto `engine/excalidraw`, their change requests decided, the fixes the merged page needed,
the gate, what is ported per feature, the parity table against today's tldraw app, and the open blockers.
The owners' reports are the evidence for their own slices: `docs/research/excalidraw/wave3/3B.md`, `3D.md`,
`3E.md`, `3F.md`, `3G.md`, `3H.md`, and the wave 3a, 3C and 3i entries of `docs/PROGRESS.md`. The runs here
are **single runs** (plus reruns of what failed), on a machine shared with other agents' runs.

**Wave 3b** (the second pass: owners 3b, 3a, 3CF, 3e and 2C, then `main` with bridge release R0) is
integrated in §7. **Wave 5** (the feature owners' fixes of the early wave-5 review, `REVIEW-W5-EARLY.md`) is
integrated in §8.

**Status of this file (refreshed 2026-10-03, wave C6).** §1 to §3 are the wave-3 record, §7 the wave-3b record and §8 the
wave-5 feature integration: dated records, kept as they were written. **§5 (parity) and §6 (blockers) are current**: they
were rewritten from what actually landed (the engine merge, wave 4, waves A, B and C, and the held release) and cite the
commit or spec for each claim. §4 (per feature) is still the wave-3/5 write-up: its "Partial" and "Not ported" bullets
are as of 2026-09-30 and several are closed; where §4 and §5 disagree, §5 wins. §9 gives the gate at the held head.

| | |
|---|---|
| Branch | `engine/excalidraw` |
| Base | `5b9c87a` (the wave-2 integration; every wave-3 owner branched from it) |
| Merged (`--no-ff`, in this order) | `engine/w3-3f` `26800da` (`24e60e9`), `engine/w3-3e` `2a45b88` (`50abc93`), `engine/w3-3a` `41508b7` (`9e51741`), `engine/w3-3c` `6908c7e` (`ed24d3e`), `engine/w3-3g` `ab4ff0e` (`84fafc2`), `engine/w3-3b` `dc2f441` (`12a195f`), `engine/w3-3d` `0387689` (`5bd70c6`), `engine/w3-3h` `1b405c0` (`6777186`), `engine/w3-3i` `da41b71` (`fb9d749`), then `spike/excalidraw` `37bdfa9` (`c171f19`). Conflicts: `docs/PROGRESS.md` in every merge after the first (all entries kept), and `canvas/api/impl.ts` plus the §2.2 table in the 3c, 3g and 3b merges (the member-table CRs, W3-1). No other conflict (the spike merge conflicted only in `docs/PROGRESS.md`). |
| Spike B | `origin/spike/excalidraw` was up to date (`92b1098`) when the owners' branches were merged. During the integration spike B pushed its part 3 (`37bdfa9`, `docs/research/excalidraw/spike-b/M3-part3.md`): O1's CR 2F-2 (`serverWrite`, `prepareBoard`) and CR-2D-1 lock scope, O2's fix of the lost-edit / lost-create race, the drag-recolour overwrite and the offline window, `message` events after the apply, `LobbyHistory.mergeTop()` / `joinPrevious()`, and CR-2D-2's `insert` on the port; `CONTRACTS_REV` 5. It is merged here (`c171f19`), and the gate below ran again after it. `spike/b-convert` (O4) is still unmerged in spike B. |
| Change requests | the owners' 8 `CR:` commits reviewed, all **accepted** (four of them merged into one mechanism), plus two proposed CRs accepted and applied by the integration (CR 3E-2; CR-3F-5 = CR 3E-3) and CR-2D-2's `LobbyTx.insert` on the port's new insert (W3-9); recorded in `docs/EXCALIDRAW-CONTRACTS.md` §12 as W3-1 to W3-9 (§1) |
| Integration commits | `612ad43` (`CR:`), `f37b44d`, `410ca30`, `2082b98`, `7a47943`, `07e6a77`, `5680fcd`, `5d2e74d`, `51513e8`, `c979618`, `3ff7ed6` (`CR:`), `a370875`, `f05bf2b`, and this report (§2) |
| Lockfile, `pnpm-workspace.yaml`, catalog | unchanged by every owner and by the integration |
| Spike-owned folders | changed only by spike B's own part-3 merge (`c171f19`); no wave-3 owner's commit and no integration commit edits them (`apps/sync/src/room/**`, `room/migrate/**`, `apps/web/src/canvas/{sync,lease,history,input,engine,presence,tools,overlay}/**`, `canvas/port-impl.ts`, `canvas/test-facade.ts`, `packages/tldraw-import/**`, `e2e/spike-b/**`) |
| Machine | Windows 11 workstation, Node 24, pnpm 10.34.5, Playwright headless Chromium (one branded-Chrome test in the default suite). Other agents' e2e runs shared the machine; durations are informational. |
| Ports | 6760-6762 and 6770 / 6783 (the first half of the Excalidraw specs, with 3h's and 3i's fake OpenAI), 6775-6777 (the second half), 6771-6773 (reruns and probes), 6790-6793 (the default suite), 6786-6788 (the spike A suite). Nothing listened in 6760-6799 afterwards. |
| Logs | the integrator's scratchpad `w3/` (`lint*.log`, `tc*.log`, `unit1.log` to `unit5.log`, `arrows*.log`, `lc1/` to `lc4/`, `default1/`, `default2/`, `spikeA1/`, `spikeA2/`, `dbg*.log`, `build-*.log`); never committed |

## 1. Change requests

| Rev (§12) | CR, commit | File(s) | Decision |
|---|---|---|---|
| W3-1 | CR-3A-1 `bc5d734`, 3c's `956d9ea`, CR 3G-1 `58c78eb`, CR 3b-1 `0780539`; CR 3E-2 (proposed) | `canvas/api/impl.ts` `LOBBY_CANVAS_MEMBERS`, `contracts.test.ts`, the table generator, §2.2 | **Accepted, merged into one mechanism.** Three owners each added a `part` status with its own `LANDED_PARTS` set, and 3b added `COMPOSED_BY_PARTS`. One `LANDED_PARTS` set now lists every landed part (status `part`); 3e's exports, real only with the board engine, get a new status `board-part` (CR 3E-2). §2.2: **0 stubs left** (13 landed parts, 4 landed board-engine parts). §7.1 regenerated: 164 files still use tldraw (3c's stores no longer do). |
| W3-2 | CR 3E-1 `737e463` | `canvas/api/lobby-canvas.ts` | **Accepted.** `ExportOptions.files` (original, display or canvas bytes for images). Additive, optional. |
| W3-3 | CR-3H-1 `054b720` | `canvas/api/index.ts` | **Accepted.** `loadCheckpointPreview()` (lazy) and its two types; the preview is a chunk of its own. |
| W3-4 | CR-3F-5 = CR 3E-3 (proposed) | `canvas/api/registries.ts` | **Applied by the integration** (`612ad43`). `cursorVisible` combines its providers. It was a real bug once both features were on one page: "Hide everyone's cursors" displaced present mode's filter for good once switched off. |
| W3-5 | CR-3A-2 `d721ff4` | 2C's `e2e/excalidraw/board-features.spec.ts` | **Accepted.** |
| W3-6 | 3c's `418e36b` | 2C's `canvas/board/session.ts` | **Accepted** (presence re-sent on a pan or zoom, for followers). Review note in §12. |
| W3-7 | integration decisions | owners' files (not frozen) | Keyboard map, present-live glue, first view, search by tag, and the fixes of §2. |
| W3-8 | requests, not commits | — | **Recorded, not applied** (§6). |
| W3-9 | CR-2D-2 (wave 2) | `canvas/api/lobby-canvas.ts`, `impl.ts`, `contracts.test.ts`, two owners' test canvases | **Applied by the integration** (`3ff7ed6`) once spike B's port had `insert`: `LobbyTx.insert(elements)` delegates to the board page's port transaction (a stub naming 2C on a bare port). 3b's template insert already called it: the Lobby tour and the template picker insert on the Excalidraw page. |

## 2. Integration fixes

The nine branches merged cleanly, but each owner had run on a page without the others (and spike B's part 3 arrived later, merged in `c171f19`). With all fifteen
features on one page, the first run of every Excalidraw spec (`lc1`) had 22 failures and 24 unexpected
passes (tests marked `test.fail` for an owner that had now landed). Every failure was traced; these are the
fixes:

| Commit | Where (owner) | What was wrong | Fix |
|---|---|---|---|
| `612ad43` `CR:` | `canvas/api/registries.ts` (contracts) | two single-slot `cursorVisible` providers (W3-4) | a combined filter |
| `f37b44d` | `features/canvas-ux/ported/keyboard-map.test.ts`, `commands.ts` (3a) | 3a's keyboard-map test, now fed all fifteen features, found five conflicts: Ctrl/Cmd+U twice (canvas-ux and media); comments' tool keys against mind maps' and a11y's; Ctrl/Cmd+= and - (navigation) and Ctrl/Cmd+Shift+C (present-export) not in its tables | Ctrl/Cmd+U is media's (it also tells a viewer why nothing happens); the comment tool's keys are listed as tool-scoped and checked for feature order and for stepping aside under the select tool; the zoom and Copy as PNG keys are listed with why (parity with the tldraw page) |
| `410ca30` | `features/present-export/live/ported/present-mode.ts` (new; 3c's folder) | present-live (3c) and present mode (3e) each built one side of their seam and asked the other to call it (CR-3C-2) | present-live's `onMount` offers present mode's presenter to the live controller and the live chrome to present mode. All 6 present-live tests pass. |
| `2082b98` | `navigation/start-view.ts` (3b) | 3b's first view is decided up to 2.5 s after mount; any camera set meanwhile (a person scrolling at once, a spec, another feature) was overridden. It broke 3g's mood-board drops, 2C's camera test, 3d's mind-map clicks and 3e's slides. | a camera moved before the first view is decided is kept (`'kept'`); templates and deep links still apply |
| `7a47943` | `navigation/SearchPanel.tsx`, `model.ts` (3b); `tags/ported/SearchTagFilter.tsx` (3d) | board search had no tag filter or `#tag` search (3b D8, 3d deviation 13) | 3b's panel uses 3d's tag-aware search and filter; the placeholder says `#tags` again |
| `07e6a77` | `tags/ported/tags.css` (3d) | the tag picker placed above its anchor collapsed to 18 px and flipped above/below on every render until React's update limit **unmounted the board page** (whenever 3a's toolbar left too little room below a selection) | the floating picker resets `bottom` |
| `07e6a77` | `canvas-ux/ported/Menu.tsx`, `StylePanel.tsx`, `canvas-tools.css` (3a) | submenus near the right edge opened off screen; on a phone the style panel covered half the board and the filter bar, and the toolbar overflowed the canvas | submenus flip left and move up; on phones the style panel folds behind a Styles button and the toolbar scrolls inside itself |
| `07e6a77` | `canvas/board/chrome.tsx`, `board.css` (2C) | the overlay root and canvas region used `overflow: hidden`, which a focus or click past the edge can still scroll: every overlay layer was drawn 165 px off on a phone | `overflow: clip` |
| `07e6a77` | `features/ai/ai.css` (3h) | 3a's style panel (a host slot above the overlay layers) covered the AI summary's buttons | on the Excalidraw canvas the summary opens at the top left (a ported-only CSS file since `c979618`; the tldraw page is unchanged) |
| `07e6a77` | `comments/ported/index.tsx`, `keys.ts` (3c) | the context menu's "Comment" found the comment tool still off (it lands a render later) and opened no composer | the composer opens once the tool is on, on the selection it was asked for |
| `07e6a77` | `people/ported/index.tsx` (3c), `workshops/ported/WorkshopOverlay.tsx` (3f) | after Gather everyone there was no "Stop following" button at all: 3c hid its label while summoned, and 3f's notice pointed to tldraw's own button at the top left | the label keeps its button (named "Stop following", as tldraw's) while summoned; the notice says "at the top" |
| `5680fcd` | `e2e/excalidraw/**` | 24 marks for owners that have landed, and specs written against pages without the others | marks removed (24 tests now must pass); marks that still fail retargeted to their real blocker; spec updates listed in the commit (present-invite in the Tab order, the live region staying in focus mode, the audit's two known status lines, a framed board for "presenting suspends Show only", 3h's switch under Board ▸, waits for a running camera move) |
| `5d2e74d` | `mindmap/mindmap.css` (3d), `navigation/start-view.ts` (3b), two specs | the two failures of the full gate run (both 3/3 on rerun, so real): the mind map topic bar's menu opened down into 3a's selection bar, and a right-click point sat under bob's style panel after 3b's first view moved his camera; and one more first-view race (a double-click placed at a camera that moved before the click) | the topic bar's menu opens upwards on the Excalidraw canvas (a ported-only CSS file); the first view is also kept when the person acted meanwhile (a press, wheel, pinch, key or local change); the two specs deselect first and right-click an empty spot of the view |
| `51513e8` | `e2e/excalidraw/history-kit.ts`, `a11y-phone-overlays.spec.ts` | two spec races of the final run (a viewport read before the phone size landed; Delete pressed before the facade selection landed) | the spec waits for the phone viewport; the kit waits for the selection |
| `c979618` | `features/ai/ported/ai-ported.css`, `features/mindmap/ported/mindmap-ported.css` (new) | the scoped rules of `07e6a77` and `5d2e74d` sat in the shared CSS files and put an engine marker into the normal build | moved to ported-only files; the shared files are back to their wave-2 content |
| `3ff7ed6` `CR:` | `canvas/api/lobby-canvas.ts`, `impl.ts` (contracts, 2C) | spike B's port had `insert` (CR-2D-2), but the canvas API did not | `LobbyTx.insert` (W3-9) |
| `a370875` | 2F's `apps/sync/test/room-internal/{deleted,place-notes}.test.ts` | two unit tests pinned the 503 of a write on an open room | they write through the open room (CR 2F-2) and check the same outcome |
| `f05bf2b` | `e2e/excalidraw/**` | after the spike merge 12 expected failures passed (the drag overwrite, six reveals, three restores, `?template=`, CR-2D-1) | marks removed; three tests retargeted to new defects (DEF-W3-1, DEF-W3-2) |

## 3. Gate

Code under test: the final tree is `f05bf2b` plus this report. The gate ran twice: on the wave-3 merges
with their fixes (up to `c979618`), and again after spike B's part 3 was merged (`c171f19`) and wired
(`3ff7ed6`, `a370875`). The second set is the result; the first is kept because it found the integration
fixes of §2.

| Check | Result |
|---|---|
| lint (`biome check .`) | PASS, 1,869 files (final tree) |
| `pnpm -r typecheck` (15 projects, e2e included) + engine-probe tsc + Node-safety tsc | PASS (after the spike merge) |
| `pnpm test` | PASS: **4,891 passed, 36 skipped** (441 files, 9 skipped) on the final tree. Before the spike merge: 4,849 / 36; the first run on the merged tree failed only 3 tests, all in 3a's keyboard-map test (the five key conflicts of §2). After the spike merge: 2 of 2F's room-internal tests failed because they pinned the 503 of CR 2F-2 (fixed in `a370875`). |
| `pnpm test:arrows` | PASS 85/85 (after the spike merge) |
| **every Excalidraw spec** (`e2e/excalidraw`, 326 tests; two halves in parallel, `E2E_PORT_BASE` 6760 and 6775) | **After the spike merge (`a370875`): 292 passed, 19 expected failures, 12 unexpected passes, 2 skipped, 1 failed.** The 12 unexpected passes are tests whose blocker spike B's part 3 or W3-9 fixed; their marks came off in `f05bf2b`, and a run of their seven spec files then passed 63, failed 5 as expected, with one flake (F6, 3/3 on rerun). The one failure (`navigation-paste` "bulk paste: Text…") passed 3/3 on rerun: a flake. **So on the final tree: 305 must pass (all passed, one of them only on rerun), 19 expected failures, 2 skipped.** Before the spike merge: the first run on the merged tree (`410ca30`) had 22 failures and 24 unexpected passes (§2); the second (`5680fcd`) 291 passed, 31 expected failures, 2 skipped, 2 failed (both 3/3 on rerun, so real; fixed in `5d2e74d`); the third (`5d2e74d`) 290 passed, 31 expected, 2 skipped, 3 failed (a flake, `mindmap-keyboard` "fast typing", 3/3 on rerun; two spec races fixed in `51513e8`, then 3/3 and 5/5). |
| **the default (tldraw) e2e suite**, whole | **PASS: 341/341** after the spike merge (`a370875`, 26.5 min, `E2E_PORT_BASE=6790`), and 341/341 before it (`410ca30`, 25.7 min); 340 chromium + 1 branded Chrome, fixtures from `pnpm fixtures` |
| **spike A suite** (`SPIKE_WEB_PORT=6786`), once | **PASS: 99 passed, 2 skipped** (opt-in) after the spike merge (`a370875`, 20.1 min), and the same before it (`7a47943`, 19.6 min) |
| normal web build, engine markers (after the spike merge) | PASS: **0** hits for 42 markers (wave 2's, and the wave-3 features': `__lobbyNavigation`, `navigation-overlay`, `dr-nav-minimap`, `workshops-marks`, `workshops-top`, `dr-wk-vote-tab`, `canvas-announcer`, `phone-sheet-open`, `__lobbyMindmap`, `__lobbyTags`, `lobby-present-live`, `ai-entry-fallback`, `checkpoint-preview-text`, `media-download-original`, `following-stop`, `style.panel-toggle`, `dr-tag-picker--floating`, …). No `excalidraw-assets/`, 0 source maps. A first check (before `c979618`) found `data-lobby-board-canvas` in the normal build's CSS: the integration's own scoped rules in shared CSS files, since moved. |
| engine flag without the dev-auth guard | PASS: 0 of the 42 markers. Positive control: the guarded engine build contains 36 of them (the other 6 are function names the minifier renames). |

The 19 **expected failures** on the wave-3 tree (`test.fail`, each naming its blocker; §6 has the owners). Wave 3b removed six of them; the 13 left are in §7.4:

| Blocker | Tests |
|---|---|
| DEF-W3-1 (2F / O1): a Recently-deleted restore through the open room does not re-bind a live connector to what it brings back ("reconnected 1 connection" missing) | 2 (`history-deleted`: a frame with its notes; a note whose frame is gone). The multi-select restore of a note and its connector passes. |
| DEF-W3-2 (O2 / 2C): undoing a template insert removes it for the inserting tab only | 1 (`navigation-templates` "templates in a board"; `?template=` passes) |
| DEF-3F-1 = 3b F2 (O1 / O2 snapshot cache): a join within 5 s of a doc write gets the old `lb_doc` | 2 (`workshops-facilitation` RETRO-03a, `navigation-start-view`) |
| CR-3F-3 (follow camera hook) | 2 (R2-04 in `workshops-follow` and `a11y-phone-overlays`) |
| wave 2's two undo defects (spike B history and lease, still open in part 3) | 2 (`collab-conflicts`: redo of Ctrl+G in a long sequence; typing into an empty note) |
| 3i's chrome and canvas keys | 4 (`a11y-keyboard-safety`: Ctrl+Z from the chrome, 3a; Ctrl+X on the canvas; Shift+= from the chrome, 3b; undo restoring the selection, spike B history) |
| one each | CR-3A-3 (`canvas-ux-keys` MAK-06), CR-3C-1 (`people-list`), CR-3D-5 (`tags-panel`), CR-3F-1 and CR-3F-4 (`workshops-facilitation`), CR-3H-2 (`ai-actions` R9) |

Now passing after the spike merge (their marks removed): the drag-recolour overwrite (`collab-conflicts`),
every private-brainstorm reveal (6), the reveal's checkpoint row, the orphaned thread's restore, the
multi-select Recently-deleted restore, `?template=` on first open, and the locked template slots' labels
(CR-2D-1).

Skipped: `present-export-heavy` (an opt-in measurement) and the context-menu "Export as" `test.fixme` (3e).
Not run: the spike B suite (spike B's lead ran it on `122995b`, `M3-part3.md`) and three runs in a row of
the whole folder (each owner ran three runs of its own specs on its branch).

## 4. Per feature: what is on the Excalidraw page

*Dated 2026-09-30 (the wave-5 feature integration). Its "Partial", "Not ported" and "Fixed at wave 5" bullets are not updated: see §5 for the current status of every feature and §6.1 for what closed since.*

"Ported" means the feature works on the Excalidraw board page with its tldraw copy and test ids and its
ported specs pass; "partial" means part of it is there and the rest waits on a named blocker; "not ported"
means absent from the new page. Every deviation below is listed in full in the owner's report.

### 4.1 Canvas tools (3a, `canvas-ux`) — ported, partial for z-order

- **Ported:** the toolbar (COL-07 order, More with the last-used tool, Media, features' tools, Templates), the style panel (13-colour note palette, colour, fill, dash, size, font, align, arrowheads; one undo step per pick; folds behind a Styles button on phones since the integration), the context menu, the board menu (Board ▸ Edit ▸ View ▸ Export ▸ Preferences ▸; the View submenu exists only since wave 5, W5-33: at 1809cf3 no feature registered a `view` entry and the submenu did not appear; it now holds zoom in and out, 100%, fit, selection and the minimap), the keyboard shortcuts dialog, the selection bar (lock, align, distribute, compact on phones), lock and Unlock all, the locked hint, double-click to add a note, frame rename, type-to-edit (RETRO-02), place at centre (A11Y-07), the export gate on copy, snapping on by default, `styles.of`/`apply`, the keyboard-map test over every feature.
- **Ported at wave 3b:** undo and redo from the chrome (A11Y2-02: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y from the top bar, the dock, a host slot or the page; never from text fields, menus or modals); Ctrl/Cmd+X cuts on the canvas; tldraw's quick actions (Undo, Redo, Delete, Duplicate, Comment and the ⋮ actions menu) on top of the toolbar on a canvas of 840 px or less; tldraw's phone toolbar (its overflow rule, capped to what fits; the Styles button at 640 px or less); the highlighter (Shift+D, highlight shades, one width) and a Hand for read-only roles (CR-3A-6, W3-13). Since the integration the context menu's target is what the right-click selected (CR 3E-4), the shortcuts dialog gives the keyboard back to the canvas, and the phone quick-actions strip starts right of the navigation slot.
- **Wave 5 (3a, `engine/w5f-3a`; `REVIEW-W5-EARLY.md`'s 3a findings, spec `canvas-ux-review`):** a connector drawn, re-ended or pasted with an end in a shape ends on the shape's outline with the same anchor, folded into the step that drew it (W5-11; `canvas/api/parts/connector-outline.ts`); Esc after a keyboard placement leaves Select on, Enter edits the placed shape again, an empty placed note goes and the live region says so (W5-20); More from the keyboard: Enter or ArrowUp opens it on its first tool, arrows move, Esc closes it back on More, it follows the tools in the DOM, `aria-haspopup` / `aria-controls` / `aria-expanded`, a canvas click or another tool closes it (W5-22); D4's polygon tools in More in tldraw's order (triangle, hexagon, rhombus, star, cloud, heart, four block arrows: a closed line plus a see-through holder, grouped, the converter's points; drag, click, Enter placement, a double-click labels them; the style panel styles the outline); View ▸ (zoom in and out, 100%, fit, selection, minimap), Paste in Edit ▸ and the context menu, Preferences ▸ Theme, and Undo / Redo left of the tools on a canvas wider than 840 px (W5-33); one Tab stop per toolbar, quick-actions strip, selection bar and style control, arrows inside (W5-42); font buttons in their own faces, icon arrowhead pickers, a visible opacity label with its value, new connectors straight (W5-40); the note-colour legend in Lobby's muted ink in dark mode (W5-41); the style panel folds behind Styles on a canvas 500 px high or less (W5-46); 44 px tools on a phone-width canvas (W5-31); the tools' `aria-keyshortcuts` (W5-50); the open text editor named for what it edits (W5-59). Display (Lilita One, D3) shows in the font picker once canvas-schema's allowlist takes family 7 (2A).
- **Partial:** PgUp/PgDn, the Reorder menu and the quick actions' reorder change no paint order (CR-3A-3, the port's `transact`); the next connector's Straight / Curved pick does not reach the engine (CR-W5-3A-1, 2C's next-style mapping; new connectors are straight by 3a's default); arrowheads about twice tldraw's size and bound connectors stopping 4-6 px short (W5-53, CR-W5-3A-2: the engine's head size and binding gap, 2C with 2A); a moved template frame's locked heading is refused by the room (W5-05: the client sends it in the frame's push; the rule is 2A's, `test.fail`); the note and text tools ignore the next style (CR-3A-7); viewers cannot copy even when exporting is allowed (CR-3A-4); no laser for read-only roles (CR-3A-8); the e2e facade's `tool` reports `freedraw` while highlighting (CR-3A-9).
- **Deviations:** stroke widths are the engine's; no in-place shape-type change; no serif font; align right has no key (Alt+D is the browser's); locking a frame locks its contents; no quick actions beside the board menu on a canvas wider than 840 px (since wave 5 Undo and Redo sit left of the tools there; Board ▸ Edit and the keys cover the rest); no Preferences ▸ Input device or Accessibility (CR-W5-3A-4: the engine's wheel preference is not a canvas setting; reduced motion follows the system, W5-21); the phone toolbar shows fewer tools than tldraw's so that it stays on screen; the history keys do nothing while a modal dialog is open.

### 4.2 Navigation (3b, `navigation`) — ported, partial for deep zoom

- **Ported:** Lobby's camera members; zoom keys and menu (MAK-10); the minimap (MAK-11, PERF-03); board search (MAK-12) **with tags since the integration**; the frames panel with reorder, skip and copy link (MAK-13); `?el=` / `?view=` links and the legacy `?d=` reader; content-search links; the first view (PRE-06, DANA-06, R13; since the integration it keeps a camera that moved, or a person who acted, before it was decided) and the board start view (PRE-08); arrange as grid (MAK-18); select by type (MAK-17); paste as sticky notes (COL-05, RETRO-01).
- **Ported since the spike merge:** the template insert, from the picker and from `?template=` (CR-2D-2, W3-9), so the Lobby tour opens on this page. Its undo removes the template for the inserting tab only (DEF-W3-2, `test.fail`).
- **Ported at wave 3b:** the level-of-detail pass (plan §8.5, `canvas/lod/**`): below zoom 0.2 each frame whose bitmap is current is drawn as one bitmap between the engine's canvases, and its members are left out of the engine's render (hit tests, selection, editing and exports unchanged); on the heavy board (9,220 elements) fit runs at 28 fps against 9.8 without it (3b's three runs, `wave3/3B-2.md`, not a quiet window). Lobby's own fit camera (80%, never above 100%, floored at the whole-board fit, W3-12); Ctrl/Cmd+wheel and trackpad pinch below 0.1 (W3-11); zoom at the pointer (Shift+= / Shift+-); the zoom and camera keys from the chrome (A11Y2-02); one-pass whole-board loops (heavy-board open 12.9 s before, 4.3-4.5 s after).
- **Fixed at wave 5** (the early review, `REVIEW-W5-EARLY.md`, branch `engine/w5f-3b`):
  - W5-09: the dashboard sidebar no longer turns upside down after a board visit. The ported navigation's classes are `dr-cnav*`, and `css-scope.test.ts` fails any ported stylesheet rule that selects only by class names a shared stylesheet uses.
  - W5-19: below the floor (a board that shrank after a fit, a follow, a stored view) no zoom-out gesture zooms in, a step in goes to the floor, and the wheel steps by 10% of the zoom instead of the engine's +0.1. The review measured the jump on 1809cf3, before wave 3b's wheel (W3-11); this is what was left of it.
  - W5-21: every camera move of 3b's members and of the navigation feature is immediate under `prefers-reduced-motion: reduce` (the zoom keys and menu, fit, go to frame, search results, the minimap, and 3i's Alt+Arrow through `ensureVisible`). `ensureVisible` also keeps the zoom for an item that fits the view: Alt+Arrow zoomed out for one that did not fit with its 64 px margin.
  - W5-33 (3b's part): the board menu's View submenu (zoom in, zoom out, 100%, fit, selection, the minimap).
  - W5-39: a connector selected by a `?el=` link or a search result gets Lobby's outline; the engine draws none for a code selection (its handles: CR 3b-11).
  - W5-54: "Back to content" (tldraw's helper button) when the view holds none of the board's content.
  - W5-58: a template inserted by `?template=` is never selected, so the live region no longer says "6 shapes selected" on a board where nothing is.
  - W5-06 and W5-46 (the zoom control over Select at 390-412 px, and at 720 × 450 with a dock panel open): already gone since wave 3b (the navigation slot above the tools' row, the quick-actions strip right of it). `navigation-keys` PRI-13 now checks that each control's centre is that control.
- **Partial:** paste as notes still makes the new-note face (3b can use `LobbyTx.insert` for the pasted-note face); a touch two-finger pinch still stops at Excalidraw's 0.1, and a pinch out from below 0.1 snaps in to it (CR 3b-10, 2C's touch input); only owners can set the start view (CR 3b-3); a locked frame keeps its place in the order (CR 3b-4); only frames are cached (a heavy board of loose elements gains nothing below 0.2) and the eraser's fade is not drawn on culled elements; the "≥ 30 fps at 0.25 and 1 with sync running" gate is at its edge at 0.25 (27-32; the port's element scans on every camera move, CR 3b-8); the cull reaches `RenderOverrides` through a Proxy until CR 3b-5 (W3-14).

### 4.3 Comments, people, follow, present to everyone (3c) — ported

- **Ported:** the comment tool (C), pins, hover preview, composer and threads, replies, edit and delete, resolve and reopen, mentions and their notices, the dock panel with filters, the notifications bell, the `?thread=` deep link, team-only threads, orphans, Shift+C; `canvas.follow`; the people item with avatars, the list, Follow / Following, Bring here, Bring everyone to me; present to everyone (invitation, chip, hand-off, reloads, api restart), **running on present mode since the integration**; a thread re-attaches when its note comes back from Recently deleted (since the spike merge).
- **Fixed at wave 5** (the early review's 3c items, `docs/research/excalidraw/wave5/3C.md`): the composer and the thread popover (on a phone, the bottom sheet) are drawn above the board's chrome, so the tools, the navigation slot and the floating ≡ no longer cover the reply box or Post / Reply, and on a laptop a popover beside its marker ends above the toolbar's row (W5-07, 3c's part); a follower who stayed on after Gather keeps "Stop following" under the "is presenting" invitation (W5-23), as one flat button (W5-51); a follower who opens or closes their own dock panel is re-fitted on the leader's centre (W5-25, the follower's side); marker initials are 4.5:1 or more on read and unread faces, on both pages (W5-49).
- **Partial:** "who follows me" by camera needs a follow target in presence (CR-3C-1). Since wave 3b the context menu of an element that was not selected offers "Comment" (CR 3E-4, the integration). A dock panel the **leader** opens after their last pointer or camera move leaves followers off the leader's centre (320 scene units at zoom 0.5) until the leader moves: the board session does not re-send presence when its canvas resizes (CR-3C-W5-1, 2C, `people-follow` `test.fail`).
- **Deviations:** follow is by session and moves at once; the comment tool's cursor is a crosshair; Tab steps in plain reading order; the comment popovers are drawn in their own layer of the canvas region (above the host slots, below the context menu and the shortcuts dialog).

### 4.4 Mind maps and tags (3d) — ported

- **Ported:** mind maps (new map, from a shape, child/sibling/level, collapse with the B12 guards, Tidy up, branch delete with confirmation, arrow navigation, the layout keeper, outline export) and tags (the picker, chips, the panel, Show only, rename/recolour/delete everywhere, the CSV column through 3e, search by tag through 3b since the integration).
- **Partial:** (a name-only editor guest creates tags since wave A, CR-3D-5: the room takes its `tagDef:*` writes, 10 keys per guest while the room is open); typing on a selected topic does not start editing, F2 does (CR-3D-3); a new topic and its words are two undo steps (spike B now has `mergeTop()`; 2C's `joinPrevious` and 3d can use it); an invisible re-route step may appear (CR-3D-4).

### 4.5 Present mode, exports, export policy, thumbnails (3e) — ported

- **Ported:** present mode (slides in presentation order, skips, fullscreen with the in-window fallback, slide keys and list, the modal key trap, view restore, collaborators' edits followed, cursors hidden), the Export dialog (PNG 1×/2×/4×, SVG, copy as PNG, PDF with bookmarks and a text layer, CSV with tags and votes), the export policy store and share badge, thumbnails, and `export.*`.
- **Ported at wave 3b:** the context menu's Export as (PNG at 2× from the original, SVG with the preview; the test body was the last `test.fixme`); RETRO-03a's Present and export steps (no author label or cursor on a slide; no PNG or SVG names the author); "presentation is clean" with comment pins and the selection bar; the event stream surviving an api restart; export control on file cards (Download off and back for viewers, 403 from the api).
- **Fixed at wave 5** (`engine/w5f-3e`, `wave3/3E.md` "Wave 5 fixes"; REVIEW-W5-EARLY.md W5-14, W5-24, W5-30, W5-47, 3e's parts of W5-37 and D3): exports draw every file card's whole face (cover, chips, play button, page strip, conversion note, error, the footer's kind badge, name, size and status) in PNG, SVG, PDF pages and copy, where they drew a bare cover or the engine's grey placeholder; slides show no frame outline; the PDF text layer keeps the canvas's own lines, so no word is split and a search finds it (DEMO 3:30 holds); leaving present mode gives the keyboard back to the Present button, and the presentation shows a focus ring; an SVG's notes have tldraw's soft export shadow and no edge.
- **Deviations:** the fullscreen element is the canvas region; engine-drawn frame names add height to whole-board PNGs; the thumbnail schematic's images are grey tiles only where `files.urlOf` has no preview; slides have 6 px rounded corners and 2 px of each edge under the surround (until CR 3E-6); a card's face in an export is a bitmap, also in an SVG; notes in a PNG or PDF page keep the engine's hard shadow until 2C's note rendering (CR 3E-7).

### 4.6 Workshops (3f) — ported

- **Ported:** the timer (with the floating timer while presenting, **now tested**), dot voting (setup, click and keyboard voting, ballot privacy, results, badges, the Voting panel and CSV gate), +1, reactions, raise hand and the queue, session settings, Gather everyone (on 3c's follow, **now tested**), private brainstorming **including the reveal and Place notes** (CR 2F-2, since the spike merge).
- **Ported at wave 3b (3CF):** the note-author label (CR-3F-4: the workshops overlay layer `workshops-authors`, the first name from the server's `lastEditedBy` in the note's corner, hidden by "Hide note authors", below zoom 0.28 and on small notes); the readable follow of a gathered phone (R2-04, on the follow camera hook W3-10: "Gather everyone", "Bring here" and "Bring everyone to me").
- **Wave 5 (W5F, 3f; the review `REVIEW-W5-EARLY.md` ran on `1809cf3`):** a click while voting lands on the topmost object, as a click picks it (W5-03): one the vote does not take casts nothing and says "Not part of this vote: only sticky notes in “…” take votes.", where it used to vote for an object the vote takes hidden underneath (select and hand tools, the vote tool; the tldraw page had the same rule and the same fix). On a phone the workshop cards stand above 3i's Board actions button (the cards' part of W5-07). The +1 pill takes theme tokens (W5-49: 1.03:1 in the dark theme, both pages). The workshop items keep the tldraw page’s place: Timer, Voting and Reactions before Present and export, the Voting and Private notes panels before History (W5-50’s workshops part). W5-27 ("no note authors") is wave 3b's note-author label, which the review did not have; checked on this branch.
- **Partial:** a note made with N inside a frame does not join it (W5-01, 2C), so a frame-scoped vote does not take it (`workshops-voting` W5-01, `test.fail`); since wave A a +1 is no undo step (CR-3F-1 = W5-26, `TransactOptions.skipUndo`) and works on locked notes (CR-3F-2, the room's `lockExempt` keys); R2-04 reads the leader's zoom from the canvas size sent with the summon, so it drifts if the leader's canvas height changes afterwards (a zoom in presence, CR-3CF-1); the label has no hover tooltip (the full name is its `title`) and exports never draw it.

### 4.7 Media (3g) — ported

- **Ported:** file cards (cover, pages, status, Office note, video player, Download), image and page placeholders, paste/drop/Ctrl+U with today's drop layout (grids, frames, template slots, F12), the PDF viewer and Place on board, open original, download originals, `files.urlOf`/`insert`, the derivative swap.
- **Since wave 5 (3g, `engine/w5f-3g`, review W5-12, W5-13, W5-36, W5-56, D2):** phone photos land in their EXIF orientation (W5-12: the drop layout and slot fit read the header's Orientation, as the worker's auto-oriented derivatives do); **Replace media** (an image or a card keeps its element, so its thread, tags, frame and slot; one undo), **Crop** (Excalidraw's crop editor through `files.crop`, CR-W5-3G-1, always in the thumb's pixels) and **Alternative text** (`customData.lobby.alt`) in the selection bar and the context menu (W5-13); the uploading tab's **local preview** while uploading and while processing (W5-56, this tab only, never stored); new cards are rounded on the canvas too and card faces and placeholders follow the dark theme (W5-36); **link cards** for pasted URLs (D2, W5-18): the page's title and icon read by the api (`POST /api/boards/:bid/link-preview`, SSRF rules, time and size limits), the face drawn by the media overlay, a new-tab link, no third-party request or script on the board.
- **Partial:** the cross-workspace image paste check (plan §2.10.4) needs a paste hook from 2C; exports saw the engine's placeholder for cards without a preview (fixed at wave 5: every export draws the card's whole face, §4.5); a viewer's drop is silent (spike B's input); the derivative swap does not reliably stick on the page (CR-W5-3G-3, 2C), so images are often drawn from their 512 px thumb at any zoom, and `media-edit`'s crop-after-upgrade test skips itself when the upgrade does not hold; Enter does not end a crop (Escape or a click does, CR-W5-3G-4).
- **Deviations:** the card face is a DOM overlay (only opaque elements above it cut holes); a cropped image stays on its thumb; slotted images land on top (no insert-at-index); a link card's double-click edits its words (its ↗ link opens it); a card made before wave 5 keeps square corners.

### 4.8 History and AI (3h) — ported, partial for connector re-binds

- **Ported:** the History panel (checkpoints, restore as new board, duplicate, .json export, automatic checkpoints), the bitmap checkpoint preview, the export gate; AI (themes, summarize, action items, ideas, budgets, the owners' switches, the Undo toast) through **3a's selection bar, context menu and board menu since the integration**.
- **Partial:** Recently deleted restores through the open room (CR 2F-2, since the spike merge), but a restore does not re-bind a live connector to what it brings back (DEF-W3-1, 2 `test.fail`); a template's prompt notes placed by a person count as typed (R9, CR-3H-2); a v1 (tldraw) checkpoint shows "can't be previewed here yet".
- **Not ported:** the backup restore drill (backups are off on the Excalidraw stack until 2B moves them to `lb_*` files).
- **Fixed at wave 5** (3h, `engine/w5f-3h`; `wave3/3H.md` §7): W5-04, "Group into themes" with a note made with N among the ideas (W5-01 leaves it outside the frame's membership) took the ideas out of the frame. Membership is now read from where a loose note lies, the clusters go to the frame most of the notes are in (the regroup question still asks, the frame grows and comes into view, the labels share one line, no note leaves its frame), so DEMO 1:20 → 2:45 → 3:30 holds again: `ai-actions` runs it in that order, with Present's slide 2 and the PDF's page 2. W5-47's AI half: closing the summary from the keyboard gives the keyboard back to the AI button (present mode's half is 3e's).

### 4.9 Accessibility and mobile (3i) — ported, partial for chrome keys

- **Ported:** the live region, keyboard traversal (F6, Alt+arrows, into and out of frames), the Contents panel, the phone sheet, palette contrast, the named canvas, the skip link; 12 of 3i's cross-feature tests **now pass against the other owners' features**.
- **Partial:** undo does not restore the selection (spike B history, `test.fail`); axe is not a dependency (CR-3I-1, the audit spec stands in). Ctrl/Cmd+Z, Shift+= and the zoom keys from the chrome and Ctrl+X on the canvas pass since wave 3b (3a, 3b).
- **Finding:** the red note's ink is 3.43:1 through Excalidraw's dark filter (below AA).
- **Since the early wave-5 review** (3i's fixes on `engine/w5f-3i`; `REVIEW-W5-EARLY.md`):
  - Board actions (≡) steps aside while a workshop card or a docked comment sheet is up (W5-07).
  - Every phone control can be tapped where it is drawn at 390 and 412 px, checked with `elementFromPoint` (W5-06). The wave-3b corner chrome (2C) and quick-actions strip (3a) had already fixed it.
  - The a11y feature's camera moves honour reduced motion (W5-21: Alt+Arrow, F6, the phone sheet's Zoom to fit).
  - The live region says a tool change politely and says the selection again when an edit ends (W5-43). A selection that comes and goes at once is not heard (W5-58: "6 shapes selected" on a template board).
  - The board shows a focus ring when the keyboard arrives (W5-45).
  - The engine's text editor is named ("Sticky note text"), and a heading is read before the line under it (W5-59).
  - The application's name comes from the board's title, so 2C can rename the region (W5-57).
  - Contrast is now checked on the rendered pixels as well (`a11y-contrast`: frame names, outlines, the canvas colour, dark-mode notes). Those 5 tests are expected failures until 2C's theme lands (W5-10, W5-15). They measure the reviewers' numbers on this tree: frame name 2.85:1 light and 4.36:1 dark, outline 1.92:1 and 2.18:1, red note 3.55:1 in dark mode.

### 4.10 The board page and guests (2C) — ported

- **Ported at wave 3b:** the guest flow's specs (`guests.spec.ts`, `guests-2.spec.ts`, the Share-dialog parts of `sharing-polish` and `workshop-copy`: joining by a name-only link on a phone, the people list and Share dialog, a guest's comment and note with the server's attribution, the refusals, revocation, "Not you?"); the phone corner chrome (the board menu right of the dock's fold button at 600 px or less, the navigation slot above the tools' row below 800 px, and since the integration the quick-actions strip right of it); the cursor name label capped at 120 px.
- **Partial:** a window resize does not bump the viewport signal (CR-3A-10; canvas-ux measures the container instead).

## 5. Parity with today's tldraw app (refreshed 2026-10-03, wave C6)

Every feature in `docs/PROGRESS.md` and `docs/DEMO.md`, as it stands on the Excalidraw board page at `release/held`
99ac6c52 (`main` 23a36bbd, which is what staging runs after wave C, plus the held release: migration 0024 and push
receipts, built and gated but not deployed when this was written). This section was first written after the wave-5
feature integration (2026-09-30), when the engine owners' branches were not yet merged; they merged the same day
(`W5-ENGINE.md`), and waves 4 to C followed. "Today's tldraw app" is R0 (`lobby-r0`, 38d3833), which staging ran until
2026-10-01 and which is no longer built. The finding-by-finding status is in `REVIEW-W5-EARLY.md` §12. "Outside the canvas"
means the feature is not part of the board page and was never a canvas port.

How to read a row: **ported** = works on the page with its spec passing; **held** = built and gated on `release/held`,
not deployed; **open** = named in "What is missing". Evidence is the spec under `e2e/excalidraw/` (or the unit test)
that pins it. The whole Excalidraw suite on chromium at the held head: 553 tests, 551 passed, 0 failed, 2 skipped (the
heavy-board measurements `present-export-heavy` and `navigation-lod-fps`), one expected-failure mark
(DEF-GAPS-1, below) counted as passed (`docs/PROGRESS.md` 2026-10-03, "Gate on the held head"; run on 4232eccb, and
99ac6c52 adds only the CR-2B-2 revert and the DANA-01 test fix). On 2026-10-03 the demo-chain specs were run again at
99ac6c52 plus docs: 165 distinct tests in 23 spec files passed, 0 failed, with the one DEF-GAPS-1 expected failure (`docs/DEMO.md`, "Last checked").

| Feature (source) | On the Excalidraw page | Owner | Evidence (e2e/excalidraw) | What is missing, and the blocker |
|---|---|---|---|---|
| Two people on a board: cursors, avatars, live edits, reload, restart, offline (M0, DEMO 0:30-1:00) | ported | 2C, spike B | `board-*`, `collab-*`, `sync-durability`, `board-drag-arrows` | A bound connector follows another person's drag live, drawing only (W5-08 / D1, `594cc4d`, DEMO 1:00). Other people's selections are drawn and an off-screen collaborator has an edge marker (below). Heavy boards: measured on Lobby's page 2026-10-03, p95 edit visibility at 100% 185 / 177 / 208 ms, 58 fps at fit with the LOD pass (`spike-b/PERF.md`). **Open:** after `POST /archive` the owner's open tab shows "Change not saved" (READ_ONLY) although nothing changed (DEF-GAPS-1, an expected-failure mark in `gaps-board-status.spec.ts:122`, needs an owner in the sync core's `engine.ts`) |
| Other people's selections; edge markers for off-screen collaborators (plan §2.7, §4.3; W5-28, W5-32) | ported (wave A, A2; wave B, B3) | 2C | `board-presence` | outlines in the person's colour under their cursor, hidden with Hide cursors, in focus mode and during a vote (`chrome.tsx` `RemoteSelections`); an initials chip per off-screen collaborator (nearest 10), click = one camera move, Shift-click = follow (`edge-markers.ts`). Chips do not avoid the phone sheet or the floating selection bar (wave B follow-up 4) |
| Same-note typing: the lease (M0, DEMO checklist 7) | ported (wave 2) | 2C, spike A/B | `collab-conflicts` | — |
| Saved indicator, per-property undo, leave guard (validation phase) | ported | 2C | `board-saved`, `sync-durability`, `doc-key-lost-write` | "Offline — N changes" counts a note and its label as one change (OFFLINE-COUNT): **held**. A write that never reached the room now goes again and beats a later write by someone else, with no notice, the way an offline edit does (push receipts, `CONTRACTS_REV` 11): **held**; on the deployed rev-10 room the later write stands and the person is told |
| Server-enforced roles, forged writes refused, revocation (M1) | ported | 2A (O1), contracts, 2E | `permissions-canvas`, `security-negative`, `workspace-members` | deleted notes' text and authors no longer reach any role: tombstones are redacted on the wire (W5-02, `c96cc5f`, `CONTRACTS_REV` 7/8). The guest cap is per guest uid (500, D5) plus a board-wide budget for every guest uid together, `GUEST_BOARD_ITEM_CAP` = 6,000 (wave A, A1). Owners and admins manage workspace members: change, remove, last-owner rule (wave B, B5, authz-006). Offboarding is not complete: a leaver's invitations, links and pending requests survive (wave B follow-up 6) |
| Toolbar, tools, style panel, 13-colour note palette (Miro phase) | ported | 3a | `canvas-ux-toolbar`, `canvas-ux-tools`, `canvas-ux-review`, `canvas-look` | connectors end on the shape's outline (W5-11); Straight after Elbow draws straight (W5-40, wave B, B2); with the note or text tool armed the style panel sets the next note's or text's colour, size and font (CR-3A-7, wave C, C1); the laser works for read-only roles (CR-3A-8, engine merge). **Open:** note labels and free text share one next font size, so after a note's L the next free text is 26 pt (C1 follow-up 3); arrowheads are about twice tldraw's size (W5-53, below); the polygon tools (D4) draw Lobby's own v1 outlines, which differ from converted shapes by up to 57 px (W5-33 D4: CR-2B-2 was reverted from `release/held` for licence, `841d6dc9`) |
| Arrowheads and bound-connector gap (W5-53, CR-W5-3A-2) | partial, **held** (wave C, C2) | 3a, 2C | `binding.test.ts`, `test:arrows` | one binding gap, the engine's own, is in the held release; the head size by stroke width needs a patch of `@excalidraw/element` through the catalog: **open** |
| Miro shortcuts: L, P, Alt+1/2, Ctrl+0, Ctrl+Shift+L, M, Ctrl+F (Miro phase) | ported | 3a, 3b | `canvas-ux-keys`, `navigation-keys` | — (`docs/SHORTCUTS.md` is the staff-facing list) |
| PgUp/PgDn z-order (Miro phase) | ported (engine merge, CR-3A-3, `da7da3df`) | 3a | `canvas-ux-keys` MAK-06 (no expected-failure mark) | — |
| Guides and snapping on by default (Miro phase) | ported | 3a | `canvas-ux-canvas` | — |
| Type-to-edit notes, Enter/Esc flow (Miro phase, RETRO-02) | ported | 3a | `canvas-ux-keys`, `mindmap-keyboard` | a printable key on a selected mind-map topic starts editing it (CR-3D-2, CR-3D-3, wave C, C3) |
| Context menu, board menu, shortcuts dialog, selection bar, lock, align, quick actions (persona fixes) | ported | 3a | `canvas-ux-menus`, `canvas-ux-canvas`, `canvas-ux-duplicate`, `canvas-ux-tools`, `canvas-ux-review`, `viewer-copy`, `input-touch-wheel` | viewers and commenters copy a selection's text where the export policy allows (CR-3A-4, wave A, A4); Board ▸ Preferences ▸ Input device (Auto, Mouse, Trackpad: a local setting, never synced; under the default Auto a mouse-wheel notch zooms where it used to pan; the Auto guess ignores `devicePixelRatio`, so a mouse under 125% display scaling probably still pans, reasoned not measured) (W5-33, wave B, B2); Alt+D has no key (the browser's) |
| Paste as sticky notes (Miro phase) | ported | 3b | `navigation-paste` | pasted notes take the new-note face (not re-checked at C6) |
| Template picker and insert, Lobby tour, `?template=` (Miro phase, DEMO 0:00) | ported | 3b, 2D | `navigation-templates`, `templates-frames`, `gaps-board-status` (DEMO 0:00 to 4:45) | undoing a template insert removes it for everyone (DEF-W3-2, engine merge); a moved template frame carries its locked heading (W5-05, `c96cc5f`; the lock rule is one-way: a frame moved alone leaves its locked members behind, accepted as a design limit at wave 4b, plan §2.4.3 step 5); the six workshop templates mark their prompt notes so Group into themes leaves them alone (R9, CR-3H-2, wave A, A5). The templates' notes are sharp; new rectangles are sharp too (W5-52, wave B, B2) |
| Fonts: no serif, no mono, no bold (review W5-16, W5-17; decision D3) | ported | 2D, 2A | `templates-frames`, `present-export-files` (D3) | no bold and no serif face is an accepted loss (D3). The templates' headings are Lilita One (family 7), accepted by the room since `CONTRACTS_REV` 7; an SVG export embeds it (`present-export-files` D3 passes) |
| Frame outline with reorder, frames panel (Miro phase) | ported | 3b | `navigation-frames`, `locked-customdata` | a locked frame can be reordered and skipped in the presentation by an account (CR 3b-4, wave A, A1) |
| Board search (Miro phase), tags in search (wave 4) | ported | 3b, 3d | `navigation-links`, `tags-panel` | — |
| Copy link to selection, deep links (Miro phase) | ported | 3b | `navigation-links` | `?el=` / `?view=`; legacy `?d=` still opens; a code-selected arrow or line gets the engine's point handles (W5-39, wave C, C1; a read-only session gets Lobby's outline) |
| Start view (Miro phase) | ported | 3b | `navigation-start-view` | owners only: accepted as a deviation (CR 3b-3, kept owner-only under the detail-level rule); a first visit right after the write sees the new one (DEF-3F-1 fixed) |
| Minimap, zoom menu, arrange as grid, select by type (persona fixes) | ported | 3b | `navigation-keys`, `navigation-arrange`, `input-touch-wheel` | a two-finger touch pinch goes below 0.1 down to the whole-board fit (CR 3b-10, wave B, B2; a real iPad check is an owner item, P10); the board menu's View submenu and "Back to content" (W5-33, W5-54) |
| Zoomed-out boards: level of detail (plan §8.5) | ported (wave 3b) | 3b | `navigation-lod`, `navigation-lod-fps` (opt-in, `LOBBY_MEASURE_FPS=1`) | **measured 2026-10-03** on Lobby's page with the 200 images loaded: fit 58.7 / 58.3 / 58.0 fps with the pass (12.7-13.4 without), 0.25 at 48.7 / 49.5 / 53.0, zoom 1 at 60 / 59.3 / 59.3: the gates are met (`spike-b/PERF.md`). Frames only; the cull no longer goes through a Proxy (CR 3b-5, engine merge) |
| 20k shape cap (Miro phase) | ported (server) | O1 | canvas-schema `limits.ts` | — |
| Comments: tool, pins, threads, replies, resolve, mentions, panel, bell, orphans, Shift+C (Miro phase, DEMO 1:40) | ported | 3c | `comments-core`, `comments-review`, `comments-privacy`, `comments-notify`, `comments-stacking` | an approved access request lands in the requester's bell (PRI-09b): **held** (migration 0024). The role-change toast names who changed the access only for the member PUT/DELETE flow (REVIEW-6, partial) |
| People list, follow, "who follows me" (wave 4) | ported | 3c | `people-list`, `people-follow` | "Following you", "N following you" from the room's `followers` list (CR-3C-1, `CONTRACTS_REV` 10, wave A, A2); a follower of a leader who opens a side panel is re-fitted (W5-25, wave A, A4). Past 41 sessions the room re-ranks the 40-cursor cap by view and always delivers the followed peer (PRES-CAP); that re-rank is what made L1's CPU and event loop heavier (`spike-b/B9.md`) |
| Present mode: frame by frame, chrome/cursors/pins hidden (Miro phase) | ported | 3e | `present-export-present` | a slide is its frame's exact rectangle (W5-24 residual: focus mode turns the engine's frame outline and names off, wave A, A4) |
| Present to everyone: invite, join, hand-off, follow in step (wave 4, DEMO 2:45) | ported | 3c, 3e | `present-live` | a late joiner or a reload no longer lands on the first frame: `presentationOwnsCamera` ends the first view's hold (PRESENT-LIVE, wave B, B3; `present-live` 120/120 over `--repeat-each=20` on the branch) |
| Export PNG / SVG / PDF / CSV, copy as PNG, Export as from the context menu (Miro phase, DEMO 3:30) | ported | 3e, 3g | `present-export-files` | file cards are drawn in full in every export and the PDF text layer keeps whole words (W5-14, W5-30); PNG, PDF pages and copy draw notes with the soft shadow and no outline, like the SVG (W5-37, wave C, C3; a context patch keyed to the engine's drawing, so re-run `c3-polish` W5-37 after any Excalidraw upgrade); the PDF can end with a "Vote results" page and a "Comments appendix" (RETRO-05b, wave B, B3; no action-items model exists, so comments only) |
| Export policy: viewers and commenters cannot export (wave 3, DEMO safety) | ported | 3e, 3a, 3g | `sharing-export-control`, `sharing-share-dialog` | name-only guests never export or download originals unless an owner turns on "Guests who joined with just a name can export and download too" (L3, wave 4b, 2F; migration 0023) |
| Thumbnails (wave 3) | ported | 3e | `thumbnails-capture` | — |
| Timer (Miro phase) | ported | 3f | `workshops-timer` | — |
| Dot voting with frame scope, notes only, ballot privacy, results (Miro phase, DEMO 2:00) | ported | 3f | `workshops-voting` | a note made with N inside the vote's frame joins it and takes votes (W5-01, engine merge); a click on something the vote does not take casts nothing and says so (W5-03). A vote over a selection of frames and objects (RETRO-10): **held** (migration 0024, the `x-lobby-client` header; the pre-0024 web reads it as a board vote) |
| Gather everyone (Miro phase) | ported | 3f, 3c | `workshops-follow`, `a11y-phone-overlays`, `people-follow` | a gathered phone gets a readable zoom (R2-04); a follower of a leader with a side panel open is re-fitted (W5-25, wave A, A4) |
| Reactions, raise hand, +1 (wave 4 polish) | ported | 3f | `workshops-facilitation` | a +1 is no undo step and works on locked notes (CR-3F-1 = W5-26, CR-3F-2, wave A, A3 and A1) |
| Session settings: hide cursors, hide note authors, the note-author label (review rounds) | ported (wave 3b) | 3f, 3e | `workshops-facilitation` | the label is an overlay: no hover tooltip, never exported. A joiner right after a change gets the new settings (DEF-3F-1, fixed) |
| Private brainstorming (wave 3, DEMO "more to show") | ported | 3f | `workshops-private-notes` | — |
| Files: images, PDF cards with pages, video, Office previews, attachments; Ctrl+U, drop, paste (M0, M3, DEMO checklist 8) | ported | 3g | `media-files`, `media-video`, `media-office`, `media-viewer`, `media-drops` | EXIF photos upright and a local preview while uploading (W5-12, W5-56); the clipboard's images from another workspace's board are left out, with a notice (CRIT-38, wave B, B5); a zoomed-in uncropped image stays on its 2,048 px rendering (the swap holds, CR-W5-3G-3, wave A, A5); cropped images (the mood-board and storyboard slots) stay on the 512 px thumb (a known limit); a read-only person's PDF viewer has no checkboxes or footer (F5 residual, wave C, C3); a tap on "View pages" no longer clicks the PDF viewer that opens under the finger (`4cc22cc8`) |
| Replace media, Crop, Alternative text (tldraw's image toolbar; the client-review loop) | ported (wave 5, W5-13) | 3g, 3a (menus) | `media-edit` | Enter ends a crop (CR-W5-3G-4, wave C, C3) |
| Embeds, bookmarks: pasted URLs (tldraw's embed and bookmark shapes) | link cards (D2) | 3g | `media-links`, api `link-preview.test.ts` | no live embeds, by decision (a link card with title and icon, opened in a new tab; no third-party script). An animated GIF has a play chip and a double-click player that loads the original only when opened; the canvas and exports keep the still (F9 / FIL-08, wave C, C3) |
| Mood board slots, drop layout (persona fixes, DEMO 1:50) | ported | 3g | `media-drops` | a slotted image lands on top (no insert-at-index) |
| Named checkpoints, restore as new, duplicate, JSON export/import, automatic checkpoints (Miro phase, wave 4, DEMO 4:00) | ported | 3h | `history-checkpoints`, `history-copies` | a checkpoint saved before the switch previews converted ("shown converted to the new canvas"; the stored body is never rewritten) (PARITY-5.5, wave B, B4) |
| Recently deleted and its restore (Miro phase, DEMO 4:00) | ported | 3h | `history-deleted` | a restore re-binds live connectors whose free end is still within the binding gap + 10 px of the restored target, in the same server write (DEF-W3-1, wave B, B4); converted rows are grouped by (origin, batch), so a converted frame no longer swallows an unrelated live deletion (M3P3) |
| Backups and the restore drill (Miro phase, wave 3) | ported on the Excalidraw stack | 2B | `backups-2`, `offsite-backups` (ported at wave 4c) | element boards get their own local backups and offsite entries; the restore drill opens a `lobby-elements` backup through the element room's store (`apps/sync/src/backup/drill.ts`). Offsite backups share the api's R2 bucket and token: a separate least-privilege bucket is an owner item |
| AI: themes, summarize, action items, ideas, budgets, owner switch (wave 4, DEMO 1:20) | ported | 3h | `ai-actions` | template prompt notes stay where they are (R9); the DEMO 1:00 → 1:20 → 2:45 → 3:30 chain is a spec (W5-04). Output is plain text |
| Mind maps (wave 4, DEMO "more to show") | ported | 3d | `mindmap-keyboard`, `mindmap-structure` | a new topic and its first words are one undo step (CR-3D-4, wave B, B1); Escape after typing keeps the topic selected (W5-44) |
| Tags, Show only, tag panel (wave 4, DEMO "more to show") | ported | 3d | `tags-picker`, `tags-panel` | an editor-role guest creates tags: the room takes `tagDef:*` writes, at most 10 tag keys per guest uid while the room is open (the budget resets when the room is evicted or restarted); "Zoom to matches" on the filter bar (F2-08, wave C, C3); chips grow below 100% to keep about 11 px text (R2-10) |
| Name-only guests on a board, on a phone (wave 3, DEMO "more to show") | ported | 2C, 3c, 3f, sharing | `guests-join`, `guests-sharing`, `sharing-share-dialog`, `workshops-phone`, `present-live` | guests and reviewers see "People", not "Share", and a guest sees the workshop controls only while a session runs (DANA-11, F14, PRI-18, wave C, C3); a guest join on a trashed board is refused (GUEST-JOIN-TRASH, wave A, A6) |
| Accessibility: skip link, live region, keyboard traversal, contrast (review rounds) | ported | 3i, 3a, 3b, 2C | `a11y-*`, `canvas-ux-review`, `a11y-audit` | axe-core is a dev dependency since wave C, C4: 0 violations over sign-in, dashboard, board, the phone sheet and a viewer's board, light and dark (a planted violation proves it has teeth). Frame names, outlines and dark-mode note ink pass the contrast checks (W5-10, W5-15, engine merge); no "Back online" on every open (CR-3I-6, `9051294`); undo restores the selection (F11, wave B, B1); the canvas region is "<title> board area" and the engine's empty footer is `role=presentation` (W5-57, wave B, B5). **Not measured:** the contrast of the sign-in page's gradient text and the dashboard's owner-filter select and one-character card menu button (axe "incomplete", accepted per page) |
| Reduced motion for camera moves (review W5-21) | ported | 3b, 3i, 3e, 2C | `navigation-keys` W5-21, `navigation-frames` W5-21, `a11y-traversal` W5-21, `present-export-present` | every animated camera move is immediate under `prefers-reduced-motion` (`durationOf` returns null; wave A, A4). The shared `durationOf` in `handles.ts` was the last holdout (the backlog's W5-21 partial) |
| Phone layout (review rounds) | ported | 3i, 3a, 2C, 3c, 3f | `a11y-phone`, `a11y-phone-reach`, `a11y-phone-overlays`, `workshops-phone`, `board-phone`, `canvas-ux-tools`, `canvas-ux-review`, `comments-stacking` | the top bar fits 320-412 px and the ⋯ menu has no empty "On this board" row (W5-31, W5-50, wave A, A4); on a coarse pointer or at 600 px or less other people's cursors show without name tags (R13 residual, wave C, C1). 44 px tools mean fewer at 390 px than tldraw's. A real phone has not been walked on staging (owner item P10) |
| Dark-mode colours (early wave-5 review W5-15) | ported (engine merge, `00abafb`) | 2C, 3i | `a11y-contrast`, `canvas/engine/theme.test.ts` | one deviation: a Paper note is a dark paper with light ink in dark mode |
| Dashboard, template gallery, sharing dialog, links, access requests, invitations (Miro phase) | outside the canvas | — | default suite | the dashboard's sidebar no longer inverts after a board visit (W5-09); the Share dialog lists workspace members, collapsed (authz-006) |
| Search across boards (wave 4) | outside the canvas | — | default suite | the api reads elements (2F) |
| Email sending, Kanban, DBC Ops, "see what changed since your last visit" (not built) | not built on either page | — | — | — (owner decisions) |

## 6. Blockers: what was open, and where each stands (rewritten 2026-10-03, wave C6)

This section first listed, by owner, what blocked the cut-over (data loss, a demo step that does not work, a go/no-go
gate). The cut-over is done (2026-10-01 20:43-20:56Z, `docs/CUTOVER-LOG.md`), so it now answers two questions: what
closed, with its evidence, and what is still open. The state is `release/held` 99ac6c52 unless a row says otherwise.
**Deployed** means on staging (`main`: waves A, B1-B5 and C1/C3/C4/C5 at 0644365, 99d902c and 9627f29; CUTOVER-LOG §7);
**held** means built and gated on `release/held` for after the R0 rollback window (about 2026-10-03 20:55Z) and not
deployed when this was written.

### 6.1 Closed

| When | Closed | How, and the evidence |
|---|---|---|
| Wave 3 integration (spike B part 3, `c171f19`, W3-9) | the lost-edit / lost-create race, the drag-recolour overwrite, the offline-queue window; CR 2F-2 (private-brainstorm reveal and Recently-deleted restore on an open board); CR-2D-1 and CR-2D-2 (the lock scope; `LobbyTx.insert`, so the template insert and the Lobby tour) | §1-§3; `collab-conflicts`, `workshops-private-notes`, `history-deleted`, `navigation-templates` |
| Wave 3b | the follow camera hook and R2-04 (CR-3F-3); the note-author label (CR-3F-4); the highlighter and the viewers' Hand (CR-3A-6); wheel deltas (CR 3b-2); 3i's chrome keys and Ctrl+X; the level-of-detail pass; a phone toolbar like tldraw's; the guest flow's specs; the context menu's Export as (CR 3E-4) | §7 |
| Wave 5 feature integration (2026-09-30) | 36 of the early review's 59 findings at that time, with their regression tests | §8, `REVIEW-W5-EARLY.md` §10 |
| Engine merge (2026-09-30, `W5-ENGINE.md`) | **W5-01** a note made with N or T joins its frame (`da7da3df`); **W5-02** deleted notes' text and authors no longer reach any role (`c96cc5f`, `CONTRACTS_REV` 7/8); **W5-05** a moved template frame carries its locked heading; **W5-08 / D1** bound connectors follow a remote drag, drawing only (`594cc4d`); **W5-10, W5-15** the engine theme (`00abafb`); **W5-16, W5-17** family 7 in the room's allowlist; D5 the guest cap per uid; DEF-3F-1; DEF-W3-2; CR-3A-3 (`index` writes reorder); CR 3b-5, 3b-7, 3b-8, 3b-9; CR-3A-8 (laser for read-only roles); CR-3A-10; A11Y-14 / CR-3I-6 (`9051294`) | `REVIEW-W5-EARLY.md` §11; `board-frames`, `sync-room-tombstones`, `sync-room-frames`, `board-drag-arrows`, `a11y-contrast`; `apps/sync/test/element-room/wave5-2a.test.ts` |
| Wave 4 and 4b/4c (2026-10-01) | the cut-over gaps G1-G10 (boot maintenance, the production build, the CSP's inline script and zod, the final-backup digest, the `engine_migration` checkpoint, the R0 row contracts, the rollback export, drop-legacy, the licence check); tldraw removed from the build; the doc-key lost-write rule (`CONTRACTS_REV` 9, V1 rounds 4 and 6); the guest export rule L3; the six retired default-suite specs ported | `docs/EXCALIDRAW-CUTOVER.md` §1; `docs/PROGRESS.md` 2026-10-01 |
| Wave A (deployed 2026-10-03 08:02-08:07Z) | **CR-3C-1 / CR-3CF-1** the follow target and the 40-cursor cap re-rank (`CONTRACTS_REV` 10); **W5-28** other people's selections; **W5-26 / CR-3F-1** a +1 is no undo step; LEAD-foldFix-indexOf; **UNDO-group-redo**; **W5-25** presence re-sent on canvas resize; **W5-24 residual**; **W5-21** reduced motion for every camera move; **CR-3A-4** viewers copy text; **W5-31, W5-50** the phone top bar; **CR-W5-3G-3, -2** the display swap holds; **CR-3H-2 / R9** template prompt notes; **CRIT-18** sign-out purges the offline queue (on the person's own Sign out only); **CR-3F-2 + CR 3b-4** +1 and reorder on locked notes and frames; **CR-3D-5 / W5-29** guests create tags (10 keys per guest uid per room life); **CR-W5-FIX-3 / W5-35** `GUEST_BOARD_ITEM_CAP` 6,000; P-W5 (the undelete pv guard); GUEST-JOIN-TRASH; AUDIT-INTERNAL-SCOPE; SCA-3 + CSD-4 + FC-3; SEC-M3-storage-review | `docs/PROGRESS.md` 2026-10-02 and "Follow-ups before deploy" |
| Wave B (B1-B5 deployed 2026-10-03 10:55-10:59Z) | **F11** undo restores the selection; **CR-3D-4** no invisible undo steps; **CR 3b-10 / W5-19** touch pinch below 0.1; **W5-33** Input device; **W5-40** Straight after Elbow; **W5-52** sharp new rectangles; **W5-32** edge markers; **PRESENT-LIVE** late joiner; **RETRO-05b** PDF vote results and comments appendix; **DEF-W3-1** connectors re-bind on a Recently-deleted restore; M3P3; **PARITY-5.5** pre-switch checkpoints preview converted; **L7** the ticket leaves the URL (`Sec-WebSocket-Protocol`); **authz-006** workspace members; **CRIT-38** paste hook; **W5-57** the board region's name and the engine's footer | `docs/PROGRESS.md` 2026-10-03 (wave B) |
| Wave C (C1, C3, C4, C5 deployed 2026-10-03 15:18-15:19Z) | **CR-3A-7** next note/text style; **W5-39** arrow handles for a code selection; **W5-38** one accent, a hover outline, frame names clear of the box; **W5-55** an editing outline; **W5-51** frame names do not overlap zoomed out; R13 residual; **Mermaid stubbed** (board route 1,159.7 → 978.1 KiB gzip); **W5-37 export half** soft note shadow in PNG, PDF and copy; **DANA-11 + F14 + PRI-18**; **F2-08**; **R2-10**; **F5 residual**; **F9 / FIL-08** a GIF player; **CR-3D-2 + CR-3D-3** type-to-edit on a mind-map topic; **CR-W5-3G-4** Enter ends a crop; **AXE** (`@axe-core/playwright`, 0 violations); the node-safe and engine-probe typechecks and the addFiles probe; the e2e harness (Chromium-unsafe ports refused, `csp:cutover` takes `E2E_PORT_BASE`, the eight gap-pass specs, the facade's `doc`/`setDoc` verbs) | `docs/PROGRESS.md` 2026-10-03 (wave C) |
| Wave B/C held (not deployed) | **RETRO-10** a dot vote over a selection and **PRI-09b** an access-granted bell item (migration 0024); **W5-ENG-2** push receipts (`CONTRACTS_REV` 11); MINOR abuse-code; OPEN16 (the room re-checks maintenance after the body is read); OFFLINE-COUNT; DEAD-barrels; the live smoke reading `render.yaml` | `docs/PROGRESS.md` 2026-10-03 ("The held deploy"); gate: unit 5,028 passed, e2e 551 passed / 0 failed / 2 skipped, 0024 on a real Postgres |
| Wave C6 (this round, 2026-10-03) | **W5-34 / G11** the heavy seed's images load, and the heavy-board numbers are re-measured on Lobby's page: edit visibility p95 185 / 177 / 208 ms against the 250 ms gate, fps gates met; **REALPG** the api suite on a real Postgres (1,176 passed on Windows and again on the NAS); **SYNC-4** the B11 divergence is explained and reproduced with a test (the fix `bf45f19a` is on `wave-c6/b11`, not merged) | `spike-b/PERF.md`, `spike-b/B9.md`, `spike-b/B11.md`; `SYNTHESIS.md` §12, §13, §21 |

### 6.2 Open now

| Item | State | Where |
|---|---|---|
| **L1 capacity on the 0.5 CPU / 512 MB plan** | **Measured and missed** (one NAS run at 99ac6c52): server event-loop p99 115.1 ms after the restart and 56.5 ms before the kill (target ≤ 50); steady-state CPU of the quota mean 62.4 %, max 91.8 % (target ≤ 80 %); the restart and conversion windows 97.1 and 98.9-109.3 %. Cause profiled to the rev-10 presence re-rank (`PresenceHub.rank`, `a5e8eb6`). Server acks, restart (5.0-5.4 s for 260 sessions), RSS and 0 acked-but-missing hold. No owner acceptance of the misses is recorded; Render's own commit latency is unmeasured | `spike-b/B9.md` "Re-run on the release/held head"; `SYNTHESIS.md` CAP-5, CAP-6 |
| SYNC-4 (B11 divergence) | explained; the fix (`bf45f19a`, one predicate in `LobbyEngineCore.applyScene`, 2 tests) is on `wave-c6/b11` and not in `release/held`. A new B11 finding: a headless rejoin waits 29-123 s late in a run (cause not determined) | `spike-b/B11.md` |
| DEF-GAPS-1 | a product defect: after an archive the owner's open tab ends "Change not saved" (READ_ONLY) and a fresh read-only open of an archived board pushes creates at base 0 (17 of 25 runs). Needs an owner in `apps/web/src/canvas/sync/core/engine.ts`; then remove the `test.fail` mark | `gaps-board-status.spec.ts:122`; wave C follow-up 1 |
| W5-53 | arrowhead size (about twice tldraw's) needs a patch of `@excalidraw/element` through the catalog; one binding gap is in the held release | `docs/EXCALIDRAW-CONTRACTS.md` row C2-1 |
| W5-33 D4 | the polygon tools draw Lobby's own v1 outlines (up to 57 px from converted shapes). CR-2B-2 moved a port of tldraw 5.4.2's geometry into the web bundle; the lead reverted it from `release/held` for licence (`841d6dc9`) | `docs/CUTOVER-LOG.md` §7 |
| CR-3A-9 seams (partial) | the caught-up signal (now possible on the rev-11 sync core) and the move of file-card's uploads to `canvas.files.track` | wave C follow-up (4) |
| REVIEW-6 (partial) | the role-change toast names the actor only for member PUT/DELETE; a no-op PUT also publishes the event, so the 60 s hint can name the wrong person | wave C follow-up (6) |
| C2 receipts, review minor | if the receipt INSERT fails inside its savepoint the push still commits with no receipt, and the next query reports it as never landed | `docs/PROGRESS.md` "Follow-ups for the held work" |
| Smaller known edges | the per-guest tag budget resets when the room is evicted; note labels and free text share one next font size; edge markers do not avoid the phone sheet or the floating selection bar; the Auto wheel guess ignores `devicePixelRatio`; a restored selection drops `selectedGroupIds`; `keepsPaintOrder` is quadratic for a mass re-key (5,000 elements 686 ms, 20,000 15.5 s); PARITY-5.5 converts a v1 checkpoint synchronously on the api event loop (about 1.7 s for 20k records); offboarding leaves a leaver's invitations, links and pending requests | wave A follow-ups (2), wave B follow-ups (1)-(6), wave C follow-ups (3), (5) |
| Testing and CI | CI has never run on GitHub or Linux; `audit`, `xbrowser` and the A3 step are continue-on-error; no Firefox result exists (it does not start on the dev PC); WebKit passes the smoke; `media-files` "7) uploads" is hardened but was never reproduced; `node --test apps/web/build/*.test.ts` and `scripts/smoke/render-yaml.test.mjs` run in no CI job | wave C (C4, C5) |
| Dependencies | 5 advisories inside `@excalidraw/excalidraw`'s own dependencies remain after two overrides, allowlisted by id in `scripts/audit-check.mjs` | wave A (A6); `docs/SECURITY-REVIEW-2026-10-02.md` |
| Owner items (not agent work) | a real iPhone, iPad Safari, Android and Mac session (P10: IME and CJK/emoji notes, pinch, Wi-Fi to cellular; it also decides any text-metrics recalibration); Clerk development to production with an identity-remap plan; email notifications (the from-domain); Clerk webhooks; the Shell checks of the conversion and the lossy counts' sign-off, then drop-legacy (about 2026-10-08); a separate backup bucket; Render's outbound pricing for large workshops; the asset collector's day-30 switch (about 2026-10-31); DBC Ops integration; Kanban; "what changed since your last visit"; the first GitHub Actions run | `docs/PROGRESS.md` 2026-10-03 (C6 entry) |

## 7. Wave 3b: the second pass, integrated

Five owners worked from `1809cf3` (the wave-3 tree) on what wave 3 left open, then `main` was merged with
bridge release R0. Each owner's own evidence is its report or `docs/PROGRESS.md` entry: 3b
`docs/research/excalidraw/wave3/3B-2.md`, 3e the "Wave 3b follow-up" of `wave3/3E.md`, 3CF `wave3/3F.md`
(D10, D13), 3a and 2C their 2026-09-30 entries. Runs are single runs plus reruns of what failed, on the
shared workstation (other agents' runs were going).

| | |
|---|---|
| Branch | `engine/excalidraw`, from `1809cf3` |
| Merged (`--no-ff`, in this order) | `engine/w3b-3b` `aaf2583` (`8787264`), `engine/w3b-3a` `d32b18d` (`f46af9e`), `engine/w3b-3cf` `21bf296` (`8661043`), `engine/w3b-3e` `219a500` (`e78c1d4`), `engine/w3b-2c` `c804c6c` (`43cf31e`), then `main` `2a4e5a6` (`724934d`). `spike/excalidraw` had not moved (`37bdfa9`, already in). Conflicts: `docs/PROGRESS.md` (all entries kept), the header comments of `workshops-facilitation.spec.ts` (3CF and 3e) and `a11y-phone-overlays.spec.ts` (3CF and 2C), and 17 files in the `main` merge (§7.2). |
| Integration commits | `863dec0`, `4582b68`, `a5e16da` (§7.3) and this report |
| Spike-owned folders | untouched by every owner and by the integration (checked on each branch's diff); `apps/sync/src/r0/**` (O4's) changed only to resolve the `main` merge (§7.2) |
| Lockfile, `pnpm-workspace.yaml`, catalog | unchanged |
| Ports | 6590-6599 only (`E2E_PORT_BASE` 6580 and 6567 with explicit `E2E_SYNC_PORT` / `E2E_API_PORT` / `E2E_WEB_PORT`, so the fake OpenAI of `ai-kit` (base + 10) and `a11y-kit` (base + 23) landed on 6590; 6594 for the second half and the default suite; `SPIKE_WEB_PORT` 6599, and 6590 for its rerun). Nothing listened in 6590-6599 afterwards. |

### 7.1 Change requests

Recorded in `docs/EXCALIDRAW-CONTRACTS.md` §12 as W3-10 (accepted) to W3-16.

| Rev | CR, commit | Decision |
|---|---|---|
| W3-10 | CR-3F-3, 3CF's `f229502` (`CR:`): `LobbyFollow.start(sid, {camera})`, and `SummonScreen` in `@draftroom/contracts` and the api | **Accepted.** Additive; the summon's canvas size stands in for a zoom in presence (CR-3CF-1). |
| W3-11 | CR 3b-2, 3b's `9f78782` (`CR:`): wheel and pinch `deltaX` / `deltaY` / `deltaMode` on `CanvasInputEvent`, from 2C's `board/input.ts` | **Accepted.** Additive. |
| W3-12 | CR 3b-6, 3b's `254aca9` (`CR:`): `viewport.fit` from 3b's navigation part | **Accepted.** Member table unchanged. |
| W3-13 | CR-3A-6, 3a's `a61408c` (`CR:`): `canvas/api/parts/tools.ts` behind `setTool` / `tool` | **Accepted**, with the highlighter's in-place stamp outside `transact` as a reviewed exception (create-only `kind` before the first push); the strict hook is a request to spike B. |
| W3-14 | 3b's level-of-detail cull through a Proxy of the engine API in 2C's `session.ts` | **Accepted as temporary** until CR 3b-5 in spike B's `RenderOverrides`. |
| W3-15 | integration decisions (§7.2, §7.3) | CR 3E-4 applied in 3a's file; the `main` merge's seam and api choices. |
| W3-16 | requests, not commits | **Recorded, not applied:** CR 3b-5, 3b-7, 3b-8, 3b-9, CR-3A-8, CR-3A-9, CR-3CF-1 (spike B), CR-3A-10 (2C), the R0 follow-up for the cut-over (2F with 2B). |

### 7.2 The `main` merge (bridge release R0)

R0 (on `main` since `38d3833`, live on staging) reviewed and shipped copies of spike B's A1/A2 routes, the
contracts' `sync-internal.ts` and O4's born-after check, and made the api refuse what the tldraw build
cannot read. This branch had the originals and the Excalidraw build's readers, so 17 files conflicted.
Kept both, as follows:

- **sync, the pre-open seam:** one list of checks, spike B's `engine-switch.ts`. R0's `r0/pre-open.ts`
  now re-exports its types, `BoardOpenRefused` and `registerPreOpenCheck` / `runPreOpenChecks`, and
  registers R0's born-after check when it loads; `rooms.ts` imports it, so the tldraw `RoomRegistry`
  refuses a board born on the new canvas whichever engine runs (with `DRAFTROOM_ENGINE=excalidraw` that
  registry stays idle). `born-after.ts` is R0's reviewed version (any `lb_*` table without `lb_meta` counts
  as born after, where the stand-in served it); `r0/index.ts` re-exports R0's check, and the spike's tests
  that unregister it still do. R0's `apps/sync/test/r0` tests and the spike's `test/migrate` tests all pass.
  Spike B (O4) should review this in `r0/**`.
- **sync, maintenance and run-all:** R0's routes are engine-neutral routes of the router; maintenance
  refuses new sockets before the engine choice, so on both engines, and closes element sockets too (they
  are in the same `liveSockets` map).
- **api:** this branch's api is the Excalidraw build's. Where R0 refuses the new canvas's content, it
  reads it: v1 and v2 checkpoint bodies (`readCheckpointBody`), `lobby-elements` snapshots
  (`boardSnapshotOf`, which still refuses an answer of neither format, R0's point) and `lobby-board`
  archives. R0's row-driven refusals (`body_version` 2; `boards.new_canvas` on tickets, duplicate,
  export, checkpoints) are kept and **dormant**: nothing on this branch writes those columns yet. The
  asset collector reads v2 bodies and, as R0 does, counts a body of neither format (or a v2 row) as
  unread and a converted board's partial `asset-refs` as an incomplete pass. Five of R0's api tests
  asserted the tldraw build's refusals of v2 content; they now assert this branch's reading of it
  (`gc.test.ts` 1, `new-canvas.test.ts` 2, `r0-fixes.test.ts` 2; the shared fake sync counts a
  `LobbySeed`'s elements).
- **web:** R0's `MAINTENANCE` copy replaces the older engine-side line in `SyncErrorScreen.tsx`
  (a duplicate key otherwise).
- **Before the cut-over** (2F with 2B): the Excalidraw build must write `body_version` 2 and
  `new_canvas` true (DEPLOY.md "Bridge release R0"; converted boards keep false) and, in the same change,
  drop R0's refusals of them from this api, which reads both.

### 7.3 Integration fixes

| Commit | Where (owner) | What was wrong | Fix |
|---|---|---|---|
| `863dec0` | `canvas-ux/ported/context-menu-open.ts` (3a) | CR 3E-4: a right-click on an element that was not selected selects it, but `select()` lands a render later, so the menu's `target.ids` was the old selection: no "Comment", no "Export as" | the target is what the right-click selected |
| `863dec0` | `canvas-ux/ported/ShortcutsDialog.tsx` (3a) | 3b's finding: `close()` focused the canvas while the modal `<dialog>` kept the page inert; the keyboard sometimes ended on `<body>` (a11y-3 flaky on `1809cf3` too) | the dialog closes first |
| `4582b68` | `canvas-ux/ported/toolbar-layout.ts`, `QuickActions.tsx`, `Toolbar.tsx` (3a) | 2C lifts the navigation slot above the tools' row below 800 px, 3a puts the quick actions there on a canvas of 840 px or less: the fit button covered the strip's Undo (2C's `board-phone` at 560 and 700 px failed; at 390 px half the button) | the room also measures the slot in the strip's band, and the strip starts right of it (`quickIndent`, unit test) |
| `a5e16da` | `e2e/excalidraw/canvas-ux-tools.spec.ts` (3a) | two layout tests asserted that the bar starts right of the navigation slot, true only while the slot is in the tools' row | they check that neither the bar nor the strip overlaps the slot |

### 7.4 Gate

Code under test: `a5e16da` (the e2e halves ran on `863dec0`; what `4582b68` and `a5e16da` touch was
run again on `a5e16da`).

| Check | Result |
|---|---|
| lint (`biome check .`) | PASS, 1,921 files |
| `pnpm -r typecheck` (15 projects) + engine-probe tsc + Node-safety tsc | PASS |
| `pnpm test` | PASS: **5,031 passed, 36 skipped** (464 files, 9 skipped) on `a5e16da`; 5,030 on `724934d` (after the `main` merge, before the layout test). Before the five R0 tests were adapted, exactly those five failed (§7.2). |
| `pnpm test:arrows` | PASS 85/85 |
| **every Excalidraw spec** (`e2e/excalidraw`, 75 files, 355 tests; two halves in parallel, then `a11y-2` / `a11y-3` with the layout specs) | **First run (`863dec0`): 320 passed, 13 expected failures, 2 skipped, 5 failed** of the 340 tests outside `a11y-2` / `a11y-3`. Four failures were real, the phone layout collision of §7.3 (`board-phone` at 560 and 700 px, `canvas-ux-tools` phone toolbar and toolbar by width); after `4582b68` and `a5e16da` a run of `a11y-2`, `a11y-3`, `board-phone`, `canvas-ux-tools`, `canvas-ux-toolbar`, `a11y-phone`, `a11y-phone-overlays` and `workshops-phone` passed **41/41**. The fifth was the pre-existing `present-live` "late joiner and reloads" flake (1 in 5 on `1809cf3` too): the file then passed **18/18** (`--repeat-each=3`). **So of the 355 tests: 340 must pass (all passed, 5 only on rerun), 13 expected failures, 2 skipped.** |
| **the default (tldraw) suite**, whole | **PASS: 344/344** on `a5e16da` (26.3 min, `E2E_PORT_BASE=6594`), 343 chromium + 1 branded Chrome; R0's `bridge-r0` spec (3) included |
| **spike A suite**, once | **PASS: 99 passed, 2 skipped** (opt-in). The run (`SPIKE_WEB_PORT=6599`, 20.3 min) set the api and sync origins to the web port to stay in range; two render specs listen on the api origin themselves and failed `EADDRINUSE` (3 more did not run); on `SPIKE_WEB_PORT=6590` with its own +1 / +2 those files passed 5/5. |
| normal web build, engine markers | PASS: **0** hits for 48 markers (wave 2's, wave 3's and wave 3b's: `__lobbyLod`, `data-lobby-lod`, `installWheelZoom`, `navigation.zoom-cursor-keys`, `cux-quick`, `mobile-styles.content`, `canvas.tool.highlight`, `canvas.tool.viewer-hand`, `cux-toolbar-styles`, `workshops-authors`, `dr-note-author__box`, `dr-wk-authors`, `follow camera rule failed`, `lobby-slot--mainMenu`, `lobby-slot--navigation`, `lobby-cursor__name`, `__lobbyBoard`, …). No `excalidraw-assets/`, 0 source maps. |
| engine flag without the dev-auth guard | PASS: 0 of the 48. Positive control: the guarded engine build (`lc-web-6593`) contains 41 of them (the other 7 are function names the minifier renames, or ids no longer used). |

The 13 **expected failures** left (`test.fail`, each naming its blocker; six came off at wave 3b: R2-04 ×2,
CR-3F-4, Ctrl+Z from the chrome, Ctrl+X on the canvas, Shift+= from the chrome; the `test.fixme` is gone too):

| Blocker | Tests |
|---|---|
| DEF-W3-1 (2F / O1): a Recently-deleted restore does not re-bind a live connector to what comes back | 2 (`history-deleted`) |
| DEF-3F-1 = 3b F2 (O1 / O2): a join within 5 s of a doc write gets the old `lb_doc` | 2 (`workshops-facilitation` RETRO-03a, `navigation-start-view`) |
| wave 2's two undo defects (spike B history and lease) | 2 (`collab-conflicts`: redo of Ctrl+G in a long sequence; typing into an empty note) |
| spike B history: undo does not restore the selection (3i F11) | 1 (`a11y-keyboard-safety`) |
| DEF-W3-2 (O2 / 2C): undoing a template insert removes it for the inserting tab only | 1 (`navigation-templates`) |
| one each | CR-3A-3 (`canvas-ux-keys` MAK-06), CR-3C-1 (`people-list`), CR-3D-5 (`tags-panel`), CR-3F-1 (`workshops-facilitation`), CR-3H-2 (`ai-actions` R9) |
| added by 3i's wave-5 fixes (`engine/w5f-3i`), all waiting on 2C | 8:<br>• `a11y-contrast` 5 (W5-10 ×3, W5-15 ×2; CR-3I-5)<br>• `a11y-phone-reach` 2 (W5-31, CR-3I-2; W5-50, CR-3I-3)<br>• `a11y-2` A11Y-14 (CR-3I-6: a regression already on f336ae4, found by 3i's runs) |
| wave 5, 3a's spec (`engine/w5f-3a`) | W5-05 (2A, the room's lock rule: `canvas-ux-review` "the server keeps a frame move that carries its locked heading") |

Skipped: the opt-in measurements `navigation-lod-fps` (LOBBY_MEASURE_FPS=1) and `present-export-heavy`.
Not run here: the spike B suite (spike B's own verification is running), a quiet-window or laptop fps
run, and three runs in a row of the whole folder (each owner ran three of its own specs on its branch).

## 8. Wave 5: the review's feature fixes, integrated

*Dated 2026-09-30. Where this section says the engine owners' branches are "not merged", they merged the same day (`W5-ENGINE.md`), and the `test.fail` marks listed in §8.4 were removed as their fixes landed; one expected-failure mark is left in the whole suite today (DEF-GAPS-1, §6.2). §5 and §6 are current.*

The early wave-5 review (`REVIEW-W5-EARLY.md`, 59 findings on `1809cf3`) gave each finding an owner. The
nine feature owners fixed theirs on `engine/w5f-*` from `f336ae4`, each with a regression test that
fails on `f336ae4`, and applied the review's §5 corrections to this report for their own area. This
section is the feature integration: the merges, the overlaps the merge produced, 3d's two findings (no
3d fixer ran), the gate and the expected failures left. The review's §10 has every finding's status.
The engine owners (2A, 2B, 2C) work in a parallel workflow on `engine/w5-2a`, `-2b` and `-2c`. Those
branches are **not merged** here, so what they fixed (W5-01, W5-02, W5-05, W5-08, W5-10, W5-15, D3's
font allowlist, D5, DEF-3F-1, DEF-W3-2, CR-3A-3 and more) still reads as waiting on them, and their
`test.fail` marks stay.

| | |
|---|---|
| Branch | `engine/excalidraw`, from `f336ae4` |
| Merged (`--no-ff`, in this order) | `engine/w5f-3a` `70a2206` (`15cbf68`), `engine/w5f-3b` `d66f0a7` (`b25e29a`), `engine/w5f-3c` `2d99a09` (`cdb18e6`), `engine/w5f-3e` `031b7bf` (`2bb3ecb`), `engine/w5f-3f` `772c857` (`2739a5a`), `engine/w5f-3g` `b4aa230` (`6d7cf49`), `engine/w5f-3h` `9dcfaf1` (`e5cb8f8`), `engine/w5f-3i` `ed7499a` (`0ffaffb`), `engine/w5f-2d` `b0315bd` (`eaa0e47`) |
| Conflicts | `docs/PROGRESS.md` (every entry kept) and this report's §4.1, §4.7 and §5 rows (Accessibility, Phone layout, Reduced motion, Template picker, Comments, People, Present mode; each row now carries every owner's part) and §6. No code conflict. |
| Integration commits | `2bc751f`, `df64bfe`, and the docs commit with this section |
| Not edited | 2A's, 2B's and 2C's engine code (contracts §0a), `pnpm-workspace.yaml`, `pnpm-lock.yaml`, the catalog. Two of 2C's specs changed by a test line each (§8.2). |
| Ports | `E2E_PORT_BASE` 6960 and 6964 (the two halves, with their fake OpenAI and fixture site at +10, +23 and +30), 6976 (the default suite), 6995 (single specs); 6960-6999 only, nothing left listening |
| Logs | the integrator's scratchpad `w5i/` (`ex-h1.log`, `ex-h2.log`, `default1.log`, `unit*.log`, `rerun*.log`, the before-fix runs); never committed |

### 8.1 Change requests

| Rev (contracts §12) | CR | Decision |
|---|---|---|
| W5-3G-1 | CR-W5-3G-1 (3g, `96af757`): `LobbyFiles.crop?(id): boolean`, member row `files.crop` (a landed part) | **Accepted.** Optional and additive: no implementor or test canvas changes. |
| W5-F1 | the integration's decisions in owners' files (§8.2) | Recorded. No member, signature or registry change. |
| — | the engine fixer's requests after the verifiers' third re-check (`W5-ENGINE.md` §5a): **CR-W5-FIX-1** (the lead, `engine-switch.ts`): a maintenance getter on `ElementRoomDeps`, so the room's write path (serverWrite, seed, restore, place-notes) refuses a write whose body arrived after maintenance went on, as `internal.ts` does for the tldraw routes; **CR-W5-FIX-2** (contracts): push receipts, or a per-key clock in the welcome's `doc`, for the doc-key ABA (open item 16); **CR-W5-FIX-3** (api, domain access): one guest uid per redeemed editor guest link, not one per cookie-less join, so D5's 500-item cap is per person | Recorded, not applied (requests, not commits). |
| — | the owners' requests to 2A, 2B and 2C (CR-W5-3A-1 to -4, CR 3b-10 to 3b-12, CR-3C-W5-1, CR 3E-5 to 3E-7, CR-W5-3G-2 to -5, CR-3I-2 to -6, 2D's font and loading requests, 3f's W5-01 and CR-3F-1) | **Recorded, not applied** (§6). CR-W5-3G-5 is answered by 3e's export part (§8.2). |

### 8.2 Integration fixes

| Commit | Where (owner) | What was wrong | Fix |
|---|---|---|---|
| `2bc751f` | `canvas-ux/ported/MainMenu.tsx` (3a), `navigation/index.tsx` (3b) | both owners fixed W5-33 by registering Board ▸ View's six rows, with different ids: the submenu listed 11 rows (12 with a selection) | the View group is navigation's; 3a's copies go. `review-w5.test.ts` checks every feature's View rows and that no two board-menu or context-menu entries of one group run the same command across `CANVAS_FEATURES` (both failed before); `canvas-ux-review` W5-33 counts six rows (11 before) |
| `2bc751f` | `a11y/ported/index.tsx`, `describe.ts` (3i); `canvas-ux/ported/canvas-events.ts` (3a) | both owners fixed W5-59 by naming the engine's text editor, with different words ("Rectangle text" then "Shape label" on one editor) | canvas-ux (3a, the review's owner of the editor's name) names it; the a11y feature's writer and `editorLabel` go. `canvas-ux-review` W5-59 records every name the editor gets for a note and a rectangle and expects one (two before) |
| `2bc751f` | `file-card/ported/card-face.ts` (3g) | W5-14 was fixed twice: 3e's `canvas/api/parts/export-faces.ts` is wired into every export; 3g's `card-face.ts` (for CR-W5-3G-5) was never called | 3g's file and its unit test removed; 3e's part is the one face in exports |
| (docs commit) | 2C's `e2e/excalidraw/board-features.spec.ts` | its probe dropped `https://example.com/dropped` expecting no feature to take it; 3g's link cards (D2) now take a lone http(s) URL at priority 100, before the probe | the probe drops a URL with a user name in it, which no feature takes (failed in the gate's first half, passes) |
| (docs commit) | 2C's `e2e/excalidraw/collab-conflicts.spec.ts` | "typing into an empty note is one undo step" passes since spike B's P6 fix, so its `test.fail` failed the gate (on `f336ae4` too) | the mark is off, with 2C's own words from `engine/w5-2c` (`e869e67`), so that merge is clean |
| `df64bfe` | `mindmap/ported/runtime.ts` (3d) | W5-44: Escape out of a topic's editor at a person's pace left nothing selected, so the arrows stopped (the keys' own replay kept the selection, so the fast-typing spec passed) | an Escape while a topic is edited selects that topic when its editor closes with nothing selected. `mindmap-keyboard` W5-44 (pauses before Escape, ArrowUp, F2 on an existing topic) failed before |
| `df64bfe` | `tags/ported/TagPicker.tsx` (3d), `tags-panel.spec.ts` | W5-29: a name-only guest's new tag said "Created", then the room refused it (CR-3D-5) | a guest is offered the board's tags only ("Find a tag", no Create, a line saying a board member can create new ones). `tags-panel` W5-29 failed before. The guest-roles test now joins 5.5 s after the tag writes: within 5 s the guest got the old document (DEF-3F-1) and had only "created" `Idea` by accident |

### 8.3 Gate

Code under test: `df64bfe` plus the two spec lines of §8.2 (the e2e halves ran on `2bc751f`; what
`df64bfe` and the spec lines touch ran again on the final tree).

| Check | Result |
|---|---|
| lint (`biome check .`) | PASS, 1,980 files |
| `pnpm -r typecheck` (15 projects) + engine-probe tsc + Node-safety tsc | PASS |
| `pnpm test` | PASS: **5,235 passed, 1 expected failure, 37 skipped** (491 files, 9 skipped). The expected failure is 2D's `hierarchy.test.ts` `it.fails` (fontFamily 7 waits on 2A's allowlist). The first run, on the merged tree, failed one sync test, `presence.test.ts` "a forged display name…" (a timestamp 1 ms off; no sync file changed), which passed 3/3 alone. |
| `pnpm test:arrows` | PASS 85/85 |
| **every Excalidraw spec** (`e2e/excalidraw`, 83 files, 422 tests; two halves in parallel) | **392 passed, 25 expected failures, 3 skipped, 2 failed.** The two failures were the gate's own findings of §8.2: `board-features` (the probe's URL) and the `collab-conflicts` mark that passes. After the fixes, a rerun of `collab-conflicts`, `board-features`, `canvas-ux-review`, `a11y-traversal`, `a11y-live-region` and `a11y-audit` passed **40/40**, and `mindmap-keyboard` + `mindmap-structure` 7/7 and `tags-panel` + `tags-picker` 11/11 (their expected failure included) on the final code. Skipped: the opt-in `navigation-lod-fps` and `present-export-heavy`, and `media-edit`'s crop after a derivative upgrade, which skips itself while the swap does not stick (CR-W5-3G-3). |
| **the default (tldraw) suite**, whole | **PASS: 346/346** on `2bc751f` (25.6 min, `E2E_PORT_BASE=6976`; chromium and the one branded-Chrome test). What came after it (`df64bfe`, two spec lines) is in ported files and Excalidraw specs only, which the default build does not contain. The shared modules the owners changed for both builds (3c's `comments.css`, `layout.ts` and `pin-face.ts`, 3e's `pdf-build.ts` and `present-export.css`, 3f's `voting.ts`, `workshops.css` and the tldraw `WorkshopOverlay.tsx`, 2D's templates) are all under this run. |
| normal web build, engine markers | PASS: **0** hits for 64 markers (wave 3's and 3b's, and wave 5's: `cux-polygon-preview`, `history-bar`, `cux-toolbar-more`, `dr-cnav`, `navigation.back-to-content`, `navigation.code-selection`, `dr-a11y-focus-ring`, `canvas-announcer-tool`, `lobby-link__title`, `link-preview`, `lobby-ghost__chip`, `media-replace`, `media-crop`, `tag-guest-hint`, "Sticky note text", "Shape label", …). No `excalidraw-assets/`, 0 source maps. Two first candidates were dropped from the list because the normal build has them for its own reasons: tldraw's own "Back to content" and the tldraw style panel's `style-opacity-label`. |
| engine flag without the dev-auth guard | PASS: 0 of the 64. Positive control: the guarded engine build contains 62 of them (the other two are a function name the minifier renames and an id no longer used). |

Not run here: the spike A and spike B suites, a quiet-window fps run, and three runs in a row of the
whole folder (each owner ran three of its own specs on its branch).

### 8.4 Expected failures left

25 (`test.fail`, each naming its blocker). Since wave 3b one mark came off (`collab-conflicts`
"typing into an empty note") and 13 were added by the wave-5 fixers, for blockers the engine owners'
branches fix or still have to fix.

| Blocker | Owner | Tests |
|---|---|---|
| W5-10, W5-15: the engine theme (CR-3I-5) | 2C (on `engine/w5-2c`) | 5 (`a11y-contrast`) |
| W5-05: the room's lock rule | 2A (on `engine/w5-2a`) | 2 (`canvas-ux-review`, `templates-frames`) |
| W5-01: N and T notes join their frame | 2C (on `engine/w5-2c`) | 1 (`workshops-voting`) |
| DEF-3F-1: a join within 5 s of a doc write gets the old `lb_doc` | 2C (on `engine/w5-2c`) | 2 (`workshops-facilitation` RETRO-03a, `navigation-start-view`) |
| DEF-W3-2: undoing a template insert removes it for the inserting tab only | 2C (on `engine/w5-2c`) | 1 (`navigation-templates`) |
| CR-3A-3: `transact` index writes change no paint order | 2C (on `engine/w5-2c`) | 1 (`canvas-ux-keys` MAK-06) |
| D3: SVG exports embed Lilita One | 2A (allowlist, on `engine/w5-2a`), 2C (`canvas/export/fonts.ts`) | 1 (`present-export-files`) |
| CR-3I-6: "Back online. All changes saved." on every board open | 2C | 1 (`a11y-2` A11Y-14) |
| CR-3I-2, CR-3I-3: the phone top bar and the empty "On this board" | 2C | 2 (`a11y-phone-reach` W5-31, W5-50) |
| CR-3C-W5-1: presence re-sent on the leader's resize | 2C | 1 (`people-follow` W5-25) |
| CR-3F-1 = W5-26: a write that skips the undo stack | 2C with 2A | 1 (`workshops-facilitation`); **done at wave A** (`TransactOptions.skipUndo`) |
| history: undo restores the selection (3i F11); redo of Ctrl+G in a long sequence | 2C | 2 (`a11y-keyboard-safety`, `collab-conflicts`); the Ctrl+G redo (`withGroup`) **done at wave A** (UNDO-group-redo: the install is in paint order) |
| DEF-W3-1: a Recently-deleted restore does not re-bind a live connector | 2A with 2F | 2 (`history-deleted`) |
| CR-3D-5: an editor guest writing `tagDef:` (then the picker's W5-29 guard comes off) | 2A | 1 (`tags-panel`); **done at wave A** (the guard is off, the `test.fail` removed) |
| CR-3H-2: what counts as "typed" (R9) | 2A with 2F | 1 (`ai-actions`); **done at wave A** (template prompt notes) |
| CR-3C-1: a follow target in presence | contracts, 2A, 2C | 1 (`people-list`); **done at wave A** (`CONTRACTS_REV` 10) |

When `engine/w5-2a`, `-2b` and `-2c` are merged, about ten of these are expected to pass (Playwright
then reports them as unexpected passes) and must lose their marks; 2D's `hierarchy.test.ts` `.fails`
and 3a's polygon pin (`polygons.test.ts`, against 2B's `CONVERTER_VERSION` 2 geometry) must be checked
at the same time.

## 9. The gate at the held head (2026-10-03)

Code: `release/held` 99ac6c52 = wave C as deployed (`main` 23a36bbd) + migration 0024 + push receipts. The gate was run by
the integrator on 28c12f18, and again on 4232eccb after two test-only fixes (`docs/PROGRESS.md` 2026-10-03, "Gate on the
held head"); 99ac6c52 adds the CR-2B-2 revert (`841d6dc9`) and the DANA-01 test fix (`99ac6c52`). **This section did not
re-run that gate**; it records it. Ports 7500-7539, headless, Windows 11, after `pnpm fixtures`.

| Check | Result |
|---|---|
| lint | 1,860 files, 0 errors (4 warnings in two sync test files that were already there) |
| `pnpm -r typecheck` | 15 projects Done (the node-safe and engine-probe tsconfigs included) |
| `pnpm test` | 511 files passed / 9 skipped, **5,028 tests passed, 36 skipped, 0 failed** (76.6 s) |
| `pnpm test:arrows`, `licence:check` | 85/85; strict PASS (2 allowlisted) |
| **whole e2e suite, chromium, two shards** | **553 tests, 551 passed, 0 failed, 2 skipped** (shard 1 11.6 min, shard 2 22.5 min, no retries); the two skips are `present-export-heavy` and `navigation-lod-fps` (opt-in measurements); the DEF-GAPS-1 expected failure counts as passed |
| database | migration 0024 and the whole api project on a real Postgres 18 (1,176 passed, twice: Windows binaries and the NAS's postgres:18) |
| stale-client checks | 19 files, 129/129; the rev-10 web against the held api and sync: 32 of 33 (the one difference is correct for a rev-10 tab); the rev-11 web against a rev-10 sync: 33/33 |
| cross-browser (smoke only; run on the wave C integration head) | WebKit 3/3, then 6/6 with `--repeat-each=2` (first launch failed on a missing `brotlienc.dll`); Firefox: no result, it does not start on this PC |
| build gates (run on the wave C integration head 95aa914 and 7e083e10, not re-run on the held branch) | `excalidraw:prod` 5/5, `excalidraw:dev` 1/1, `csp:cutover` PASS (0 violations, 0 CSP console messages, 0 foreign requests), `probe:browser` PASS |

On 2026-10-03 (this refresh) the demo-chain specs were run once more at 99ac6c52 plus docs-only commits, headless chromium,
one worker, `E2E_PORT_BASE=7920`: 165 distinct tests in 23 spec files passed, 0 failed, 1 expected failure (DEF-GAPS-1) (the list is in `docs/DEMO.md`, "Last checked"). Nothing was left listening.
