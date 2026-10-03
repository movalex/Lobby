# Lobby demo

Two parts: the **5-minute demo on staging** for DBC leadership, then the longer **local checklist** for the
Lobby team. Staging: https://draftroom-staging-web.onrender.com (the hostname keeps the old code
name; everything on screen says Lobby).

**This is the script for the Excalidraw canvas, which is the only canvas.** Staging has run it since 2026-10-01
(cut-over `main` `bbe1b48`, `docs/CUTOVER-LOG.md`), with the later waves A, B and C deployed on top of it
(`main` 0644365, 99d902c, 9627f29). The tldraw script is kept in `docs/DEMO-tldraw.md` as history only.

**The demo video is retired.** The narrated 2:18 video and its pipeline (`pnpm --filter @draftroom/e2e demo:video`,
`e2e/demo`) drove the tldraw canvas. The pipeline was deleted in `fe17a6b` when the Excalidraw suite became the default
suite (the tldraw build keeps it, on the tag `lobby-r0`). Any copy of that video shows the old canvas and must not be
shown as the product. No replacement exists: run the demo live from this script.

**What was checked, and what was not (2026-10-03).** Each step of the script has a Playwright spec that drives it
on a local stack; those specs were run again on 2026-10-03 against `release/held` 99ac6c52 plus docs-only commits, and
passed, with one known expected failure that is not a step of this script (table "Last checked" after the script). **Not checked, so do not promise it:** a run of this whole script on staging
with two real Clerk sign-ins (the log lists "DEMO.md" among the checks that did not run, `docs/CUTOVER-LOG.md` §5; the
owner's sign-in check of 2026-10-03 covered sign-in, boards, editing, reload and two browsers seeing each other, §7); a real
phone for the client step; Firefox and Safari (WebKit passes a smoke test, Firefox has never run). **Not live yet:** a dot vote
over a selection of frames or objects and the "access approved" bell item are built and gated but held for the release that
deploys after 2026-10-03 20:55Z (`docs/PROGRESS.md`, "The held deploy"); until then the Voting dialog offers only the board and
one frame.

## 5-minute demo on staging

### Before the meeting (10 minutes, once)

- **Two accounts, two browsers.** You (browser A, your normal Chrome profile) and a colleague account
  (browser B: a private window or a second browser). Sign in to both once on staging, so neither sees
  the sign-in page during the demo. Put the windows side by side, or have B on a second laptop.
- **A fresh lobby to show.** In browser A, open the workspace you will demo in. If it has no boards, the
  dashboard offers **Start with the sample board**; otherwise use **New board**, pick **Lobby tour**
  (the first card, marked *Start here*) and click **Create from Lobby tour** (it stays at the bottom of
  the dialog; double-clicking the card does the same). Do it once as a dry run, then move that board to
  Trash so the real run starts clean.
- **Optional: one reference image.** Keep one DBC key-art image (PNG or JPEG, not a video) on the
  desktop of browser A for the Mood board step. Without it, the Mood board still shows its palette and
  type samples.
- **Warm it up.** Open staging in both browsers two minutes before you start. The first load after a
  deploy can take a few seconds.
- **AI once.** In browser A, run one AI action on the dry-run board and accept the notice ("Sends the
  selected text to OpenAI"), so the demo does not stop on it.
- **Know the two live rules.** Moves and typing show on the other screen as they happen. A resize, a
  rotation or a pen stroke shows when you let go. Do not promise live resizing.

### The script

| Time | What you do | What they see |
|---|---|---|
| 0:00 | **Dashboard.** "Every DBC project gets a lobby: its boards, files and feedback." Click **New board**, pick **Lobby tour**, then **Create from Lobby tour** at the bottom of the dialog. | A private board with six frames in a row: Welcome, Brainstorm, Plan, Mood board, Retro, Tips and shortcuts. The headings are in the Display font. |
| 0:30 | **Share and invite.** **Share** → **More ways to share** → **Workshop link** → **Create workshop link** → **Copy** next to the new link. In browser B, paste the link and click **Accept and open board**. | B is on the same board as an editor. Both see each other's cursor and avatar. |
| 1:00 | **Edit together** (Brainstorm frame). In B, press **N**, click the empty space at the end of the *Story* row (after its two ideas) and type an idea. In A, drag the *Story* theme down a little (about half-way to *Community*), into the empty space under it. | B's note appears on A's screen as it is typed, inside the frame. The connector from the question follows the *Story* theme while A drags it. |
| 1:20 | **AI.** Drag a selection box over the Brainstorm idea notes (not the theme boxes) → **AI** in the selection bar → **Group into themes**. | The notes move into labelled theme clusters on both screens, inside the frame, which grows to fit; one undo step. Only the selected notes were sent to OpenAI. |
| 1:40 | **Comment.** In A, press **C** and click one of B's notes, type a comment and press Enter. | A comment pin appears on both screens; B can reply in the thread. |
| 1:50 | **Mood board** (optional, if you brought an image). Drag the image from the desktop onto **Drop a reference here**. | It fits the slot, next to the palette and the type samples, and shows on B's screen within a second. If you have time: select it and point at **Replace media**, **Crop** and **Alternative text** in the selection bar ("key art v2 keeps its comments and its slot"). |
| 2:00 | **Vote** (Retro frame). Open **Voting** in the left rail → **Start a vote…** → *What can be voted on*: **Only inside frame “5 · Retro”** → *Objects*: **Sticky notes only** → **Start vote**. In both browsers, click **Join vote** on the card that appears, then click a few notes (a click before **Join vote** only selects the note). B clicks **I'm done**. In A's Voting panel: **End and show results**. | Each person sees only their own dots until the reveal, then the ranked results show on both screens. A click on something the vote does not take (a heading, say) casts nothing and says so. |
| 2:45 | **Present to everyone.** Click empty canvas (so it starts at slide 1), then **Present** → **Invite everyone** in the presentation bar. In B, click **Join** on the banner. Walk the slides with → and ←, then **End**. | Each frame fills the screen with no frame outline; B's screen follows every slide in step and A sees "1 following". B can step out with **Stop following** and rejoin. |
| 3:30 | **Export.** The download icon next to Present (**Export: PNG, SVG, PDF, CSV**) → in the PDF section, **Download PDF**. If a size warning shows in the image section, it is about the PNG of the whole board, not the PDF. | A PDF with one page per frame, in presentation order, named after the board; the 2026-09-30 review timed the export at 1.0 s on a local stack (not timed on staging). The pages are images of the frames with a searchable text layer, as the dialog says; file cards are drawn in full. |
| 4:00 | **History.** Open **History** in the left rail, type "Before clean-up" as the *Checkpoint name* and click **Save checkpoint**. Delete a note on the Retro frame, then restore it from **Recently deleted** in the same panel. | The note comes back where it was, on both screens. The checkpoint can also be opened with **Restore as new board**. |
| 4:45 | **Wrap.** Back to the dashboard. | The board is in the list with the rest of the lobby's boards. |

### More to show (swap in, or for Q&A)

- **A client on their phone.** **Share** → **Share with a client** → **Create and copy link** (guests can
  join with just a name). Open the link on a phone, type a name, **Join**. They show as "Sam (guest)" on
  cursors, see only this board, and can comment; the owner's bell shows their comment. Revoke the link and
  their view ends within seconds. A guest sees a **People** button where you see **Share**.
- **Private brainstorm.** **Private notes** in the left rail → **Start a private brainstorm…** → a prompt
  and **A new frame, "Private ideas", in view**. Everyone gets an "Add your notes" prompt and sees only the
  counts until **Reveal**, when the notes land as real sticky notes (anonymous if chosen). An automatic
  checkpoint is saved just before.
- **Mind map.** The **Mind map** tool (or **Alt+Shift+M**), type a topic, then **Tab** for a child and
  **Enter** for the next one; the layout tidies itself.
- **Link cards.** Paste a YouTube or Google Drive link onto the board: it becomes a card with the page's
  title and icon that opens in a new tab. Nothing from outside loads inside the board.
- **Tags and search.** Tag notes or images from the selection bar, filter by tag; the dashboard's search
  finds text inside every board you can open.
- **Dark mode.** Board menu (top left) → **Preferences** → **Theme**. The DBC note colours keep their
  contrast.
- **Safety answers.** **Share** → the export setting stops viewers and commenters exporting or downloading
  (not screenshots, like Miro); name-only guests never export unless an owner turns that on; owners can
  switch **AI** off per board or workspace; **History** keeps automatic checkpoints; every board is backed up
  offsite (at the 31 h check every board had offsite copies, 0 failures and 0 pending, `docs/CUTOVER-LOG.md` §7);
  pasted links never run outside scripts on the board. Do not say the restore drill was run on the converted
  boards: that is the owner's check (log §6 step 2).

### If something goes wrong

- **The status pill says Offline** (or "Offline — 2 changes on this device"): wait a few seconds. Edits
  made meanwhile are kept on the device and sync when it reconnects. A reload is safe for signed-in people
  (a name-only guest keeps their edits in the tab only, so do not reload B if B joined as a guest).
- **The status pill says Change not saved**: the board refused the last change and undid it, usually because
  someone else was typing in that note or the object is locked. Hover the pill for the reason, then try
  again. (One known exception: on an archived board the owner's open tab can say it although nothing changed,
  DEF-GAPS-1; do not demo archiving.)
- **Letters go into a note instead of picking a tool**: one note is selected, so typing edits it. Press
  **Esc** or click empty canvas, then press the tool key.
- **Present starts on the wrong slide**: it starts at the selected frame. Press **Home** for slide 1.
- **Browser B cannot open the link**: it must be signed in, or open the link as a name-only guest. Links
  expire; create a new one from **Share**.

## Last checked

On 2026-10-03 (about 20:30-20:55Z) the specs below were run against `release/held` 99ac6c52 plus docs-only commits: headless Chromium, one worker, `E2E_PORT_BASE=7920`, a local stack with development sign-in and the fake OpenAI (not staging, no real Clerk, no phone). **165 distinct tests passed and 0 failed; 1 was an expected failure** (DEF-GAPS-1, `gaps-board-status.spec.ts:117`, an open product defect marked `test.fail`, which Playwright counts as passed) across the files named here and the others in the same runs.
The table names, per step, the spec files whose tests drive it; "passed" means the named tests passed in those runs. A passing spec is not a rehearsal: it proves the steps work, not that the wording on screen still matches this page word for word, so do the dry run in "Before the meeting".

| Step | What | Spec files | Result |
|---|---|---|---|
| 0:00 | Dashboard, New board, Lobby tour | `gaps-board-status.spec.ts` | passed |
| 0:30 | Workshop link and a guest joining | `guests-sharing.spec.ts`, `guests-join.spec.ts` | passed |
| 1:00 | Edit together, the connector follows a drag | `board-drag-arrows.spec.ts` | passed |
| 1:20 | AI: Group into themes | `ai-actions.spec.ts` | passed |
| 1:40 | Comment | `comments-core.spec.ts` | passed |
| 1:50 | Mood board; Replace media, Crop, Alternative text | `media-drops.spec.ts`, `media-edit.spec.ts` | passed |
| 2:00 | Vote | `workshops-voting.spec.ts` | passed |
| 2:45 | Present to everyone | `present-live.spec.ts`, `present-export-present.spec.ts` | passed |
| 3:30 | Export a PDF | `present-export-files.spec.ts` | passed |
| 4:00 | History: checkpoint, Recently deleted | `history-checkpoints.spec.ts`, `history-deleted.spec.ts` | passed |
| 4:45 | Back to the dashboard | `gaps-board-status.spec.ts` | passed |
| More | A client on a phone | `guests-join.spec.ts` | passed |
| More | Private brainstorm | `workshops-private-notes.spec.ts` | passed |
| More | Mind map | `mindmap-keyboard.spec.ts`, `mindmap-structure.spec.ts` | passed |
| More | Link cards | `media-links.spec.ts` | passed |
| More | Tags and search | `tags-panel.spec.ts` | passed |
| More | Safety: the export setting | `sharing-export-control.spec.ts` | passed |

The run's files: `ai-actions.spec.ts`, `board-drag-arrows.spec.ts`, `comments-core.spec.ts`, `gaps-board-status.spec.ts`, `guests-join.spec.ts`, `guests-sharing.spec.ts`, `history-checkpoints.spec.ts`, `history-deleted.spec.ts`, `media-drops.spec.ts`, `media-edit.spec.ts`, `media-links.spec.ts`, `mindmap-keyboard.spec.ts`, `mindmap-structure.spec.ts`, `present-export-files.spec.ts`, `present-export-present.spec.ts`, `present-live.spec.ts`, `sharing-export-control.spec.ts`, `sharing-share-dialog.spec.ts`, `tags-panel.spec.ts`, `tags-picker.spec.ts`, `workshops-facilitation.spec.ts`, `workshops-private-notes.spec.ts`, `workshops-voting.spec.ts`.

## Local checklist (for the Lobby team)

Start everything with one command from the repo root:

```bash
pnpm dev
```

That runs the API (127.0.0.1:5859, with an in-process Postgres under `./.data/pg`), the sync server
(127.0.0.1:5858), the preview worker (an HTTP client of the api, using the dev-only worker token in both
`dev.env` files; uploaded files are under `./.data/blobs`), and the web app at http://127.0.0.1:5173.
Sign-in uses **development identities** (the `dev.env` files; never allowed with `NODE_ENV=production`).
Board data lives in `./.data` — delete the folder to start fresh. Generate sample files once with
`pnpm fixtures` (written to `tests/fixtures/generated/`).

> Excalidraw is the only canvas: there is no engine flag to set (`DRAFTROOM_ENGINE` may be unset or `excalidraw`, and
> `tldraw` is refused at start; the web app no longer reads `VITE_LOBBY_ENGINE` or `VITE_TLDRAW_LICENSE_KEY`, although the licence key is still set on the staging web service until drop-legacy, `docs/EXCALIDRAW-CUTOVER.md` §9).

> The **first** person to sign in on a fresh `.data` becomes the owner of the shared **Dev Studio** workspace. Sign in as **alice** first.

1. **Sign in and create a board.** Open http://127.0.0.1:5173 → *Development sign-in* → pick **alice**. On an empty dashboard, **Start with the sample board** creates the Lobby tour; **New board** opens the template gallery (Lobby tour first, then Blank board and the six templates). New boards are private.
2. **Share it.** On the board, open **Share**: add **bob** as *Can view* (bob must have signed in once, e.g. in a private window), or create an invite link with a role and open it in another browser profile as **carol**.
3. **Two people on one board.** bob opens the board: he sees alice's avatar and live cursor, a *View only* pill and a reduced toolbar (Select, Hand, Comment). The server refuses his edits even if forced.
4. **Change access live.** alice changes bob to *Can edit*: bob's board reconnects and becomes editable. alice removes bob: within a moment bob sees "You no longer have access to this board".
5. **Edit together.** Add sticky notes, text, a frame and a connector between two shapes; move a shape the connector is attached to — the connector follows on the other screen during the drag. Resize a shape: the other screen updates when you let go. Undo and redo affect your own changes, property by property.
6. **Reload and restart.** Reload either tab: everything is still there. Stop `pnpm dev` (Ctrl+C): the status pill turns **Offline** and, after an edit, "Offline — 1 change on this device". Start `pnpm dev` again: both tabs go back to **Saved** and the edit appears on the other screen. Reloading the offline tab while signed in keeps the queued edit.
7. **Same-note typing.** alice types in a note; bob sees that alice is editing it. If bob types in it, his change is reverted with "Change not saved" and he sees who is typing. A few seconds after alice stops, bob can edit it.
8. **Files.** Press Ctrl+U (or drop files) and add `tests/fixtures/generated/document.pdf`, `video.mp4`, `image.png`, `encrypted.pdf`, `notes.zip`: PDF cover + "4 pages", a video card with a poster that plays in place, a normal image, a readable error for the encrypted PDF (download still offered), and an attachment card for the ZIP — on both screens. Drop an image onto one of the Lobby tour's mood-board slots: it fits the slot. Paste a URL: a link card.
9. **Dashboard.** Rename, archive, move to trash and restore boards; search by title; archived boards open read-only.

Expected: the top bar says **Saved** only once the server has acknowledged every local change (see `docs/research/saved-indicator.md`).
