# Draftroom UX acceptance checklist (what a Miro user will test us on)

Date: 2026-09-26. This turns the two Miro research files into pass/fail checks for Draftroom, grouped by the workflows in build plan §2. Each row can be run by a person or scripted in Playwright. We copy interaction patterns, not Miro's names, icons, palette, sounds or copy (see [miro-official-behaviors.md](miro-official-behaviors.md), "Naming and branding").

**Inputs.** [miro-official-behaviors.md](miro-official-behaviors.md) (**OB**, section numbers, with Miro help article tags [H#]), [miro-user-voices.md](miro-user-voices.md) (**UV**, theme codes F#/D#/§#), [../Miro_Clone_Build_Plan.md](../Miro_Clone_Build_Plan.md) §2–4, §9, §13 (**BP**), [../FEATURES-CONTRACTS.md](../FEATURES-CONTRACTS.md) (**FC**), and the tldraw 5.4.2 source in `node_modules` (**TL**, files listed at the end). I re-checked Miro's shortcut article (help.miro.com, updated 2026-09-15) on 2026-09-26. It confirms L (connector), P (pen), Alt/Option+1 (zoom to fit), Ctrl/Cmd+0 (100%), G (grid), Ctrl/Cmd+Shift+L (lock), PgUp (bring to front), Ctrl/Cmd+F (search), F1, M, Shift+C and Alt+arrow (duplicate in a direction). Nothing here was tested hands-on in Miro.

## How to read a row

- **Priority.** **P0**: a Miro user would be blocked, or disappointed right away, without it. **P1**: expected soon after first use. **P2**: nice to have.
- **Engine.**
  - **FREE**: tldraw 5.4.2 already does this by default (I read it in the source). We only test it and avoid breaking it.
  - **CONFIG**: tldraw has it, but it needs an option, a different user-preference default, a shortcut remap through `overrides`, or UI that exposes it.
  - **BUILD**: Draftroom code (our UI, server, or custom shapes).
  - A **?** means the behavior is likely but I could not confirm it in source (**UNVERIFIED**).
- **Test setup.** Unless a row says otherwise, "A" and "B" are two signed-in browsers on the same board (two Playwright contexts). Numbers in [brackets] are our proposed thresholds where Miro publishes none. Tune them, but keep a number.
- **Order.** Within each workflow, rows run P0, then P1, then P2.

**Totals: 121 items.** 64 are P0, 48 are P1 and 9 are P2. By the first word of the Engine column, 19 rows are FREE, 12 are CONFIG and 90 are BUILD. Several FREE rows still need our own UI or a config change on top. The facilitation group has no P0s because build plan §4 puts it in the broader release. For a live-workshop pilot, promote the timer (FAC-03) and voting (FAC-04 to FAC-06) first.

## Engine facts that change the work (read in tldraw 5.4.2 source)

1. **Shape cap.** `maxShapesPerPage` defaults to **4,000**. Once a page is at the cap, tldraw refuses the *whole* create batch and raises a "max shapes" alert (`Editor.canCreateShapes`, `options.ts`). The heavy-board gate (5,000 objects) and large pastes fail unless we raise it (PRF-02).
2. **Upload limits.** The defaults are `maxAssetSize` **10 MB**, `maxFilesAtOnce` 100 and `maxImageDimension` 5,000 (`defaultExternalContentHandlers.ts`, set through `<Tldraw>` props). Creative originals often exceed 10 MB (FIL-01).
3. **Dropped images.** They are created at their native pixel size, side by side in one row, and then the camera zooms out to fit them (`createShapesForAssets`, `centerSelectionAroundPoint`). A consistent insert size is ours to build (FIL-06).
4. **Double-click and typing.** Double-clicking empty canvas creates a **text** shape (`createTextOnCanvasDoubleClick: true`). Typing on a selected note only works behind the debug flag `editOnType`, which is off, and tldraw's own comment warns that it conflicts with single-key shortcuts (COL-04, COL-09).
5. **Snapping.** It is off by default (`isSnapMode: false`); holding Ctrl/Cmd reverses whatever the setting is (MAK-02).
6. **Shortcuts while editing text.** All of tldraw's app shortcuts are suspended while a shape is being edited, a menu is open, or the user has turned shortcuts off (`areShortcutsDisabled`). So inside text, Ctrl/Cmd+B/I/U reach TipTap's bold, italic and underline (StarterKit 3.31 includes Underline). The Ctrl+I (embed) and Ctrl+U (upload) conflicts only happen when a shape is selected but not being edited.
7. **Cmd counts as Ctrl on Mac.** For pointer input, tldraw treats Cmd as Ctrl (`getPointerInfo`: `ctrlKey = metaKey || ctrlKey`). On a Mac, Cmd therefore stops an arrow from binding, gives a fully-enclosed box selection and reverses snapping, which matches Miro's Mac behavior.
8. **Remapping works.** `TLUiOverrides.actions(editor, actions, helpers)` and `.tools(...)` receive the full maps, and `useKeyboardShortcuts` registers whatever `kbd` strings they return. Some keys are handled in the editor's state machine instead of those maps, so overrides can't reach them: Enter to edit, Tab and Ctrl+Enter to make a note, arrow-key nudge, and Tab or Ctrl+arrow traversal. Changing those needs a custom select-tool state or an earlier keydown listener. `apps/web/src/board/BoardPage.tsx` already passes an `overrides` prop; I did not review what it contains.
9. **Already free.** Shift-click or Ctrl/Cmd-click adds to a selection. Space-drag, middle-drag and right-drag all pan (`rightClickPanning: true`). tldraw also ships:
   - user preferences for Mouse/Trackpad input mode and for fully-enclosed ("wrap") selection;
   - `unlock-all`, `pack`, `stack` and `fit-frame-to-content`;
   - PNG and SVG export with a transparent-background option, copy as PNG, and download original;
   - reduced motion (animated images then show a still first frame), a switch to turn shortcuts off, and dynamic size mode;
   - follow, which stops on wheel or pinch (`Editor.ts`).

---

## 1. Prepare a session (PRE)

| ID | P | Expected behavior (pass/fail) | Engine | Source |
|---|---|---|---|---|
| PRE-01 | P0 | "New board" on the dashboard opens a board within [3 s], showing the template picker with a prominent **Blank board** choice, search and categories. Ticking "Don't show on new boards" keeps the picker closed on that user's next new board. | BUILD | OB §8 [H24][H43] |
| PRE-02 | P0 | Each of the six templates inserts only ordinary, ungrouped, editable shapes: every note's text can be edited, and every bound arrow stays attached when its target is dragged. Inserting the same template twice creates no duplicate IDs. | BUILD | OB §8; FC templates |
| PRE-03 | P0 | Inside a board, the toolbar's Templates entry places a template in empty space near the viewport and leaves it selected and in view. One Undo removes all of it. | BUILD | OB §8 (ours) |
| PRE-04 | P0 | F then click drops a frame of a default size; F then drag draws one; double-clicking the title renames it. Selecting content and pressing Ctrl/Cmd+Alt+G wraps it in a new frame. | FREE (verify click-to-place size) | OB §2 [H5]; TL actions `frame-selection` |
| PRE-05 | P0 | Dragging a shape into a frame makes it a child: moving the frame moves the shape, and dragging the shape out detaches it. | FREE | OB §2 [H5] |
| PRE-06 | P0 | A board never opens on an empty viewport. Returning users land on their last view (or on all content, if that view is empty); first-time users land on the start view, or on all content if none is set. | BUILD | UV F2 #3; OB §6 [H35] |
| PRE-07 | P1 | Template backgrounds, headings, instructions and frame borders arrive locked. A participant can type into the starter notes, but dragging the background moves nothing. | BUILD | UV F8, §5 |
| PRE-08 | P1 | An owner can set a start view (the current view, or a frame). A newly invited user's first visit lands there. | BUILD | OB §6, §10 [H35] |
| PRE-09 | P1 | The frame tool offers 16:9, 4:3, A4 and 1:1 presets. "Fit frame to content" resizes a frame around its children. | BUILD presets; FREE fit (TL `fit-frame-to-content`) | OB §2 [H5] |
| PRE-10 | P1 | "Save as template" on a selection or a whole board adds it to the workspace library with a name, description and preview. Other members find it in the picker's search, and inserting it passes PRE-02. | BUILD | OB §8 [H25]; UV D4 |
| PRE-11 | P2 | Small blocks can be inserted on their own: a voting area, a 2×2, retro columns, and a storyboard strip whose panels renumber when reordered. "Clear content" empties the text of selected notes but keeps their color, size and position. | BUILD | UV D4, §7; OB §4, §8 |

## 2. Collect ideas (COL)

| ID | P | Expected behavior (pass/fail) | Engine | Source |
|---|---|---|---|---|
| COL-01 | P0 | N then click places a note, and the tool returns to Select. Dragging the note button onto the canvas drops a note where you let go; Q (keep tool selected) allows repeated placement. | FREE (return to Select: verify) | OB §1 [H1][H13]; TL useTools, `toggle-tool-lock` |
| COL-02 | P0 | With one note selected, Enter starts editing with all its text selected. Esc stops editing and leaves the note selected. | FREE | OB §1 [H3]; TL Idle.ts |
| COL-03 | P0 | While editing a note, Tab creates and opens a new note to the right; Shift+Tab goes left, Ctrl/Cmd+Enter below and Ctrl/Cmd+Shift+Enter above. Inside a bulleted list, Tab indents instead. | FREE | OB §1; TL NoteShapeUtil |
| COL-04 | P0 | With exactly one unlocked note selected, typing a printable character starts editing, and that character is in the note (decide whether it replaces or appends, then test that one). Single-key tool shortcuts still work when nothing, or something other than a note, is selected. | BUILD (TL has this only behind the `editOnType` debug flag, off) | OB §1; UV F6 #1 |
| COL-05 | P0 | Pasting tab- or comma-separated cells, or multi-line text, asks "Notes or text?". Notes creates one note per non-empty cell in the source rows and columns, all selected and undoable in one step. Above the cap (default 500), it creates the first 500 and shows how many were left out. | BUILD (FC `parseBulkText`, `notesFromText`) | OB §1 [H1][H12]; FC |
| COL-06 | P0 | The note color picker shows Draftroom's own fixed palette (≥12 colors), and text on every color meets WCAG AA contrast in light and dark themes. One pick recolors every selected note in one Undo step. | CONFIG (TL has 13 color slots; the values are ours) | OB §1; UV F6 |
| COL-07 | P0 | The default toolbar holds Select, Hand, Note, Text, Shape, Pen, Connector, Frame, Upload, Comment and Templates; everything else is one level down. | BUILD | UV F11; BP §3 |
| COL-08 | P0 | Ctrl/Cmd+D duplicates the selection with an offset. Alt/Option-drag leaves the original in place and drags a copy. | FREE | OB §4 [H4]; TL `duplicate`, Translating |
| COL-09 | P1 | Double-clicking empty canvas creates a note in the last-used color, already in edit mode (not a text box). Double-clicking an existing note places the caret. | CONFIG (`createTextOnCanvasDoubleClick: false`, plus our handler) | UV D2, §5 |
| COL-10 | P1 | Bulk entry: a dialog where each line becomes a note. Done places them as a grid near the viewport; Esc closes it without creating anything. | BUILD | OB §1 [H1][H4] |
| COL-11 | P1 | A note can have several tags, shown as chips; you can pick an existing tag, create one, or remove one. "Delete tag everywhere" strips it from every object in one Undo step, and search can filter by tag. | BUILD | OB §1 [H1][H16]; BP §4 |
| COL-12 | P1 | While editing notes and text, Ctrl/Cmd+B/I/U, lists and links work. The text toolbar adds alignment (including justify) and line spacing, and one text box can hold two sizes (headline plus body). | FREE (B/I/U, lists, links via TipTap) + BUILD (justify, spacing, mixed sizes) | UV F6 #3 |

## 3. Make sense: organize and navigate (MAK)

| ID | P | Expected behavior (pass/fail) | Engine | Source |
|---|---|---|---|---|
| MAK-01 | P0 | A drag box selects every shape it touches; holding Ctrl/Cmd limits it to shapes fully inside. Shift-click or Ctrl/Cmd-click adds or removes a shape, and Ctrl/Cmd+A selects all. | FREE | OB §4 [H10]; TL Brushing, PointingShape |
| MAK-02 | P0 | Alignment guides appear by default when a dragged or resized shape lines up with another shape's edge or center. Holding Ctrl/Cmd while dragging turns them off. | CONFIG (flip the TL `isSnapMode` default to true) | OB §4; TL TLUserPreferences, Translating |
| MAK-03 | P0 | With 2+ shapes selected, the selection toolbar offers align left, center, right, top, middle and bottom; with 3+, it also offers distribute horizontally and vertically. Each is one Undo step. | FREE actions + BUILD toolbar | OB §4 [H6]; TL align/distribute actions |
| MAK-04 | P0 | Ctrl/Cmd+G groups and Ctrl/Cmd+Shift+G ungroups. A click selects the group, a double-click selects one member, and Enter on a group selects its children. | FREE | OB §4 [H6]; TL actions, Idle.ts |
| MAK-05 | P0 | Ctrl/Cmd+Shift+L locks or unlocks the selection, and B sees the lock at once. Nobody can drag, edit or delete a locked shape until it is unlocked; right-click on the canvas → Unlock all unlocks everything. | CONFIG (TL `toggle-lock` is on Shift+L; `unlock-all` exists) | OB §4 [H11] |
| MAK-06 | P0 | PgUp brings to front and PgDn sends to back; Shift+PgUp/PgDn move one step. tldraw's ] and [ keep working. | CONFIG (TL uses ] [ and Alt+] Alt+[) | OB §4, §5 [H4] |
| MAK-07 | P0 | L (and A) starts a connector. Its ends bind to notes, shapes, text and images, and stay attached when A or B moves either end; holding Ctrl/Cmd while drawing stops it binding. | FREE (A) + CONFIG (L is TL's unbound line) | OB §3 [H9]; TL useTools, ArrowShapeUtil |
| MAK-08 | P0 | Connectors can be straight, curved or elbow, with arrowheads (or none) at either end, color, dash and thickness. Double-clicking a connector adds a label that can be dragged along it. | FREE | OB §3 [H9]; TL TLArrowShape |
| MAK-09 | P0 | On a trackpad, two-finger scroll pans and pinch zooms. With a mouse, the wheel follows a Mouse/Trackpad setting in our menu. Space-drag, middle-drag and right-drag pan, and a right-click without dragging opens the context menu. | FREE + CONFIG (TL `inputMode` preference, `rightClickPanning`) | OB §6 [H15]; TL Editor |
| MAK-10 | P0 | Alt/Option+1 fits all content, Alt/Option+2 zooms to the selection, and Ctrl/Cmd+0 goes to 100% without changing the browser's zoom. The zoom menu shows the percentage and the same three actions. | CONFIG (TL uses Shift+1/2/0) | OB §5, §6 [H4] |
| MAK-11 | P0 | M shows or hides a minimap with the viewport rectangle; clicking or dragging in it moves the camera. | CONFIG (TL minimap is in the navigation panel, collapsed by default, with no key) | OB §6 [H15]; TL Minimap |
| MAK-12 | P0 | Ctrl/Cmd+F opens board search, not the browser's find. It matches text in notes, text boxes, shapes, connector labels, frame names, file names and alt text, lists results with snippets, highlights matches and dims the rest; Enter or a click jumps to a result, filters narrow by type and tag, and Esc closes it and restores the view. | BUILD (FC `searchBoard`) | OB §6 [H16]; UV F2 #1; FC |
| MAK-13 | P0 | The frame outline lists every frame by name, in presentation order. Clicking a frame moves the camera to fit it; dragging reorders, and B sees the new order; "Auto-order" sorts left-to-right, then top-to-bottom, and one Undo restores the previous order. | BUILD (FC `frameOutline`, `presentationOrder`) | OB §2 [H5][H8]; BP §3 |
| MAK-14 | P1 | Protected lock (Ctrl/Cmd+Shift+P, owners and facilitators only): editors and visitors can't unlock it, and the server rejects their writes to those shapes. | BUILD | OB §4 [H11]; UV F8 |
| MAK-15 | P1 | A selected note shows four side handles: clicking one creates a connected copy on that side, and dragging one onto another shape connects the two. Clicking inside a note's body never starts a connector. | BUILD | OB §1, §3 [H9]; UV F8 |
| MAK-16 | P1 | G shows or hides a grid; with the grid on, moves snap to it and the arrow keys nudge one grid step. With the grid off, the arrow keys nudge 1 px and Shift+arrow nudges 10 px. | CONFIG (TL grid is on Ctrl/Cmd+'; the nudge is FREE) | OB §4 [H12]; TL Idle.ts |
| MAK-17 | P1 | "Filter selection" narrows a mixed selection to one type: notes, frames, connectors, images or text. | BUILD | OB §4 [H10] |
| MAK-18 | P1 | "Arrange as grid" lays the selected images or notes out in rows of equal width (or height) with even gaps, in one Undo step. | BUILD (TL's `pack` and `stack` don't make a grid) | UV §7 |
| MAK-19 | P1 | Find & replace across note, text, shape, connector-label and frame-name text. It shows the match count, can replace all or one at a time, and one Undo reverts a replace-all. | BUILD | UV F2 #2 |
| MAK-20 | P1 | When not editing, Tab and Shift+Tab select the next and previous shape, and Ctrl/Cmd+arrows select the nearest shape in that direction. Ctrl/Cmd+Shift+↓ and ↑ enter and leave a frame or group. | FREE | OB §6 [H3]; TL Idle.ts |
| MAK-21 | P2 | Cluster the selected notes by color, tag or author into labeled groups. Copy and paste style (Ctrl/Cmd+Alt+C and V) across a selection. | BUILD | OB §1 [H2], §4 [H55] |
| MAK-22 | P2 | Frame titles and outline labels stay readable (≥ [11 px] on screen) when zoomed out to 10%. | BUILD | UV F2 #7 |

## 4. Work together (WRK)

| ID | P | Expected behavior (pass/fail) | Engine | Source |
|---|---|---|---|---|
| WRK-01 | P0 | An edit by A appears for B within [250 ms] at the 95th percentile on the agreed network. B sees A's named cursor and A's selection outline, both in the color of A's avatar. | BUILD (sync) + FREE (presence rendering) | BP §13; OB §9 [H28] |
| WRK-02 | P0 | The people bar shows everyone present, collapsing to "+N" with a searchable list beyond [5]. With 30 people it stays one row with readable names. | CONFIG (TL people menu) + BUILD | UV D1; OB §9 [H14] |
| WRK-03 | P0 | A save indicator is always visible (Saved / Saving / Offline). If A goes offline, makes 10 edits and reconnects, the indicator shows "Offline, changes will sync" and then "Saved", and all 10 edits reach B. | BUILD | UV F9; BP §3, §13 |
| WRK-04 | P0 | While A is typing in a note, B sees it marked as being edited by A and can't type in it until A leaves. Neither person loses characters. | BUILD (server text lease, M0) | BP §13 conflict gate |
| WRK-05 | P0 | Undo only reverses your own changes. If A moves a note and B then recolors it, A's Undo moves it back and keeps B's color; A's Undo never brings back a shape B deleted, and it goes back at least [100] steps in a session. | BUILD (TL undo writes back whole records; SYNTHESIS §8) | OB §13 [H53]; UV F8 |
| WRK-06 | P0 | Viewers see navigation only, and commenters see only the comment tool. Disabled tools explain why on hover, and the server rejects writes forged from a viewer's socket so they never reach B. | BUILD | OB §10 [H31]; BP §13 |
| WRK-07 | P1 | "Hide cursors" hides everyone else's cursors for me, and "Hide my cursor" hides mine from everyone else. | BUILD | OB §6 [H13]; UV §5 |
| WRK-08 | P2 | Cursor chat ("/") and the laser pointer (K) are visible to others and fade away. | FREE (TL `open-cursor-chat`, laser tool) | UV D1 |

## 5. Facilitate (FAC)

| ID | P | Expected behavior (pass/fail) | Engine | Source |
|---|---|---|---|---|
| FAC-01 | P1 | Clicking B's avatar makes A follow B: a "Following B" bar appears in B's color, A's view tracks B's, and B can see that A is following. Following ends on a wheel, pinch, pan, click on the canvas, or the bar's Stop button. | FREE (follow; stops on camera input) + BUILD (stop on click?, notice) | OB §9 [H28]; BP §2; TL Editor |
| FAC-02 | P1 | "Gather everyone" moves every participant, viewers included, to the facilitator's view, and each keeps following until they pan, zoom or click. "Bring to me" does the same for one person. | BUILD (server command) | OB §9 [H28] |
| FAC-03 | P1 | Facilitators and editors set the timer (typed or with ±), start, pause, stop/reset it and add 1 or 5 minutes. Everyone else sees it read-only, including in presentation mode, and all clients agree within [1 s], even after joining or reloading mid-countdown. At zero, everyone gets a visual alert and our own sound, which each person can mute. | BUILD (server end timestamp) | OB §9 [H26]; UV §5; BP §9 |
| FAC-04 | P1 | Setting up a vote covers scope (the selection, a frame or object types), votes per person (1–99), duration, and an optional one vote per object. It is anonymous by default, with a choice of "Start now" or "Save for later". | BUILD | OB §9 [H27] |
| FAC-05 | P1 | Everyone gets a join/skip prompt, late joiners included, then uses + and − on eligible objects with a votes-left count and an "I'm done" button. The server rejects votes over the allowance, on objects outside the scope, or after the end. | BUILD | OB §9 [H27]; BP §9 |
| FAC-06 | P1 | Until the vote ends, no client receives other people's ballots or counts; the facilitator sees "N of M done" and can extend or end early, and pressing End twice gives one result. At the end, everyone sees the top 3 and then the full ranking, which can stay as badges, be reopened from a list of past votes, and be exported to CSV. | BUILD | OB §9 [H27]; BP §9; UV §5 |
| FAC-07 | P1 | While private drafting is on, other people's new or edited notes show as covered placeholders, and their text never appears in any WebSocket frame I receive. Ending it runs a [5 s] countdown, then reveals everything; at the start the facilitator chooses whether authors stay anonymous for good and whether only the starter can end it. | BUILD (server-side separation) | OB §9 [H29]; BP §2, §9 |
| FAC-08 | P1 | One click or one key adds a +1, with a count, to the object under the cursor. There is also a small set of our own emoji stamps, and a raised hand shows next to the person's avatar. | BUILD | UV §5; OB §9 [H30] |
| FAC-09 | P1 | A facilitator can hide a frame from everyone else: they see a placeholder, and the frame's content, title and comments never reach their browsers. Revealing restores it for all, and hidden frames are skipped in presentations. | BUILD (server-enforced) | OB §2 [H5]; UV §5 |
| FAC-10 | P2 | A facilitator overview shows each participant's current frame, with an idle flag. "Close session" takes a snapshot, moves leftovers to an archive frame, and adds a decisions/actions frame. | BUILD | UV §5 |

## 6. Review later (REV)

| ID | P | Expected behavior (pass/fail) | Engine | Source |
|---|---|---|---|---|
| REV-01 | P0 | C selects the comment tool. Clicking a shape attaches a thread that moves with it, clicking empty canvas pins one to that spot, Enter posts, Shift+Enter adds a new line, and an unsent draft survives closing the thread. | BUILD | OB §7 [H20] |
| REV-02 | P0 | Threads support replies and let you edit or delete your own comments. Resolve takes the marker off the canvas (the thread stays under "Show resolved"), and Reopen brings it back. | BUILD | OB §7 [H20] |
| REV-03 | P0 | Each person sees different markers for unread, read, resolved (when shown) and mentions of them. Hovering a marker previews its thread. | BUILD | OB §7 [H20] |
| REV-04 | P0 | The comments panel lists threads, filters them (open, resolved, mine, mentions), and clicking one moves the camera to it and opens it. Shift+C hides or shows all comment markers, for me only. | BUILD | OB §7 [H20][H14]; UV §6 |
| REV-05 | P0 | Typing @ suggests people with access, and posting notifies the person in the app and by email, with a link to the thread. Mentioning someone without access offers to invite them, and an @name inside a note notifies no one. | BUILD | OB §7 [H21] |
| REV-06 | P0 | Deleting a shape keeps its threads in the panel as orphans, labeled with the deleted object. Restoring the shape reattaches them. | BUILD | BP §9 |
| REV-07 | P0 | "Recently deleted" lists the shapes deleted on this board (at least this session plus the last [1,000]). Restoring puts each one back in its original place and parent, and reconnects connectors whose two ends both still exist. | BUILD | OB §13 [H52]; BP §4 |
| REV-08 | P0 | You can save a named snapshot, see a list of them, and restore one as a new private board with no public links carried over. The original board is unchanged. | BUILD | OB §13 [H50]; BP §4, §9 |
| REV-09 | P1 | A notification inbox has Unread and All. You automatically follow threads you post in or are mentioned in, and you can unfollow a thread, mute a board, and choose email right away or as a digest. | BUILD | OB §7 [H22][H23]; UV §6 |
| REV-10 | P1 | A snapshot is saved automatically every hour while the board is changing, and when each session ends, and kept for ≥ [90 days]. | BUILD | OB §13 [H50] |
| REV-11 | P1 | Opening a board that others changed since my last visit offers "See what changed", which highlights those objects with who changed them and when. | BUILD | OB §13 [H51]; UV §6 |
| REV-12 | P1 | Comments export to CSV for the board or selected frames, with author, date, status, the frame or object they are attached to, text and replies. | BUILD | UV F7 #3, §6 |
| REV-13 | P2 | An activity list shows who added, edited or deleted what, and clicking an entry jumps to it. Each object shows who created it and who last changed it, and each frame can carry a review status (in review / changes requested / approved) with who and when. | BUILD | OB §13 [H51]; UV §6 |

## 7. Present and share (PRS)

| ID | P | Expected behavior (pass/fail) | Engine | Source |
|---|---|---|---|---|
| PRS-01 | P0 | Present opens full screen at the first frame, or at the selected one. →, Space and PgDn go forward and ← and PgUp go back in outline order, skipping frames marked "skip"; tools, frame titles and other people's cursors are hidden, and Esc returns you to where you were on the board. | BUILD | OB §2 [H5][H7] |
| PRS-02 | P0 | The Share dialog invites people by email with a role (editor, commenter or viewer; ownership can be transferred), sets workspace-wide access (none, view, comment or edit), and lists who has access and through which grant. Each person gets their highest grant; if removing a direct invite leaves another grant, the dialog says so. | BUILD | OB §10 [H31][H33][H35] |
| PRS-03 | P0 | Every board header shows its sharing state (Private / Workspace / Link: view, comment or edit / expires on a date), with the Share button in a fixed place. Clicking the badge opens the list of who has access. | BUILD | UV F3 #2 |
| PRS-04 | P0 | "Copy link" works on a board, a frame or an object, and a frame or object link opens the board zoomed to it. A signed-in user without access sees Request access, which notifies the owner, and viewers and commenters can ask for edit rights. | BUILD | OB §2, §6, §10 [H19][H31] |
| PRS-05 | P0 | PNG export of the selection, a frame or the whole board at 1×, 2× or 4×, with an optional transparent background, plus SVG export of a selection. Ctrl/Cmd+Shift+C copies the selection as a PNG. | FREE (TL `export-as-png/svg`, `toggle-transparent`, `copy-as-png`) + BUILD menu | OB §12 [H47][H49]; UV F7 #2 |
| PRS-06 | P0 | PDF export makes one page per frame in outline order, or just the selected frames, with selectable vector text. Images come from the original or a high-resolution copy, never the small one shown on the canvas, so a [300 dpi] test image still looks sharp at 200% in a PDF viewer. | BUILD | OB §12 [H47]; UV F7 #1; BP §9 |
| PRS-07 | P1 | While presenting, a slide grid jumps to any frame. "Invite everyone to join" gives each person a join/decline prompt; those who join see the presenter's slide, can leave and rejoin, and the presenter can hand over control. | BUILD | OB §2 [H7] |
| PRS-08 | P1 | An owner can create a review link (view, comment or edit) that expires (default [14 days]) and can have a password of 8+ characters. Visitors only type a display name and comment by default, and revoking the link disconnects its live sessions within [5 s]; a workshop version gives edit rights for a window the facilitator sets and can extend in one click. | BUILD | OB §10 [H36][H38]; UV F3 #1, #4; BP §9 |
| PRS-09 | P1 | Visitors can't share, rename, mention, lock or unlock, start votes, or see history. They can upload and paste only during a workshop window the facilitator has opened. | BUILD | OB §10 [H36]; UV F3 #3 |
| PRS-10 | P1 | In PDF exports, frame names become bookmarks, embedded PDF pages are re-rendered from the source file, and there is an optional appendix of open comments. | BUILD | UV F7 #1, #3 |
| PRS-11 | P1 | Exporting a board and importing the file makes a new board with the same shapes, connections, frames and files, under new IDs. A broken or oversized file is rejected with a message and changes nothing. This is a release gate. | BUILD (FC `exportBoardArchive`, `importBoardArchive`) | OB §12 [H48]; BP §13 portability |
| PRS-12 | P1 | An owner setting controls whether viewers and commenters can export and download. When it is off, those roles see no export or download controls, and the server returns 403 when they try. | BUILD | OB §10 [H39]; UV F7 #4 |
| PRS-13 | P2 | CSV export of the board's or selection's text, with a tags column and spreadsheet formulas neutralized; PowerPoint export of frames; presenter notes that only the presenter sees. | BUILD (FC `boardToCsv` plus tags) | OB §2, §12; UV F7 |

## 8. Files and media (FIL)

| ID | P | Expected behavior (pass/fail) | Engine | Source |
|---|---|---|---|---|
| FIL-01 | P0 | Dropping or pasting PNG, JPEG, GIF or WebP files (up to [50 MB] each, [100] at a time) from the desktop or a browser tab inserts them where they were dropped. A file that is too large gets a clear size message. | CONFIG (TL defaults: 10 MB, 100 files, 5,000 px) | UV §7; BP §8 |
| FIL-02 | P0 | The canvas never loads full-size originals for display. At 10% zoom, a board of large photos loads only small copies (check the network log), and larger copies load as you zoom in. | BUILD (`TLAssetStore.resolve` using `steppedScreenScale`/`dpr`) | UV F1 #1 |
| FIL-03 | P0 | While a file uploads or its preview is made, the card shows progress and editing continues everywhere else. A malformed, encrypted, unsupported or interrupted file ends in a clear error on its card and never freezes the canvas. | BUILD | BP §13 file processing |
| FIL-04 | P0 | A PDF shows a preview card of its first page. "Extract pages" puts its pages on the board as images that stay sharp at 200% zoom. | BUILD | BP §4, §8; UV §7 |
| FIL-05 | P0 | An MP4 shows a poster and plays in place when clicked, and audio plays in a card. Other files show a card with name, type and size, and anyone allowed can download the original. | BUILD (`dr-file-card`) | BP §4, §8 |
| FIL-06 | P1 | A dropped image appears at a consistent on-screen size (longest side about [40%] of the viewport), not its pixel size, and several dropped together land in a grid rather than one long row. Exports still use the full-resolution originals. | BUILD (TL uses native size in one row, then zooms out) | UV §7; TL defaultExternalContentHandlers |
| FIL-07 | P1 | Pasting a URL makes a link card (title, description, image and domain) fetched by the server. URLs that point at private or metadata addresses, including through redirects, get a plain link card instead. | BUILD | UV D8; BP §8, §13 |
| FIL-08 | P1 | Animated GIF and WebP play on the canvas, and the reduced-motion setting shows their first frame instead. Our resized display copies must keep the animation, or animated files must be served as originals. | FREE (TL ImageShapeUtil) + BUILD (derivative pipeline) | UV §7 |
| FIL-09 | P1 | On a phone, "Add photo" opens the camera and uploads the picture into the current frame or view, where others see it. | BUILD | UV §5, §7, F5 #2 |
| FIL-10 | P1 | Pasting from Figma, Illustrator or Photoshop gives an image, with SVG cleaned before display. Test with saved clipboard samples from each app. | BUILD | UV §7 |
| FIL-11 | P1 | You can comment on a video at the current playhead, and clicking the comment jumps to that time. You can also comment on one page of a PDF. | BUILD | UV §7; BP §4 |
| FIL-12 | P2 | HEIC photos are converted on upload, Office files get previews, and there is a color swatch object (hex and name; click to copy). | BUILD | BP §4; UV §7 |

## 9. Dashboard (DSH)

| ID | P | Expected behavior (pass/fail) | Engine | Source |
|---|---|---|---|---|
| DSH-01 | P0 | The dashboard shows Recent (by last opened), Starred and All boards in the workspace, plus project folders by client and campaign, in a grid or list view. | BUILD | OB §11 [H41][H42]; UV F2 #5 |
| DSH-02 | P0 | Each board card's menu has open, rename, share, duplicate (with "keep sharing settings"), move to project, star, delete, copy link and details. | BUILD | OB §11 [H41][H44] |
| DSH-03 | P0 | A deleted board goes to Trash and can be restored for [30] days (Miro keeps 90 on paid plans). A restored board has all its content and files. | BUILD | OB §11, §13 [H46]; BP §4 |
| DSH-04 | P1 | Boards sort by name, created, last opened or last modified, and filter by owner (anyone, me, not me). | BUILD | OB §11 [H41] |
| DSH-05 | P1 | Board thumbnails are made from the board and refresh within [5 min] of an edit. An owner can choose a frame as the thumbnail. | BUILD | OB §11 [H45] |
| DSH-06 | P1 | Ctrl/Cmd+E jumps to board search, which shows recent boards before you type and matches board and project names. | BUILD | OB §11 [H17] |
| DSH-07 | P1 | Archiving a board or project hides it from the usual views, keeps it findable under "Archived", and lets you restore it. | BUILD | UV F2 #4 |
| DSH-08 | P2 | Dashboard search also matches text inside boards, and a result opens the board at that spot. | BUILD (FC `searchBoard`) | OB §11 [H17] |

## 10. Performance and trust (PRF)

| ID | P | Expected behavior (pass/fail) | Engine | Source |
|---|---|---|---|---|
| PRF-01 | P0 | A board with 2,000 basic objects and 50 optimized images is ready to use within [3 s] on the agreed laptop and network. | BUILD | BP §13 |
| PRF-02 | P0 | A board with 5,000 objects and 200 images opens and pans smoothly, and pasting 500 notes into a board that already has 4,000 shapes works. (tldraw's default limit of 4,000 shapes per page refuses the whole batch, so raise it.) | CONFIG (`options.maxShapesPerPage`) + BUILD | BP §13; TL options.ts, Editor |
| PRF-03 | P0 | A mood board with 2,000–3,000 images pans and zooms at ≥ [30 fps] median on a mid-range laptop, and opens in Safari on an iPad without crashing or reloading. Off-screen images aren't decoded. | BUILD | UV F1 #3, F5 |
| PRF-04 | P0 | With 30 editors making scripted and manual edits for 30 minutes, every client ends up with the same board, and remote edits show within [250 ms] at the 95th percentile. | BUILD | BP §13 (20 editors); UV F1 #3 (test at 30) |
| PRF-05 | P0 | Killing the sync process, deploying, or cutting the network loses no edit the server has already confirmed. Clients show Offline, then reconnect and catch up on their own. | BUILD | BP §13; UV F9 |
| PRF-06 | P0 | These all fail safely: a board ID from another workspace returns "not found", a forged write from a read-only socket is rejected, a leaked asset ID doesn't download without a signed URL, and an expired invitation doesn't work. A user whose access is revoked is disconnected within [5 s]. | BUILD | BP §13 |
| PRF-07 | P0 | B's WebSocket frames and API responses never contain private-draft text, hidden-frame content or titles, or ballots that haven't been revealed. | BUILD | BP §2, §9; OB §9 |
| PRF-08 | P0 | A new board is private to its creator until shared, and a board restored from a snapshot also starts private. | BUILD | BP §9, §13 |
| PRF-09 | P0 | There are no product tours or upgrade pop-ups, at most one hint that can be dismissed for good. A visual-regression snapshot pins the toolbar layout so tools don't move between releases. | BUILD | UV F11, F2 #8 |
| PRF-10 | P1 | On a phone, the PRF-03 board opens for viewing and commenting without crashing, and falls back to a list of frames if memory is short. | BUILD | UV F5 #1 |
| PRF-11 | P1 | On an iPad, the Pencil draws with palm rejection, pinch zooms the board rather than the page, text being edited scrolls above the on-screen keyboard, and hardware-keyboard shortcuts work. | FREE? (TL pen mode) + BUILD | UV F5 #3 |
| PRF-12 | P1 | Every control has an accessible name and a visible focus ring, interface text meets WCAG AA in light and dark themes, and reduced motion is respected. People can turn off single-key shortcuts, and screen-reader users get a text/list view of the board. | CONFIG (TL `toggle-keyboard-shortcuts`, `toggle-reduce-motion`, `toggle-dark-mode`) + BUILD | BP §4; OB §5, §6 [H3]; UV §10 (dark mode) |

---

## Keyboard shortcuts Draftroom should support

The **tldraw 5.4.2 default** column comes from the `kbd:` strings in `tldraw/src/lib/ui/context/actions.tsx` and `ui/hooks/useTools.tsx`, and from the key handling in `tools/SelectTool/childStates/Idle.ts` and `shapes/note/NoteShapeUtil.tsx`. All of these were read on 2026-09-26. The **Draftroom** column is our decision.

**Work** column:
- **FREE**: keep tldraw's key.
- **REMAP**: change or add a `kbd` through `overrides`.
- **UNBIND**: remove tldraw's key.
- **BUILD**: a new action, or a key tldraw doesn't handle.

Wherever this table keeps a tldraw key as an alias, both keys work.

### Tools

| Action | Miro | tldraw 5.4.2 default | Draftroom | Work | P |
|---|---|---|---|---|---|
| Select / Hand | V / H | V / H; Space, middle or right drag also pans | same | FREE | P0 |
| Sticky note | N | N | N | FREE | P0 |
| Text | T | T | T | FREE | P0 |
| Frame | F | F | F | FREE | P0 |
| Connector | L | A = arrow; L = unbound line | L and A = bound connector; the line tool gets no key | REMAP | P0 |
| Pen | P | D, B, X | P, keeping D/B/X | REMAP | P0 |
| Comment tool | C | none (tldraw's own comment tool is licensed and not in the base tools) | C | BUILD | P0 |
| Show/hide comments | Shift+C | none | Shift+C | BUILD | P0 |
| Rectangle / Ellipse | R / O | R / O | same | FREE | P1 |
| Shapes menu | S | G = geo tool | S (G goes to the grid) | REMAP | P1 |
| Eraser | E | E | E | FREE | P1 |
| Keep tool selected | — | Q | Q | FREE | P1 |
| Highlighter / Laser | — | Shift+D / K | same | FREE | P2 |

### Editing and arranging

| Action | Miro | tldraw 5.4.2 default | Draftroom | Work | P |
|---|---|---|---|---|---|
| Edit selected / stop | Enter / Esc | Enter (select-all text) / Esc | same | FREE | P0 |
| Type to edit a selected note | type | only behind the `editOnType` debug flag | on for notes (COL-04) | BUILD | P0 |
| New note beside, while editing | Tab (direction UNVERIFIED) | Tab → right, Shift+Tab → left, Ctrl/Cmd+Enter → below, Ctrl/Cmd+Shift+Enter → above | same | FREE | P0 |
| Undo / Redo | Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z | same | same, plus Ctrl+Y on Windows (ours) | FREE | P0 |
| Copy / Cut / Paste | Ctrl/Cmd+C / X / V | same (native clipboard events) | same | FREE | P0 |
| Duplicate | Ctrl/Cmd+D; Alt-drag | same | same | FREE | P0 |
| Delete | Backspace / Delete | Backspace / Del | same | FREE | P0 |
| Select all | Ctrl/Cmd+A | same | same | FREE | P0 |
| Add to selection | Ctrl/Cmd-click (Shift-click also documented) | Shift-click or Ctrl/Cmd-click | same | FREE | P0 |
| Group / Ungroup | Ctrl/Cmd+G / Ctrl/Cmd+Shift+G | same | same | FREE | P0 |
| Frame the selection | ⋯ → Create frame | Ctrl/Cmd+Alt+G | same | FREE | P0 |
| Lock / unlock | Ctrl/Cmd+Shift+L | Shift+L | Ctrl/Cmd+Shift+L | REMAP | P0 |
| Bring to front / send to back | PgUp / PgDn (Mac: fn+↑/↓) | ] / [ | PgUp / PgDn, keeping ] [ | REMAP | P0 |
| Copy as image | Ctrl/Cmd+Shift+C | Ctrl/Cmd+Shift+C (PNG) | same | FREE | P0 |
| Forward / backward one step | Shift+PgUp / Shift+PgDn | Alt+] / Alt+[ | Shift+PgUp/PgDn, keeping Alt+] [ | REMAP | P1 |
| Box-select only fully enclosed | long click-drag, or a setting | hold Ctrl/Cmd while dragging; "wrap mode" preference | same, and show the preference in our menu | FREE | P1 |
| Nudge | arrow keys | arrows move 1 px, Shift+arrows 10 px; one grid step with the grid on | same | FREE | P1 |
| Align left / center / right / top / middle / bottom | toolbar | Alt+A / H / D / W / V / S | keep; check Alt+D on Windows doesn't jump to the browser's address bar (UNVERIFIED) | FREE | P1 |
| Distribute horizontally / vertically | toolbar | Alt+Shift+H / Alt+Shift+V | keep | FREE | P1 |
| Add/edit link on object | Ctrl+Alt+K / Cmd+Option+K | the `edit-link` action has no key | Ctrl/Cmd+Alt+K | REMAP | P1 |
| Protected lock | Ctrl/Cmd+Shift+P | none | Ctrl/Cmd+Shift+P | BUILD | P1 |
| Bold / Italic / Underline | Ctrl/Cmd+B / I / U | while editing: TipTap bold, italic, underline. With a shape selected, not editing: Ctrl/Cmd+I = insert embed, Ctrl/Cmd+U = upload media | while editing, same; on selected shapes, style all of their text | UNBIND embed/upload + BUILD | P1 |
| Flatten to image | — | Shift+F (turns the selection into one image) | remove the key; keep it in a menu | UNBIND | P1 |
| Duplicate in a direction | Alt/Option+arrow | Alt+←/↑ previous page, Alt+→/↓ next page | Alt+arrow duplicates (if Draftroom hides pages) | REMAP | P2 |
| Copy / paste style | Ctrl/Cmd+Alt+C / V | Shift+Q copies hovered styles; Ctrl/Cmd+Alt+V = paste at cursor | Ctrl/Cmd+Alt+C / V once MAK-21 ships; move paste-at-cursor then | BUILD | P2 |
| Clear content | Ctrl/Cmd+Backspace | none | Ctrl/Cmd+Backspace | BUILD | P2 |
| Grow / shrink selection | Ctrl/Cmd+Alt+Shift+Plus / Minus | Ctrl/Cmd+Alt+Shift+= / − | same | FREE | P2 |
| Rotate / Flip | — | Shift+. / Shift+, rotate; Shift+H / Shift+V flip | keep | FREE | P2 |

### Navigation

| Action | Miro | tldraw 5.4.2 default | Draftroom | Work | P |
|---|---|---|---|---|---|
| Zoom in / out | Ctrl/Cmd + + / − | Ctrl/Cmd+= / −, and = / − | same | FREE | P0 |
| Zoom to fit | Alt/Option+1 | Shift+1 | Alt/Option+1, keeping Shift+1 (test Option+1 on macOS) | REMAP | P0 |
| Zoom to selection | Alt/Option+2 | Shift+2 | Alt/Option+2, keeping Shift+2 | REMAP | P0 |
| Zoom to 100% | Ctrl/Cmd+0 | Shift+0 | Ctrl/Cmd+0, keeping Shift+0 (tldraw's handler blocks the browser's default; check Safari) | REMAP | P0 |
| Minimap | M | none (a button in the navigation panel) | M | REMAP | P0 |
| Board search | Ctrl/Cmd+F | none, so the browser's find opens | Ctrl/Cmd+F | BUILD | P0 |
| Present: next / previous / exit | arrow keys / Esc | n/a | → Space PgDn / ← PgUp / Esc | BUILD | P0 |
| Grid | G | Ctrl/Cmd+' | G, keeping Ctrl/Cmd+' | REMAP | P1 |
| Move through shapes | Tab / Shift+Tab; Ctrl/Cmd+arrows | same | same | FREE | P1 |
| Enter / leave a frame or group | Ctrl/Cmd+Shift+↓ / ↑ | same | same | FREE | P1 |
| Zoom tool | — | Z | keep | FREE | P2 |
| Command palette | Ctrl/Cmd+K | none | Ctrl/Cmd+K | BUILD | P2 |

### App and other

| Action | Miro | tldraw 5.4.2 default | Draftroom | Work | P |
|---|---|---|---|---|---|
| Shortcut sheet | F1, or ? → Keyboard shortcuts | Ctrl/Cmd+Alt+/ | F1 plus a "?" button, keeping Ctrl/Cmd+Alt+/ (check that browsers let us override F1; UNVERIFIED) | REMAP | P1 |
| Dashboard board search | Ctrl/Cmd+E | n/a | Ctrl/Cmd+E | BUILD | P1 |
| Bulk entry: next note / exit | Enter / Esc | n/a | same, in the bulk dialog | BUILD | P1 |
| Turn off single-key shortcuts | an accessibility setting | the `toggle-keyboard-shortcuts` preference (no key) | show it in our menu | FREE | P1 |
| Comment on focused object | Alt/Option+C | none | Alt/Option+C | BUILD | P2 |
| Cursor chat / dark mode / focus mode | — | / ; Ctrl/Cmd+/ ; Ctrl/Cmd+. | keep; focus mode must show a visible way back | FREE | P2 |
| Print | (the browser's) | Ctrl/Cmd+P prints the selection or pages | open PDF export (PRS-06) | REMAP | P2 |

**How to remap (checked in source).** Pass `overrides={{ actions(editor, actions) { ... }, tools(editor, tools) { ... } }}` to `<Tldraw>`, and return the maps with a new `kbd` string on the entries you change. For example, set `kbd: 'cmd+shift+l,ctrl+shift+l'` on `actions['toggle-lock']` and `kbd: 'a,l'` on `tools.arrow`; to unbind, set `kbd` to `undefined`. The syntax is comma-separated alternatives using `cmd+`, `ctrl+`, `alt+` and `shift+`; the older forms `$`, `?` and `!` mean cmd/ctrl, alt and shift. Keys match on `event.key`, falling back to `event.code` for non-Latin layouts and for macOS Option characters such as Option+1. In read-only mode, shortcuts are dropped for actions that aren't marked `readonlyOk`.

## Open decisions this checklist forces

1. **Type-to-edit versus single-key tools (COL-04).** Miro starts editing when you type on a selected note. tldraw leaves this off because it collides with tool keys. My recommendation: typing edits only when exactly one note is selected, and tool keys work in every other case.
2. **Default role for invites and links (PRS-02, PRS-08).** Miro defaults to edit. Ours: edit for workspace members, comment for external addresses and review links.
3. **Pages.** If Draftroom boards expose tldraw pages, Alt+arrow must keep switching pages, and directional duplicate (P2) needs a different key.
4. **The L key.** Remapping L to the connector leaves the unbound line tool without a key. That's fine for creative teams (ours), but it needs a decision.
5. **Thresholds.** The bracketed numbers (250 ms, 3 s, 30 fps, 50 MB, 14-day links, 30-day trash) are proposals. Settle them before the release-gate runs in build plan §13.

## Still UNVERIFIED

- Whether tldraw's note tool always returns to Select after one placement without tool lock (COL-01), and the default frame size on click-to-place (PRE-04).
- Whether a plain click on the canvas stops following in tldraw. Wheel, pinch and camera-moving input do stop it (FAC-01).
- Whether browsers let the page override F1, and Cmd+0 in Safari; and whether Alt+D (align right) is reachable on Windows before the browser takes it.
- Pencil palm rejection in iPad Safari with tldraw's pen mode (PRF-11).
- Everything already listed as UNVERIFIED in [miro-official-behaviors.md](miro-official-behaviors.md) (for example, which way a Tab-created note goes in Miro) and [miro-user-voices.md](miro-user-voices.md) §12.

## tldraw 5.4.2 source read for this checklist

Paths are under `node_modules/.pnpm/tldraw@5.4.2_*/node_modules/tldraw/src/lib/` unless marked `editor/` (`@tldraw/editor@5.4.2/src/lib/`).
- `ui/context/actions.tsx`: every action `kbd` value; `overrides` applied at the end of the provider.
- `ui/hooks/useTools.tsx`: tool keys (v, h, e, d/b/x, r, o, a, l, f, t, n, k, Shift+D, Ctrl/Cmd+U).
- `ui/hooks/useKeyboardShortcuts.ts`: registration, `areShortcutsDisabled`, key matching. `ui/kbd-utils.ts`: kbd syntax. `ui/overrides.ts`: `TLUiOverrides`.
- `tools/SelectTool/childStates/Idle.ts`: Enter, Tab, arrow nudge (1/10 px), Ctrl+arrow traversal, the `editOnType` gate, double-click creates text. `PointingShape.ts` and `Brushing.ts`: additive and wrap selection.
- `shapes/note/NoteShapeUtil.tsx`: Tab and Ctrl/Cmd+Enter make adjacent notes. `shapes/image/ImageShapeUtil.tsx`: animated images and reduced motion.
- `defaultExternalContentHandlers.ts` and `Tldraw.tsx`: `maxAssetSize` (10 MB), `maxImageDimension` (5,000), where dropped images are placed.
- `utils/text/richText.ts`: TipTap StarterKit and Highlight. TipTap's `extension-bold` and `extension-underline` bind Mod-b and Mod-u.
- `editor/options.ts`: `maxShapesPerPage` 4,000, `maxFilesAtOnce` 100, `createTextOnCanvasDoubleClick`, `rightClickPanning`. `editor/config/TLUserPreferences.ts`: `isSnapMode`, `isWrapMode`, `isDynamicSizeMode`, `inputMode` and `areKeyboardShortcutsEnabled` defaults. `editor/utils/debug-flags.ts`: `editOnType` off. `editor/utils/getPointerInfo.ts`: Cmd counts as Ctrl. `editor/editor/Editor.ts`: `canCreateShapes`, follow stops on wheel and pinch, `getResizeScaleFactor`.
