# Excalidraw migration, wave 3: integration

The wave-3 integration of `docs/EXCALIDRAW-MIGRATION.md` §7.2 (row "3 Features"): the nine feature owners'
branches merged onto `engine/excalidraw`, their change requests decided, the fixes the merged page needed,
the gate, what is ported per feature, the parity table against today's tldraw app, and the open blockers.
The owners' reports are the evidence for their own slices: `docs/research/excalidraw/wave3/3B.md`, `3D.md`,
`3E.md`, `3F.md`, `3G.md`, `3H.md`, and the wave 3a, 3C and 3i entries of `docs/PROGRESS.md`. The runs here
are **single runs** (plus reruns of what failed), on a machine shared with other agents' runs.

**Wave 3b** (the second pass: owners 3b, 3a, 3CF, 3e and 2C, then `main` with bridge release R0) is
integrated in §7. §4, §5 and §6 below describe the page **after wave 3b**; §1 to §3 are the wave-3 record,
and §7.4 has the expected failures that are left.

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

"Ported" means the feature works on the Excalidraw board page with its tldraw copy and test ids and its
ported specs pass; "partial" means part of it is there and the rest waits on a named blocker; "not ported"
means absent from the new page. Every deviation below is listed in full in the owner's report.

### 4.1 Canvas tools (3a, `canvas-ux`) — ported, partial for z-order

- **Ported:** the toolbar (COL-07 order, More with the last-used tool, Media, features' tools, Templates), the style panel (13-colour note palette, colour, fill, dash, size, font, align, arrowheads; one undo step per pick; folds behind a Styles button on phones since the integration), the context menu, the board menu (Board ▸ Edit ▸ View ▸ Export ▸ Preferences ▸), the keyboard shortcuts dialog, the selection bar (lock, align, distribute, compact on phones), lock and Unlock all, the locked hint, double-click to add a note, frame rename, type-to-edit (RETRO-02), place at centre (A11Y-07), the export gate on copy, snapping on by default, `styles.of`/`apply`, the keyboard-map test over every feature.
- **Ported at wave 3b:** undo and redo from the chrome (A11Y2-02: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y from the top bar, the dock, a host slot or the page; never from text fields, menus or modals); Ctrl/Cmd+X cuts on the canvas; tldraw's quick actions (Undo, Redo, Delete, Duplicate, Comment and the ⋮ actions menu) on top of the toolbar on a canvas of 840 px or less; tldraw's phone toolbar (its overflow rule, capped to what fits; the Styles button at 640 px or less); the highlighter (Shift+D, highlight shades, one width) and a Hand for read-only roles (CR-3A-6, W3-13). Since the integration the context menu's target is what the right-click selected (CR 3E-4), the shortcuts dialog gives the keyboard back to the canvas, and the phone quick-actions strip starts right of the navigation slot.
- **Partial:** PgUp/PgDn, the Reorder menu and the quick actions' reorder change no paint order (CR-3A-3, the port's `transact`); the note and text tools ignore the next style (CR-3A-7); viewers cannot copy even when exporting is allowed (CR-3A-4); no laser for read-only roles (CR-3A-8); the e2e facade's `tool` reports `freedraw` while highlighting (CR-3A-9).
- **Deviations:** stroke widths are the engine's; no in-place shape-type change; no serif font; align right has no key (Alt+D is the browser's); locking a frame locks its contents; no quick actions beside the board menu on a canvas wider than 840 px (Board ▸ Edit and the keys cover them); the phone toolbar shows fewer tools than tldraw's so that it stays on screen; the history keys do nothing while a modal dialog is open.

### 4.2 Navigation (3b, `navigation`) — ported, partial for deep zoom

