# Excalidraw migration, wave 3: integration

The wave-3 integration of `docs/EXCALIDRAW-MIGRATION.md` §7.2 (row "3 Features"): the nine feature owners'
branches merged onto `engine/excalidraw`, their change requests decided, the fixes the merged page needed,
the gate, what is ported per feature, the parity table against today's tldraw app, and the open blockers.
The owners' reports are the evidence for their own slices: `docs/research/excalidraw/wave3/3B.md`, `3D.md`,
`3E.md`, `3F.md`, `3G.md`, `3H.md`, and the wave 3a, 3C and 3i entries of `docs/PROGRESS.md`. The runs here
are **single runs** (plus reruns of what failed), on a machine shared with other agents' runs.

| | |
|---|---|
| Branch | `engine/excalidraw` |
| Base | `5b9c87a` (the wave-2 integration; every wave-3 owner branched from it) |
| Merged (`--no-ff`, in this order) | `engine/w3-3f` `26800da` (`24e60e9`), `engine/w3-3e` `2a45b88` (`50abc93`), `engine/w3-3a` `41508b7` (`9e51741`), `engine/w3-3c` `6908c7e` (`ed24d3e`), `engine/w3-3g` `ab4ff0e` (`84fafc2`), `engine/w3-3b` `dc2f441` (`12a195f`), `engine/w3-3d` `0387689` (`5bd70c6`), `engine/w3-3h` `1b405c0` (`6777186`), `engine/w3-3i` `da41b71` (`fb9d749`). Conflicts: `docs/PROGRESS.md` in every merge after the first (all entries kept), and `canvas/api/impl.ts` plus the §2.2 table in the 3c, 3g and 3b merges (the member-table CRs, W3-1). No other conflict. |
| Spike B | `origin/spike/excalidraw` merged again: **already up to date** (`92b1098`, the M3 report). Spike B has pushed nothing to it since the wave-1 freeze, so the O2 lost-edit fix and every spike-side request below are still open. |
| Change requests | 8 `CR:` commits reviewed, all **accepted** (four of them merged into one mechanism), plus two proposed CRs accepted and applied by the integration (CR 3E-2; CR-3F-5 = CR 3E-3); recorded in `docs/EXCALIDRAW-CONTRACTS.md` §12 as W3-1 to W3-8 (§1) |
| Integration commits | `612ad43` (`CR:`), `f37b44d`, `410ca30`, `2082b98`, `7a47943`, `07e6a77`, `5680fcd`, `5d2e74d`, `51513e8`, `c979618`, and this report (§2) |
| Lockfile, `pnpm-workspace.yaml`, catalog | unchanged by every owner and by the integration |
| Spike-owned folders | unchanged by every owner and by the integration (`apps/sync/src/room/**`, `room/migrate/**`, `apps/web/src/canvas/{sync,lease,history,input,engine,presence,tools,overlay}/**`, `canvas/port-impl.ts`, `canvas/test-facade.ts`, `packages/tldraw-import/**`, `e2e/spike-b/**`) |
| Machine | Windows 11 workstation, Node 24, pnpm 10.34.5, Playwright headless Chromium (one branded-Chrome test in the default suite). Other agents' e2e runs shared the machine; durations are informational. |
| Ports | 6760-6762 and 6770 / 6783 (the first half of the Excalidraw specs, with 3h's and 3i's fake OpenAI), 6775-6777 (the second half), 6771-6773 (reruns and probes), 6790-6793 (the default suite), 6786-6788 (the spike A suite). Nothing listened in 6760-6799 afterwards. |
| Logs | the integrator's scratchpad `w3/` (`lint*.log`, `tc*.log`, `unit1-3.log`, `arrows*.log`, `lc1/`, `lc2/`, `lc3/`, `default1/`, `spikeA1/`, `dbg*.log`, `build-*.log`); never committed |

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

## 2. Integration fixes

The nine branches merged cleanly, but each owner had run on a page without the others. With all fifteen
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

