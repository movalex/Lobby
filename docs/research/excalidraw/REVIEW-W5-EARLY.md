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

- **Status (wave 5):** waiting on 2C. Fixed on `engine/w5-2c` (`da7da3d`), not merged here. 3f's `workshops-voting` "W5-01" is a `test.fail` for it; 3g checked the media paths (drops, Ctrl+U, Place on board and link cards already join the frame); 3h's grouping works either way.
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

- **Status (wave 5):** waiting on 2A. Redacted tombstones on `engine/w5-2a` (`c96cc5f`, `CONTRACTS_REV` 7 and 8) with 2C's consumer side on `engine/w5-2c`; not merged here.
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

- **Status (wave 5):** fixed. 3f, both pages: `workshops-voting` W5-03, `e2e/tests/workshops.spec.ts`.
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

- **Status (wave 5):** fixed. 3h: `ai-actions` "DEMO 1:00 → 1:20 → 2:45 → 3:30 (W5-04)".
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

- **Status (wave 5):** client half fixed; waiting on 2A. 3a: the frame's push already carries its locked heading's move. The room's lock rule is 2A's (on `engine/w5-2a`, not merged): `canvas-ux-review` W5-05 and `templates-frames` W5-05 are `test.fail`.
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

- **Status (wave 5):** fixed. Already at wave 3b (the review ran on 1809cf3); pinned since wave 5 by `canvas-ux-review` W5-31 / W5-06, `navigation-keys` PRI-13 and `a11y-phone-reach`.
- **From:** FAC-X05, A11Y-X04 and part of PRD-X12.
- **What:**
  - At 390-412 px, `navigation.zoom-to-fit` sits over `tools.select`. Tapping Select zooms to fit instead, so a participant who picked Hand is stuck; the only way back is ≡ Board actions → Select.
  - `main-menu.button` sits under `dock-rail-toggle`, with only a 6 px strip showing. So Board, Edit, Export, Preferences and Keyboard shortcuts are unreachable on a phone, for owners and clients alike.
- **tldraw today:** every tool can be tapped, and the page menu sits beside the panels button.
- **WAVE-3:** partly known. §6 gives 3a "a phone toolbar like tldraw's"; the overlaps are new.
- **Owner:** 3i (phone flows), with 3b (the zoom-to-fit button), 3a (board menu and toolbar) and 2C (the rail toggle).
- **Fix:** move Zoom to fit into the toolbar or the phone sheet, and move the board menu clear of the rail toggle (or put its entries in the Board actions sheet). Add a phone spec: `elementFromPoint` at each control's centre returns that control.

### W5-07 · major · P1/P2 · Phone: the floating ≡ Board actions button and the tool dock cover the reply box and the workshop cards

- **Status (wave 5):** fixed. 3c (the comment sheets above the chrome), 3i (Board actions steps aside), 3f (the workshop cards clear of it): `comments-stacking`, `a11y-phone-reach` W5-07, `workshops-phone`.
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

- **Status (wave 5):** waiting on 2C. D1's drawing-only re-route is on `engine/w5-2c` (`594cc4d`), not merged here; DEMO 1:00 is not true on this branch yet.
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

- **Status (wave 5):** fixed. 3b: `dr-cnav*`, `navigation/css-scope.test.ts` (the build check), `navigation-keys` W5-09.
- **From:** PRD-X06.
- **What:** after opening a board, the sidebar reads Trash, Archived, All boards, Recent.
- **WAVE-3:** new. The §3 engine-marker check looks for engine markers in the normal build, not for class names shared by both builds.
- **Checked in code:** `apps/web/src/features/canvas-ux/ported/navigation/navigation.css:4` sets `.dr-nav { flex-direction: column-reverse; gap: 6px }`, which overrides the dashboard's `.dr-nav` in `apps/web/src/styles.css:1328`. `.dr-nav--compact` and `.dr-nav__*` collide the same way.
- **Owner:** 3b, plus the wave 4 integration for the build check.
- **Fix:** rename the classes to `dr-cnav*`, or scope them under `[data-lobby-board-canvas]`. Add a build check for selectors defined in both the shared and the ported CSS. This is a small fix.

### W5-10 · major · every board · Frame names fail contrast (2.65:1), and frames barely stand out

