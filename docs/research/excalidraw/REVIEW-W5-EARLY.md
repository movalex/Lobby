# Excalidraw build review (wave 5): synthesis, 2026-09-30

This synthesis merges five reviews of the Excalidraw build of `origin/engine/excalidraw` at `1809cf3`. Each reviewer ran it side by side with today's tldraw build of the same commit, in their own detached worktree. They used the repo's stack launcher (`e2e/tests/support/stack.ts`), with sync on `DRAFTROOM_ENGINE=excalidraw` and web on `VITE_LOBBY_ENGINE=excalidraw` with dev auth. They drove headless Chromium through real mouse, keyboard and touch input:

| Reviewer | What they did | Ports (tldraw / Excalidraw) |
|---|---|---|
| Producer | Ran the DEMO.md script end to end, plus a client review on an emulated iPhone 13 and Pixel 7 | 6600-6603 / 6610-6613 |
| Designer | Checked craft, type, colour and exports, plus a 2,070-item heavy board | 6625-6627 / 6635-6637 |
| Facilitator | Ran a retro and a brainstorm with 4 participants, a late joiner and a name-only guest on a Pixel 7 | 6650-6653 / 6660-6663 |
| Accessibility | Tested keyboard, live region, reduced motion, contrast and a 390 px phone; axe-core 4.12.1 was injected from a local copy (not installed) | 6675-6678 / 6685-6688 |
| Security seam (plan wave 5) | Attacked the seams with raw sockets and Playwright: forged elements, customData, links, cross-board files, roles and guests | 6700-6702 / 6710-6712 |

- **Identities:** creators signed in with @darkburn.com dev identities. Clients used outside emails or joined as name-only guests.
- **AI:** the AI steps used the repo's fake OpenAI.
- **Clean-up:** every reviewer reports no edits, no commits and all servers stopped.
- **Timings:** these are single runs on a shared workstation, so timings are informational only.

**How the findings were merged.** The 69 reviewer findings became 59 after deduplication. Each blocker and major was checked against `docs/research/excalidraw/WAVE-3.md` (§4 per feature, §5 parity, §6 open blockers) and against `docs/EXCALIDRAW-MIGRATION.md`.

**What was checked in the code.** The root-cause claims behind 9 findings were read in the source at `1809cf3` with `git show` (read-only). They are marked "Checked in code". Everything else rests on the reviewers' evidence. The synthesizer started no stacks and edited nothing.

**How findings are ranked.** They are sorted by severity. Within a severity they follow the owner's launch priorities: **P1** workshop tools and present mode, then **P2** the demo script and client review, then **P3** creative and mood boards, then accessibility, security and gates.

## 1. Verdict

**Not ready to replace the tldraw build**, not for the leadership demo (DEMO.md), a client review or a client workshop. It is acceptable for internal working boards.

| Reviewer | Verdict | Counts (own severities) |
|---|---|---|
| Producer | NOT READY for the demo or a real client review. Most of the script matches; it is blocked by frame membership and the AI → Present → PDF chain | 1 blocker, 7 major, 4 minor, 1 polish |
| Designer | NOT YET for creative or client-facing boards; fine for internal ones | 0 blocker, 7 major, 8 minor, 6 polish |
| Facilitator | Not ready for a client-facing workshop. Four majors share one root cause (frame membership) | 0 blocker, 5 major, 8 minor, 2 polish |
| Accessibility | Not at parity yet, but close; nothing blocks a pilot. Better than tldraw in several places | 0 blocker, 5 major, 10 minor, 3 polish |
| Security | 1 blocker (deleted-content disclosure); every other seam held | 1 blocker, 0 major, 1 minor |

**After deduplication:** 59 findings, of which 2 are blockers, 20 major, 27 minor and 10 polish.

**Against WAVE-3.md:**

| Status | Findings | Blockers + majors |
|---|---|---|
| New | 39 | 13 |
| Partly known | 8 | 4 |
| In the migration plan but missing from WAVE-3 | 6 | 4 |
| Already known | 5 | 1 |
| Shared with the tldraw build | 1 | 0 |

Neither blocker appears in WAVE-3 §6, and neither has an owner yet.

**Must land before the rehearsal (plan §7.5 step 1):**
1. **Canvas and workshops:** W5-01, then W5-04 and W5-03; W5-05.
2. **Security:** W5-02.
3. **Phone:** W5-06 and W5-07.
4. **Dashboard:** W5-09, which is a small fix.
5. **Owner decisions:** D1 to D5 in §4.
6. **WAVE-3's own cut-over blockers**, which no reviewer re-measured:
   - heavy-board performance (B9: 1.5 s p95 visibility, 4-6 fps pan);
   - B8's rollback drill (O4 is unmerged);
   - the `transact` defect.

## 2. Blockers and majors

### W5-01 · blocker · P1 · Notes made with N (or the phone Note tool) never join their frame

- **From:** PRD-X01 (blocker) and FAC-X01 (major).
- **What:**
  - N plus a click inside a frame creates a note with `frameId` null. Only double-click-to-add and the keyboard placement put a note in the frame. T and the rail's "Add a sticky note" look the same, but nobody checked them.
  - Effects:
    - a frame-scoped vote cannot accept the note, so ideas added during a retro get no votes;
    - moving the frame leaves the note behind;
    - comments say "On a note" instead of the frame's name;
    - AI grouping sees mixed membership (W5-04), and votes fall through to covered notes (W5-03).