- **Ported:** Lobby's camera members; zoom keys and menu (MAK-10); the minimap (MAK-11, PERF-03); board search (MAK-12) **with tags since the integration**; the frames panel with reorder, skip and copy link (MAK-13); `?el=` / `?view=` links and the legacy `?d=` reader; content-search links; the first view (PRE-06, DANA-06, R13; since the integration it keeps a camera that moved, or a person who acted, before it was decided) and the board start view (PRE-08); arrange as grid (MAK-18); select by type (MAK-17); paste as sticky notes (COL-05, RETRO-01).
- **Ported since the spike merge:** the template insert, from the picker and from `?template=` (CR-2D-2, W3-9), so the Lobby tour opens on this page. Its undo removes the template for the inserting tab only (DEF-W3-2, `test.fail`).
- **Ported at wave 3b:** the level-of-detail pass (plan §8.5, `canvas/lod/**`): below zoom 0.2 each frame whose bitmap is current is drawn as one bitmap between the engine's canvases, and its members are left out of the engine's render (hit tests, selection, editing and exports unchanged); on the heavy board (9,220 elements) fit runs at 28 fps against 9.8 without it (3b's three runs, `wave3/3B-2.md`, not a quiet window). Lobby's own fit camera (80%, never above 100%, floored at the whole-board fit, W3-12); Ctrl/Cmd+wheel and trackpad pinch below 0.1 (W3-11); zoom at the pointer (Shift+= / Shift+-); the zoom and camera keys from the chrome (A11Y2-02); one-pass whole-board loops (heavy-board open 12.9 s before, 4.3-4.5 s after).
- **Partial:** paste as notes still makes the new-note face (3b can use `LobbyTx.insert` for the pasted-note face); a touch two-finger pinch still stops at Excalidraw's 0.1; only owners can set the start view (CR 3b-3); a locked frame keeps its place in the order (CR 3b-4); only frames are cached (a heavy board of loose elements gains nothing below 0.2) and the eraser's fade is not drawn on culled elements; the "≥ 30 fps at 0.25 and 1 with sync running" gate is at its edge at 0.25 (27-32; the port's element scans on every camera move, CR 3b-8); the cull reaches `RenderOverrides` through a Proxy until CR 3b-5 (W3-14).

### 4.3 Comments, people, follow, present to everyone (3c) — ported

- **Ported:** the comment tool (C), pins, hover preview, composer and threads, replies, edit and delete, resolve and reopen, mentions and their notices, the dock panel with filters, the notifications bell, the `?thread=` deep link, team-only threads, orphans, Shift+C; `canvas.follow`; the people item with avatars, the list, Follow / Following, Bring here, Bring everyone to me; present to everyone (invitation, chip, hand-off, reloads, api restart), **running on present mode since the integration**; a thread re-attaches when its note comes back from Recently deleted (since the spike merge).
- **Partial:** "who follows me" by camera needs a follow target in presence (CR-3C-1). Since wave 3b the context menu of an element that was not selected offers "Comment" (CR 3E-4, the integration).
- **Deviations:** follow is by session and moves at once; the comment tool's cursor is a crosshair; Tab steps in plain reading order.

### 4.4 Mind maps and tags (3d) — ported

- **Ported:** mind maps (new map, from a shape, child/sibling/level, collapse with the B12 guards, Tidy up, branch delete with confirmation, arrow navigation, the layout keeper, outline export) and tags (the picker, chips, the panel, Show only, rename/recolour/delete everywhere, the CSV column through 3e, search by tag through 3b since the integration).
- **Partial:** a name-only guest cannot create a tag (CR-3D-5); typing on a selected topic does not start editing, F2 does (CR-3D-3); a new topic and its words are two undo steps (spike B now has `mergeTop()`; 2C's `joinPrevious` and 3d can use it); an invisible re-route step may appear (CR-3D-4).

### 4.5 Present mode, exports, export policy, thumbnails (3e) — ported

- **Ported:** present mode (slides in presentation order, skips, fullscreen with the in-window fallback, slide keys and list, the modal key trap, view restore, collaborators' edits followed, cursors hidden), the Export dialog (PNG 1×/2×/4×, SVG, copy as PNG, PDF with bookmarks and a text layer, CSV with tags and votes), the export policy store and share badge, thumbnails, and `export.*`.
- **Ported at wave 3b:** the context menu's Export as (PNG at 2× from the original, SVG with the preview; the test body was the last `test.fixme`); RETRO-03a's Present and export steps (no author label or cursor on a slide; no PNG or SVG names the author); "presentation is clean" with comment pins and the selection bar; the event stream surviving an api restart; export control on file cards (Download off and back for viewers, 403 from the api).
- **Deviations:** the fullscreen element is the canvas region; engine-drawn frame names add height to whole-board PNGs; the thumbnail schematic's images are grey tiles only where `files.urlOf` has no preview.

### 4.6 Workshops (3f) — ported

- **Ported:** the timer (with the floating timer while presenting, **now tested**), dot voting (setup, click and keyboard voting, ballot privacy, results, badges, the Voting panel and CSV gate), +1, reactions, raise hand and the queue, session settings, Gather everyone (on 3c's follow, **now tested**), private brainstorming **including the reveal and Place notes** (CR 2F-2, since the spike merge).
- **Ported at wave 3b (3CF):** the note-author label (CR-3F-4: the workshops overlay layer `workshops-authors`, the first name from the server's `lastEditedBy` in the note's corner, hidden by "Hide note authors", below zoom 0.28 and on small notes); the readable follow of a gathered phone (R2-04, on the follow camera hook W3-10: "Gather everyone", "Bring here" and "Bring everyone to me").
- **Wave 5 (W5F, 3f; the review `REVIEW-W5-EARLY.md` ran on `1809cf3`):** a click while voting lands on the topmost object, as a click picks it (W5-03): one the vote does not take casts nothing and says "Not part of this vote: only sticky notes in “…” take votes.", where it used to vote for an object the vote takes hidden underneath (select and hand tools, the vote tool; the tldraw page had the same rule and the same fix). On a phone the workshop cards stand above 3i's Board actions button (the cards' part of W5-07). The +1 pill takes theme tokens (W5-49: 1.03:1 in the dark theme, both pages). The workshop items keep the tldraw page’s place: Timer, Voting and Reactions before Present and export, the Voting and Private notes panels before History (W5-50’s workshops part). W5-27 ("no note authors") is wave 3b's note-author label, which the review did not have; checked on this branch.
- **Partial:** a note made with N inside a frame does not join it (W5-01, 2C), so a frame-scoped vote does not take it (`workshops-voting` W5-01, `test.fail`); +1 is an undo step (CR-3F-1 = W5-26, 2C) and not possible on locked notes (CR-3F-2); R2-04 reads the leader's zoom from the canvas size sent with the summon, so it drifts if the leader's canvas height changes afterwards (a zoom in presence, CR-3CF-1); the label has no hover tooltip (the full name is its `title`) and exports never draw it.

### 4.7 Media (3g) — ported

- **Ported:** file cards (cover, pages, status, Office note, video player, Download), image and page placeholders, paste/drop/Ctrl+U with today's drop layout (grids, frames, template slots, F12), the PDF viewer and Place on board, open original, download originals, `files.urlOf`/`insert`, the derivative swap.
- **Partial:** the cross-workspace image paste check (plan §2.10.4) needs a paste hook from 2C; exports see the engine's placeholder for cards without a preview (2C's loader); a viewer's drop is silent (spike B's input).
- **Deviations:** the card face is a DOM overlay (only opaque elements above it cut holes); no local preview while uploading; slotted images land on top (no insert-at-index).

### 4.8 History and AI (3h) — ported, partial for connector re-binds

- **Ported:** the History panel (checkpoints, restore as new board, duplicate, .json export, automatic checkpoints), the bitmap checkpoint preview, the export gate; AI (themes, summarize, action items, ideas, budgets, the owners' switches, the Undo toast) through **3a's selection bar, context menu and board menu since the integration**.
- **Partial:** Recently deleted restores through the open room (CR 2F-2, since the spike merge), but a restore does not re-bind a live connector to what it brings back (DEF-W3-1, 2 `test.fail`); a template's prompt notes placed by a person count as typed (R9, CR-3H-2); a v1 (tldraw) checkpoint shows "can't be previewed here yet".
- **Not ported:** the backup restore drill (backups are off on the Excalidraw stack until 2B moves them to `lb_*` files).

### 4.9 Accessibility and mobile (3i) — ported, partial for chrome keys

- **Ported:** the live region, keyboard traversal (F6, Alt+arrows, into and out of frames), the Contents panel, the phone sheet, palette contrast, the named canvas, the skip link; 12 of 3i's cross-feature tests **now pass against the other owners' features**.
- **Partial:** undo does not restore the selection (spike B history, `test.fail`); axe is not a dependency (CR-3I-1, the audit spec stands in). Ctrl/Cmd+Z, Shift+= and the zoom keys from the chrome and Ctrl+X on the canvas pass since wave 3b (3a, 3b).
- **Finding:** the red note's ink is 3.43:1 through Excalidraw's dark filter (below AA).

### 4.10 The board page and guests (2C) — ported

- **Ported at wave 3b:** the guest flow's specs (`guests.spec.ts`, `guests-2.spec.ts`, the Share-dialog parts of `sharing-polish` and `workshop-copy`: joining by a name-only link on a phone, the people list and Share dialog, a guest's comment and note with the server's attribution, the refusals, revocation, "Not you?"); the phone corner chrome (the board menu right of the dock's fold button at 600 px or less, the navigation slot above the tools' row below 800 px, and since the integration the quick-actions strip right of it); the cursor name label capped at 120 px.
- **Partial:** a window resize does not bump the viewport signal (CR-3A-10; canvas-ux measures the container instead).

## 5. Parity with today's tldraw app

Every feature in `docs/PROGRESS.md` and `docs/DEMO.md`, as it stands on the Excalidraw page after the
wave-3b integration (§7). "Outside the canvas" means the feature is not part of the board page and both
builds share it.

| Feature (source) | On the Excalidraw page | Owner | Evidence (e2e/excalidraw) | What is missing, and the blocker |
|---|---|---|---|---|
| Two people on a board: cursors, avatars, live edits, reload, restart, offline (M0, DEMO 0:30-1:00) | ported (wave 2; spike B's part-3 fixes merged) | 2C, spike B | `board-*`, `collab-*`, `sync-durability` | the lost-edit race and the drag overwrite are fixed (spike B part 3). Heavy boards: 3b's level-of-detail pass takes fit from 9.8 to 28 fps (wave 3b), but B9's visibility (1.5 s p95) and the port's per-camera-move scans (CR 3b-7, CR 3b-8) are spike B's (O2 with O5) |
| Same-note typing: the lease (M0, DEMO checklist 7) | ported (wave 2) | 2C, spike A/B | `collab-conflicts` | typing into an empty note is two undo steps (spike B history) |
| Saved indicator, per-property undo, leave guard (validation phase) | ported (wave 2) | 2C | `board-saved`, `sync-durability` | the offline window is fixed (spike B part 3); the per-item "Offline — N changes" count (O2/2C) |
| Server-enforced roles, forged writes refused, revocation (M1) | ported (wave 2) | O1, 2E | `permissions-canvas`, `security-negative` | — |
| Toolbar, tools, style panel, 13-colour note palette (Miro phase) | ported | 3a | `canvas-ux-toolbar`, `canvas-ux-tools` | the highlighter and the viewers' Hand since wave 3b (CR-3A-6), with one highlighter width; no laser for viewers (CR-3A-8); next note/text style (CR-3A-7); stroke widths are the engine's |
| Miro shortcuts: L, P, Alt+1/2, Ctrl+0, Ctrl+Shift+L, M, Ctrl+F (Miro phase) | ported | 3a, 3b | `canvas-ux-keys`, `navigation-keys` | — |
| PgUp/PgDn z-order (Miro phase) | **partial** | 3a | `canvas-ux-keys` MAK-06 (`test.fail`) | the keys and menu run, but the paint order does not change: CR-3A-3 (the port's `transact`, spike B / 2C) |
| Guides and snapping on by default (Miro phase) | ported | 3a | `canvas-ux-canvas` | — |
| Type-to-edit notes, Enter/Esc flow (Miro phase, RETRO-02) | ported | 3a | `canvas-ux-keys` | typing on a selected mind-map topic starts nothing (F2 does; CR-3D-3) |
| Context menu, board menu, shortcuts dialog, selection bar, lock, align, quick actions (persona fixes, tldraw's phone and tablet layout) | ported | 3a | `canvas-ux-menus`, `canvas-ux-canvas`, `canvas-ux-duplicate`, `canvas-ux-tools` | viewers cannot copy (CR-3A-4); Alt+D has no key; the quick actions sit on the toolbar at 840 px or less only (deviation: none beside the board menu on a wider canvas) |
| Paste as sticky notes (Miro phase) | ported | 3b | `navigation-paste` | pasted notes take the new-note face (3b can now use `LobbyTx.insert`) |
| Template picker and insert, Lobby tour, `?template=` (Miro phase, wave 3, DEMO 0:00) | ported, partial | 3b | `navigation-templates` (1 `test.fail`) | inserts since the spike merge and W3-9 (CR-2D-2); its undo removes the template for the inserting tab only (DEF-W3-2) |
| Frame outline with reorder, frames panel (Miro phase) | ported | 3b | `navigation-frames` | a locked frame keeps its place (CR 3b-4) |
| Board search (Miro phase), tags in search (wave 4) | ported | 3b, 3d | `navigation-links`, `tags-panel` | — (tags wired at the integration) |
| Copy link to selection, deep links (Miro phase) | ported | 3b | `navigation-links` | new `?el=` / `?view=` format; legacy `?d=` still opens |
| Start view (Miro phase) | ported | 3b | `navigation-start-view` | owners only (CR 3b-3); a first visit within 5 s of the write sees the old one (DEF-3F-1 = 3b F2) |
| Minimap, zoom menu, arrange as grid, select by type (persona fixes) | ported | 3b | `navigation-keys`, `navigation-arrange` | wheel and trackpad pinch below 0.1 since wave 3b (W3-11); a touch pinch still stops at 0.1 |
| Zoomed-out boards: level of detail (plan §8.5) | ported (wave 3b) | 3b | `navigation-lod` (+ the opt-in `navigation-lod-fps`) | frames only; the 0.25 fps gate at its edge (CR 3b-8); the cull through a Proxy until CR 3b-5 (W3-14) |
| 20k shape cap (Miro phase) | ported (server) | O1 | canvas-schema `limits.ts` | — |
| Comments: tool, pins, threads, replies, resolve, mentions, panel, bell, orphans, Shift+C (Miro phase, DEMO 1:40) | ported | 3c | `comments-core`, `comments-review`, `comments-privacy`, `comments-notify` | — (the orphan's restore works since the spike merge) |
| People list, follow, "who follows me" (wave 4) | ported, partial | 3c | `people-list` | "N following you" by camera needs CR-3C-1 |
| Present mode: frame by frame, chrome/cursors/pins hidden (Miro phase) | ported | 3e | `present-export-present` | — (pins and the selection bar hidden, and the event stream across an api restart, tested since wave 3b) |
| Present to everyone: invite, join, hand-off, follow in step (wave 4, DEMO 2:45) | ported | 3c, 3e | `present-live` (6 tests, all passing since the integration) | — |
| Export PNG / SVG / PDF / CSV, copy as PNG, Export as from the context menu (Miro phase, DEMO 3:30) | ported | 3e | `present-export-files` | — (the context menu's Export as since wave 3b, with CR 3E-4) |
| Export policy: viewers and commenters cannot export (wave 3, DEMO safety) | ported | 3e, 3a, 3g | `sharing-export-control` | copy for viewers when exporting is allowed (CR-3A-4); the context menu and file cards' Download tested since wave 3b |
| Thumbnails (wave 3) | ported | 3e | `thumbnails-capture` | — |
| Timer (Miro phase) | ported | 3f | `workshops-timer` | — |
| Dot voting with frame scope, notes only, ballot privacy, results (Miro phase, DEMO 2:00) | ported, partial | 3f | `workshops-voting` (1 `test.fail`) | a note made with N inside the vote's frame is not in it, so the vote does not take it (W5-01, 2C). Since wave 5 a click on it casts nothing and says so, instead of voting for a note under it (W5-03, 3f, both pages). DEMO 2:00 votes on the tour's own notes, which are in their frame |
| Gather everyone (Miro phase) | ported | 3f, 3c | `workshops-follow`, `a11y-phone-overlays` | R2-04 (a readable zoom on a phone) since wave 3b (W3-10), from the leader's canvas size at the summon; a live zoom needs CR-3CF-1 |
| Reactions, raise hand, +1 (wave 4 polish) | ported, partial | 3f | `workshops-facilitation` | a +1 is an undo step, so Ctrl+Z by the giver takes it back for everyone (CR-3F-1 = W5-26, 2C), and impossible on locked notes (CR-3F-2); the pill reads in the dark theme since wave 5 (W5-49) |
| Session settings: hide cursors, hide note authors, the note-author label (review rounds) | ported (wave 3b) | 3f, 3e | `workshops-facilitation` | W5-27 is resolved by wave 3b's label (the review ran before it); the label is an overlay: no hover tooltip, never exported; a joiner within 5 s of the change gets the old settings (DEF-3F-1, `test.fail`) |
| Private brainstorming (wave 3, DEMO "more to show") | ported | 3f | `workshops-private-notes` | — (the reveal works since the spike merge: CR 2F-2) |
| Files: images, PDF cards with pages, video, Office previews, attachments; Ctrl+U, drop, paste (M0, M3, DEMO checklist 8) | ported | 3g | `media-files`, `media-video`, `media-office`, `media-viewer` | no local preview while uploading; the cross-workspace paste check (2C hook) |
| Mood board slots, drop layout (persona fixes, DEMO 1:50) | ported | 3g | `media-drops` | a slotted image lands on top (no insert-at-index) |
| Named checkpoints, restore as new, duplicate, JSON export/import, automatic checkpoints (Miro phase, wave 4, DEMO 4:00) | ported | 3h | `history-checkpoints`, `history-copies` | a v1 (tldraw) checkpoint is not previewed |
| Recently deleted and its restore (Miro phase, DEMO 4:00) | ported, partial | 3h | `history-deleted` (2 `test.fail`) | restores through the open room since the spike merge (CR 2F-2); a live connector is not re-bound to what comes back (DEF-W3-1) |
| Backups and the restore drill (Miro phase, wave 3) | not on this stack | 2B | — | backups are off on the Excalidraw stack until 2B writes `lb_*` files. The tldraw sync on this branch has R0's backups of `lb_*`-only files, run-all and maintenance since the `main` merge (§7.2) |
| AI: themes, summarize, action items, ideas, budgets, owner switch (wave 4, DEMO 1:20) | ported | 3h | `ai-actions` | R9: template prompt notes count as typed (CR-3H-2, `test.fail`); output is plain text |
| Mind maps (wave 4, DEMO "more to show") | ported | 3d | `mindmap-keyboard`, `mindmap-structure` | new topic + words are two undo steps (W1-9) |
| Tags, Show only, tag panel (wave 4, DEMO "more to show") | ported | 3d | `tags-picker`, `tags-panel` | a name-only guest cannot create a tag (CR-3D-5) |
| Name-only guests on a board, on a phone (wave 3, DEMO "more to show") | ported (wave 3b) | 2C, 3c, 3f, sharing | `guests-join`, `guests-sharing`, `sharing-share-dialog`, `workshops-phone`, `present-live` | a name-only guest cannot create a tag (CR-3D-5, `test.fail`) |
| Accessibility: skip link, live region, keyboard traversal, contrast (review rounds) | ported | 3i, 3a, 3b | `a11y-*` | the chrome keys and Ctrl+X pass since wave 3b; undo restoring the selection (spike B history, `test.fail`); red note ink in dark mode 3.43:1 |
| Phone layout (review rounds) | ported | 3i, 3a, 2C | `a11y-phone`, `a11y-phone-overlays`, `workshops-phone`, `board-phone`, `canvas-ux-tools` | tldraw's phone toolbar, quick actions and Styles button since wave 3b (3a), the corner chrome (2C); fewer tools at 390 px than tldraw's, so the bar stays on screen. Open from the review: Zoom to fit over Select and the board menu under the panels button (W5-06, 3i with 3b, 3a, 2C); the Board actions button and the dock over the comment sheet's reply box (W5-07, 3i with 3c). The workshop cards stand clear of the Board actions button since wave 5 (W5-07's cards, 3f) |
| Dashboard, template gallery, sharing dialog, links, access requests, invitations (Miro phase) | outside the canvas | — | default suite | the dashboard's content-search hits open `?el=` links in the engine build (3b) |
| Search across boards (wave 4) | outside the canvas | — | default suite | the api reads elements (2F) |
| Email sending, Kanban, DBC Ops (not built) | not built on either page | — | — | — |

## 6. Open blockers, by owner

Blocking the cut-over (data loss, a demo step that does not work, or a go/no-go gate) are marked **B**.
Each expected failure (`test.fail`) names its blocker, and must lose its mark when the blocker lands
(Playwright then reports an unexpected pass).

**Resolved during the wave-3 integration** (spike B's part 3, merged in `c171f19`, and W3-9): the O2 lost-edit /
lost-create race, the drag-recolour overwrite and the offline-queue window (wave 2's three data-loss
blockers); CR 2F-2 (`serverWrite` / `prepareBoard`: the private-brainstorm reveal and Recently-deleted
restore on an open board); CR-2D-2 (`LobbyTx.insert`: the template insert and the Lobby tour); CR-2D-1
(the lock scope); `message` events after the apply; `LobbyHistory.mergeTop()`. Specs still wait for Saved
around seeding writes (the O2 race's workaround); they can drop the waits.

**Resolved at wave 3b** (§7): CR-3F-3 (the follow camera hook, W3-10) and R2-04; CR-3F-4 (the note-author label); CR-3A-6 (the highlighter and the viewers' Hand, W3-13); CR 3b-2 (wheel deltas, W3-11); 3i's chrome keys (Ctrl/Cmd+Z, Shift+= and the zoom keys from the chrome, Ctrl+X on the canvas); the level-of-detail pass (plan §8.5); a phone toolbar like tldraw's; the guest flow's specs; the context menu's Export as; CR 3E-4 (the integration).

**Spike B (O2 web engine, O5, the lead)**
- **B · performance on heavy boards** (O2 with O5, `CanvasPort.bounds` and the per-change `updateScene`): B9's visibility is 1.5 s p95 against 250 ms (`M3-part3.md`). At wave 3b, 3b's level-of-detail pass took fit on the heavy board from 9.8 to 28 fps and made its open 3× faster, but three port costs stay spike B's: CR 3b-7 (`get` and `bounds` are O(n) per call in `port-impl.ts`: every per-element caller is quadratic), CR 3b-8 (the core's and the port's element scans on an `onChange` that only moved the camera: 15-20% of the main thread at every zoom, the reason 0.25 is at 27-32 fps against the ≥ 30 gate) and CR 3b-9 (`shouldCacheIgnoreZoom` during Lobby's continuous zooms, with 2C's `CameraTween`; found in the code, not measured). B8's rollback drill waits for O4's `spike/b-convert` merge. M3 is not reached on these.
- **CR 3b-5 (O5, `canvas/overrides.ts`):** a render-only cull source in `RenderOverrides` (`setCulled(source, ids)`), so the level-of-detail pass drops its Proxy in 2C's `session.ts` (W3-14).
- **`canvas/port-impl.ts` `transact`** (spike B C0), reported four times: an update to an element created in the same `transact` is dropped (3b F1, CR-3D-1, CR-3H-3, CR-3F-6; worked around with a second `joinPrevious` write), and index writes do not move elements in the scene array, so `tx.reorder` changes no paint order (CR-3A-3, MAK-06 `test.fail`).
- **DEF-W3-2 (O2 with 2C, new):** undoing a template insert removes it for the inserting tab only; the other tab keeps the elements (`navigation-templates`, `test.fail`).
- **History (`canvas/history`):** wave 2's two undo defects (typing into an empty note; redo of Ctrl+G in a long sequence; 2 `test.fail`); bound-arrow re-routes recorded as their own steps (CR-3D-4); undo does not restore the selection (3i F11, `test.fail`).
- **Input and lease (`canvas/input`, `canvas/lease`, `canvas/tools`, `canvas/engine`):** synthetic key-downs unmarked and no feature keys while an open is pending (CR-3D-2); read-only roles cannot copy at all (CR-3A-4); Alt+D is prevented (CR-3A-5); the laser for read-only roles (CR-3A-8: `READ_ONLY_INTERACTION` and `setEngineTool`); `highlight` and the read-only `hand` as port tool names, and a hook that decorates a new gesture element before its first push (CR-3A-9, W3-13; 3a's part stands in); a viewer's drop is silent (3g).
- **The e2e facade (`canvas/test-facade.ts`, with 2C's `session.ts`):** its `tool` / `setTool` verbs read the raw port, so they report `freedraw` while highlighting and `select` under a viewer's Hand (CR-3A-9; specs read `LobbyCanvas.tool()` instead).
- O2: `rebuild` should keep an image's derivative key (3g, E9); the per-item "Offline — N changes" count. O3's facade: `setViewport` does not stop a running camera tween (found here; 3h's kit waits for the move to end).
- Protocol (the lead with O1, then O2/O3, 2C and contracts): CR-3C-1, a follow target in presence ("who follows me", `test.fail`), with the "always included" peers; CR-3CF-1, an optional sender zoom `view.z` (then `RemoteCursor.zoom`, and R2-04 uses the leader's live zoom instead of the summon's canvas size). They can be batched.

**O1 (the room) and 2F (the api's routes)**
- **DEF-W3-1 (2F / O1, new):** a Recently-deleted restore through the open room does not re-bind a live connector to what it brings back ("reconnected 1 connection" missing; 2 `test.fail`). A restore that brings the connector back too is fine.
- **DEF-3F-1 = 3b F2 (O1 with O2):** a session that joins within 5 s of a board-document write gets the cached snapshot's old `lb_doc` (session settings, tags, start view; 2 `test.fail`).
- CR-3F-2 (+1 on locked notes) and CR 3b-4 (presentation order on locked frames): identity- or board-level `customData` through the lock rule; CR-3D-5 (a name-only editor guest writing `tagDef:`, `test.fail`); CR-3H-2 with 2F (what counts as "typed", R9 `test.fail`); CR 3b-3 (`startView` writer: an owner decision); converted `lb_deleted` batch numbers overlap live ones for 2F's grouping (`M3-part3.md`).

**Contracts owner and 2C (the board page)**
- 2C, from O2's part 3: call `core.syncScene()` after the undo install, `core.persistNow()` on `pagehide`, when hidden and on unmount, drop the `message` microtask deferral, and let `history-join.ts` use `undo.joinPrevious()` / `mergeTop()` (the core covers the loss either way; these make Saved and the queue exact at once).
- CR-3F-1 = W5-26 (`transact` that skips the undo stack: +1s, `test.fail`; 3f then passes the option in `ported/plus-ones.ts`); CR 3G-2 (`LobbyFiles.track`); a tool qualifier on key claims (3c; the keyboard-map test's `TOOL_SCOPED_KEYS` stands in); a "caught up" signal for features (3b F3).
- 2C: a window resize does not bump the viewport signal (CR-3A-10); the note and text tools ignore the next style (CR-3A-7); the element-paste hook for the cross-workspace image check, a client-drawn face for cards without a preview, and a revoked blob URL seen once in the loader (3g); `viewport.get()` lags a `set` by a render and a tween can end a hair off (3b F4, F5).

**Feature owners (follow-ups after wave 3b)**
- 3a: a toolbar action hook for tools that are buttons, the board's Delete calling `mindmap.delete` and type-to-edit on a selected topic (3d, CR-3D-3); the shortcuts key from the chrome (tldraw's CHROME_SAFE_ACTIONS); the highlighter's sizes; the Laser in the viewer toolbar once CR-3A-8 lands.
- 3b: the content list inside the search panel (3i); the pasted-note face through `LobbyTx.insert`; the laptop half and a quiet-window run of the §8.5 gate.
- 3f (wave 5): its own ported CSS (`workshops/ported/workshops-ported.css`) lifts the workshop cards above 3i's Board actions button on phones (W5-07); it wins over 3a's `canvas-tools.css` rule for the phone toolbar's two rows on specificity. If 3i moves or hides that button (W5-06, W5-07), 3f's rule can go; `workshops-phone` checks with `elementFromPoint` that nothing lies over any card.
- 2C: W5-01 (the review's blocker): a note made with N or T inside a frame gets `frameId` null; `workshops-voting` W5-01 (`test.fail`, 3f's spec) checks that the note joins the frame and takes a frame-scoped vote.
- 3c / 3b: `present-live` "late joiner and reloads" leaves the late joiner on the first frame now and then (1 in 5 on 1809cf3 too; likely the first view against the live follow).
- 2F with 2B, before the cut-over: the Excalidraw build writes `board_snapshots.body_version` 2 for v2 bodies and `boards.new_canvas` true for boards born on the new canvas (bridge release R0's contract, `docs/DEPLOY.md`; converted boards keep false), and drops R0's refusals of them from this branch's api at the same time (W3-15, W3-16).
- The api: the private-brainstorm start limit (10 a minute per person) makes long spec files order-dependent; 3CF's spec fix starts its brainstorms as another host.
- 3i and the palette owners: the red note's ink in dark mode (3.43:1).
- 2B: backups (and the restore drill) on `lb_*` files. 2E: the wave-1 facade verbs (specs still use the dev handle `window.__lobbyBoard`), and moving `e2e/spike-b/support` into `e2e/tests/support`.
- Lockfile owner: CR-3I-1 (`@axe-core/playwright`), and the importer edges of W1-9.
- AGENTS.md (plan §10): unchanged; it needs the owner's approval.

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

Skipped: the opt-in measurements `navigation-lod-fps` (LOBBY_MEASURE_FPS=1) and `present-export-heavy`.
Not run here: the spike B suite (spike B's own verification is running), a quiet-window or laptop fps
run, and three runs in a row of the whole folder (each owner ran three of its own specs on its branch).