## 3. Gate

Code under test: the final tree is `c979618`. The last full run of the Excalidraw specs was on `5d2e74d`; the
two commits after it change two spec helpers (`51513e8`, rerun below) and move two CSS rules into ported-only
files (`c979618`, whose two specs were rerun). The default suite ran on `410ca30` and the spike A suite on
`7a47943`: every later commit changes only the engine build (ported code, `canvas/**`, `e2e/excalidraw`) or
docs; the shared CSS files the integration had touched are back to their wave-2 content, which the marker
check confirms (0 hits in the normal build).

| Check | Result |
|---|---|
| lint (`biome check .`) | PASS, 1,861 files (final tree) |
| `pnpm -r typecheck` (15 projects, e2e included) + engine-probe tsc + Node-safety tsc | PASS (final tree) |
| `pnpm test` | PASS: **4,849 passed, 36 skipped** (435 files, 9 skipped). Wave 2's 4,573, the owners' new tests, and two of the integration's (the combined cursor filter; the tool-scoped keys). The first run on the merged tree failed only 3 tests, all in 3a's keyboard-map test (the five key conflicts of §2). |
| `pnpm test:arrows` | PASS 85/85 |
| **every Excalidraw spec** (`e2e/excalidraw`, 326 tests; two halves in parallel, `E2E_PORT_BASE` 6760 and 6775) | first run on the merged tree (`410ca30`): 22 failures and 24 unexpected passes (§2). Second run (`5680fcd`): 291 passed, 31 expected failures, 2 skipped, 2 failed, both 3/3 on rerun, so real (fixed in `5d2e74d`, then 3/3 each). **Final run (`5d2e74d`): 290 passed, 31 expected failures, 2 skipped, 3 failed.** Reruns, 3 each: `mindmap-keyboard` "fast typing" 3/3 (a flake of the keyboard and lease class 3D.md describes); A11Y2-06 and R17 were spec races (a viewport read before the phone size landed; Delete pressed before the facade selection landed), fixed in `51513e8`, then 3/3 and 5/5, and the history and phone-overlay files 23/23. After `c979618`: `ai-actions` and `mindmap-structure` 12/12. |
| **the default (tldraw) e2e suite**, whole, once (`E2E_PORT_BASE=6790`, `410ca30`) | **PASS: 341/341** (25.7 min; 340 chromium + 1 branded Chrome), fixtures from `pnpm fixtures` |
| **spike A suite** (`SPIKE_WEB_PORT=6786`, `7a47943`), once | **PASS: 99 passed, 2 skipped** (opt-in), 19.6 min |
| normal web build, engine markers (final tree) | PASS: **0** hits for 42 markers (wave 2's, and the wave-3 features': `__lobbyNavigation`, `navigation-overlay`, `dr-nav-minimap`, `workshops-marks`, `workshops-top`, `dr-wk-vote-tab`, `canvas-announcer`, `phone-sheet-open`, `__lobbyMindmap`, `__lobbyTags`, `lobby-present-live`, `ai-entry-fallback`, `checkpoint-preview-text`, `media-download-original`, `following-stop`, `style.panel-toggle`, `dr-tag-picker--floating`, …). No `excalidraw-assets/`, 0 source maps. A first check found `data-lobby-board-canvas` in the normal build's CSS (the integration's own scoped rules in shared CSS files; moved in `c979618`). |
| engine flag without the dev-auth guard | PASS: 0 of the 42 markers. Positive control: the guarded engine build contains 36 of them (the other 6 are function names the minifier renames). |

The 31 **expected failures** (`test.fail`, each naming its blocker; §6 has the owners):