- **tldraw today:** notes created inside a frame become its children.
- **WAVE-3:** new. §5 lists "Dot voting with frame scope" and the frames outline as ported with nothing missing.
- **Checked in code:** `apps/web/src/canvas/board/session.ts:723-744`. There, `onToolClick` calls `tx.create('note', …)` and `createFreeText` calls `tx.create('text', …)`, and neither calls `setFrame`. The double-click path does: `features/canvas-ux/ported/notes.ts:80-88` calls `frameAt(…, {unlockedOnly: true})` and then `putInFrame`.
- **Owner:** 2C, which owns `session.ts` and the rail button in `canvas/board/chrome.tsx`. It should reuse 3a's `frameAt` and `putInFrame`. 3g checks the media insert paths, and 3f and 3a add specs.
- **Fix:** in the same transaction, set the unlocked frame under the click for N, T, the phone Note tool and the rail button.
  - Add specs: N plus a click inside a frame sets `frameId`, the note moves with the frame, and a frame-scoped vote accepts it.

### W5-02 · blocker · Security · Every role receives the text and authors of deleted notes over the canvas socket

- **From:** SEAM-SEC-1.
- **What:**
  - The welcome reset snapshot and the `since` catch-up carry full tombstones: `text`, `originalText`, `customData.lobby`, and `lobbyServer.createdBy` with uid and name.
  - They reach viewers, commenters and name-only guests, for up to 14 days or 10,000 tombstones.
  - The text is hidden on the canvas but sits in `getSceneElementsIncludingDeleted()` and on the wire.
  - This bypasses the authz-001 fix: `GET /api/boards/:bid/deleted` correctly returns 403 to viewers.
  - The real risk: the agency writes internal notes, deletes them, then shares a client link.