- **Status (wave 5):** waiting on 2C. 2C's engine theme is on `engine/w5-2c` (`00abafb`); 3i's rendered-pixel checks `a11y-contrast` (5 `test.fail`) are ready.
- **From:** A11Y-X05 (major), XD-14 (minor) and part of PRD-X13.
- **What:** frame names are #9f9f9f on white (2.65:1; 3.84:1 in dark mode). The outline is light grey, and the canvas is pure white like the frame fill.
- **tldraw today:** names are black at 20.1:1, on an off-white #f9fafb canvas.
- **WAVE-3:** new. 3i's palette-contrast test covers the note palette only.
- **Owner:** 2C (the engine theme in the host), with 3i (`palette-contrast.test.ts`).
- **Fix:** use an ink token for names (#1b2330 light, #ebe8e1 dark), an outline of at least 3:1, and a #f9fafb canvas, and add all of these to the tests.

### W5-11 · major · P3 · A connector you draw runs centre to centre through both shapes

- **Status (wave 5):** fixed. 3a: `canvas/api/parts/connector-outline.ts`; `canvas-ux-review` W5-11.
- **From:** XD-01.
- **What:** drawing with L from inside shape A to inside shape B uses Excalidraw 0.18's fixed-point binding. The line crosses both interiors, the head sits in the middle of B, and exports look the same.
- **tldraw today:** the arrow is clipped to both outlines.
- **WAVE-3:** new.
- **Owner:** 3a (the connector tool), with O2 if the binding mode is set in the engine host.
- **Fix:** on pointer-up, and for pasted arrows, turn fixed-point bindings into outline bindings. Add an e2e check that the drawn end points lie on the shapes' boundaries.

### W5-12 · major · P3 · Phone photos with EXIF rotation are squashed

- **Status (wave 5):** fixed. 3g: `media-files` W5-12 (`image-exif6.jpg`).
- **From:** XD-02.
- **What:** `image-exif6.jpg` lands as a 360×203 landscape box with the rotated pixels squeezed into it. The distortion carries into PNG export.
- **tldraw today:** the same file lands as 203×360 portrait.
- **WAVE-3:** new.
- **Owner:** 3g.
- **Fix:** size images from their oriented dimensions (`createImageBitmap` with `imageOrientation: 'from-image'`, or the worker's derivative size), in the drop layout and slot fit as well. Add the exif6 fixture to the ported media-files spec.

### W5-13 · major · P3/P2 · Images have no Replace media, Crop or Alternative text

- **Status (wave 5):** fixed. 3g: Replace media, Crop, Alternative text (`media-edit`). Enter does not end a crop (CR-W5-3G-4, 2C), and the crop after a derivative upgrade skips itself while the swap does not stick (CR-W5-3G-3, 2C).
- **From:** PRD-X08.
- **What:** the selection bar offers Comment, Copy link, Lock, Tags, AI and Download original. Replace media is the client-review loop: key art v1 becomes v2 and keeps its thread, position and slot.
- **WAVE-3:** new. It is not in §4.7 or the §5 parity table.
- **Owner:** 3g (Replace first, then crop in `customData`, then alt text), with 3a for the menu entries.

### W5-14 · major · P3/P2 · PNG exports drop the file-card faces

- **Status (wave 5):** fixed. 3e: `canvas/api/parts/export-faces.ts`; `present-export-files` W5-14.
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

- **Status (wave 5):** waiting on 2C. As W5-10.
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

- **Status (wave 5):** fixed; Lilita One waits on 2A. 2D (D3): template hierarchy by size and colour, Lilita One for headings once 2A's allowlist takes family 7 (on `engine/w5-2a`, `b3ce1a7`); `scene/hierarchy.test.ts` (1 `it.fails`).
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

- **Status (wave 5):** fixed; Lilita One waits on 2A. 2D (D3): the type specimen names the faces it is set in, no "mono"; 3e's SVG embedding is ready (`present-export-files` D3 `test.fail`).
- **From:** XD-05 (major) and PRD-X13 (polish).
- **WAVE-3:** known, and awaiting an owner decision:
  - §4.1 lists "no serif font" as a deviation;
  - PROGRESS (2D) calls the tour's serif sample the one deliberate difference;
  - plan §2.12 limits fonts to families 5, 6 and 8, and Comic Shanns is 8;
  - Appendix B 1 asks the owner to accept "no serif".
- **Owner:** owner decision D3. Then 2C (register the fonts), O1 with contracts (the font allowlist and the metrics table), 3a (Serif in the style panel), 3e (embedding in exports) and 2D (restore "Display · serif").
- **Severity:** kept at the designer's major, because the type specimen is the point of a client-facing mood board.

### W5-18 · major · P3 · No embeds: a pasted YouTube link becomes plain text

- **Status (wave 5):** fixed. 3g (D2): link cards with an SSRF-guarded api fetch; `media-links`, `apps/api/test/features/link-preview`.
- **From:** PRD-X07.
- **WAVE-3:** plan only. §2.10.4 says "No embeddables" (the server refuses embeddables), and Appendix B 2 lists "live embeds" as a loss awaiting acceptance. WAVE-3 §5 is missing it, so leadership would discover it as a regression.
- **Owner:** owner decision D2. Then 3g: a link card drawn as a Lobby overlay, the way file cards are, with no third-party script on the board.

### W5-19 · major · P3 · Zooming out from zoom-to-fit on a large board zooms in

- **Status (wave 5):** fixed. 3b: `navigation-keys` W5-19; a touch two-finger pinch still stops at 0.1 (CR 3b-10, 2C).
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

- **Status (wave 5):** fixed. 3a: `canvas-ux-review` W5-20.
- **From:** A11Y-X01.
- **What:** press N, Enter, type, then Esc: the Note tool is still active. The next Enter creates a new empty note instead of editing the selected one. T and R behave the same, so keyboard users leave blank notes on shared boards, and nothing is announced.
- **tldraw today:** the tool returns to Select, and Enter re-edits the note.
- **WAVE-3:** new. After N plus a click, `session.ts:731` switches back to Select; the keyboard path (`features/canvas-ux/ported/place.ts`) selects the new shape but does not reset the tool.
- **Owner:** 3a (`place.ts`, `keys.ts`).
- **Fix:** switch back to Select after a keyboard placement, make Enter with a selection edit it, remove a note left empty, and announce the result.

### W5-21 · major · A11y · prefers-reduced-motion is ignored for every camera move

- **Status (wave 5):** fixed for navigation and traversal; rest waiting on 2C. 3b (zoom keys and menu, fit, Go to frame, search, minimap) and 3i (Alt+Arrow, F6, the phone sheet's fit): `navigation-keys` / `navigation-frames` / `a11y-traversal` W5-21. Follow, present to everyone and comments animate until CR 3b-12 (2C).
- **From:** A11Y-X02.
- **What:** with reduced motion on, Ctrl+=, Ctrl+-, zoom to fit, Go to frame and Alt+Arrow all still animate (16-21 camera positions each). Alt+Arrow also changes the zoom. Only present mode honours the setting.
- **WAVE-3:** new.
- **Owner:** 3b (zoom and the frames panel) and 3i (`traversal.ts`).
- **Fix:** use duration 0 under reduce, and keep the zoom when bringing an item into view unless it does not fit.

### W5-22 · major · A11y · The toolbar's More popover can't be used from the keyboard

- **Status (wave 5):** fixed. 3a: `canvas-ux-review` W5-22.
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

| ID | Pri | Finding | From | WAVE-3 | Owner | Fix | Status (wave 5) |
|---|---|---|---|---|---|---|---|
| W5-23 | P1 | A follower who stayed on after Gather loses the Stop following control when the "is presenting" banner arrives, although they are still following | FAC-X08 | New (a new case of the gap `07e6a77` fixed) | 3c | Keep Stop following visible under the banner, or turn the gather follow into the presentation follow on Join | fixed |
| W5-24 | P1 | In present mode, slides show the frame's grey rounded outline | XD-14, PRD-X13 | New | 3e | Hide the frame outline while presenting, and in frame exports | fixed |
| W5-25 | P1 | Gather: a phone lands at 14% zoom; with the leader's side panel open, desktop followers sit about 420 units off the leader's centre | FAC-X07 | Partly known: R2-04 / CR-3F-3 (2 `test.fail`); the desktop off-centre is new | 2C (the CR-3F-3 hook), 3c | Centre followers on the leader's view centre, with a readable minimum zoom on narrow screens | follower side fixed; leader side waiting on 2C |
| W5-26 | P1 | Ctrl+Z by the giver removes a +1 for everyone | FAC-X10 | Known: CR-3F-1 | 2C, 3f | Land CR-3F-1 (a transaction that skips undo) | waiting on 2C |
| W5-27 | P1 | No note authors on notes; "Hide note authors" hides nothing | PRD-X10, FAC-X13 | Known: CR-3F-4 | 2C, 3f | Land CR-3F-4, or hide the setting until it works | fixed |
| W5-28 | P1 | Other people's selections are not drawn, although presence carries them | PRD-X10, XD-13, FAC-X11 | Plan only: §2.7 and §4.3 plan outlines through `updateScene({collaborators})`; not built | 2C (`board/peers.ts`) | Feed peers' `sel` into `collaborators[].selectedElementIds`; honour Hide cursors and the server dropping selections during a vote; add a presence spec | waiting on 2C |
| W5-29 | P1 | A name-only guest's new tag says 'Created "#fans"', then is undone with "Change not saved" | FAC-X09 | Partly known: CR-3D-5; the contradictory feedback is new | 3d; O1 for CR-3D-5 | Hide or explain Create for guests; never say "Created" before the server accepts it | fixed |
| W5-30 | P2 | The PDF text layer splits wrapped words ("Stor/y", "Brie/f", "Deliver/y"), so search fails, although the dialog and DEMO 3:30 promise searchable text | PRD-X09, XD-09 | New | 3e | Build the layer from the element's wrapped lines; add a word check to `present-export-files` | fixed |
| W5-31 | P2 | Phone at 390 px: Share half off screen; the "people 3" chip; the title cut short; 24×38 px tools; guests get only Select and Comment | PRD-X12, A11Y-X04 | Partly known: CR-3A-6 (no Hand for read-only roles) | 3i, 3a | Top-bar fit rules, no people chip on phones, fewer 48 px tools plus an overflow, Hand for read-only roles | partly fixed; rest waiting on 2C |
| W5-32 | P2 | No edge marker points to collaborators off screen | PRD-X10 | New | 2C (presence overlay) | Edge indicators for off-screen cursors | waiting on 2C |
| W5-33 | P2 | Menus and shapes thinner than today (see below this table) | PRD-X11 | Partly known: 3a deviation (no Paste); CR-3A-6 (highlighter); Appendix B 2 planned extra shapes as polygons | 3a, 3b | See below this table | fixed |
| W5-34 | Gates | The Excalidraw heavy seed's 60 images never load (no `customData.lobby.file`), so Excalidraw heavy-board numbers are measured with no images drawn | XD-21 | New; affects the B9 / §8.5 numbers WAVE-3 cites | 2E (`e2e/perf/seed.ts`, `e2e/load/boards.ts:184-201`) | Write `customData.lobby.file` as a real drop does, then re-measure B9 and pan | not fixed |
| W5-35 | Security | The 500-item guest cap is counted per socket session; a new tab resets it (800 items from one guest) | SEAM-SEC-2 | Plan: §3.5 says per session; not a regression (tldraw has no guest cap) | O1; decision D5 | Count per uid or per redeemed link for the room's life, or document the scope | waiting on 2A |
| W5-36 | P3 | File-card bitmaps show past the overlay's rounded corners; in dark mode the card bodies stay beige, with low-contrast error text | XD-08 | New | 3g | Clip the bitmap to the corner radius; theme the placeholder and the overlay | fixed |
| W5-37 | P3 | Notes have a hard grey offset "shadow" and a 1 px outline, in exports too | XD-10 | New | 2C (note rendering), 3e | Blurred shadow, no outline, 2 px radius; `feDropShadow` in SVG | SVG fixed; rest waiting on 2C |
| W5-38 | P3 | Four accent colours at once; no hover outline; a selected frame's box crosses its name | XD-11 | New | 2C (host CSS), 3a | One Lobby accent token, tighter selection padding, a hover outline | waiting on 2C |
| W5-39 | P3 | An arrow selected by code (a `?el=` link) shows no outline or handles | XD-12 | New | 3b, 2C | Set `selectedLinearElement`, or draw a highlight | fixed for code selections; handles waiting on 2C |
| W5-40 | P3 | Style panel about 35% taller; font buttons are plain words; native selects for arrowheads; arrows default to Curved; unlabelled opacity slider | XD-15 | New | 3a | Font buttons drawn in their own font, icon pickers, a labelled slider | fixed |
| W5-41 | A11y | In dark mode the style panel's "Note color" legend is 1.03:1 | A11Y-X06 | New | 3a | Use the muted-text token | fixed |
| W5-42 | A11y | A full Tab cycle is 44 stops (32 today): every tool and 27 style options are stops, and the selection bar comes last | A11Y-X08 | New | 3a | Roving tabindex, one stop per style group | fixed |
| W5-43 | A11y | The live region says nothing on a tool change or when an edit ends | A11Y-X09 | New | 3i | Polite tool announcements; re-announce the selection when an edit ends | fixed |
| W5-44 | A11y | Mind map: Esc after typing selects nothing, so arrow navigation stops working | A11Y-X10 | New | 3d | Select the topic whose edit ended | fixed |
| W5-45 | A11y | The board container takes Tab focus with no visible indicator (WCAG 2.4.7) | A11Y-X11 | New | 2C, 3i | A focus ring, or select the first item | fixed |
| W5-46 | A11y | At 200% page zoom the style panel stays open over half the canvas, and the zoom control sits over Select | A11Y-X12 | New | 3a, 3b | Fold the style panel below about 800×500 | fixed |
| W5-47 | A11y / P1 | Leaving present mode or the AI summary puts focus on the canvas, not the opener; the present overlay has no focus ring | A11Y-X13 | New | 3e, 3h | Restore focus to the opener | fixed |
| W5-48 | A11y | Confirmed known gaps: Ctrl+X doesn't cut; Ctrl+Z from the chrome doesn't undo | A11Y-X15 | Known (3i `test.fail`) | spike B input, 3a | As tracked | fixed |
| W5-49 | Both builds | Dark-mode "+1" pill is 1.03:1; comment-pin initials are 3.73:1 | A11Y-X14 | Shared with tldraw, so it belongs in BACKLOG | 3f, 3c | Token pair for the pill; pick the initials colour by contrast | fixed |

**W5-33 in detail:**
- **Board menu:** no View submenu. WAVE-3 §4.1 claims one, but `MainMenu.tsx:66` builds it only from "view" entries, and the page registers none.
- **Missing commands:** no Insert file or Insert embed, and no Paste in Edit or the context menu.
- **Preferences:** Accessibility, Input device and Theme are gone.
- **Desktop canvas:** no undo, redo, delete or duplicate buttons.
- **Toolbar More:** 5 shapes instead of 13, and no Highlight.
- **Fix:** put the zoom entries under View; add Paste; add undo and redo buttons (the tour tells people to press Ctrl+Z); decide on the shapes (D4).

**Polish**

| ID | Pri | Finding | From | WAVE-3 | Owner | Fix | Status (wave 5) |
|---|---|---|---|---|---|---|---|
| W5-50 | P1 | Chrome order moved: Timer and Reactions now sit by Share, and Voting and Private notes are lower in the rail. Tool labels lost their key hints. The phone overflow shows an empty "On this board" heading | FAC-X14, A11Y-X18 | New | 2C, 3a, 3i | Keep the order DEMO and facilitators know; restore the hints and `aria-keyshortcuts` | partly fixed; rest waiting on 2C |
| W5-51 | P1 | At about 14% zoom, frame names overlap the frame above; the Stop following pill has a double border | FAC-X15 | New | 2C, 3c | Clip names that don't fit; one flat button | partly fixed; rest waiting on 2C |
| W5-52 | P3 | New rectangles get large rounded corners (templates are sharp), and default strokes are thinner | XD-16 | New | 2C (the host's initial data) | `currentItemRoundness: 'sharp'` | waiting on 2C |
| W5-53 | P3 | Arrowheads are about twice today's size; the last dash runs into the head; bound connectors stop 4-6 px short | XD-17 | New | 3a, 2C | Scale heads to the stroke; smaller binding gap | waiting on 2C |
| W5-54 | P3 | No "Back to content" button in empty space | XD-18 | New | 3b | An overlay button that calls `viewport.fit()` | fixed |
| W5-55 | P3 | A note being typed into has no editing outline | XD-19 | New | 2C | Outline the note while it is being edited | waiting on 2C |
| W5-56 | P3 | During a 40-image upload the "Processing…" text is unreadable, for about 11 s | XD-20 | Known: §4.7 "no local preview while uploading" | 3g | A local preview in this tab only, never stored | fixed |
| W5-57 | A11y | An empty `contentinfo` footer sits inside `main`, so axe fails in every state; the region and the application share a name | A11Y-X16 | New | 2C | Remove the footer's role; rename the region | waiting on 2C |
| W5-58 | A11y | Opening a template board announces "6 shapes selected" when nothing is selected | A11Y-X17 | New | 3b, 3i | Mute announcements during the insert | fixed |
| W5-59 | A11y | The note editor has no name; the Tips frame still says "main menu" and lists no navigation keys; a frame's subtitle is read before its title | A11Y-X18 | Mostly shared with tldraw | 3a, 2D, 3i | Label the editor, update the Tips frame, fix the reading order | fixed |

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

**Applied at wave 5** (each owner for its area, then the feature integration): the rows below, §4.1's View claim, the missing §5 rows and the §6 entries are corrected in `WAVE-3.md` (§5 and §6, and §8 for the integration). DEMO.md says on the Excalidraw build what is still false there: 1:00's connector during the drag (W5-08, waiting on 2C's D1). The chain 1:20 → 2:45 → 3:30 (W5-04) and 3:30's searchable text layer (W5-30) hold again.

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

## 10. Status after the wave-5 fixes (2026-09-30)

*Dated 2026-09-30. §11 updates it for the engine merge and §12 for 2026-10-03; where a row below says "waiting on 2A / 2C" or "not merged", read §12.*

The feature owners 3a, 3b, 3c, 3e, 3f, 3g, 3h, 3i and 2D fixed their findings on `engine/w5f-*` branches
from `f336ae4`; the feature integration merged all nine onto `engine/excalidraw` and fixed the three
overlaps the merge produced and 3d's two findings, since no 3d fixer ran (`WAVE-3.md` §8). The engine
owners 2A, 2B and 2C fix theirs in a parallel workflow on `engine/w5-2a`, `-2b` and `-2c`; those branches
are **not merged** here, so a finding they fixed still reads "waiting on 2A" or "waiting on 2C" below.

- **fixed:** the finding no longer reproduces on this branch, with a regression test (unit or e2e) that
  failed before and passes now; "already at wave 3b" means the review measured 1809cf3 and the fix was
  merged since, so the test is a guard.
- **partly fixed:** the feature owner's part is fixed; the rest is named with its owner.
- **waiting on 2A / 2C:** the fix belongs to an engine owner; a `test.fail` names it where one exists, and
  must lose its mark when the fix is merged.
- **not fixed:** no fixer ran for its owner in wave 5.

| | Fixed | Partly fixed | Waiting on 2A / 2C | Not fixed | Total |
|---|---|---|---|---|---|
| Blockers and majors | 15 | 2 | 5 | 0 | 22 |
| Minor and polish | 21 | 6 | 9 | 1 | 37 |
| All | 36 | 8 | 14 | 1 | 59 |

**Decisions (§9):** D1 waits on 2C (`engine/w5-2c`); D2 is built (3g's link cards); D3 is built in the
templates (2D), the font picker (3a) and the SVG embedding (3e), and Lilita One shows once 2A's allowlist
is merged; D4 is built in the tools (3a; the converter's polygons are 2B's, `engine/w5-2b`); D5 waits on
2A.

| ID | Severity | Finding | Owner | Status | Evidence, and what is left |
|---|---|---|---|---|---|
| W5-01 | blocker | Notes made with N (or the phone Note tool) never join their frame | 2C | waiting on 2C | fixed on `engine/w5-2c` (`da7da3d`), not merged here. 3f's `workshops-voting` "W5-01" is a `test.fail` for it; 3g checked the media paths (drops, Ctrl+U, Place on board and link cards already join the frame); 3h's grouping works either way |
| W5-02 | blocker | Every role receives the text and authors of deleted notes over the canvas socket | 2A (O1), contracts | waiting on 2A | redacted tombstones on `engine/w5-2a` (`c96cc5f`, `CONTRACTS_REV` 7 and 8) with 2C's consumer side on `engine/w5-2c`; not merged here |
| W5-03 | major | A frame-scoped vote counts a click for a hidden note nobody clicked | 3f | fixed | 3f, both pages: `workshops-voting` W5-03, `e2e/tests/workshops.spec.ts` |
| W5-04 | major | AI "Group into themes" pulls ideas out of the frame, so the Brainstorm slide and PDF… | 3h | fixed | 3h: `ai-actions` "DEMO 1:00 → 1:20 → 2:45 → 3:30 (W5-04)" |
| W5-05 | major | Moving a template frame leaves its locked heading behind and saves the split | 2A (O1), 3a | client half fixed; waiting on 2A | 3a: the frame's push already carries its locked heading's move. The room's lock rule is 2A's (on `engine/w5-2a`, not merged): `canvas-ux-review` W5-05 and `templates-frames` W5-05 are `test.fail` |
| W5-06 | major | Phone: Zoom to fit covers the Select tool, and the Board menu hides under the panels… | 3i, 3b, 3a, 2C | fixed | already at wave 3b (the review ran on 1809cf3); pinned since wave 5 by `canvas-ux-review` W5-31 / W5-06, `navigation-keys` PRI-13 and `a11y-phone-reach` |
| W5-07 | major | Phone: the floating ≡ Board actions button and the tool dock cover the reply box and… | 3i, 3c, 3f | fixed | 3c (the comment sheets above the chrome), 3i (Board actions steps aside), 3f (the workshop cards clear of it): `comments-stacking`, `a11y-phone-reach` W5-07, `workshops-phone` |
| W5-08 | major | Connectors detach on the other person's screen during a drag | 2C (D1) | waiting on 2C | D1's drawing-only re-route is on `engine/w5-2c` (`594cc4d`), not merged here; DEMO 1:00 is not true on this branch yet |
| W5-09 | major | The dashboard sidebar turns upside down after you visit a board | 3b | fixed | 3b: `dr-cnav*`, `navigation/css-scope.test.ts` (the build check), `navigation-keys` W5-09 |
| W5-10 | major | Frame names fail contrast (2.65:1), and frames barely stand out | 2C, 3i | waiting on 2C | 2C's engine theme is on `engine/w5-2c` (`00abafb`); 3i's rendered-pixel checks `a11y-contrast` (5 `test.fail`) are ready |
| W5-11 | major | A connector you draw runs centre to centre through both shapes | 3a | fixed | 3a: `canvas/api/parts/connector-outline.ts`; `canvas-ux-review` W5-11 |
| W5-12 | major | Phone photos with EXIF rotation are squashed | 3g | fixed | 3g: `media-files` W5-12 (`image-exif6.jpg`) |
| W5-13 | major | Images have no Replace media, Crop or Alternative text | 3g | fixed | 3g: Replace media, Crop, Alternative text (`media-edit`). Enter does not end a crop (CR-W5-3G-4, 2C), and the crop after a derivative upgrade skips itself while the swap does not stick (CR-W5-3G-3, 2C) |
| W5-14 | major | PNG exports drop the file-card faces | 3e | fixed | 3e: `canvas/api/parts/export-faces.ts`; `present-export-files` W5-14 |
| W5-15 | major | Dark mode changes the brand colours and the notes | 2C | waiting on 2C | as W5-10 |
| W5-16 | major | No bold anywhere, so template hierarchy is flat | 2D, 2A (D3) | fixed; Lilita One waits on 2A | 2D (D3): template hierarchy by size and colour, Lilita One for headings once 2A's allowlist takes family 7 (on `engine/w5-2a`, `b3ce1a7`); `scene/hierarchy.test.ts` (1 `it.fails`) |
| W5-17 | major | No serif, and the mono face is a comic-style one, so the mood board's type specimen… | 2D, 2A (D3) | fixed; Lilita One waits on 2A | 2D (D3): the type specimen names the faces it is set in, no "mono"; 3e's SVG embedding is ready (`present-export-files` D3 `test.fail`) |
| W5-18 | major | No embeds: a pasted YouTube link becomes plain text | 3g (D2) | fixed | 3g (D2): link cards with an SSRF-guarded api fetch; `media-links`, `apps/api/test/features/link-preview` |
| W5-19 | major | Zooming out from zoom-to-fit on a large board zooms in | 3b | fixed | 3b: `navigation-keys` W5-19; a touch two-finger pinch still stops at 0.1 (CR 3b-10, 2C) |
| W5-20 | major | After placing with the keyboard and pressing Esc, the tool stays armed, so the next… | 3a | fixed | 3a: `canvas-ux-review` W5-20 |
| W5-21 | major | prefers-reduced-motion is ignored for every camera move | 3b, 3i | fixed for navigation and traversal; rest waiting on 2C | 3b (zoom keys and menu, fit, Go to frame, search, minimap) and 3i (Alt+Arrow, F6, the phone sheet's fit): `navigation-keys` / `navigation-frames` / `a11y-traversal` W5-21. Follow, present to everyone and comments animate until CR 3b-12 (2C) |
| W5-22 | major | The toolbar's More popover can't be used from the keyboard | 3a | fixed | 3a: `canvas-ux-review` W5-22 |
| W5-23 | minor | A follower who stayed on after Gather loses the Stop following control when the "is… | 3c | fixed | 3c: `people-follow` W5-23 |
| W5-24 | minor | In present mode, slides show the frame's grey rounded outline | 3e | fixed | 3e: `present-export-present` W5-24 |
| W5-25 | minor | Gather: a phone lands at 14% zoom; with the leader's side panel open, desktop… | 2C (the CR-3F-3 hook), 3c | follower side fixed; leader side waiting on 2C | 3c re-fits a follower after their own panel; the leader's panel needs CR-3C-W5-1 (2C, `session.ts`): `people-follow` (1 `test.fail`). The phone half (R2-04) was fixed at wave 3b |
| W5-26 | minor | Ctrl+Z by the giver removes a +1 for everyone | 2C, 3f | waiting on 2C | CR-3F-1 (a write that skips the undo stack; 2C asked 2A for `TransactOptions`): `workshops-facilitation` `test.fail` |
| W5-27 | minor | No note authors on notes; "Hide note authors" hides nothing | 2C, 3f | fixed | at wave 3b (CR-3F-4, the note-author label); checked by 3f |
| W5-28 | minor | Other people's selections are not drawn, although presence carries them | 2C (`board/peers.ts`) | waiting on 2C | peers' selections (`board/peers.ts`); not on `engine/w5-2c`'s list yet |
| W5-29 | minor | A name-only guest's new tag says 'Created "#fans"', then is undone with "Change not saved" | 3d; 2A (O1) for CR-3D-5 | fixed | by the wave-5 integration (no 3d fixer ran): a name-only guest gets no Create (`tags-panel` W5-29). CR-3D-5 (2A: editor guests writing `tagDef:`) is still open |
| W5-30 | minor | The PDF text layer splits wrapped words ("Stor/y", "Brie/f", "Deliver/y"), so search… | 3e | fixed | 3e: `present-export-files` W5-30 (the Lobby tour's PDF) |
| W5-31 | minor | Phone at 390 px: Share half off screen; the "people 3" chip; the title cut short;… | 3i, 3a | partly fixed; rest waiting on 2C | 44 px phone tools (3a), Hand for read-only roles (wave 3b). Share past the screen edge and the people chip are 2C's top bar (CR-3I-2): `a11y-phone-reach` W5-31 `test.fail` |
| W5-32 | minor | No edge marker points to collaborators off screen | 2C (presence overlay) | waiting on 2C | edge markers for off-screen cursors (the presence overlay) |
| W5-33 | minor | Menus and shapes thinner than today (see below this table) | 3a, 3b | fixed | 3a and 3b: View ▸ (navigation's rows, once), Paste, Preferences ▸ Theme, Undo / Redo beside the tools, D4's polygon tools (`canvas-ux-review` W5-33, `navigation-keys` W5-33, `review-w5.test.ts`). Preferences ▸ Input device waits on CR-W5-3A-4 (2C); reduced motion follows the OS setting; no Insert embed (D2: a pasted link becomes a card) |
| W5-34 | minor | The Excalidraw heavy seed's 60 images never load (no `customData.lobby.file`), so… | 2E (`e2e/perf/seed.ts`, `e2e/load/boards.ts:184-201`) | not fixed | 2E's (`e2e/perf/seed.ts`, `e2e/load/boards.ts`); no wave-5 fixer for 2E ran, so B9 on this build is still measured without images |
| W5-35 | minor | The 500-item guest cap is counted per socket session; a new tab resets it (800 items… | 2A (O1); decision D5 | waiting on 2A | D5: the guest cap per uid, live and deleted, is on `engine/w5-2a`; not merged here |
| W5-36 | minor | File-card bitmaps show past the overlay's rounded corners; in dark mode the card… | 3g | fixed | 3g: `media-files` W5-36 |
| W5-37 | minor | Notes have a hard grey offset "shadow" and a 1 px outline, in exports too | 2C (note rendering), 3e | SVG fixed; rest waiting on 2C | 3e: SVG exports get the soft shadow (`present-export-files`); the canvas, PNG, PDF pages and copy keep the engine's look until 2C (CR 3E-7) |
| W5-38 | minor | Four accent colours at once; no hover outline; a selected frame's box crosses its name | 2C (host CSS), 3a | waiting on 2C | 3a's chrome already uses one accent; the engine's selection colour, padding and hover outline are 2C's host CSS |
| W5-39 | minor | An arrow selected by code (a `?el=` link) shows no outline or handles | 3b, 2C | fixed for code selections; handles waiting on 2C | 3b outlines a connector a link or a search selected (`navigation-links` W5-39); the engine's handles need CR 3b-11 (2C) |
| W5-40 | minor | Style panel about 35% taller; font buttons are plain words; native selects for… | 3a | fixed | 3a: `canvas-ux-review` W5-40; the next connector's Straight / Curved pick waits on CR-W5-3A-1 (2C), and new connectors are straight meanwhile |
| W5-41 | minor | In dark mode the style panel's "Note color" legend is 1.03:1 | 3a | fixed | 3a: `canvas-ux-review` W5-41 |
| W5-42 | minor | A full Tab cycle is 44 stops (32 today): every tool and 27 style options are stops,… | 3a | fixed | 3a: `canvas-ux-review` W5-42, `review-w5.test.ts` |
| W5-43 | minor | The live region says nothing on a tool change or when an edit ends | 3i | fixed | 3i: `a11y-live-region` W5-43 |
| W5-44 | minor | Mind map: Esc after typing selects nothing, so arrow navigation stops working | 3d | fixed | by the wave-5 integration (no 3d fixer ran): `mindmap-keyboard` W5-44 |
| W5-45 | minor | The board container takes Tab focus with no visible indicator (WCAG 2.4.7) | 2C, 3i | fixed | 3i's focus ring: `a11y-traversal` W5-45 |
| W5-46 | minor | At 200% page zoom the style panel stays open over half the canvas, and the zoom… | 3a, 3b | fixed | 3a (the style panel folds at 500 px high or less) and 3b: `canvas-ux-review` W5-46, `navigation-keys` PRI-13 |
| W5-47 | minor | Leaving present mode or the AI summary puts focus on the canvas, not the opener; the… | 3e, 3h | fixed | 3e (present mode) and 3h (the AI summary): `present-export-present` W5-47, `ai-actions` W5-47 |
| W5-48 | minor | Confirmed known gaps: Ctrl+X doesn't cut; Ctrl+Z from the chrome doesn't undo | spike B input, 3a | fixed | at wave 3b; `a11y-keyboard-safety` passes |
| W5-49 | minor | Dark-mode "+1" pill is 1.03:1; comment-pin initials are 3.73:1 | 3f, 3c | fixed | both builds: 3f's +1 pill tokens (`plus-ones-contrast.test.ts`), 3c's pin initials (`pin-face.test.ts`, `comments-stacking`, `e2e/tests/comments.spec.ts`) |
| W5-50 | polish | Chrome order moved: Timer and Reactions now sit by Share, and Voting and Private notes… | 2C, 3a, 3i | partly fixed; rest waiting on 2C | the chrome order (3f, `chrome-order.test.ts`) and the key hints (3a); the empty "On this board" in the phone menu is 2C's (CR-3I-3): `a11y-phone-reach` W5-50 `test.fail` |
| W5-51 | polish | At about 14% zoom, frame names overlap the frame above; the Stop following pill has a… | 2C, 3c | partly fixed; rest waiting on 2C | Stop following is one flat button (3c, `people-follow`); frame names overlapping at 14% are 2C's |
| W5-52 | polish | New rectangles get large rounded corners (templates are sharp), and default strokes… | 2C (the host's initial data) | waiting on 2C | the host's initial `currentItemRoundness` |
| W5-53 | polish | Arrowheads are about twice today's size; the last dash runs into the head; bound… | 3a, 2C | waiting on 2C | CR-W5-3A-2 (the head size and the binding gap, with 2A) |
| W5-54 | polish | No "Back to content" button in empty space | 3b | fixed | 3b: `navigation-keys` W5-54 |
| W5-55 | polish | A note being typed into has no editing outline | 2C | waiting on 2C | the editing outline on a note |
| W5-56 | polish | During a 40-image upload the "Processing…" text is unreadable, for about 11 s | 3g | fixed | 3g: `media-files` W5-56 |
| W5-57 | polish | An empty `contentinfo` footer sits inside `main`, so axe fails in every state; the… | 2C | waiting on 2C | the footer's role and the region's name; 3i's groundwork lets the region be renamed (CR-3I-4) |
| W5-58 | polish | Opening a template board announces "6 shapes selected" when nothing is selected | 3b, 3i | fixed | 3b (insert without selecting) and 3i (a selection is said only if it stands): `navigation-templates`, `a11y-live-region` W5-58 |
| W5-59 | polish | The note editor has no name; the Tips frame still says "main menu" and lists no… | 3a, 2D, 3i | fixed | 3a (the editor's name), 2D (headings first, the Tips frame), 3i (reading order): `canvas-ux-review` W5-59, `templates-frames` W5-59, `a11y-traversal` W5-59, `reading-order.test.ts` |

## 11. Status after the engine merge (2026-09-30)

*Dated 2026-09-30. §12 gives the reading at the held release (2026-10-03).*

The engine owners' branches (`engine/w5-2a`, `-2b`, `-2c`) are merged on `engine/excalidraw` and met the
feature integration there (`docs/research/excalidraw/W5-ENGINE.md`). §10's rows that waited on them, now:

| ID | §10 status | Now | Evidence on the merged tree |
|---|---|---|---|
| W5-01 | waiting on 2C | **fixed** (2C) | `board-frames`; `workshops-voting` W5-01 passes, its mark is off |
| W5-02 | waiting on 2A | **fixed** (2A, with 2C's consumer side; `CONTRACTS_REV` 7 and 8) | `apps/sync/test/element-room/wave5-2a.test.ts`, `sync-room-tombstones` |
| W5-05 | client half fixed; waiting on 2A | **fixed** (2A's lock rule, 3a's push) | `sync-room-frames`; `canvas-ux-review` W5-05 and `templates-frames` W5-05 pass, marks off |
| W5-08 | waiting on 2C (D1) | **fixed** (2C, drawing only) | `board-drag-arrows`; DEMO 1:00 holds on the Excalidraw build |
| W5-10 | waiting on 2C | **fixed** (2C's engine theme) | `a11y-contrast` W5-10 ×3 pass, marks off |
| W5-15 | waiting on 2C | **fixed** (2C), one deviation: a Paper note is dark paper with light ink in dark mode | `a11y-contrast` W5-15 ×2 pass, marks off; `canvas/engine/theme.test.ts` |
| W5-16, W5-17 | fixed; Lilita One waits on 2A | **fixed**: 2A's allowlist takes family 7, so the templates' headings are Lilita One | `present-export-files` D3 passes (mark off); 2D's `hierarchy.test.ts` `it.fails` now fails and must lose `.fails` (a request to 2D) |
| W5-35 | waiting on 2A | **fixed** (D5: per guest uid, tombstones counted) | `wave5-2a.test.ts` |

Still waiting on 2C (or 2C with 2A): W5-25's leader side (CR-3C-W5-1), W5-26 (CR-3F-1), W5-28, W5-31's top
bar (CR-3I-2), W5-32, W5-37's canvas look (CR 3E-7), W5-38, W5-39's handles (CR 3b-11), W5-50's phone row
(CR-3I-3), W5-51's frame names, W5-52, W5-53, W5-55, W5-57, and W5-21's other camera moves (CR 3b-12).
Counts after the merge: **43 fixed, 7 partly fixed, 8 waiting on 2A / 2C, 1 not fixed (W5-34, 2E)**.

## 12. Status at the held release (2026-10-03, wave C6)

Written at `release/held` 99ac6c52 (`main` 23a36bbd, which is what staging runs after wave C, plus the held release). §10 and §11
stay as they were written (2026-09-30); this section gives the reading **now** for every finding whose §11 status was not
"fixed", and for the two findings that are still not fully fixed. Rows not listed here were "fixed" at §10 or §11 and nothing in
waves 4, A, B or C reopened them (the specs that pin them ran in the held gate: 553 e2e tests, 551 passed, 0 failed, 2 skipped,
`docs/PROGRESS.md` 2026-10-03). The fix of each row below came from a wave workstream; its test failed on the commit before it and
passes with it (the implementer proved it, the workstream reviewer re-proved it by reverting the fix on the branch; it was not
re-proved on the merged tree).

**Counts.** §11: 43 fixed, 7 partly fixed, 8 waiting on 2A / 2C, 1 not fixed. **Now: 56 fixed and deployed to staging, 1 fixed on a
branch that is not merged (W5-34), 2 partly fixed (W5-33's polygon outlines, W5-53's arrowhead size), 0 waiting, 0 not fixed.**
"Deployed" is checked against `docs/CUTOVER-LOG.md` §7 (waves A, B1-B5, C1/C3/C4/C5); the held release is not deployed.

| ID | §11 reading | Now | Evidence |
|---|---|---|---|
| W5-13 | fixed; the swap did not stick, Enter did not end a crop | **fixed** (deployed) | wave A, A5: the sync core keeps a clean image's local `@display` suffix (`local-file-suffix.test.ts`, `swap.test.ts`; `media-edit.spec.ts` crop-after-upgrade no longer skips); wave C, C3: Enter ends a crop (`c3-polish.spec.ts`). Cropped images stay on the 512 px thumb: a known limit |
| W5-19 | fixed; a touch pinch stopped at 0.1 | **fixed** (deployed) | wave B, B2 (`92792869`): `input-touch.test.ts`, `zoom-input.test.ts`, `input-touch-wheel.spec.ts`. A real iPad check is an owner item (P10) |
| W5-21 | fixed for navigation and traversal; the rest waiting | **fixed** (deployed) | wave A, A4: `durationOf` returns null under `prefers-reduced-motion` (`camera-tween.test.ts`, `a11y-traversal.spec.ts`) |
| W5-24 | fixed; a 6 px cover left a 2 px edge | **fixed** (deployed) | wave A, A4 (CR-3E-6): focus mode turns the engine's frame outline and names off; `present-export-present.spec.ts` pixel checks |
| W5-25 | follower side fixed; leader side waiting | **fixed** (deployed) | wave A, A4: presence is re-sent when the canvas box changes size; `people-follow.spec.ts` W5-25 mark removed |
| W5-26 | waiting | **fixed** (deployed) | wave A, A3: `TransactOptions.skipUndo`; `workshops-facilitation.spec.ts` "+1 is not an undo step" |
| W5-28 | waiting | **fixed** (deployed) | wave A, A2: `chrome.tsx` `RemoteSelections`; `board-presence.spec.ts` W5-28, `remote-selection.test.ts` |
| W5-29 | fixed; CR-3D-5 open | **fixed** (deployed) | wave A, A1: editor-role guests write `tagDef:*` only, at most 10 tag keys per guest uid while the room is open (`guest-tag-list.test.ts`, `tags-panel.spec.ts`). The budget resets when the room is evicted or restarted |
| W5-31 | partly fixed; the top bar was 2C's | **fixed** (deployed) | wave A, A4: the phone top bar fits 320-412 px; `a11y-phone-reach.spec.ts` (both marks removed) |
| W5-32 | waiting | **fixed** (deployed) | wave B, B3: an initials chip per off-screen collaborator; `edge-markers.test.ts` (26), `board-presence.spec.ts` (3 tests). The chips do not avoid the phone sheet or the floating selection bar |
| W5-33 | fixed; Input device waited on CR-W5-3A-4 | **partly fixed.** Input device **fixed** (deployed): Board ▸ Preferences ▸ Input device (Auto, Mouse, Trackpad), wave B, B2 (`482009c0`). The D4 polygon tools draw Lobby's own v1 outlines, which differ from converted shapes by up to 57 px: CR-2B-2 (the converter's outlines) was built in C2 and **reverted from `release/held`** because it moved a port of tldraw 5.4.2's geometry into the web bundle | `input-touch-wheel.spec.ts`, `zoom-input.test.ts`; `841d6dc9`; `docs/CUTOVER-LOG.md` §7 (wave C entry) |
| W5-34 | not fixed (2E) | **fixed on `wave-c6/perf-heavy`, not merged** (wave C6, G11). Every generated image carries `customData.lobby.file` the way a drop writes it (`36e243b8`); the perf harness drives Lobby's board page (`56f93231`, `f4ceabd2`, `9406f2ab`); the heavy seed's 200 images load and decode. With them loaded the heavy-board gates were measured and met (edit visibility p95 185 / 177 / 208 ms against 250; fps at fit 58 with the LOD pass). Every earlier Excalidraw heavy-board browser number from the shipped seed had no image drawn | `spike-b/PERF.md`, `spike-b/B9.md` (wave C6) |
| W5-35 | fixed (D5, per guest uid) | **fixed** (deployed), with a second layer: `GUEST_BOARD_ITEM_CAP` = 6,000 holds all guest uids together, rebuilt from the rows on room open and surviving a SIGKILL (wave A, A1) | `guest-board-budget.test.ts`, `limits.test.ts` |
| W5-37 | SVG fixed; the rest waiting on 2C | **fixed** (deployed): wave C, C3: PNG, PDF pages and copy draw notes with a soft shadow and no outline (a context patch for the length of one export). The on-canvas look is closed by the owner's "The look is fine as it is" (§9). LOD frame bitmaps (below zoom 0.2) draw notes soft while the live canvas is hard | `note-shadow.test.ts`, `export-faces.test.ts`, `c3-polish.spec.ts`. Re-run W5-37 after any Excalidraw upgrade |
| W5-38 | waiting | **fixed** (deployed): wave C, C1: one accent (`--color-selection` = `--dr-focus`), a 1.5 px hover outline at rest, frame names 6 px above the frame. The drag-into-frame highlight (rgb(0,118,255)) is hard-coded in the engine and stays | `canvas-look.spec.ts`, `theme.test.ts`, `outlines.test.ts` |
| W5-39 | fixed for code selections; the engine's handles waiting | **fixed** (deployed): wave C, C1 (CR 3b-11): a code-selected arrow or line gets the engine's point editor; a read-only session gets Lobby's outline | `port-impl.test.ts`, `outlines.test.ts` |
| W5-40 | fixed; the Straight / Curved pick waited | **fixed** (deployed): wave B, B2: a connector's kind is its own next-style value | `next-style.test.ts`, `board-core.test.ts` |
| W5-50 | partly fixed | **fixed** (deployed): wave A, A4: the ⋯ menu has no empty "On this board" row | `a11y-phone-reach.spec.ts` |
| W5-51 | partly fixed | **fixed** (deployed): wave C, C1: zoomed out, a frame name that would run into a neighbour or a name above it is hidden (visibility only); a frame inside or over another frame keeps its name | `frame-names.test.ts` (10) |
| W5-52 | waiting | **fixed** (deployed): wave B, B2: `currentItemRoundness: 'sharp'` | `ui-defaults.test.ts` |
| W5-53 | waiting | **partly fixed, held:** one binding gap (the engine's own) is in the held release (wave C, C2, `8ce47edc`); the arrowhead size by stroke width needs a patch of `@excalidraw/element` through the catalog and is **open** | `binding.test.ts`, `pnpm test:arrows`; `docs/EXCALIDRAW-CONTRACTS.md` row C2-1 |
| W5-55 | waiting | **fixed** (deployed): wave C, C1: the element being typed into gets a 2 px accent outline (a fixed-width free text keeps the engine's own box) | `canvas-look.spec.ts` |
| W5-57 | waiting | **fixed** (deployed): wave B, B5: the canvas region is "<title> board area", apart from the application's "<title> board", and the engine's empty footer is `role=presentation` (kept by an observer) | `a11y-audit.spec.ts` rule 7, `board-open.spec.ts` |

What the review did not and cannot cover, and what is still open outside it, is in `SYNTHESIS.md` §19 and `docs/PROGRESS.md`
(2026-10-03, wave C6 entry): L1 capacity misses, SYNC-4's unmerged fix, DEF-GAPS-1, real devices, Firefox, CI.
