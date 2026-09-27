# Miro's documented behaviors, and the minimum Draftroom must match

Date: 2026-09-26. Scope: Miro's own help center (help.miro.com) and product pages (miro.com) only. Reviews and third-party posts are out of scope here; the build plan (§2–4) already covers them.

**Why this exists.** People who come from Miro bring muscle memory: N for a note, Tab to add the next one, pasting a spreadsheet to get a grid of notes, Alt+1 to fit the board, a frames list that sets the presentation order. This file records what Miro documents today, area by area. For each area it then lists the minimum a Miro user will expect from Draftroom. We copy interaction *patterns*, never assets. Draftroom's names, icons, colors, sounds and copy are our own (see "Naming and branding" at the end).

## How this was researched, and how to read it

- **Method.** I downloaded 74 help-center articles through the help center's public article API (`help.miro.com/api/v2/help_center/en-us/articles/<id>.json`), which returns the same body as the web page. I read the 60 cited below in full, plus two miro.com product pages. Every cited article was last updated between 2026-09-08 and 2026-09-15. I accessed all of them on 2026-09-26. Nothing was tested hands-on in a Miro account.
- **Citations.** `[H#]` is a help-center article and `[P#]` is a miro.com product page (both listed under Sources). `[T#]` is a tldraw 5.4.2 source file I read in this repo's `node_modules`, used only to say what our engine already does.
- **Tags.** **UNVERIFIED** means I could not confirm the claim in an official source (or in the tldraw source, for engine claims). *"(ours)"* marks a Draftroom recommendation, not a Miro fact.
- **Release tags**, taken from build plan §4: **R1** = dependable first release, **R2** = broader release, **Later** = defer until there is demand.
- **Plans.** Many of the facilitation features below are paid-only in Miro (timer, voting, private mode, hidden frames, guests, backups, versions). That tells us what Miro treats as premium. It does not limit Draftroom.
- **Two Miro UIs.** Miro is partway through two rollouts: a "simplified" board UI [H14], and a new Presentation mode that shipped between March and April 2026 [H7]. Some articles still describe the older layout (for example, "board overview in the bottom-left" versus "Frames and layers in the bottom-right"). Where they differ, I describe the newer behavior.

---

## 1. Sticky notes

### What Miro does
- **Create.** Press N, or click the note tool, then click the board. You can also drag a note straight off the toolbar, or click-drag on the board to draw one [H1]. Using the keyboard only: press N, then Tab, then Enter, and a note is placed [H3]. Most tools are one-shot and drop back to Select after one use; pen, eraser, lasso and comment are the exceptions [H13].
- **Type and edit.** Select a note and start typing, or press Enter to edit and Esc to stop [H1][H3][H4]. A note holds roughly 3,000 characters, depending on text size. An optional **Auto font size** shrinks text to fit. Formatting inside notes is limited to size, alignment, bold, italic and underline [H1].
- **Next note from the keyboard.** The keyboard-navigation article says that when you are editing a note, pressing Tab creates a new object next to the selected one [H3]. Which direction it goes, and whether Shift+Tab or Ctrl/Cmd+Enter variants exist, is **UNVERIFIED** in Miro's docs.
- **Bulk entry.** "Bulk mode" (found under Tools) takes one idea per line: Enter separates notes, Done places them all, and Esc exits [H1][H4]. **Sticky Stack** places a pile of blank notes that people drag from [H1].
- **Paste from a spreadsheet.** Copy cells from Sheets or Excel and paste onto the canvas. Miro then asks what to create: **Paste as sticky notes** (one note per cell, laid out as a cluster) or Paste as Grid/table [H1][H12]. The limits are 5,000 cells per paste (no more than 50 rows × 100 columns) and 6,000 characters [H1].
- **Color, shape and size.** There are 16 fixed note colors, chosen for readability, with no custom colors [H1]. A square note can be switched to a rectangle from the context menu [H1]. Selecting several notes lets you change size and color together. "Object dimensions" helps you match sizes exactly [H1][H54]. Whether notes have discrete size presets (S/M/L) is **UNVERIFIED**.
- **Tags.** Apply an existing tag or create a new one from the note's toolbar, up to 8 per note. Board search can find notes by tag. You remove a tag from one note in the tag menu, and can delete a tag from every object on the board at once [H1]. Search results can be filtered by tag [H16].
- **Author label.** Any editor can show or hide it per note; it is off by default and can't be forced on for everyone. It follows whoever last replaced the text, and shows "visitor" for anonymous visitors. Info on the context menu shows who created and last modified the note [H1][H51].
- **Emoji reactions** can be added to a note and counted, which some teams use as informal votes [H1].
- **Quick diagram.** A selected note shows blue dots on its sides. Click a dot to create a connected copy, or drag it onto another object to connect them [H1][H9].
- **Organize.** Align several notes into a row or column [H1]. **Cluster** groups selected notes into movable, renamable containers by color, tag or author (and, with AI, by keyword or sentiment). A note with several tags is duplicated into each tag's cluster; notes with no tag go into a "no tag" cluster [H2].
- **Export text.** Select notes, then choose ⋯ → Export to CSV [H1].
- **Roles.** Commenters cannot add notes or emoji [H1].

### Minimum a Miro user will expect from Draftroom
- **R1** Press N, click to place a note, drag from the toolbar, and see the tool return to Select after one placement. Enter edits and Esc exits. Typing on a selected note should start editing (ours; whether tldraw does this already is **UNVERIFIED**).
- **R1** While editing, **Tab makes the next note beside the current one**. tldraw 5.4.2 already does this: Tab goes right, Shift+Tab goes left, Ctrl/Cmd+Enter goes below and Ctrl/Cmd+Shift+Enter goes above. The new note opens with its text selected [T1]. Keep this behavior and document it on our shortcuts sheet.
- **R1** Paste spreadsheet cells and get **one note per cell, laid out in the source rows and columns**. Offer a choice when the clipboard holds tabular data (notes, or plain text/table). If a paste is capped, say so explicitly. Our contract caps at 500 notes by default (`notesFromText`, `docs/FEATURES-CONTRACTS.md`), versus Miro's 5,000 cells. That is fine for the pilot, but the truncation notice must be visible.
- **R1** Bulk entry: a dialog where each line becomes a note.
- **R1** Our own fixed palette of note colors with legible text. tldraw's default set has 13 color names [T5], a little short of Miro's 16. Recolor and resize many notes at once, with a few size steps (tldraw has s/m/l/xl [T5]).
- **R1** **Basic tags**: several per note, shown as chips on the note; choose an existing tag or create one; remove one; delete a tag everywhere; find notes by tag in board search.
- **R1** Role rules: commenters and viewers cannot create or edit notes.
- **R2** Author label toggle and a "created by / last edited by" info panel. Reactions on notes. Auto-fit text. Square/wide switch. Export selected notes to CSV. Cluster by tag, color or author.
- **Later** AI clustering by keyword or sentiment.

---

## 2. Frames