| Blocker | Tests |
|---|---|
| CR 2F-2 (O1 `serverWrite`) | 11: the private-brainstorm reveal ×6 (`workshops-private-notes`), Recently-deleted restore ×3 (`history-deleted`), the reveal's checkpoint row (`history-checkpoints`), a restored note re-attaching its thread (`comments-core`) |
| CR-2D-2 (`LobbyTx.insert`) | 2 (`navigation-templates`) |
| DEF-3F-1 = 3b F2 (O1/O2 snapshot cache) | 2 (`workshops-facilitation` RETRO-03a, `navigation-start-view`) |
| CR-3F-3 (follow camera hook) | 2 (R2-04 in `workshops-follow` and `a11y-phone-overlays`) |
| wave 2's known defects (O2, spike B history) | 3 (`collab-conflicts`: the drag overwrite, redo of Ctrl+G, typing into an empty note) |
| 3i's chrome and canvas keys | 4 (`a11y-keyboard-safety`: Ctrl+Z from the chrome, 3a; Ctrl+X on the canvas; Shift+= from the chrome, 3b; undo restoring the selection, spike B history) |
| one each | CR-2D-1 (`templates-scenes`), CR-3A-3 (`canvas-ux-keys` MAK-06), CR-3C-1 (`people-list`), CR-3D-5 (`tags-panel`), CR-3F-1 and CR-3F-4 (`workshops-facilitation`), CR-3H-2 (`ai-actions` R9) |

Skipped: `present-export-heavy` (an opt-in measurement) and the context-menu "Export as" `test.fixme` (3e).
Not run: the spike B suite (its page is `?page=spike` on this branch, W1-8) and three runs in a row of the
whole folder (each owner ran three runs of its own specs on its branch).

## 4. Per feature: what is on the Excalidraw page

"Ported" means the feature works on the Excalidraw board page with its tldraw copy and test ids and its
ported specs pass; "partial" means part of it is there and the rest waits on a named blocker; "not ported"
means absent from the new page. Every deviation below is listed in full in the owner's report.

### 4.1 Canvas tools (3a, `canvas-ux`) — ported, partial for z-order