- **tldraw today:** no deleted text reaches a viewer (probe `p1-tldraw.mjs`).
- **WAVE-3:** new, and not in §6. The plan itself **requires** full tombstones on the wire (§2.4.2 welcome row; revision 3.3's B3 decision), because the convergence hash `hash.ts` covers the live elements and the tombstones. So this is a design defect, not only an implementation bug.
- **Checked in code:**
  - `apps/sync/src/room/store.ts:227-230`: `snapshotJson` returns "every element (tombstones included)".
  - `apps/sync/src/room/element-room.ts:587-656`: `hello` sends the catch-up or the cached snapshot with no role check.
  - `snapshotFor` (line 658) caches one snapshot for all roles.
- **Owner:** O1 (room: `hello`, `snapshotFor`, catch-up, and the broadcast of a delete), with:
  - the contracts owner: `protocol.ts` welcome and snapshot, `hash.ts`, the §2.4.2 revision and a `CONTRACTS_REV` bump;
  - O2: the engine core and undo must work with reduced tombstones;
  - 2E: a negative spec.
- **Fix:**
  - Send every client tombstones reduced to the fields that prevent resurrection: `id`, `type`, `isDeleted`, `version`, `versionNonce`, `index` and the deleted clock. Keep full rows on the server for `lb_deleted` and restore.
  - Redefine `hash.ts` on the reduced tombstone so convergence checks still work.
  - Confirm two things still work: undoing your own delete (the local history holds the full element), and a create on a tombstone id, which is an undelete (§2.4.3 rule 3).
  - Add a protocol test beside `e2e/excalidraw/security-negative.spec.ts`: resets for a viewer, a commenter and a guest carry no deleted text or author.

### W5-03 · major · P1 · A frame-scoped vote counts a click for a hidden note nobody clicked

- **From:** FAC-X02.
- **What:**
  - When the top note under a click is not in the vote (for example a note made with N, W5-01), the click passes through it. It silently votes for the in-scope note hidden underneath.
  - The results rank notes nobody picked, and the badges sit on hidden notes. Every client showed the wrong "Results are in" card.
- **tldraw today:** the same retro ranked exactly the clicked notes.
- **WAVE-3:** new.
- **Checked in code:** `features/workshops/ported/voting-canvas.ts:18-28` passes the vote rule to `canvas.hitTest` as a `filter`, so the hit test skips notes the rule rejects. tldraw's `features/workshops/WorkshopOverlay.tsx:220-226` uses the same pattern; the bug stays hidden there only because notes made with N are frame children.
- **Owner:** 3f, on both pages.
- **Fix:** hit-test the top element with no filter. If the vote does not accept it, show "not part of this vote" and cast nothing. Add a spec with overlapping notes. This can land independently of W5-01.

### W5-04 · major · P1 · AI "Group into themes" pulls ideas out of the frame, so the Brainstorm slide and PDF page come out empty

- **From:** PRD-X02, FAC-X03 and FAC-X12. This is the DEMO chain 1:20 → 2:45 → 3:30.
- **What:**
  - With one note outside the frame (W5-01), the regroup guard ("These notes are already grouped") is skipped.
  - The clusters land below the frame, and the notes that were inside it lose their frame. The frame does not grow and the camera does not follow.
  - Present and the PDF then show the Brainstorm frame with no ideas. The theme labels are 36 units off one line. Ctrl+Z restores everything.
- **tldraw today:** the guard appears, then the notes are grouped inside the frame. The toast says "The frame grew to fit".
- **WAVE-3:** new. §4.8 and §5 list only R9 / CR-3H-2.
- **Checked in code:** `features/ai/ported/apply.ts` (about lines 320-322) keeps the frame only when every note shares it; otherwise it uses the page. The transaction (about line 407) then calls `tx.setFrame(outside, space.frame?.id ?? null)`, which sets `frameId` null on the notes that were in the frame.
- **Owner:** 3h (`apply.ts`, and the `groups` lookup in `target.ts`).
- **Fix:**
  - Use the frame most notes are in, or the frame under the selection's centre. Never take notes out of their frame, and grow the frame to fit.
  - Make `target.ts` find existing groups when frame membership is mixed, and line the labels up on one baseline.
  - Add an e2e test in DEMO order: add a note with N, group, then check that the frame grew and the ideas are on the Brainstorm slide and PDF page 2.

### W5-05 · major · P1 · Moving a template frame leaves its locked heading behind and saves the split

- **From:** PRD-X04 and FAC-X04. Every workshop template arrives with locked headings (RETRO-16).
- **What:**
  - Dragging the frame shows the toast "Change not saved — that object is locked" and the pill "Change not saved".
  - The frame and its unlocked children move; the locked heading and instructions stay.
  - The server keeps the split. After a reload, other people see the heading outside the frame, which can now overlap its neighbours.
- **tldraw today:** the whole frame moves and the pill stays on Saved.
- **WAVE-3:** new. It is neither the §4.1 deviation ("locking a frame locks its contents") nor CR-2D-1's lock scope, which is resolved.
- **Checked in code:** `apps/sync/src/room/merge.ts`, step 5 (about lines 407-433). For a locked element only `z` and the lock toggle survive. Every other group is denied with `LOCKED`, including a translation that matches its frame's move in the same push.
- **Owner:** O1 (the lock rule in `merge.ts`), with the contracts owner (the lock rule in §3.5 and the canvas-schema invariants). 3a owns the client-side handling.
- **Fix:** do one of the following, and never save half a move:
  - on the server, accept a position-only change on a locked child when its frame moves by the same delta in the same push, with protocol tests;
  - or have the client refuse such a move before sending anything.

  Then add a spec that moves each tour and template frame and expects Saved.

### W5-06 · major · P1 · Phone: Zoom to fit covers the Select tool, and the Board menu hides under the panels button

- **From:** FAC-X05, A11Y-X04 and part of PRD-X12.
- **What:**
  - At 390-412 px, `navigation.zoom-to-fit` sits over `tools.select`. Tapping Select zooms to fit instead, so a participant who picked Hand is stuck; the only way back is ≡ Board actions → Select.
  - `main-menu.button` sits under `dock-rail-toggle`, with only a 6 px strip showing. So Board, Edit, Export, Preferences and Keyboard shortcuts are unreachable on a phone, for owners and clients alike.
- **tldraw today:** every tool can be tapped, and the page menu sits beside the panels button.
- **WAVE-3:** partly known. §6 gives 3a "a phone toolbar like tldraw's"; the overlaps are new.
- **Owner:** 3i (phone flows), with 3b (the zoom-to-fit button), 3a (board menu and toolbar) and 2C (the rail toggle).
- **Fix:** move Zoom to fit into the toolbar or the phone sheet, and move the board menu clear of the rail toggle (or put its entries in the Board actions sheet). Add a phone spec: `elementFromPoint` at each control's centre returns that control.

### W5-07 · major · P1/P2 · Phone: the floating ≡ Board actions button and the tool dock cover the reply box and the workshop cards

- **From:** PRD-X05 (major) and FAC-X06 (minor).
- **What:**
  - Both float above the comment sheet and cover part of the New comment / Reply box and the Post row.
  - Tapping the right side of the Reply box opens Board actions instead of the text box.
  - The ≡ button also covers the private-brainstorm prompt, the vote bar's Details and the "Results are in" card.
  - On desktop, the bottom toolbar covers the thread popover's "@ to mention" hint.
- **tldraw today:** the comment sheet covers the canvas tools, and the whole text box can be tapped.
- **WAVE-3:** new.
- **Owner:** 3i (phone sheet), with 3c (comment sheet stacking) and 3f (workshop cards).
- **Fix:** on phones, hide the dock and ≡ while a comment sheet or a workshop card is showing, or stack those above the chrome. On desktop, place the popover above the toolbar. Add a phone spec with `elementFromPoint` across the reply box and each card's buttons.

### W5-08 · major · P2 (DEMO 1:00) · Connectors detach on the other person's screen during a drag

- **From:** PRD-X03.
- **What:** B sees the Story box move, but the connector from the question stays where it was until A releases (checked after 1.5 s of holding).
- **tldraw today:** the connector follows the box on every frame.
- **WAVE-3:** plan only.
  - §2.7 states that "arrows bound to dragged elements catch up at commit", and Appendix B 2 asks the owner to accept "the live-ness change".
  - WAVE-3 §5 ("Two people on a board") does not mention it.
  - DEMO.md 1:00 promises the opposite.
- **Owner:** owner decision D1. If it is fixed: O2 / O5 (`canvas/overrides.ts`, `canvas/presence/hub.ts`), plus DEMO.md.
- **Fix:**
  - Either re-route bound arrows from the drag offsets in the render override (drawing only, never written), with a two-browser spec on the arrow's end point mid-drag;
  - or accept the loss and change DEMO.md 1:00 before any demo on this build.

### W5-09 · major · P2 (DEMO 4:45) · The dashboard sidebar turns upside down after you visit a board

- **From:** PRD-X06.
- **What:** after opening a board, the sidebar reads Trash, Archived, All boards, Recent.
- **WAVE-3:** new. The §3 engine-marker check looks for engine markers in the normal build, not for class names shared by both builds.
- **Checked in code:** `apps/web/src/features/canvas-ux/ported/navigation/navigation.css:4` sets `.dr-nav { flex-direction: column-reverse; gap: 6px }`, which overrides the dashboard's `.dr-nav` in `apps/web/src/styles.css:1328`. `.dr-nav--compact` and `.dr-nav__*` collide the same way.
- **Owner:** 3b, plus the wave 4 integration for the build check.
- **Fix:** rename the classes to `dr-cnav*`, or scope them under `[data-lobby-board-canvas]`. Add a build check for selectors defined in both the shared and the ported CSS. This is a small fix.

### W5-10 · major · every board · Frame names fail contrast (2.65:1), and frames barely stand out

- **From:** A11Y-X05 (major), XD-14 (minor) and part of PRD-X13.
- **What:** frame names are #9f9f9f on white (2.65:1; 3.84:1 in dark mode). The outline is light grey, and the canvas is pure white like the frame fill.
- **tldraw today:** names are black at 20.1:1, on an off-white #f9fafb canvas.
- **WAVE-3:** new. 3i's palette-contrast test covers the note palette only.
- **Owner:** 2C (the engine theme in the host), with 3i (`palette-contrast.test.ts`).
- **Fix:** use an ink token for names (#1b2330 light, #ebe8e1 dark), an outline of at least 3:1, and a #f9fafb canvas, and add all of these to the tests.

### W5-11 · major · P3 · A connector you draw runs centre to centre through both shapes

- **From:** XD-01.
- **What:** drawing with L from inside shape A to inside shape B uses Excalidraw 0.18's fixed-point binding. The line crosses both interiors, the head sits in the middle of B, and exports look the same.
- **tldraw today:** the arrow is clipped to both outlines.
- **WAVE-3:** new.
- **Owner:** 3a (the connector tool), with O2 if the binding mode is set in the engine host.
- **Fix:** on pointer-up, and for pasted arrows, turn fixed-point bindings into outline bindings. Add an e2e check that the drawn end points lie on the shapes' boundaries.

### W5-12 · major · P3 · Phone photos with EXIF rotation are squashed

- **From:** XD-02.
- **What:** `image-exif6.jpg` lands as a 360×203 landscape box with the rotated pixels squeezed into it. The distortion carries into PNG export.
- **tldraw today:** the same file lands as 203×360 portrait.
- **WAVE-3:** new.
- **Owner:** 3g.
- **Fix:** size images from their oriented dimensions (`createImageBitmap` with `imageOrientation: 'from-image'`, or the worker's derivative size), in the drop layout and slot fit as well. Add the exif6 fixture to the ported media-files spec.

### W5-13 · major · P3/P2 · Images have no Replace media, Crop or Alternative text

- **From:** PRD-X08.
- **What:** the selection bar offers Comment, Copy link, Lock, Tags, AI and Download original. Replace media is the client-review loop: key art v1 becomes v2 and keeps its thread, position and slot.
- **WAVE-3:** new. It is not in §4.7 or the §5 parity table.
- **Owner:** 3g (Replace first, then crop in `customData`, then alt text), with 3a for the menu entries.

### W5-14 · major · P3/P2 · PNG exports drop the file-card faces

- **From:** XD-07.
- **What:** in a whole-board PNG:
  - the PDF card exports as a bare cover, with no name, size, page count or "View pages";
  - the video card exports as a bare poster, with no play button, name or duration;
  - zip, encrypted PDF and DOCX files become grey tiles with a generic icon.
- **tldraw today:** every card is drawn in full.
- **WAVE-3:** partly known. §4.7 notes "the engine's placeholder for cards without a preview (2C's loader)". Cards that have a preview losing their name and details is new, and plan §2.10.4's client-drawn card face (icon, name, size) was not built.
- **Owner:** 3e, with 3g and 2C (the loader).
- **Fix:** draw the card face into the export through `ExportOptions.files` or a render override; at minimum the name and a type badge. Add a check to `present-export-files`.

### W5-15 · major · P3 · Dark mode changes the brand colours and the notes

- **From:** XD-03 and A11Y-X07.
- **What:** Excalidraw inverts colours in dark mode with an invert and hue-rotate filter:
  - Ember #f1ac4b becomes #874c00, Signal red becomes #ff8383, and Dusk becomes #de7ef6;
  - note fills turn muddy;
  - the Coral note's ink is 3.55:1.
- **tldraw today:** designed dark variants.
- **WAVE-3:** partly known. §4.9 records the red note at 3.43:1; the swatch recolouring is new.
- **Owner:** 2C (host theme and rendering), with 3i and the palette owners.
- **Fix:** map Lobby's palettes to hand-picked dark variants and draw any other explicit colour unchanged. Make the palette-contrast test go through the dark path and require 4.5:1.

### W5-16 · major · P3 · No bold anywhere, so template hierarchy is flat

- **From:** XD-04 (major) and PRD-X13 (polish).
- **What:** only Nunito 400 loads, and Excalidraw text has no weight. So headings, theme names, retro headers and the Tips keys all read like body text.
- **tldraw today:** IBM Plex Sans in semibold and bold.
- **WAVE-3:** plan only. Appendix B 2 lists "rich-text formatting" as a loss for the owner to accept; WAVE-3 does not list it.
- **Owner:** owner decision D3. Then:
  - 2C: rendering and font loading;
  - 3e: SVG, PNG and PDF;
  - 2D: templates;
  - 3a: style panel;
  - O1 and contracts: the server's font rules, and the metrics table if a new face is added (§2.11, §2.12).
- **Fix:** either self-host Nunito 600/700 with a `customData.lobby.weight` style, or at least give template headings their own larger, darker text elements.

### W5-17 · major · P3 · No serif, and the mono face is a comic-style one, so the mood board's type specimen says "hand-drawn"

- **From:** XD-05 (major) and PRD-X13 (polish).
- **WAVE-3:** known, and awaiting an owner decision:
  - §4.1 lists "no serif font" as a deviation;
  - PROGRESS (2D) calls the tour's serif sample the one deliberate difference;
  - plan §2.12 limits fonts to families 5, 6 and 8, and Comic Shanns is 8;
  - Appendix B 1 asks the owner to accept "no serif".
- **Owner:** owner decision D3. Then 2C (register the fonts), O1 with contracts (the font allowlist and the metrics table), 3a (Serif in the style panel), 3e (embedding in exports) and 2D (restore "Display · serif").
- **Severity:** kept at the designer's major, because the type specimen is the point of a client-facing mood board.

### W5-18 · major · P3 · No embeds: a pasted YouTube link becomes plain text

- **From:** PRD-X07.
- **WAVE-3:** plan only. §2.10.4 says "No embeddables" (the server refuses embeddables), and Appendix B 2 lists "live embeds" as a loss awaiting acceptance. WAVE-3 §5 is missing it, so leadership would discover it as a regression.
- **Owner:** owner decision D2. Then 3g: a link card drawn as a Lobby overlay, the way file cards are, with no third-party script on the board.

### W5-19 · major · P3 · Zooming out from zoom-to-fit on a large board zooms in

- **From:** XD-06.
- **What:**
  - Zoom to fit goes to 6.9%, below Excalidraw's 0.1 floor. One Ctrl+wheel notch out then jumps in to 10%.
  - One notch in jumps from 6.9% to 16.9%.
  - Ctrl+- does nothing.
- **tldraw today:** zoom changes smoothly both ways, and Ctrl+- reaches 5%.
- **WAVE-3:** partly known. CR 3b-2 (wheel and pinch stop at 0.1) is in §4.2 and §6. The wrong-direction jump and the dead Ctrl+- are new.
- **Owner:** 3b, with 2C (CR 3b-2's wheel and pinch deltas).
- **Fix:** send wheel, pinch and the zoom keys through Lobby's camera below 0.1. Clamp the minimum zoom to min(0.1, the fit zoom), step in proportion, and never zoom in on an out gesture.

### W5-20 · major · A11y · After placing with the keyboard and pressing Esc, the tool stays armed, so the next Enter makes a blank note

- **From:** A11Y-X01.
- **What:** press N, Enter, type, then Esc: the Note tool is still active. The next Enter creates a new empty note instead of editing the selected one. T and R behave the same, so keyboard users leave blank notes on shared boards, and nothing is announced.
- **tldraw today:** the tool returns to Select, and Enter re-edits the note.
- **WAVE-3:** new. After N plus a click, `session.ts:731` switches back to Select; the keyboard path (`features/canvas-ux/ported/place.ts`) selects the new shape but does not reset the tool.
- **Owner:** 3a (`place.ts`, `keys.ts`).
- **Fix:** switch back to Select after a keyboard placement, make Enter with a selection edit it, remove a note left empty, and announce the result.

### W5-21 · major · A11y · prefers-reduced-motion is ignored for every camera move

- **From:** A11Y-X02.
- **What:** with reduced motion on, Ctrl+=, Ctrl+-, zoom to fit, Go to frame and Alt+Arrow all still animate (16-21 camera positions each). Alt+Arrow also changes the zoom. Only present mode honours the setting.
- **WAVE-3:** new.
- **Owner:** 3b (zoom and the frames panel) and 3i (`traversal.ts`).
- **Fix:** use duration 0 under reduce, and keep the zoom when bringing an item into view unless it does not fit.

### W5-22 · major · A11y · The toolbar's More popover can't be used from the keyboard

- **From:** A11Y-X03.
- **What:**
  - Enter opens the popover but focus stays on More, and Esc does not close it.
  - The popover comes before the toolbar in DOM order, and it stays open, later covering the vote bar's "I'm done" and "Details".
  - Diamond, Line and Lasso have no shortcut key, so keyboard users cannot reach them.
- **WAVE-3:** new.
- **Owner:** 3a.
- **Fix:**
  - On open, move focus to the first item, with arrow keys inside the popover.
  - Esc closes it and returns focus to More.
  - Render it right after the button in DOM order, with `aria-haspopup`, `aria-controls` and `aria-expanded`.
  - Close it when a tool is picked or the canvas is clicked.

## 3. Minor and polish

**Minor**

| ID | Pri | Finding | From | WAVE-3 | Owner | Fix |
|---|---|---|---|---|---|---|
| W5-23 | P1 | A follower who stayed on after Gather loses the Stop following control when the "is presenting" banner arrives, although they are still following | FAC-X08 | New (a new case of the gap `07e6a77` fixed) | 3c | Keep Stop following visible under the banner, or turn the gather follow into the presentation follow on Join |
| W5-24 | P1 | In present mode, slides show the frame's grey rounded outline | XD-14, PRD-X13 | New | 3e | Hide the frame outline while presenting, and in frame exports |
| W5-25 | P1 | Gather: a phone lands at 14% zoom; with the leader's side panel open, desktop followers sit about 420 units off the leader's centre | FAC-X07 | Partly known: R2-04 / CR-3F-3 (2 `test.fail`); the desktop off-centre is new | 2C (the CR-3F-3 hook), 3c | Centre followers on the leader's view centre, with a readable minimum zoom on narrow screens |
| W5-26 | P1 | Ctrl+Z by the giver removes a +1 for everyone | FAC-X10 | Known: CR-3F-1 | 2C, 3f | Land CR-3F-1 (a transaction that skips undo) |
| W5-27 | P1 | No note authors on notes; "Hide note authors" hides nothing | PRD-X10, FAC-X13 | Known: CR-3F-4 | 2C, 3f | Land CR-3F-4, or hide the setting until it works |
| W5-28 | P1 | Other people's selections are not drawn, although presence carries them | PRD-X10, XD-13, FAC-X11 | Plan only: §2.7 and §4.3 plan outlines through `updateScene({collaborators})`; not built | 2C (`board/peers.ts`) | Feed peers' `sel` into `collaborators[].selectedElementIds`; honour Hide cursors and the server dropping selections during a vote; add a presence spec |
| W5-29 | P1 | A name-only guest's new tag says 'Created "#fans"', then is undone with "Change not saved" | FAC-X09 | Partly known: CR-3D-5; the contradictory feedback is new | 3d; O1 for CR-3D-5 | Hide or explain Create for guests; never say "Created" before the server accepts it |
| W5-30 | P2 | The PDF text layer splits wrapped words ("Stor/y", "Brie/f", "Deliver/y"), so search fails, although the dialog and DEMO 3:30 promise searchable text | PRD-X09, XD-09 | New | 3e | Build the layer from the element's wrapped lines; add a word check to `present-export-files` |
| W5-31 | P2 | Phone at 390 px: Share half off screen; the "people 3" chip; the title cut short; 24×38 px tools; guests get only Select and Comment | PRD-X12, A11Y-X04 | Partly known: CR-3A-6 (no Hand for read-only roles) | 3i, 3a | Top-bar fit rules, no people chip on phones, fewer 48 px tools plus an overflow, Hand for read-only roles |
| W5-32 | P2 | No edge marker points to collaborators off screen | PRD-X10 | New | 2C (presence overlay) | Edge indicators for off-screen cursors |
| W5-33 | P2 | Menus and shapes thinner than today (see below this table) | PRD-X11 | Partly known: 3a deviation (no Paste); CR-3A-6 (highlighter); Appendix B 2 planned extra shapes as polygons | 3a, 3b | See below this table |
| W5-34 | Gates | The Excalidraw heavy seed's 60 images never load (no `customData.lobby.file`), so Excalidraw heavy-board numbers are measured with no images drawn | XD-21 | New; affects the B9 / §8.5 numbers WAVE-3 cites | 2E (`e2e/perf/seed.ts`, `e2e/load/boards.ts:184-201`) | Write `customData.lobby.file` as a real drop does, then re-measure B9 and pan |
| W5-35 | Security | The 500-item guest cap is counted per socket session; a new tab resets it (800 items from one guest) | SEAM-SEC-2 | Plan: §3.5 says per session; not a regression (tldraw has no guest cap) | O1; decision D5 | Count per uid or per redeemed link for the room's life, or document the scope |
| W5-36 | P3 | File-card bitmaps show past the overlay's rounded corners; in dark mode the card bodies stay beige, with low-contrast error text | XD-08 | New | 3g | Clip the bitmap to the corner radius; theme the placeholder and the overlay |
| W5-37 | P3 | Notes have a hard grey offset "shadow" and a 1 px outline, in exports too | XD-10 | New | 2C (note rendering), 3e | Blurred shadow, no outline, 2 px radius; `feDropShadow` in SVG |
| W5-38 | P3 | Four accent colours at once; no hover outline; a selected frame's box crosses its name | XD-11 | New | 2C (host CSS), 3a | One Lobby accent token, tighter selection padding, a hover outline |
| W5-39 | P3 | An arrow selected by code (a `?el=` link) shows no outline or handles | XD-12 | New | 3b, 2C | Set `selectedLinearElement`, or draw a highlight |
| W5-40 | P3 | Style panel about 35% taller; font buttons are plain words; native selects for arrowheads; arrows default to Curved; unlabelled opacity slider | XD-15 | New | 3a | Font buttons drawn in their own font, icon pickers, a labelled slider |
| W5-41 | A11y | In dark mode the style panel's "Note color" legend is 1.03:1 | A11Y-X06 | New | 3a | Use the muted-text token |
| W5-42 | A11y | A full Tab cycle is 44 stops (32 today): every tool and 27 style options are stops, and the selection bar comes last | A11Y-X08 | New | 3a | Roving tabindex, one stop per style group |
| W5-43 | A11y | The live region says nothing on a tool change or when an edit ends | A11Y-X09 | New | 3i | Polite tool announcements; re-announce the selection when an edit ends |
| W5-44 | A11y | Mind map: Esc after typing selects nothing, so arrow navigation stops working | A11Y-X10 | New | 3d | Select the topic whose edit ended |
| W5-45 | A11y | The board container takes Tab focus with no visible indicator (WCAG 2.4.7) | A11Y-X11 | New | 2C, 3i | A focus ring, or select the first item |
| W5-46 | A11y | At 200% page zoom the style panel stays open over half the canvas, and the zoom control sits over Select | A11Y-X12 | New | 3a, 3b | Fold the style panel below about 800×500 |
| W5-47 | A11y / P1 | Leaving present mode or the AI summary puts focus on the canvas, not the opener; the present overlay has no focus ring | A11Y-X13 | New | 3e, 3h | Restore focus to the opener |
| W5-48 | A11y | Confirmed known gaps: Ctrl+X doesn't cut; Ctrl+Z from the chrome doesn't undo | A11Y-X15 | Known (3i `test.fail`) | spike B input, 3a | As tracked |
| W5-49 | Both builds | Dark-mode "+1" pill is 1.03:1; comment-pin initials are 3.73:1 | A11Y-X14 | Shared with tldraw, so it belongs in BACKLOG | 3f, 3c | Token pair for the pill; pick the initials colour by contrast |

**W5-33 in detail:**
- **Board menu:** no View submenu. WAVE-3 §4.1 claims one, but `MainMenu.tsx:66` builds it only from "view" entries, and the page registers none.
- **Missing commands:** no Insert file or Insert embed, and no Paste in Edit or the context menu.
- **Preferences:** Accessibility, Input device and Theme are gone.
- **Desktop canvas:** no undo, redo, delete or duplicate buttons.
- **Toolbar More:** 5 shapes instead of 13, and no Highlight.
- **Fix:** put the zoom entries under View; add Paste; add undo and redo buttons (the tour tells people to press Ctrl+Z); decide on the shapes (D4).

**Polish**

| ID | Pri | Finding | From | WAVE-3 | Owner | Fix |
|---|---|---|---|---|---|---|
| W5-50 | P1 | Chrome order moved: Timer and Reactions now sit by Share, and Voting and Private notes are lower in the rail. Tool labels lost their key hints. The phone overflow shows an empty "On this board" heading | FAC-X14, A11Y-X18 | New | 2C, 3a, 3i | Keep the order DEMO and facilitators know; restore the hints and `aria-keyshortcuts` |
| W5-51 | P1 | At about 14% zoom, frame names overlap the frame above; the Stop following pill has a double border | FAC-X15 | New | 2C, 3c | Clip names that don't fit; one flat button |
| W5-52 | P3 | New rectangles get large rounded corners (templates are sharp), and default strokes are thinner | XD-16 | New | 2C (the host's initial data) | `currentItemRoundness: 'sharp'` |
| W5-53 | P3 | Arrowheads are about twice today's size; the last dash runs into the head; bound connectors stop 4-6 px short | XD-17 | New | 3a, 2C | Scale heads to the stroke; smaller binding gap |
| W5-54 | P3 | No "Back to content" button in empty space | XD-18 | New | 3b | An overlay button that calls `viewport.fit()` |
| W5-55 | P3 | A note being typed into has no editing outline | XD-19 | New | 2C | Outline the note while it is being edited |
| W5-56 | P3 | During a 40-image upload the "Processing…" text is unreadable, for about 11 s | XD-20 | Known: §4.7 "no local preview while uploading" | 3g | A local preview in this tab only, never stored |
| W5-57 | A11y | An empty `contentinfo` footer sits inside `main`, so axe fails in every state; the region and the application share a name | A11Y-X16 | New | 2C | Remove the footer's role; rename the region |
| W5-58 | A11y | Opening a template board announces "6 shapes selected" when nothing is selected | A11Y-X17 | New | 3b, 3i | Mute announcements during the insert |
| W5-59 | A11y | The note editor has no name; the Tips frame still says "main menu" and lists no navigation keys; a frame's subtitle is read before its title | A11Y-X18 | Mostly shared with tldraw | 3a, 2D, 3i | Label the editor, update the Tips frame, fix the reading order |

## 4. Owner decisions

These come from Appendix B of the migration plan. Each is needed before a fix can be scheduled.

- **D1 · Connectors during a remote drag (W5-08).**
  - Option A: accept Appendix B 2's "live-ness change" for bound arrows and rewrite DEMO.md 1:00.
  - Option B: fund a drawing-only re-route in the drag preview (O2 / O5).
  - The synthesizer recommends option B. It is the first thing leadership sees two people do together.
- **D2 · Embeds (W5-18).** Appendix B 2's "live embeds" loss. Options: plain links; a link card drawn as a Lobby overlay (3g); or a click-to-play overlay for allow-listed hosts.
- **D3 · Serif, mono and bold (W5-16, W5-17).** Appendix B 1/2. Adding faces touches several places:
  - the server's font allowlist (§2.12, §3.5);
  - the text-metrics table for server-made text (§2.11, an A3 re-calibration);
  - SVG font embedding (§2.10.4).
- **D4 · Extra geo shapes (W5-33).** The plan said "extra geo shapes as polygons", but the build dropped them. Decide: build the polygons, or remove the shapes from the templates' vocabulary.
- **D5 · Guest cap scope (W5-35).** Count per uid or per redeemed link, or document the per-session scope.
- **Not optional (W5-02).** The lead has to revise §2.4.2 and `hash.ts`, because tombstones may no longer carry content.

## 5. Corrections for WAVE-3.md and DEMO.md

These are for their owners to apply; this review changed nothing.

1. **§5 rows marked "ported" with nothing missing** that the review contradicts:

   | §5 row | Contradicted by |
   |---|---|
   | Dot voting with frame scope | W5-01, W5-03 |
   | AI | W5-04 |
   | Template picker and the Lobby tour | W5-05 |
   | Two people on a board | W5-08 |
   | Export | W5-14, W5-30 |
   | Files | W5-12, W5-13 |
   | Phone layout | W5-06, W5-07 |
   | Accessibility | W5-20 to W5-22 |
   | Server-enforced roles | W5-02 |

2. **§4.1** claims "Board ▸ Edit ▸ View ▸ …", but the View submenu does not appear (W5-33).
3. **Rows missing from §5:**
   - embeds;
   - Replace media, crop and alt text;
   - remote selection outlines;
   - fonts (serif, mono, bold);
   - dark-mode colour mapping;
   - the note look;
   - reduced motion.
4. **§6 changes:**
   - Add W5-01 (2C) and W5-02 (O1 with contracts) as **B**.
   - Add W5-05 to O1.
   - Note W5-34 against the B9 heavy-board numbers. The designer's pan rate on a 2,070-item board (tldraw 56.5 fps, Excalidraw 54.2 fps) was one headless run with no images drawn, so it does not clear B9.
5. **DEMO.md** is false on this build in three places until they are fixed:
   - 1:00, the connector following the drag (W5-08);
   - the chain 1:20 → 2:45 → 3:30 (W5-04);
   - 3:30's "searchable text layer" (W5-30).

## 6. What held, and what is better

**Matched today's build:**
- **Demo steps:**
  - project lobby, Lobby tour, Share, and the workshop and client links;
  - live typing, comments, mentions and the bell;
  - mood-board slot drop, Ctrl+U, the PDF card and viewer;
  - frame-scoped voting on notes that are frame members, and its reveal;
  - Present, Invite everyone, "N following" and End;
  - checkpoint, delete and restore from Recently deleted;
  - revoking a guest link (283 ms against tldraw's 298 ms).
- **Workshop tools:** timer in step, private brainstorm with reveal, reactions and raise hand, Hide cursors, mind-map keyboard building, tag filter.
- **Shared chrome and keyboard:** dock panels, dialogs, context menu, the AI summary, keyboard voting, focus rings, and present-mode keys.

**Better than today's build:**
- PDF export takes 1.0 s against 6.1 s.
- Queued offline changes survive a reload.
- The tour SVG is 187 KB against 1.07 MB.
- No text halo, so BACKLOG F2-07 goes away.
- Traversal announces frame context.
- The frame-rename field has a name.
- Lease conflicts are announced.
- The phone private-notes close button is visible.
- Fonts are self-hosted.

**Security seams that held:**
- Forged `lobbyServer` or identity fields and `privateNote` are replaced or dropped.
- Read-only roles are refused on writes and leases.
- Links using `javascript:`, `data:`, a username:password address or signed URLs are refused.
- Cross-board and cross-workspace fileIds come back unavailable.
- The export policy holds (403 on originals while media loads still get 200).
- Domain access holds (CREATOR_REQUIRED).
- Internal and test routes need the secret, and dev auth and test hooks are refused in production.
- The engine page is gated behind the dev-auth flag.

## 7. Not covered by any reviewer

- heavy-board performance gates (B9, §8.5) with images drawn;
- reconnect after a sync restart on this build;
- conversion of real boards and the rollback drill (B8, O4 unmerged);
- backups (off on this stack);
- tablet;
- Firefox and Safari;
- real screen readers;
- the vote CSV and sounds;
- SVG export of file cards;
- a name-only guest's join in the accessibility pass;
- a real WAN.

## 8. Evidence, by owner, and clean-up

**Evidence** (each worktree is detached at `1809cf3` with no tracked changes):
- `C:/Users/Chase/Documents/GitHub/Draftroom-review-producer/.review/`: `shots/*-dT|cT|gT` for tldraw and `*-dX|cX|gX` for Excalidraw, plus the PDFs and CSVs in `downloads/`.
- `C:/Users/Chase/Documents/GitHub/Draftroom-review-designer/.review/`: `shots/`, `exports/`, `crops/` and the scripts `*.mjs` and `08-heavy.ts`. The builds in `apps/web/dist/rv-*` are gitignored.
- `C:/Users/Chase/Documents/GitHub/Draftroom-review-facilitator/.review/`: `tl-*` and `ex-*` shots. The untracked scripts are in `e2e/.review-fac/`.
- `C:/Users/Chase/Documents/GitHub/Draftroom-review-a11y/.review/`: `shots/engine-NN-*.png` and the scripts `launch.mts`, `lib.mjs` and `repl.mjs`.
- `C:/Users/Chase/Documents/GitHub/Draftroom-review-security/.review/`: probes `p1` to `p9` and `shots/`.

**Findings by owner** (IDs in parentheses are supporting roles):

| Owner | Findings |
|---|---|
| 2C | W5-01, 10, 15, 25, 26, 27, 28, 32, 37, 38, 45, 50, 51, 52, 55, 57 (and 06, 14, 16, 17, 19) |
| O1 | W5-02, 05, 35 (and 17, 29) |
| Contracts owner | W5-02, 05 |
| O2 / O5 | W5-02 (client), 08 (if funded), 11 (binding mode) |
| 2D | W5-16, 17, 59 |
| 2E | W5-02 (spec), 34 |
| 3a | W5-11, 20, 22, 33, 40, 41, 42, 46, 53 (and 06, 31) |
| 3b | W5-09, 19, 21, 39, 54, 58 (and 06) |
| 3c | W5-23 (and 07, 25, 49, 51) |
| 3d | W5-29, 44 |
| 3e | W5-14, 24, 30, 47 (and 16, 37) |
| 3f | W5-03 (and 07, 26, 27, 49) |
| 3g | W5-12, 13, 18, 36, 56 (and 14) |
| 3h | W5-04 (and 47) |
| 3i | W5-06, 07, 31, 43 (and 10, 15, 21, 45, 58, 59) |
| Wave 4 integration | the CSS-collision check (W5-09) |
| Docs | DEMO.md, WAVE-3.md (§5 of this report) |

**Clean-up.** Five review worktrees are still registered. Remove them with `git worktree remove` once the evidence is no longer needed.
## 9. Decisions (2026-09-30)

**Owner decisions:**
- Accepted losses (Appendix B 2): plain text only (no bold, italic or lists); pages flattened; video and GIFs as a poster plus a player; resizes, rotations and strokes appear to others at the end of the gesture (moves still preview live).
- The look is fine as it is (Appendix B 1).
- The AGENTS.md rewrite is applied at cut-over (Appendix B 12).

**Lead decisions** (the owner asked not to be stopped for details):
- **D1 · Fix W5-08.** Bound connectors follow a remote drag live, through a drawing-only re-route in the drag preview. Nothing extra is saved. Owner: 2C.
- **D2 · Link cards.** A pasted URL becomes a link card: page title, site icon, opens in a new tab. It is drawn as a Lobby overlay the way file cards are, and no third-party script runs on the board. Owner: 3g (the metadata fetch goes through the api, with SSRF protection).
- **D3 · No new fonts, no bold.**
  - Templates get their hierarchy from size and colour, plus Excalidraw's Lilita One display face (fontFamily 7) for headings. The server's font allowlist gains 7, and the text-metrics table gets its metrics. Owners: contracts and 2A for the allowlist, 2D for the templates.
  - The mood-board type specimen stops presenting Comic Shanns as "mono".
- **D4 · Polygons.** The extra geo shapes are built as polygons, as the plan says, and not removed from the templates. Owners: 2B (the converter mapping) and 3a (the tools).
- **D5 · Guest cap per uid.** The guest cap is counted per guest uid. Owner: 2A.