### What Miro does
- **Create.** Press F and click to drop a frame, or click-drag to draw one. You can also drag a frame from the tool. The frame tool offers preset sizes and "View templates" for slide layouts. To wrap existing content, select it and choose ⋯ → **Create frame** [H5][H6].
- **Name, style and size.** Double-click the title to rename, or use ⋯ → Rename frame. Frames are white by default, and color is set on the context toolbar. You resize by dragging a border, and can change the aspect ratio from ⋯ [H5].
- **Containment.** Content inside a frame moves with it. The FAQ admits that objects sometimes don't attach when a frame is drawn over them, and that nudging them fixes it [H5]. Frames always sit behind other objects and can't be re-ordered in depth [H10]. Connectors can't attach to frames [H9]. Objects in different frames can't be grouped together [H6].
- **Duplicate and paste.** Ctrl/Cmd+D duplicates a frame. If the frame name contains a date, the copy's date moves forward automatically [H5]. Pasting into other selected frames puts content at the **same relative position** as in the source frame, measured from the top-left corner [H5].
- **Frames panel (the outline).** It opens from the bottom-right canvas controls, under "Frames and layers". It shows thumbnails or a **List view**. Clicking a frame jumps to it, and dragging reorders frames. Ctrl/Cmd-click selects several frames to reorder, hide or delete them together. **Organize frames** sorts the list left-to-right, then top-to-bottom, and can be undone. Each row's ⋯ menu offers hide, export, add frame, copy link and delete [H5][H8]. Reordering by drag isn't available on touch devices [H5].
- **Link to a frame.** Choose ⋯ → Copy link on a frame. Opening the link takes collaborators straight to that frame [H5][H19].
- **Present from frames.** Click Present. Frames become full-screen slides, with board tools and frame titles hidden. Arrow keys move between frames [H5]. In the 2026 Presentation mode [H7]:
  - Everyone on the board gets a prompt to join or decline. People who join see exactly the presenter's view.
  - A grid of slides lets the presenter jump anywhere. **Go to canvas** leaves the slides so participants can roam, and **Go to slide** locks them back into the presentation.
  - The presenter can **Hand off** control to someone else, and **Stop** the presentation. Participants can **Leave**, and rejoin later with Join.
  - **Presenter notes** open in a separate window that only the presenter sees.
  - The presenter chooses which creation tools participants may use (notes, shapes, text, pen, stickers, comments) and can toggle participants' cursors.
  - Visitors can't start a presentation [H7].
  - The legacy mode also offered a dimmed "lightbox" border around the current frame, click-to-zoom, and letting a participant take over as presenter [H8].
  - Hidden frames are left out of the presentation [H7].
- **Hide frames.** Board owners and co-owners, on paid plans, can hide frames using the eye icon on the frame or in the panel. Everyone else sees a blank placeholder with a closed-eye icon, and can't copy or duplicate it until it is revealed [H5]. Miro warns that hiding a frame "doesn't conceal the frame's comments and title" [H5].
- **Export frames.** Export one frame, or a selection of frames, as an image or PDF [H5]. When the whole board is exported as a PDF, each frame becomes a page in frames-panel order [H47].

### Minimum a Miro user will expect from Draftroom
- **R1** Press F and click (for a default size) or drag. **Frame the current selection**; tldraw has a frame-selection action on Ctrl/Cmd+Alt+G [T2]. Rename by double-clicking the title.
- **R1** Dropping an object inside a frame makes it a child that moves with the frame. Frames stay behind other content.
- **R1** A **frame outline panel**: every frame by name (in list or thumbnail view), click to jump, drag to reorder, and an "auto-order" action (left-to-right, then top-to-bottom) that can be undone. The panel order is also the presentation order and PDF page order. The contracts' `frameOutline` and `presentationOrder` (with `meta.presentationIndex`) already model this.
- **R1** **Copy link to frame**, which opens the board zoomed to that frame.
- **R1** **Basic presentation**: full screen, arrow keys, Esc to exit, titles and tools hidden, a slide grid to jump around, and a per-frame "skip in presentation" flag.
- **R2** Invite everyone on the board to join the presentation, with leave and rejoin. Hand off to a co-presenter. Private presenter notes. Choose which tools participants may use during the presentation. A dimmed surround on the current frame.
- **R2** Hidden frames for private drafts **enforced on the server**, not just covered on screen (build plan §2). Hide the frame's title and comments too, which closes the gap Miro admits.
- **R2** Frame color, aspect-ratio presets (16:9, 4:3, A4, 1:1), and pasting at the same relative position into other frames. Moving dates forward in duplicated frame names is **Later**.

---

## 3. Connectors and arrows

### What Miro does
- **Create.** Press L, or pick the connection-line tool. Alternatively, select an object and click or drag one of its blue side dots. If another object is nearby, Miro suggests a connector to it; if not, it creates a linked copy of the selected object [H9][H6].
- **Snapping to objects.** Connector ends attach to shapes, notes, cards, text and similar objects, but not to frames [H9]. Holding Ctrl (Windows) or Cmd (Mac) stops the end from snapping to objects. Holding Shift keeps the line horizontal, vertical or diagonal [H9]. Attaching to the **center** dot makes the line follow the object's edge as it moves; attaching to a **side** dot fixes the line to that point, so it can cut across the object [H9]. You reattach an end by dragging it to another object [H9].
- **Styles.** The context menu sets the line type (straight, orthogonal or curved), start and end arrowheads (including none), thickness (arrowhead size scales with it), and color [H9]. A line can be reshaped with bend points and reset by double-clicking a bend point [H9]. **Line jumps** add small hops where straight or orthogonal lines cross [H9]. To style every line the same way, copy one line's style, select all, filter to lines, and paste the style [H9].
- **Labels.** Double-click a line, or use the text option on its toolbar, to add a label. A line can have **several labels**, and each can be dragged along the line. Labels have their own size and color, and can stay horizontal or follow the curve. Label font and alignment can't be changed [H9].
- **Other.** You can insert a shape onto an existing line [H9]. Locking a line freezes its style, but it still follows the objects it connects [H9]. Lines can't be hidden, only deleted [H9]. Keyboard users can connect two objects through the command palette ("Create connection to", then "Connect to this object") [H3].

### Minimum a Miro user will expect from Draftroom
- **R1** A connector tool. Miro users will press **L** for it; in tldraw, L is an unbound line and the arrow is **A** [T3] (see §5). Arrows bind to notes, shapes, text and images, and stay attached when either end moves.
- **R1** Center versus fixed-point attachment. tldraw separates imprecise binding (to the center) from precise binding (to a point), with a pointing timeout; Alt makes the binding exact [T4]. Hold a modifier to stop binding: tldraw ignores targets while **Ctrl** is held [T4]. That matches Miro on Windows, but not Miro's Cmd on Mac. Decide whether Draftroom follows Miro on Mac (ours).
- **R1** Straight, curved and orthogonal (elbow) styles. tldraw has `kind: 'arc' | 'elbow'` plus `bend` [T6]. Arrowheads at either end or none (tldraw has 9 head types including none [T6]), thickness through the size style, color and dash.
- **R1** Double-click an arrow to add a **label**, and drag the label along the line. tldraw supports **one** label per arrow (`richText` + `labelPosition` [T6]). Several labels per line is **Later**.
- **R2** Blue-dot quick-connect: click to create a linked copy, drag to connect. Whether tldraw 5.4.2 ships anything like this is **UNVERIFIED**; plan to build it. Also: copy/paste style across many lines, and a keyboard way to connect two objects.
- **Later** Line jumps, inserting a shape onto a line.

---

## 4. Selection, alignment, grouping and locking

### What Miro does
- **Select.**
  - Dragging a selection box picks up every object it touches. Large complex widgets (tables, mind maps, kanban boards) need about 90% coverage [H10].
  - **Precise selection** only includes objects at least 90% covered. You start it with a long click-and-drag, and it can be turned on permanently under Accessibility [H10][H13]. The lasso also uses 90% coverage [H10].
  - Shift-click or Ctrl/Cmd-click adds objects to the selection [H10]. The shortcut table lists only Ctrl/Cmd-click [H4]. Ctrl/Cmd+A selects everything [H4].
  - A **Filter** on the selection's context menu narrows it to one object type (for example, only frames or only lines). Miro relies on this for bulk work such as exporting frames or restyling lines [H10][H5][H9].