- **Ported:** the toolbar (COL-07 order, More with the last-used tool, Media, features' tools, Templates), the style panel (13-colour note palette, colour, fill, dash, size, font, align, arrowheads; one undo step per pick; folds behind a Styles button on phones since the integration), the context menu, the board menu (Board ▸ Edit ▸ View ▸ Export ▸ Preferences ▸), the keyboard shortcuts dialog, the selection bar (lock, align, distribute, compact on phones), lock and Unlock all, the locked hint, double-click to add a note, frame rename, type-to-edit (RETRO-02), place at centre (A11Y-07), the export gate on copy, snapping on by default, `styles.of`/`apply`, the keyboard-map test over every feature.
- **Partial:** PgUp/PgDn and the Reorder menu change no paint order (CR-3A-3, the port's `transact`); the note and text tools ignore the next style (CR-3A-7); viewers cannot copy even when exporting is allowed (CR-3A-4); no Hand tool for read-only roles and no highlighter (CR-3A-6).
- **Deviations:** stroke widths are the engine's; no in-place shape-type change; no serif font; align right has no key (Alt+D is the browser's); locking a frame locks its contents.

### 4.2 Navigation (3b, `navigation`) — ported, partial for templates and deep zoom

- **Ported:** Lobby's camera members; zoom keys and menu (MAK-10); the minimap (MAK-11, PERF-03); board search (MAK-12) **with tags since the integration**; the frames panel with reorder, skip and copy link (MAK-13); `?el=` / `?view=` links and the legacy `?d=` reader; content-search links; the first view (PRE-06, DANA-06, R13; since the integration it keeps a camera that moved, or a person who acted, before it was decided) and the board start view (PRE-08); arrange as grid (MAK-18); select by type (MAK-17); paste as sticky notes (COL-05, RETRO-01).
- **Partial:** the template picker opens, but inserting a template (from the picker or `?template=`) is **blocked by CR-2D-2**; wheel and pinch stop at Excalidraw's 0.1 (CR 3b-2); only owners can set the start view (CR 3b-3); a locked frame keeps its place in the order (CR 3b-4).
- **Not ported:** the level-of-detail pass for zoomed-out views (plan §8.5, a render pass in spike-owned `canvas/overrides.ts`); zoom keys from the chrome (3i's request).

### 4.3 Comments, people, follow, present to everyone (3c) — ported

- **Ported:** the comment tool (C), pins, hover preview, composer and threads, replies, edit and delete, resolve and reopen, mentions and their notices, the dock panel with filters, the notifications bell, the `?thread=` deep link, team-only threads, orphans, Shift+C; `canvas.follow`; the people item with avatars, the list, Follow / Following, Bring here, Bring everyone to me; present to everyone (invitation, chip, hand-off, reloads, api restart), **running on present mode since the integration**.
- **Partial:** restoring a deleted note does not re-attach its thread (CR 2F-2); "who follows me" by camera needs a follow target in presence (CR-3C-1).
- **Deviations:** follow is by session and moves at once; the comment tool's cursor is a crosshair; Tab steps in plain reading order.

### 4.4 Mind maps and tags (3d) — ported

- **Ported:** mind maps (new map, from a shape, child/sibling/level, collapse with the B12 guards, Tidy up, branch delete with confirmation, arrow navigation, the layout keeper, outline export) and tags (the picker, chips, the panel, Show only, rename/recolour/delete everywhere, the CSV column through 3e, search by tag through 3b since the integration).
- **Partial:** a name-only guest cannot create a tag (CR-3D-5); typing on a selected topic does not start editing, F2 does (CR-3D-3); a new topic and its words are two undo steps (W1-9 `mergeTop`); an invisible re-route step may appear (CR-3D-4).

### 4.5 Present mode, exports, export policy, thumbnails (3e) — ported

- **Ported:** present mode (slides in presentation order, skips, fullscreen with the in-window fallback, slide keys and list, the modal key trap, view restore, collaborators' edits followed, cursors hidden), the Export dialog (PNG 1×/2×/4×, SVG, copy as PNG, PDF with bookmarks and a text layer, CSV with tags and votes), the export policy store and share badge, thumbnails, and `export.*`.
- **Partial:** the context-menu "Export as" test is still `test.fixme` (its body is not ported; the menu entries are on the page).
- **Deviations:** the fullscreen element is the canvas region; engine-drawn frame names add height to whole-board PNGs; the thumbnail schematic's images are grey tiles only where `files.urlOf` has no preview.

### 4.6 Workshops (3f) — ported, partial for the reveal

- **Ported:** the timer (with the floating timer while presenting, **now tested**), dot voting (setup, click and keyboard voting, ballot privacy, results, badges, the Voting panel and CSV gate), +1, reactions, raise hand and the queue, session settings, Gather everyone (on 3c's follow, **now tested**), private brainstorming up to the reveal.
- **Partial:** the private-brainstorm **reveal and "Place notes" answer 503 on an open board (CR 2F-2)**; +1 is an undo step (CR-3F-1) and not possible on locked notes (CR-3F-2); nobody draws note authors on this page, so "Hide note authors" has nothing to hide (CR-3F-4); a gathered phone keeps the leader's zoom (R2-04, CR-3F-3).

### 4.7 Media (3g) — ported

- **Ported:** file cards (cover, pages, status, Office note, video player, Download), image and page placeholders, paste/drop/Ctrl+U with today's drop layout (grids, frames, template slots, F12), the PDF viewer and Place on board, open original, download originals, `files.urlOf`/`insert`, the derivative swap.
- **Partial:** the cross-workspace image paste check (plan §2.10.4) needs a paste hook from 2C; exports see the engine's placeholder for cards without a preview (2C's loader); a viewer's drop is silent (spike B's input).
- **Deviations:** the card face is a DOM overlay (only opaque elements above it cut holes); no local preview while uploading; slotted images land on top (no insert-at-index).

### 4.8 History and AI (3h) — ported, partial for Recently deleted

- **Ported:** the History panel (checkpoints, restore as new board, duplicate, .json export, automatic checkpoints), the bitmap checkpoint preview, the export gate; AI (themes, summarize, action items, ideas, budgets, the owners' switches, the Undo toast) through **3a's selection bar, context menu and board menu since the integration**.
- **Partial:** **Recently deleted restore answers 503 on an open board (CR 2F-2)**; a template's prompt notes placed by a person count as typed (R9, CR-3H-2); a v1 (tldraw) checkpoint shows "can't be previewed here yet".
- **Not ported:** the backup restore drill (backups are off on the Excalidraw stack until 2B moves them to `lb_*` files).

### 4.9 Accessibility and mobile (3i) — ported, partial for chrome keys

- **Ported:** the live region, keyboard traversal (F6, Alt+arrows, into and out of frames), the Contents panel, the phone sheet, palette contrast, the named canvas, the skip link; 12 of 3i's cross-feature tests **now pass against the other owners' features**.
- **Partial:** Ctrl/Cmd+Z and Shift+= from the chrome do not reach the board (3a, 3b); Ctrl+X on the canvas does not cut (the key allowlist); undo does not restore the selection (spike B history); axe is not a dependency (CR-3I-1, the audit spec stands in).
- **Finding:** the red note's ink is 3.43:1 through Excalidraw's dark filter (below AA).

## 5. Parity with today's tldraw app

Every feature in `docs/PROGRESS.md` and `docs/DEMO.md`, as it stands on the Excalidraw page after this
integration. "Outside the canvas" means the feature is not part of the board page and both builds share it.

| Feature (source) | On the Excalidraw page | Owner | Evidence (e2e/excalidraw) | What is missing, and the blocker |
|---|---|---|---|---|
| Two people on a board: cursors, avatars, live edits, reload, restart, offline (M0, DEMO 0:30-1:00) | ported (wave 2) | 2C, spike B | `board-*`, `collab-*`, `sync-durability` | the O2 lost-edit race and the drag overwrite (§6) are data-loss defects that block the cut-over |
| Same-note typing: the lease (M0, DEMO checklist 7) | ported (wave 2) | 2C, spike A/B | `collab-conflicts` | typing into an empty note is two undo steps (spike B history) |
| Saved indicator, per-property undo, leave guard (validation phase) | ported (wave 2) | 2C | `board-saved`, `sync-durability` | the offline queue's 100 ms window (O2) |
| Server-enforced roles, forged writes refused, revocation (M1) | ported (wave 2) | O1, 2E | `permissions-canvas`, `security-negative` | — |
| Toolbar, tools, style panel, 13-colour note palette (Miro phase) | ported | 3a | `canvas-ux-toolbar` | no highlighter, no Hand for viewers (CR-3A-6); next note/text style (CR-3A-7); stroke widths are the engine's |
| Miro shortcuts: L, P, Alt+1/2, Ctrl+0, Ctrl+Shift+L, M, Ctrl+F (Miro phase) | ported | 3a, 3b | `canvas-ux-keys`, `navigation-keys` | — |
| PgUp/PgDn z-order (Miro phase) | **partial** | 3a | `canvas-ux-keys` MAK-06 (`test.fail`) | the keys and menu run, but the paint order does not change: CR-3A-3 (the port's `transact`, spike B / 2C) |
| Guides and snapping on by default (Miro phase) | ported | 3a | `canvas-ux-canvas` | — |
| Type-to-edit notes, Enter/Esc flow (Miro phase, RETRO-02) | ported | 3a | `canvas-ux-keys` | typing on a selected mind-map topic starts nothing (F2 does; CR-3D-3) |
| Context menu, board menu, shortcuts dialog, selection bar, lock, align (persona fixes) | ported | 3a | `canvas-ux-menus`, `canvas-ux-canvas`, `canvas-ux-duplicate` | viewers cannot copy (CR-3A-4); Alt+D has no key |
| Paste as sticky notes (Miro phase) | ported | 3b | `navigation-paste` | pasted notes take the new-note face (CR-2D-2) |
| Template picker and insert, Lobby tour, `?template=` (Miro phase, wave 3, DEMO 0:00) | **partial** | 3b | `navigation-templates` (2 `test.fail`) | the picker opens; the insert is blocked by **CR-2D-2** (`LobbyTx.insert`); a board created from the dashboard's template opens empty (3i's finding) |
| Frame outline with reorder, frames panel (Miro phase) | ported | 3b | `navigation-frames` | a locked frame keeps its place (CR 3b-4) |
| Board search (Miro phase), tags in search (wave 4) | ported | 3b, 3d | `navigation-links`, `tags-panel` | — (tags wired at the integration) |
| Copy link to selection, deep links (Miro phase) | ported | 3b | `navigation-links` | new `?el=` / `?view=` format; legacy `?d=` still opens |
| Start view (Miro phase) | ported | 3b | `navigation-start-view` | owners only (CR 3b-3); a first visit within 5 s of the write sees the old one (DEF-3F-1 = 3b F2) |
| Minimap, zoom menu, arrange as grid, select by type (persona fixes) | ported | 3b | `navigation-keys`, `navigation-arrange` | wheel/pinch below 0.1 (CR 3b-2); level-of-detail pass not started |
| 20k shape cap (Miro phase) | ported (server) | O1 | canvas-schema `limits.ts` | — |
| Comments: tool, pins, threads, replies, resolve, mentions, panel, bell, orphans, Shift+C (Miro phase, DEMO 1:40) | ported | 3c | `comments-core`, `comments-review`, `comments-privacy`, `comments-notify` | an orphan does not re-attach on a Recently-deleted restore (**CR 2F-2**) |
| People list, follow, "who follows me" (wave 4) | ported, partial | 3c | `people-list` | "N following you" by camera needs CR-3C-1 |
| Present mode: frame by frame, chrome/cursors/pins hidden (Miro phase) | ported | 3e | `present-export-present` | — |
| Present to everyone: invite, join, hand-off, follow in step (wave 4, DEMO 2:45) | ported | 3c, 3e | `present-live` (6 tests, all passing since the integration) | — |
| Export PNG / SVG / PDF / CSV, copy as PNG (Miro phase, DEMO 3:30) | ported | 3e | `present-export-files` | the context-menu Export as test is `test.fixme` (body not ported) |
| Export policy: viewers and commenters cannot export (wave 3, DEMO safety) | ported | 3e, 3a, 3g | `sharing-export-control` | copy for viewers when exporting is allowed (CR-3A-4) |
| Thumbnails (wave 3) | ported | 3e | `thumbnails-capture` | — |
| Timer (Miro phase) | ported | 3f | `workshops-timer` | — |
| Dot voting with frame scope, notes only, ballot privacy, results (Miro phase, DEMO 2:00) | ported | 3f | `workshops-voting` | — |
| Gather everyone (Miro phase) | ported | 3f, 3c | `workshops-follow` | a phone keeps the leader's zoom (R2-04, CR-3F-3) |
| Reactions, raise hand, +1 (wave 4 polish) | ported, partial | 3f | `workshops-facilitation` | a +1 is an undo step (CR-3F-1) and impossible on locked notes (CR-3F-2) |
| Session settings: hide cursors, hide note authors (review rounds) | partial | 3f, 3a | `workshops-facilitation` | nobody draws note authors on this page (CR-3F-4, `test.fail`) |
| Private brainstorming (wave 3, DEMO "more to show") | **partial** | 3f | `workshops-private-notes` (6 `test.fail`) | the reveal and Place notes answer 503 on an open board: **CR 2F-2** (O1 `serverWrite`) |
| Files: images, PDF cards with pages, video, Office previews, attachments; Ctrl+U, drop, paste (M0, M3, DEMO checklist 8) | ported | 3g | `media-files`, `media-video`, `media-office`, `media-viewer` | no local preview while uploading; the cross-workspace paste check (2C hook) |
| Mood board slots, drop layout (persona fixes, DEMO 1:50) | ported | 3g | `media-drops` | a slotted image lands on top (no insert-at-index) |
| Named checkpoints, restore as new, duplicate, JSON export/import, automatic checkpoints (Miro phase, wave 4, DEMO 4:00) | ported | 3h | `history-checkpoints`, `history-copies` | a v1 (tldraw) checkpoint is not previewed |
| Recently deleted and its restore (Miro phase, DEMO 4:00) | **partial** | 3h | `history-deleted` (3 `test.fail`) | the list works; the restore answers 503 on an open board: **CR 2F-2** |
| Backups and the restore drill (Miro phase, wave 3) | not on this stack | 2B | — | backups are off on the Excalidraw stack until 2B writes `lb_*` files |
| AI: themes, summarize, action items, ideas, budgets, owner switch (wave 4, DEMO 1:20) | ported | 3h | `ai-actions` | R9: template prompt notes count as typed (CR-3H-2, `test.fail`); output is plain text |
| Mind maps (wave 4, DEMO "more to show") | ported | 3d | `mindmap-keyboard`, `mindmap-structure` | new topic + words are two undo steps (W1-9) |
| Tags, Show only, tag panel (wave 4, DEMO "more to show") | ported | 3d | `tags-picker`, `tags-panel` | a name-only guest cannot create a tag (CR-3D-5) |
| Name-only guests on a board, on a phone (wave 3, DEMO "more to show") | partial | 2C, 3c, 3f, sharing | `workshops-phone`, `tags-panel`, `present-live` | the guest flow's own specs (`guests*.spec.ts`) are not ported (joining is shared with the tldraw page) |
| Accessibility: skip link, live region, keyboard traversal, contrast (review rounds) | ported | 3i | `a11y-*` (47 tests) | Ctrl+Z / Shift+= from the chrome, Ctrl+X on the canvas, undo restoring the selection (`test.fail`); red note ink in dark mode 3.43:1 |
| Phone layout (review rounds) | ported | 3i, 3a | `a11y-phone`, `a11y-phone-overlays`, `workshops-phone` | the phone style panel folds behind a button (integration); no tldraw-style phone toolbar |
| Dashboard, template gallery, sharing dialog, links, access requests, invitations (Miro phase) | outside the canvas | — | default suite | the dashboard's content-search hits open `?el=` links in the engine build (3b) |
| Search across boards (wave 4) | outside the canvas | — | default suite | the api reads elements (2F) |
| Email sending, Kanban, DBC Ops (not built) | not built on either page | — | — | — |

## 6. Open blockers, by owner

Blocking the cut-over (data loss or a demo step that does not work) are marked **B**. Each expected failure
(`test.fail`) names its blocker, and must lose its mark when the blocker lands (Playwright then reports an
unexpected pass).

**Spike B (still running; nothing pushed since the wave-1 freeze)**
- **B · O2 (`canvas/sync/core`):** the lost-edit / lost-create race (an edit a server frame overtakes is lost while the tab shows Saved); the remote edit overwritten by a local drag's pointer-up push (`collab-conflicts`, `test.fail`); the offline queue's 100 ms window. Specs still wait for Saved around seeding writes; remove the waits when the fix lands.
- **`canvas/port-impl.ts` `transact`** (spike B C0), reported four times: an update to an element created in the same `transact` is dropped (3b F1, CR-3D-1, CR-3H-3, CR-3F-6; worked around with a second `joinPrevious` write), and index writes do not move elements in the scene array, so `tx.reorder` changes no paint order (CR-3A-3, MAK-06 `test.fail`).
- **History (`canvas/history`):** typing into an empty note is two steps, redo of Ctrl+G in a sequence does nothing (wave 2); bound-arrow re-routes recorded as their own steps (CR-3D-4); undo does not restore the selection (3i F11, `test.fail`); `LobbyHistory.mergeTop()` (W1-9: a new mind-map topic and its words are two steps).
- **Input and lease (`canvas/input`, `canvas/lease`, `canvas/tools`):** synthetic key-downs unmarked and no feature keys while an open is pending (CR-3D-2); read-only roles cannot copy at all (CR-3A-4); Alt+D is prevented (CR-3A-5); `setTool('hand')` for read-only roles and the highlighter (CR-3A-6); Ctrl+X on the canvas does not cut (3i, `test.fail`); a viewer's drop is silent (3g).
- **O2:** `rebuild` should keep an image's derivative key (3g, E9). **O3 facade:** its `setViewport` does not stop a running camera tween (found here; 3h's kit waits for the move to end).
- **Protocol (spike B lead + O1):** CR-3C-1, a follow target in presence ("who follows me", `test.fail`).

**O1 (the room, `apps/sync/src/room/**`)**
- **B · CR 2F-2, `serverWrite` / `prepareBoard`:** every private-brainstorm reveal and Place notes (6 `test.fail` in `workshops-private-notes`), every Recently-deleted restore (3 in `history-deleted`, 1 in `comments-core`), and the reveal's checkpoint row (1 in `history-checkpoints`) answer 503 on an open board. This is the demo's 4:00 step and a "more to show" item.
- **DEF-3F-1 = 3b F2 (with O2):** a session that joins within 5 s of a board-document write gets the cached snapshot's old `lb_doc` (session settings, tags, start view; 2 `test.fail`).
- CR-2D-1 (a label created with its new locked container, `test.fail`); CR-3F-2 (+1 on locked notes) and CR 3b-4 (presentation order on locked frames): identity- or board-level `customData` through the lock rule; CR-3D-5 (a name-only editor guest writing `tagDef:`, `test.fail`); CR-3H-2 with 2F (what counts as "typed", R9 `test.fail`); CR 3b-3 (`startView` writer: an owner decision).

**Contracts owner and 2C**
- **B · CR-2D-2, `LobbyTx.insert(elements)`:** the template insert from the picker and from `?template=` (2 `test.fail`, and a new board from a dashboard template opens empty), the pasted-note face, and a slotted image stacked above its slot. The Lobby tour is the demo's first step.
- CR-3F-1 (`transact` that skips the undo stack: +1s, `test.fail`); CR-3F-3 (a hook for the follower's camera: R2-04, 2 `test.fail`); CR 3b-2 (wheel and pinch deltas); CR 3G-2 (`LobbyFiles.track`); a tool qualifier on key claims (3c; the keyboard-map test's `TOOL_SCOPED_KEYS` stands in); a "caught up" signal for features (3b F3).
- **2C:** nobody draws a note's author on this page (CR-3F-4, `test.fail`); the note and text tools ignore the next style (CR-3A-7); the element-paste hook for the cross-workspace image check, a client-drawn face for cards without a preview, and a revoked blob URL seen once in the loader (3g); `viewport.get()` lags a `set` by a render and a tween can end a hair off (3b F4, F5).

**Feature owners (wave 3 follow-ups)**
- 3a: Ctrl/Cmd+Z from the chrome (3i, `test.fail`); a toolbar action hook for tools that are buttons, and the board's Delete calling `mindmap.delete` (3d); a phone toolbar like tldraw's (the integration folded the style panel and made the toolbar scroll).
- 3b: the level-of-detail pass (plan §8.5); zoom keys from the chrome (3i, `test.fail`); the content list inside the search panel (3i).
- 3e: port the context-menu "Export as" test body (`test.fixme`).
- 3i and the palette owners: the red note's ink in dark mode (3.43:1).
- 2B: backups (and the restore drill) on `lb_*` files. 2E: the wave-1 facade verbs (specs still use the dev handle `window.__lobbyBoard`), and moving `e2e/spike-b/support` into `e2e/tests/support`.
- Lockfile owner: CR-3I-1 (`@axe-core/playwright`), and the importer edges of W1-9.
- AGENTS.md (plan §10): unchanged; it needs the owner's approval.