- **Align and distribute.** An Align button on the context menu lines selected objects up by their edges or centers. Grouped objects and objects inside tables can't be aligned [H6]. **Auto layout** has a handle you drag to spread items out evenly [H6]. **Alignment guides** appear while you move objects; they are controlled by Preferences → Align objects [H10]. Whether guides are on by default is **UNVERIFIED**.
- **Grid.** Choose no grid, a line grid or a dot grid, with an optional snap-to-grid setting. G toggles the grid [H13][H4].
- **Group.** Ctrl/Cmd+G groups and Ctrl/Cmd+Shift+G ungroups. A group behaves as one object, but you can double-click to move a single member. Groups can't span frames, and can't include table, kanban or mind-map parts [H6][H10].
- **Lock.** Ctrl/Cmd+Shift+L, or the lock icon on the context menu. A locked object can't be moved, edited or deleted. You unlock by long-pressing the lock icon, by right-clicking, or with the same shortcut. **Unlock all** is on the canvas right-click menu [H11]. Owners and co-owners can add a **protected lock** (Ctrl/Cmd+Shift+P) that nobody else can remove [H11][H4]. Visitors can't lock or unlock [H11].
- **Stacking order.** PgUp brings an object to the front and PgDn sends it to the back; with Shift, they move it one step forward or backward. Frames always stay at the back [H4][H10].
- **Duplicate.** Ctrl/Cmd+D, Alt/Option-drag, or Alt/Option+arrow key to duplicate in a direction [H4][H10].
- **Other bulk actions.** **Clear content** (Ctrl/Cmd+Backspace) removes text, tags, emoji, authors and dates from the selected objects but keeps their styling [H10]. Copy and paste style with Ctrl/Cmd+Alt+C and Ctrl/Cmd+Alt+V [H55]. A rotate handle sits on selected objects [H10]. Holding Shift while selecting hides the context menu [H13].

### Minimum a Miro user will expect from Draftroom
- **R1** A selection box that picks up whatever it touches (tldraw's default), with a mode that only takes fully-covered objects (tldraw: hold Ctrl [T7]). Shift-click to add to a selection, and Ctrl/Cmd+A.
- **R1** **Alignment guides on by default** (ours). tldraw's snap mode defaults to off and only activates while Ctrl/Cmd is held [T8]. Miro users expect guides whenever they drag, so make Draftroom's default snap-on, with Ctrl/Cmd to suspend it.
- **R1** Align (left, center, right, top, middle, bottom) and distribute evenly, all on the selection toolbar. tldraw has these actions [T2].
- **R1** Group and ungroup on Ctrl/Cmd+G and Ctrl/Cmd+Shift+G (tldraw's defaults match [T2]), with double-click to reach a member.
- **R1** Lock and unlock stored in the shared board state, so everyone sees it, plus an **Unlock all** action. Locked items must resist dragging, editing and deleting for everyone except through an explicit unlock.
- **R1** Stacking order controls, duplicate (Ctrl/Cmd+D and Alt-drag; tldraw clones on Alt-drag [T9]), and a grid toggle with optional snap-to-grid.
- **R2** **Filter selection by type** (for example, "only notes" or "only frames"). Whether tldraw has this in its UI is **UNVERIFIED**; plan to build it. Also copy and paste style across a selection, Clear content, protected lock (owner-only), and Alt+arrow directional duplicate. That last one needs a remap, because tldraw binds Alt+arrow keys to page switching [T2].

---

## 5. Main keyboard shortcuts

Miro's shortcuts come from its official table [H4] and keyboard-navigation guide [H3]. The **tldraw 5.4.2 default** column comes from the `kbd:` entries in `tldraw/src/lib/ui/context/actions.tsx` and `hooks/useTools.tsx` [T2]. "none" means tldraw registers no default shortcut there. **Conflict** marks rows where a Miro user's habit does something different, or nothing, in stock tldraw.

| Action | Miro (Windows / Mac) | tldraw 5.4.2 default | Conflict? |
|---|---|---|---|
| Select / Hand (pan) | V / H | V / H | — |
| Sticky note | N | N | — |
| Text | T | T | — |
| Shapes menu | S | G (geo tool) | **Yes** |
| Rectangle / Oval | R / O | R / O | — |
| Connector (arrow) | L | A = arrow; L = unbound line | **Yes** |
| Pen | P | D, B or X | **Yes** |
| Card | D | D = draw | **Yes** (we have no cards) |
| Eraser | E | E | — |
| Frame | F | F | — |
| Comment tool | C | none | Build |
| Show/hide comments | Shift+C | none | Build |
| Minimap | M | none (button only) | Build |
| Command palette | Ctrl+K / Cmd+K | none | Build (R2) |
| Switch tools by number (2 = templates) | 1–9 | none | Optional |
| Shortcut list | F1 (or ? → Keyboard shortcuts) | Ctrl/Cmd+Alt+/ | Add F1 |
| Undo / Redo | Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z | same | — |
| Copy / Cut / Paste | Ctrl/Cmd+C / X / V | same | — |
| Duplicate | Ctrl/Cmd+D; Alt/Option+drag | Ctrl/Cmd+D; Alt-drag clones [T9] | — |
| Duplicate in a direction | Alt/Option+arrow | Alt+←/↑ and Alt+→/↓ switch pages | **Yes** |
| Select all | Ctrl/Cmd+A | same | — |
| Add to selection | Ctrl/Cmd+click (Shift+click per [H10]) | Shift+click (**UNVERIFIED**) | Check |
| Edit selected / stop editing | Enter / Esc | not checked (**UNVERIFIED**) | Check |
| Delete | Backspace (Win) / Delete (Mac) | Backspace or Del | — |
| Group / Ungroup | Ctrl/Cmd+G / Ctrl/Cmd+Shift+G | same | — |
| Lock / Unlock | Ctrl/Cmd+Shift+L | Shift+L | **Yes** |
| Protected lock | Ctrl/Cmd+Shift+P | none | R2 |
| Bring to front / Send to back | PgUp / PgDn (Mac: fn+↑ / fn+↓) | ] / [ | **Yes** |
| Bring forward / Send backward | Shift+PgUp / Shift+PgDn | Alt+] / Alt+[ | **Yes** |
| Add/edit link on object | Ctrl+Alt+K / Cmd+Option+K | none (Ctrl+I = insert embed) | Build |
| Clear object contents | Ctrl/Cmd+Backspace | none | R2 |
| Copy as image | Ctrl/Cmd+Shift+C | Ctrl/Cmd+Shift+C (copy as PNG) | — |
| Copy / paste style | Ctrl/Cmd+Alt+C / Ctrl/Cmd+Alt+V | Shift+Q (copy hovered styles) | **Yes** |
| Zoom in / out | Ctrl/Cmd + + / − | Ctrl/Cmd+= / −, also = / − | — |
| Zoom to 100% | Ctrl/Cmd+0 | Shift+0 | **Yes** |
| **Zoom to fit** | **Alt/Option+1** | **Shift+1** | **Yes** |
| Zoom to selection | Alt/Option+2 | Shift+2 | **Yes** |
| Pan | Space+drag; right-drag; arrow keys | not checked (**UNVERIFIED**) | Check |
| Toggle grid | G | Ctrl/Cmd+' (G = geo tool) | **Yes** |
| Search on board | Ctrl/Cmd+F | none (browser find) | Build (R1) |
| Bold / Italic / Underline | Ctrl/Cmd+B / I / U, on selected or edited text | Ctrl/Cmd+I = insert embed; Ctrl/Cmd+U = upload media (outside text editing) | **Yes** |
| New note beside, while editing | Tab (direction **UNVERIFIED**) | Tab → right, Shift+Tab → left, Ctrl/Cmd+Enter → below, +Shift → above [T1] | — |
| Bulk mode: next note / exit | Enter / Esc | n/a | Build |
| Move focus through objects (accessibility) | Tab / Shift+Tab; Ctrl/Cmd+arrows move spatially | not checked | R2 |
| Enter or leave a container (frame, group) | Ctrl/Cmd+Shift+↓ / ↑ | not checked | R2 |
| Focus the object's context menu | Ctrl/Cmd+Enter | Ctrl/Cmd+Enter = style panel (accessibility) | ~ |
| Grow / shrink selected object | Ctrl/Cmd+Alt+Shift+Plus / Minus | Ctrl/Cmd+Alt+Shift+= / − | — |
| Add comment to focused object | Alt+C / Option+C | none | Build |
| Dashboard board search | Ctrl/Cmd+E | n/a (app) | Build |
| New board in a new tab | Ctrl/Cmd+Shift+K | n/a (app) | Optional |

Other tldraw defaults a Miro user could trigger by accident: Q (keep tool selected), K (laser), Z (zoom tool), Shift+H / Shift+V (flip), Alt+A/H/D/V/W/S (align), `/` (cursor chat), Ctrl/Cmd+/ (dark mode), Ctrl/Cmd+. (focus mode), **Shift+F (flatten the selection to an image)** and Ctrl/Cmd+P (print) [T2].

### Minimum a Miro user will expect from Draftroom
- **R1** Remap the conflicts that cost the most and are cheapest to fix, so Miro habits just work (ours):
  - **L** gives a *bound* arrow and **P** gives the pen.
  - **Alt+1**, **Alt+2** and **Ctrl/Cmd+0** zoom to fit, to the selection and to 100%. Ctrl/Cmd+0 must `preventDefault`, or the browser resets its own zoom.
  - **Ctrl/Cmd+Shift+L** locks. **PgUp/PgDn** set stacking order. **G** toggles the grid.
  - **C** opens comments. **M** toggles the minimap.
  - **Ctrl/Cmd+F** opens board search instead of the browser's find.
- **R1** Keep tldraw's other defaults where they don't collide. Review the risky ones: Shift+F flattens to an image, and Ctrl+I/U are hijacked by embed/upload even though Miro users expect bold, italic and underline on selected text.
- **R1** A shortcuts sheet opened by **F1** and a "?" button, in our own design. It lists the Tab / Ctrl+Enter note behavior.
- **R2** An option to turn off single-key shortcuts for people using assistive technology (Miro offers this [H3]), plus Ctrl/Cmd+K command palette.
- **Note.** How exactly to override tldraw's `kbd` bindings in 5.4.2 (the UI `overrides` for actions and tools) is **UNVERIFIED** here; check against `node_modules/tldraw` before implementing.

---

## 6. Navigation: zoom, minimap and search

### What Miro does
- **Moving around.**
  - With a mouse, right-drag pans and the wheel zooms. Space plus left-drag also pans, as does a held mouse wheel on some mice.
  - With a trackpad, two fingers pan and a pinch zooms.
  - On a touchscreen you drag to pan, pinch to zoom, and long-press-drag to select.
  - A per-user Mouse / Trackpad / Auto-switch setting decides what a scroll gesture does [H15].
- **Canvas controls.** These sit bottom-right: the zoom percentage, whose menu holds **fit to screen**, a **minimap** (show/pin it there or press M), full screen, grid and object dimensions; plus Frames and layers, and Help [H14][H15][H13]. Hiding collaborator cursors, comments or scroll bars is in the View menu [H13].
- **Search on the board.** Ctrl/Cmd+F (also under Edit → Find) lists every matching object. Matches are **highlighted on the canvas while everything else is dimmed**, and clicking a result jumps to it. A filter limits results to one content type, such as notes with a given tag [H16]. There is no find-and-replace [H16]. Whether this search covers comment text is **UNVERIFIED**; the dashboard's paid search does cover comments [H17].
- **Getting people to the right place.**
  - A **start view** decides where newly invited people land; with none set, they see the whole board [H35].
  - Any object or frame can give a deep link [H19].
  - Links between objects (Link to…) make clickable navigation inside a board [H19].
  - Viewers can switch between frames from the board overview [H31].
- **Keyboard and screen-reader navigation.** Tab and Shift+Tab move through objects in reading order (top-left to bottom-right). Ctrl/Cmd+arrow keys move spatially. B moves focus to the board, and Esc goes back to the toolbars. A screen-reader "board summary" is available on Alt/Option+S [H3].
- **Command palette.** Ctrl/Cmd+K finds tools, apps and recent boards. It works only for people with edit access, and not during a presentation [H18].

### Minimum a Miro user will expect from Draftroom
- **R1** Wheel or pinch zoom, two-finger or space-drag pan, and right-drag pan with a mouse. A mouse/trackpad preference, because the wrong scroll mapping is one of the first things Miro users notice (ours).
- **R1** A zoom control with fit to screen, zoom to selection and 100%. A **minimap** (tldraw 5.4.2 includes one in its navigation panel, collapsed by default and remembered in local storage [T10]). Full screen.
- **R1** **Board search** on Ctrl/Cmd+F. It covers note text, text boxes, shapes, arrow labels, frame names, file-card names and image alt text (as the contracts' `searchBoard` does). Show results as a list, highlight matches and dim the rest, click to jump, and filter by type and tag.
- **R1** Deep links to objects and frames. A start view for people opening the board for the first time.
- **R2** Tab through objects in reading order, spatial arrow navigation, and a text/list view of the board (build plan §4 accessibility). Hiding collaborators' cursors. Command palette.

---

## 7. Comments, mentions and notifications

### What Miro does
- **Create.** Press C, or use the comment tool. Then click the canvas or an object, type, and publish with Enter (Shift+Enter adds a new line). Comments are plain text only. Leaving an unpublished comment keeps it as a draft [H20]. Keyboard users can add a comment to the focused object with Alt/Option+C, and move between comments with Option+Tab [H3].
- **Anchoring.** Dropping a comment over an object attaches it, and then it moves with the object. You can drag a comment to a different object. Comments are **not** copied, cut or pasted with their object, and never appear in exports, though duplicating a whole board copies them [H20].
- **Markers and state.** On the canvas, markers look different for **new** comments, **read** ones and **resolved** ones (which carry a check), and for mentions of you, which show an @ [H20]. Hovering previews a thread. A per-comment color can signal category [H20].
- **Threads.**
  - Replies, editing your own comments, and deleting (one at a time only). Emoji reactions on comments.
  - Mark a thread unread, or mark everything read.
  - **Resolve** hides a thread from the board, and "Show resolved" in the panel brings resolved threads back [H20].
  - **Pin** keeps a thread open on the board. Note that "pin" here means *keep it expanded*, not the marker itself [H20].
  - Shift+C, or a panel setting, hides all comments on the board [H20][H4].
- **Comments panel.** It sits under the Activity (bell) icon and lists every comment and mention. Clicking one jumps to its location [H20][H14].
- **Mentions.**
  - Type @ in a comment to notify someone who has access to the board. **@board** notifies everyone with access, and **@team** and **@project** notify those groups.
  - You can mention yourself as a reminder.
  - If a name doesn't appear, that person needs to be invited to the board first.
  - An @ inside a note, shape or text object only labels a person and **doesn't notify them**.
  - Guests can only mention people directly invited to the board; visitors can't mention anyone [H21].
  - Suggested mentions appear on some plans [H21].
- **Following and notifications.**
  - You are notified about threads you commented on, replied to or were mentioned in. You can turn that off per thread with Follow thread, follow a thread manually, or turn on "Follow all threads" for a board [H20][H21].
  - Notifications arrive through an in-app **Activity/Feed** grouped by board, with Unread and All tabs (All keeps items for 30 days), plus pop-up toasts [H23].
  - Per-person settings choose email, mobile or Slack for each category, and offer an optional "Summary of changes on my boards" digest with a chosen time and period [H22].
  - You can reply to a mention straight from the feed without opening the board [H23].

### Minimum a Miro user will expect from Draftroom
- **R1** A comment tool on **C**. Click the canvas for a comment pinned to a board position, or click an object to attach the comment so it moves with the object. Enter posts and Shift+Enter adds a new line. Unsent drafts survive closing the thread.
- **R1** Threaded replies, editing and deleting your own comments, **resolve and reopen** (resolved threads leave the canvas but stay in the panel behind "Show resolved"), and read/unread per person with a visible difference on markers. Use our own markers and colors, not Miro's blue and white.
- **R1** A **comments panel** that lists threads, filters open or resolved, and jumps to each thread's location. Hover preview on markers. Hide all comments with Shift+C.
- **R1** **@mentions** autocomplete from people who have access and send notifications. When someone without access is mentioned, prompt to invite them instead of failing silently (ours). An @ inside note or text content doesn't notify anyone, matching Miro.
- **R1** Follow a thread automatically when you post or are mentioned, and let people unfollow. An in-app notification inbox with Unread and All, and a link from each notification to the thread. Email for mentions and replies, with a per-person choice of immediate or digest.
- **R2** @board mentions, emoji reactions on comments, keeping a thread open on the board, comment colors, "Follow all threads" per board, and a digest of board changes. Two places Draftroom could beat Miro (ours): **include open comments in exports** as an option, and **carry attached comments along when objects are duplicated**.

---

## 8. Templates

### What Miro does
- **Where templates appear.** A strip of templates and an "Explore templates" button sit on the dashboard; picking one creates a new board [H24][H43]. Inside a board, the Templates button on the creation bar (or key **2** [H4]) opens the **template picker** so a template can be added to the current board. The frame, note, table and mind-map tools each have a Templates entry too [H24].
- **Picker flow.**
  1. The picker opens automatically on a new board unless you untick "Show when creating a new board" [H24].
  2. Search (which also covers custom templates), or browse categories, topic tags and featured picks [H24].
  3. Open a preview showing the template's author, an interactive preview and guidance [H24].
  4. Some templates let you choose **pre-filled example content or blank** [H24].
  5. Choose "Use template". From the dashboard, that opens a new board [H43].
- **After insertion.** The inserted elements are **automatically ungrouped** and individually editable. Several templates can be combined on one board [H24]. **Clear content** empties example text but keeps the styling. The shortcut is given as Ctrl/Cmd+Backspace in one article and Ctrl/Cmd+Delete in another [H10][H24].
- **Custom templates.** You can save a whole board, a selection (⋯ → Save as template) or a from-scratch design. Each is saved as Personal, Team or Company. You can set its name, description and preview area, and edit it together with others. Deleting a template can be undone [H25]. Selections must be unlocked before they can be saved as a template [H25]. Sharing a template link sends someone straight to it [H24].
- **Scale.** Miro claims more than 300 of its own templates, plus a community gallery [H24] that the product pages put at over 7,000 [P2].

### Minimum a Miro user will expect from Draftroom
- **R1** The picker opens on a new board and is also reachable from the toolbar on an existing board. It has search, a few categories and a large preview. Offer "don't show on new boards" and a clear **Blank board** choice.
- **R1** Inserting a template places **ordinary, ungrouped, editable** objects in empty space near the viewport, then selects and frames them so they can be moved as one (ours). The six creative templates in `packages/templates` cover the first release.
- **R1** "New board from template" on the dashboard.
- **R2** Save a selection or board as a template, a shared team library, editing and deleting your own templates (with undo), pre-filled versus blank variants, and Clear content that keeps styling.
- **Later** A public gallery.

---

## 9. Facilitation: timer, voting, follow, attention and private mode

### What Miro does

**Timer** [H26]
- Found under the Facilitation tools and Reactions menu (top right). Set a duration by typing or with + and −, then Start.
- While it runs you can pause, stop (which also resets), or add time with **+1m** or **+5m**. These controls are open to whoever started the timer and to editors who were invited directly or through a team or space.
- The timer **starts and ends for everyone**. It can be minimized, and the toolbar icon then shows the time left. When time runs out, everyone gets a visual alert and a chime. Optional royalty-free music can play during the countdown, with a mute button.
- Viewers, commenters and visitors can't set it up. Registered users, including registered viewers and commenters, see it running, and so do visitors with edit access. Whether view-only anonymous visitors see it is **UNVERIFIED** [H26][H31].
- It can't be moved on screen. In Presentation mode it appears in the top-left [H26].

**Voting** [H27]
- **Setup** (team members with edit rights). A side panel sets:
  - the **voting area**, meaning which objects can receive votes, filterable to types such as notes;
  - **votes per person**, up to 99;
  - the **duration**, in minutes, hours or days;
  - optionally, **at most one vote per object** per person.
  Voting is anonymous. Start it now, or choose "Add to board" to save it for later.
- **Taking part.** Everyone on the board, including unregistered users, gets a prompt showing the time left and can join or skip. People who skipped can join later from the toolbar icon, which shows the countdown. Votes are cast and removed with + and − on each object. **"I'm done"** marks you finished, and anyone can see who is done under Participants.
- **Facilitator.** Sees progress, and votes per person under Participants. Can add minutes or end early. There is no reset; you end the session and start a new one.
- **Results.** Everyone sees the **top 3** first, then **See all results** gives the full list. A toggle keeps the results showing on the board. Past sessions stay available in a results history, and each can be renamed or deleted. **Results can't be exported** (Miro suggests a screenshot), and duplicating a board doesn't copy them.
- **Conflict in Miro's docs.** The voting article says guests and visitors who can edit can't start a vote [H27]. The roles table says visitors and guests can "set up and join" voting [H32]. The visitor article lists starting a vote as unavailable to visitors [H36]. Treat setup as team-members-only.

**Follow and attention management** [H28][H14]
- **Follow a collaborator.** Click their avatar in the People bar. You see their view in real time until you click, move your cursor or zoom. The person being followed sees a notice on their avatar.
- **Bring everyone to me.** Everyone auto-follows your view until they themselves move, zoom or click. There is also **Bring to me** for a single person, from their menu.
- Cursor colors and avatar border colors match for everyone on the board, so you can tell who is who.
- **Who can do what.** Editors who were invited directly or through a team or space (guests included) can use every feature. Visitors who can edit, and registered viewers and commenters, can only follow. Anonymous view-only visitors get none of it.
- The People bar also offers people search, and turning cursors on or off [H14].

**Private mode** [H29]
- An editor turns it on for everyone. While it runs, **new notes and edits to existing notes are hidden from everyone except their author**, and a closed-eye icon marks a private note. It applies to sticky notes only.
- **Options at start.**
  - **Make names anonymous**: hides authors, disables follow, anonymizes cursors and shuffles their positions, keeps the content out of board history, and stays anonymous **permanently**.
  - **Allow anyone to turn off**: if this is off, only the starter can end the session (board owners and enterprise admins always can).
- **During the session**, the starter can let people reveal their own notes early ("reveal all my sticky notes").
- **Ending** shows who ended it, then a 5-second countdown, then everything is revealed.
- Miro states plainly that private mode "isn't a data protection feature" [H29].

**Reactions and extras**
- Six emoji reactions appear on the board together with the sender's avatar [H30]. Raising a hand moved into Presentation mode [H14][H8].
- **Breakout frames** (beta) split participants across copies of a frame. You can assign people, lock them to their frame, and use up to 100 breakouts [H59].
- The workshops product page also promotes live polls, word clouds, dot voting, alignment scales and spinner wheels [P1].

### Minimum a Miro user will expect from Draftroom
All of these are **R2** in the build plan, except the escape-from-follow behavior, which must be right as soon as follow ships.
- **Timer.** The server owns it: store the end timestamp, not a counting client. Controls: set, start, pause, stop/reset, +1 and +5 minutes, available to facilitators and editors. Everyone sees it, including viewers and people who join late. Show a compact countdown in the toolbar, give an unmistakable end signal (visual, plus a sound that can be muted), and keep it visible during presentations. The end sound must be our own, not Miro's chime.
- **Voting.**
  - Setup: scope (the selection, a frame, or object types), votes per person, duration, a one-vote-per-object option, anonymous by default, and start-now or save-for-later.
  - Taking part: a join or skip prompt, + and − on objects, a count of votes left, "I'm done", and rejoining from the toolbar.
  - Facilitator: progress, extend, end.
  - Results: top 3 plus the full ranking, an option to leave result badges on the board, and past sessions.
  - Enforce the allowance on the server. **Export results to CSV** is a cheap way to beat Miro (ours).
- **Follow.**
  - Click an avatar to follow, with a visible "following X" state and a clear way out. **Any pan, zoom or click stops following** (build plan §2: easy escape). tldraw has follow built in, through `startFollowingUser`/`stopFollowingUser` and a people menu [T11].
  - **Gather everyone** and **bring one person** need a server-sent command that each client can escape the same way. That part must be built.
  - Keep cursor and avatar colors consistent, and offer hide cursors.
- **Private drafting.** A facilitator toggle hides others' note text while it is on, with an optional permanent anonymize, a choice of who can end it, reveal-my-own, and an end countdown before the reveal. Do it with **server-side access separation** (build plan §2), so hidden text never reaches other clients. Unlike Miro, this makes it a real confidentiality feature.
- **Reactions.** Quick emoji shown with the sender's avatar, and raise hand. **Later**: breakouts, polls, word clouds.

---

## 10. Sharing, roles, guests and visitors

### What Miro does
- **Roles on a board.**
  - **Owner** (exactly one): can move the board, download backups, add co-owners, set a password, hide frames, use protected lock, control content and collaboration settings, decide who may share, transfer ownership and delete the board.
  - **Co-owner** (Business and Enterprise): shares most of the owner's controls.
  - **Editor**, **Commenter** and **Viewer** [H31].
  Viewers see only zoom and map controls. Commenters can only comment. Registered viewers and commenters can take part in votes and see the timer [H31].
- **Ways a board is shared.** It can be shared with specific people by email, with **space** members, with the whole **team** or company, or with **anyone who has the link** (view, comment or edit). The **highest** of these grants applies to each person. Removing someone's email invite doesn't remove access they get through the team, space or link, which the docs repeat several times [H31][H33][H35]. Icons next to Share show the current level [H33].
- **Invite flow.** Share → type email addresses and pick a role (the default is **Can edit**) → Send. Invites can also go through Slack, a Microsoft directory, or a team invite link [H31][H35]. People who aren't registered sign up from the email [H35]. **Start view** is set when you first share [H35]. Stop sharing by changing a role or removing a person in Manage access [H35].
- **Guests** are registered users invited by email to specific boards only. They get paid features on those boards, but can't create boards, share, change settings or see team boards. They are free and unlimited, and their access never expires unless removed [H37]. A **guest link** expires after 30 days [H35].
- **Visitors.**
  - People without accounts reach a board through a public link. Anyone editing without an account is given an automatic name (the docs' example is "Visiting Inventor"); owners can let them type their own name [H36].
  - What visitors can't do: rename, share, mention, start votes, lock or unlock, upload, see board history, receive notifications, or bring others to their view [H36].
  - Public links can carry a **password**. It must be at least 8 characters, is asked for again every 72 hours, and changing it immediately locks out everyone using the old one [H38]. Enterprise admins can make public links expire after a period without opens [H36].
- **Controls for owners and co-owners.**
  - **Who can share**: owners only, or every team-member editor [H34].
  - **Who can copy, export or duplicate** board content [H39]. This also controls whether collaborators can export [H47] and restore versions [H50].
- **Requesting access.** Opening a link to a board you don't have shows **Request access**, which emails the owner. Viewers and commenters can ask for editor rights [H31].
- On Free plans, every board is visible to the whole team, and private boards need a paid plan [H40][H33].

### Minimum a Miro user will expect from Draftroom
- **R1** Owner, editor, commenter and viewer, enforced on the server as well as in the UI. Viewers get navigation only. Commenters get comments only. Tools that aren't allowed are hidden or disabled, with a tooltip explaining why (ours).
- **R1** A Share dialog that invites by email with a role, sets **workspace-wide access** (none, view, comment, edit), and shows **who has access and through which grant**. Effective access is the highest grant. When removing a direct invite leaves access through another grant, say so.
- **R1** Copy board link. A **Request access** page for signed-in users without access, and a request-edit-access option for viewers and commenters.
- **R1** Choose a default invite role deliberately (ours: Miro defaults to edit; for client review links, *comment* is the safer default).
- **R2** Link sharing (view, comment or edit) with **expiry** and an optional password. **Guests** limited to invited boards. Named visitor sessions where the visitor enters a name. Owner-only sharing. A copy/export permission setting. Co-owners. Transfer of ownership. A per-board start view.
- **Later** Enterprise admin policies (mandatory passwords, org-wide sharing rules).

---

## 11. Board dashboard: recent, starred, spaces and search

### What Miro does
- **Layout.** The dashboard (called "Home") holds a team switcher, Spaces, boards shared with you, **Recent** (boards opened from any team) and **Starred** (across your whole profile). From here you can create boards, search and upload backups [H41][H42].
- **Organizing.** Filter by owner (anyone, me, not me). Sort alphabetically or by date created, last opened or last modified. Switch between grid and list view [H41].
- **Board card menu.** Share, rename, move, duplicate, delete, change thumbnail, board details, download backup and copy link [H41]. Starring moved into the board's main menu in the new UI [H14].
- **Spaces** (these replaced "Projects"; project permissions carried over [H42]). Each Space has its own sidebar, reorderable **sections**, an overview page and its own access roles (owner, co-owner, editor, commenter, viewer). A Space role raises your access on every board inside it. A filter finds "Boards not in a Space" [H42].
- **Search.** Ctrl/Cmd+E, or the search box, finds boards and Spaces by name. Recent items appear before you type. Filters narrow by owner or Space [H17]. Paid plans also search inside board content, comments and notes, and a result opens the board at the matching spot [H17].
- **Create.**
  - **+ Create new → Board**, from a template, or by typing `miro.new` in the browser [H43].
  - Duplicating a board asks for a name and whether to keep its sharing settings [H44].
  - **Board details** show owner, description, creation and modification dates and location, and let you change the thumbnail (an icon, an upload or an area of the board) [H45].
- **Trash.** Deleted boards can be restored for 90 days on paid plans. Free-plan users can restore a board by opening its link [H41][H46].

### Minimum a Miro user will expect from Draftroom
- **R1** A dashboard with **Recent**, **Starred** and **All boards** in the workspace, plus projects/spaces as folders (build plan §11). Sort by name, created, last opened or last modified. Filter by owner. Grid and list views. Thumbnails generated from the board, or chosen.
- **R1** Card menu: open, rename, share, duplicate (with a keep-sharing option), move to a project, star, delete, copy link and details.
- **R1** Search by board name on **Ctrl/Cmd+E**, with recent boards shown before typing.
- **R1** Trash with restore (recoverable deletion is in build plan §4 for R1).
- **R2** Sections within projects, search inside board content (reusing `searchBoard`), a board description and a chosen thumbnail area.

---

## 12. Exports

### What Miro does
- **Image.**
  - Board menu → Export → **Save as image**: choose an area, then a size (Small, Medium, Large, or **Vector**, which saves as PDF or SVG) [H47].
  - A frame can be exported as an image from its menu [H47].
  - To export the whole board as one image, frame everything first [H47].
  - **Copy as image** (Ctrl/Cmd+Shift+C) puts a PNG on the clipboard [H49].
- **PDF.**
  - **Save as PDF** makes one page per frame, in frames-panel order. Quality is Small or Best (vector), and links only stay clickable in vector PDFs.
  - Selected frames can be exported alone.
  - With no frames, you frame everything first [H47].
- **CSV.** **Export to CSV** works on a selection or the whole board. It writes text from notes, tables, cards, text boxes and shapes into one column, in the order text, card description or URL, then tags. It doesn't keep structure, except when exporting tables [H47]. It isn't available in every browser or on mobile [H47].
- **Copy as text.** Copying objects puts their text on the clipboard, one object per line [H49].
- **Backup.** Owners and co-owners, on paid plans, can download a `.rtb` backup up to 1 GB, from the board or the dashboard. Importing it creates a **new** board whose title includes "Restored". Backups can't be made in bulk [H48].
- **What's left out, and limits.**
  - No PowerPoint or PNG file export. Comments and frame titles don't appear in exports. Voting results can't be exported [H47].
  - Bitmap images are compressed on upload, so exports don't restore full image quality [H47].
  - Uploaded files can be downloaded one at a time if board settings allow [H47].
  - Very large frames can export with missing text [H47].
  - Export can be switched off per board [H39].
  - Board notes export as PDF [H60], and Grids as CSV [H12].

### Minimum a Miro user will expect from Draftroom
- **R1** **PNG export** of the selection, a frame or the whole board, at a few sizes. **Vector PDF**: one page per frame, in outline order, with a "selected frames only" option. **Copy as image** on Ctrl/Cmd+Shift+C (tldraw's default matches [T2]).
- **R1** **Native board export and import**. The import always makes a new board, and the archive must bring its assets with it (the contracts' `exportBoardArchive`/`importBoardArchive`; the build plan's asset-complete packages are R2). Original uploaded files can be downloaded.
- **R1** Respect an owner's "no export" setting once it exists (R2), and apply it on the server.
- **R2** CSV of text from a selection or the whole board. The contract's header is `id,type,text,frame,color,x,y`; add a **tags** column, which Miro users expect in exports (ours). Copy as text.
- Optional ways to beat Miro (ours): export **with frame titles**, and **with open comments** as an appendix or annotations.

---

## 13. Board history, versions and recovery

### What Miro does
- **Undo and redo.** Covers **only your own actions**, up to **30 steps**, for the current session only. A reload clears it [H53].
- **Activity log** (Board → History → Activity).
  - Visible to editors who were invited or belong through a team or space. Hidden from viewers, commenters and visitors.
  - Lists additions, duplications, edits and deletions (including undos) by date, grouped by person, with text changes shown. **Moves aren't recorded**, and only the latest change to each object is kept.
  - Clicking an entry jumps to the object. Deleted objects can be **restored in place** from here.
  - Entries are kept for 90 days [H51].
- **What changed while you were away.** When you open a board others edited in your absence, a **"See recent changes"** button (shown for about 30 seconds) highlights those changes with names and times. A **Highlight changes** toggle takes you to the most recently changed object [H51].
- **Restoring deleted objects** [H52][H51] is possible for:
  - anything deleted during the current session and for 30 minutes afterwards;
  - otherwise, the last 1,000 deleted objects.
  There are edge cases: connectors whose endpoints were deleted, content that was removed from a table, and comments deleted on their own.
- **Versions** (Board → History → Versions).
  - Saved automatically **every hour if something changed, and at the end of each collaborative session**, and kept for **90 days**.
  - Restoring a version makes a **separate board** with a dated title; the original is never touched.
  - Available to owners and co-owners, and to team-member editors if copying is allowed [H50].
- **Object info.** The Info panel shows who created an object, who last modified it, and when [H51].
- **Deleted boards** go to Trash for 90 days [H46].

### Minimum a Miro user will expect from Draftroom
- **R1** Per-user undo and redo that doesn't undo other people's work, with more than 30 steps. Watch the known tldraw caveat: undo writes back the whole earlier record and can overwrite others' changes or bring back deleted shapes (`docs/research/SYNTHESIS.md` §8).
- **R1** **Recoverable deletion.** A "recently deleted" list per board that restores objects to their original place.
- **R1** **Named snapshots** plus automatic ones. Restore as a **new board**, non-destructively, as build plan §4 and Miro both do.
- **R2** An activity list (who added, edited or deleted what; click to jump), a "changes since your last visit" highlight, an automatic snapshot browser (hourly while the board changes, and at the end of each session), and a created-by / modified-by info panel.

---

## Where Miro's own docs disagree

Watch these if you are copying behavior from a single article:
1. **Who can start a vote.** The voting article [H27] and visitor article [H36] say guests and visitors can't. The roles table [H32] says they can.
2. **Clear content shortcut.** One article says Ctrl/Cmd+Backspace [H10][H4]; the templates article says Ctrl/Cmd+Delete [H24].
3. **Adding to a selection.** The shortcut table gives Ctrl/Cmd+click only [H4]; the objects article gives Shift or Ctrl/Cmd [H10].
4. **Presenter notes.** Both presentation articles describe private presenter notes, yet each FAQ says hidden presenter notes aren't possible yet [H7][H8].
5. **Where frames and Trash live.** Frames are placed in the "board overview, bottom-left" [H47][H31] and also in "Frames and layers, bottom-right" [H14]. Trash is placed under the avatar at bottom-left [H41] and at upper-right [H46]. Both reflect the ongoing UI rollout.
6. **Link-to shortcut.** The linking article's Windows shortcut includes Cmd, which is a typo [H19]; the shortcut table gives Alt+Ctrl+K [H4].
7. **Projects versus Spaces.** Spaces replaced projects [H42], but mentions still document `@project` [H21].

## Still UNVERIFIED

- Which direction a Tab-created note goes in Miro, and whether Shift+Tab or Ctrl/Cmd+Enter variants exist [H3].
- Whether Miro notes have discrete size presets, and whether alignment guides are on by default.
- Whether Miro's hidden frames and private mode keep content from ever reaching other browsers. Miro documents only what appears on screen, and says private mode isn't data protection [H29].
- Whether board search (Ctrl/Cmd+F) covers comment text.
- What late joiners see on a running timer or vote. Everyone is said to be notified, but late joiners aren't described.
- tldraw 5.4.2: typing to start editing a selected note; Enter/Esc editing; Shift+click to add to a selection; Space-drag pan; an existing selection-filter UI; blue-dot quick create; the exact API for overriding shortcuts. Everything else marked [T#] was read in source.

## Naming and branding

Copy the interaction, never the identity. Use Draftroom names for features, and don't reuse Miro product names: Miroverse, Talktrack, Blueprints, Intelligent templates, Miro Engage and Sidekicks. Use our own icons, palette (including note colors), marker styles, sounds (no Miro chime) and copy. Where a Miro label is simply a plain description ("Bring everyone to me", "Private mode"), prefer our own wording anyway, such as "Gather everyone" or "Private drafting" (ours). Plain verbs like Present, Share and Follow are fine.

---

## Sources

All accessed 2026-09-26. Each help-center entry gives the article's last-updated date. Articles were read through the help center's article API, which returns the same content as the linked page.

**Miro help center**
- [H1] Sticky notes (upd. 2026-09-15): https://help.miro.com/hc/en-us/articles/360017572054-Sticky-notes
- [H2] Clustering (2026-09-08): https://help.miro.com/hc/en-us/articles/4409706795410-Clustering
- [H3] Keyboard navigation while working on boards (2026-09-15): https://help.miro.com/hc/en-us/articles/11997028019858-Keyboard-navigation-while-working-on-boards
- [H4] Shortcuts and hotkeys (2026-09-15): https://help.miro.com/hc/en-us/articles/360017731033-Shortcuts-and-hotkeys
- [H5] Frames (2026-09-15): https://help.miro.com/hc/en-us/articles/360018261813-Frames
- [H6] Structuring board content (2026-09-15): https://help.miro.com/hc/en-us/articles/360017730973-Structuring-board-content
- [H7] Presentation mode, 2026 version (2026-09-15): https://help.miro.com/hc/en-us/articles/34307373858450-Presentation-mode
- [H8] Interactive Presentation Mode, legacy (2026-09-15): https://help.miro.com/hc/en-us/articles/8512850754962-Interactive-Presentation-Mode
- [H9] Connection lines (2026-09-15): https://help.miro.com/hc/en-us/articles/360017730733-Connection-lines
- [H10] Working with objects (2026-09-15): https://help.miro.com/hc/en-us/articles/360017730953-Working-with-objects
- [H11] Locking content on the board (2026-09-15): https://help.miro.com/hc/en-us/articles/4408887253778-Locking-content-on-the-board
- [H12] Grid (2026-09-15): https://help.miro.com/hc/en-us/articles/360011986519-Grid
- [H13] Toolbars (2026-09-15): https://help.miro.com/hc/en-us/articles/360017730553-Toolbars
- [H14] Miro's new simplified user interface (2026-09-08): https://help.miro.com/hc/en-us/articles/20967864443410-Miro-s-new-simplified-user-interface
- [H15] Using Miro with a mouse, trackpad, or touchscreen (2026-09-08): https://help.miro.com/hc/en-us/articles/360017731053-Using-Miro-with-a-mouse-trackpad-or-touchscreen
- [H16] Searching text on the board (2026-09-08): https://help.miro.com/hc/en-us/articles/360018109534-Searching-text-on-the-board
- [H17] How to search in Miro (2026-09-08): https://help.miro.com/hc/en-us/articles/360012140959-How-to-search-in-Miro
- [H18] Command palette (2026-09-08): https://help.miro.com/hc/en-us/articles/10389262146706-Command-palette
- [H19] Internal and external linking (2026-09-15): https://help.miro.com/hc/en-us/articles/360017572354-Internal-and-external-linking
- [H20] Comments (2026-09-15): https://help.miro.com/hc/en-us/articles/360017730873-Comments
- [H21] @Mentioning people on the board (2026-09-15): https://help.miro.com/hc/en-us/articles/360017730893--Mentioning-people-on-the-board
- [H22] Manage notifications and email preferences (2026-09-15): https://help.miro.com/hc/en-us/articles/360017571314-Manage-notifications-and-email-preferences
- [H23] Feed (2026-09-15): https://help.miro.com/hc/en-us/articles/360034278893-Feed
- [H24] Templates (2026-09-08): https://help.miro.com/hc/en-us/articles/360017572134-Templates
- [H25] Custom templates (2026-09-15): https://help.miro.com/hc/en-us/articles/360019018899-Custom-templates
- [H26] Timer (2026-09-15): https://help.miro.com/hc/en-us/articles/360017730933-Timer
- [H27] Voting (2026-09-15): https://help.miro.com/hc/en-us/articles/360017572274-Voting
- [H28] Attention management (2026-09-15): https://help.miro.com/hc/en-us/articles/360013358479-Attention-management
- [H29] Private mode (2026-09-08): https://help.miro.com/hc/en-us/articles/9794413310482-Private-mode
- [H30] Reactions (2026-09-08): https://help.miro.com/hc/en-us/articles/360021249320-Reactions
- [H31] Board access rights (2026-09-15): https://help.miro.com/hc/en-us/articles/360017572194-Board-access-rights
- [H32] Visitors, guests and members (2026-09-08): https://help.miro.com/hc/en-us/articles/7045408248594-Visitors-guests-and-members
- [H33] Who has access to my board? (2026-09-08): https://help.miro.com/hc/en-us/articles/4408888726290-Who-has-access-to-my-board
- [H34] Who can share a Miro board (2026-09-15): https://help.miro.com/hc/en-us/articles/4409700441362-Who-can-share-a-Miro-board
- [H35] Sharing boards and inviting collaborators (2026-09-15): https://help.miro.com/hc/en-us/articles/360017730813-Sharing-boards-and-inviting-collaborators
- [H36] Collaboration with Visitors (2026-09-08): https://help.miro.com/hc/en-us/articles/360012524559-Collaboration-with-Visitors
- [H37] Collaboration with Guests (2026-09-15): https://help.miro.com/hc/en-us/articles/360021415119-Collaboration-with-Guests
- [H38] Password protection for public boards (2026-09-15): https://help.miro.com/hc/en-us/articles/360014617239-Password-protection-for-public-boards
- [H39] How to allow or restrict copying and exporting boards and content (2026-09-15): https://help.miro.com/hc/en-us/articles/360018350399-How-to-allow-or-restrict-copying-and-exporting-boards-and-content
- [H40] Public boards vs. private boards (2026-09-15): https://help.miro.com/hc/en-us/articles/360011114519-Public-boards-vs-private-boards
- [H41] What is on your dashboard (2026-09-15): https://help.miro.com/hc/en-us/articles/360017571294-What-is-on-your-dashboard
- [H42] Spaces (2026-09-15): https://help.miro.com/hc/en-us/articles/21040490154898-Spaces
- [H43] Create a Miro board (2026-09-09): https://help.miro.com/hc/en-us/articles/360017571974-Create-a-Miro-board
- [H44] How to duplicate a board (2026-09-15): https://help.miro.com/hc/en-us/articles/360017730113-How-to-duplicate-a-board
- [H45] Update your board information (2026-09-08): https://help.miro.com/hc/en-us/articles/22659235132946-Update-your-board-information
- [H46] How to restore a deleted board (2026-09-08): https://help.miro.com/hc/en-us/articles/360017572614-How-to-restore-a-deleted-board
- [H47] How to export your board (2026-09-08): https://help.miro.com/hc/en-us/articles/360017572754-How-to-export-your-board
- [H48] How to save board backup (2026-09-08): https://help.miro.com/hc/en-us/articles/360017572774-How-to-save-board-backup
- [H49] Copy as text or as an image (2026-09-08): https://help.miro.com/hc/en-us/articles/4413451973266-Copy-as-text-or-as-an-image
- [H50] Board history: versions (2026-09-15): https://help.miro.com/hc/en-us/articles/360021668819-Board-history-versions
- [H51] Board history: activity (2026-09-15): https://help.miro.com/hc/en-us/articles/360017730913-Board-history-activity
- [H52] Restoring board content (2026-09-15): https://help.miro.com/hc/en-us/articles/360019838260-Restoring-board-content
- [H53] Undo/Redo (2026-09-15): https://help.miro.com/hc/en-us/articles/360017730793-Undo-Redo
- [H54] Shapes (2026-09-15): https://help.miro.com/hc/en-us/articles/360017730713-Shapes
- [H55] Text (2026-09-15): https://help.miro.com/hc/en-us/articles/360017572094-Text
- [H56] Layers (2026-09-15, background only): https://help.miro.com/hc/en-us/articles/20258488000786-Layers
- [H57] How to make your Miro boards more accessible (2026-09-15, background only): https://help.miro.com/hc/en-us/articles/4403828924306-How-to-make-your-Miro-boards-more-accessible
- [H58] Ways to add content (2026-09-15, background only): https://help.miro.com/hc/en-us/articles/360017731233-Ways-to-add-content
- [H59] Breakout frames (BETA) (2026-09-15): https://help.miro.com/hc/en-us/articles/4408994822546-Breakout-frames-BETA
- [H60] Visual notes (2026-09-15): https://help.miro.com/hc/en-us/articles/360035713254-Visual-notes

**miro.com product pages**
- [P1] Meetings and workshops: https://miro.com/meetings-and-workshops/
- [P2] Mood board: https://miro.com/moodboard/

**tldraw 5.4.2 source** (read in `node_modules/.pnpm/tldraw@5.4.2_*/node_modules/tldraw/src/lib/` and the matching `@tldraw/tlschema` and `@tldraw/editor` packages)
- [T1] `shapes/note/NoteShapeUtil.tsx`, `useNoteKeydownHandler`: Tab / Shift+Tab / Ctrl/Cmd(+Shift)+Enter create an adjacent note and start editing it.
- [T2] `ui/context/actions.tsx` and `ui/hooks/useTools.tsx`: every `kbd:` default in the shortcut table.
- [T3] `ui/hooks/useTools.tsx`: tool keys (arrow `a`, line `l`, draw `d,b,x`, note `n`, frame `f`, laser `k`).
- [T4] `shapes/arrow/ArrowShapeUtil.tsx` options: `shouldIgnoreTargets` = Ctrl held, `shouldBeExact` = Alt held, precise-pointing timeouts; `arrowTargetState.ts`.
- [T5] `@tldraw/tlschema` `styles/TLColorStyle.ts` (13 default color names) and `styles/TLSizeStyle.ts` (s/m/l/xl).
- [T6] `@tldraw/tlschema` `shapes/TLArrowShape.ts`: `kind` arc/elbow, `bend`, 9 arrowhead types, a single `richText` label with `labelPosition`.
- [T7] `tools/SelectTool/childStates/Brushing.ts`: wrap (fully-enclosed) selection only while Ctrl is held; the default selects touched shapes.
- [T8] `@tldraw/editor` `config/TLUserPreferences.ts` (`isSnapMode` default false) and `tools/SelectTool/childStates/Translating.ts` (snapping is active when snap mode XOR Ctrl/Cmd).
- [T9] `tools/SelectTool/childStates/Translating.ts`: Alt-drag clones.
- [T10] `ui/components/Minimap` and `NavigationPanel` (minimap collapsed by default, state kept in local storage).
- [T11] `@tldraw/editor` `editor/Editor.ts` (`stopFollowingUser` and follow handling) and `ui/components/SharePanel/DefaultPeopleMenu*.tsx`.
