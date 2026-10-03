> **HISTORY ONLY: the old canvas (tldraw).** This is the demo script as it was before the move to the new canvas. It cannot be run against
> anything now. Staging has run the Excalidraw canvas since 2026-10-01 (cut-over `bbe1b48`, `docs/CUTOVER-LOG.md`); tldraw was removed from the
> build (`a75883d6`) and its last build is R0 (tag `lobby-r0`), which is no longer deployed. Do not use it for a demo: its steps rely on tldraw
> behaviour the new canvas does not have (for example the "Get a license for production" notice it expects on localhost, last line). The
> narrated video made from it is retired too (`docs/DEMO.md`). The current script is `docs/DEMO.md`.

# Lobby demo

Two parts: the **5-minute demo on staging** for DBC leadership, then the longer **local checklist** for
`pnpm dev`. Staging: https://draftroom-staging-web.onrender.com (the hostname keeps the old code name;
everything on screen says Lobby).

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

### The script

> **On the Excalidraw build** (`engine/excalidraw`, not on staging yet): at 1:00, B sees the connector follow A's drag, drawn only (2C's re-route in the drag preview, decision D1, `docs/research/excalidraw/REVIEW-W5-EARLY.md` W5-08, merged at the wave-5 engine integration, `docs/research/excalidraw/W5-ENGINE.md`); the saved route arrives when A lets go. The other two steps the early wave-5 review found false there hold since wave 5: 1:20 → 2:45 → 3:30 (W5-04) and 3:30's searchable PDF text (W5-30).

| Time | What you do | What they see |
|---|---|---|
| 0:00 | **Dashboard.** "Every DBC project gets a lobby: its boards, files and feedback." Click **New board**, pick **Lobby tour**, then **Create from Lobby tour** at the bottom of the dialog. | A private board with six frames in a row: Welcome, Brainstorm, Plan, Mood board, Retro, Tips and shortcuts. |
| 0:30 | **Share and invite.** **Share** → **More ways to share** → **Workshop link** → **Create workshop link** → **Copy** next to the new link. In browser B, paste the link and click **Accept and open board**. | B is on the same board as an editor. Both see each other's cursor and avatar. |
| 1:00 | **Edit together** (Brainstorm frame). In B, press **N**, click the empty space at the end of the *Story* row (after its two ideas) and type an idea. In A, drag the *Story* theme down a little (about half-way to *Community*), into the empty space under it. | B's note appears on A's screen as it is typed. The connector from the question follows the *Story* theme while A drags it. |
| 1:20 | **AI.** Drag a selection box over the Brainstorm idea notes (not the theme boxes) → **AI** in the selection bar → **Group into themes**. | The notes move into labelled theme clusters on both screens, in one undo step. Only the selected notes were sent to OpenAI. |
| 1:40 | **Comment.** In A, press **C** and click one of B's notes, type a comment and press Enter. | A comment pin appears on both screens; B can reply in the thread. |
| 1:50 | **Mood board** (optional, if you brought an image). Drag the image from the desktop onto **Drop a reference here**. | It fits the slot, next to the palette and the type samples, and shows on B's screen within a second. |
| 2:00 | **Vote** (Retro frame). Open **Voting** in the left rail → **Start a vote…** → *What can be voted on*: **Only inside frame “5 · Retro”** → *Objects*: **Sticky notes only** → **Start vote**. In both browsers, click **Join vote** on the card that appears, then click a few notes (a click before **Join vote** only selects the note). B clicks **I'm done**. In A's Voting panel: **End and show results**. | Each person sees only their own dots until the reveal, then the ranked results show on both screens. |
| 2:45 | **Present to everyone.** Click empty canvas (so it starts at slide 1), then **Present** → **Invite everyone** in the presentation bar. In B, click **Join** on the banner. Walk the slides with → and ←, then **End**. | Each frame fills the screen; B's screen follows every slide in step and A sees "1 following". B can step out with **Stop following** and rejoin. |
| 3:30 | **Export.** The download icon next to Present (**Export: PNG, SVG, PDF, CSV**) → in the PDF section, **Download PDF**. The yellow size note in the image section is about the PNG of the whole board, not the PDF. | A PDF with one page per frame, in presentation order, named after the board. The pages are images of the frames with a searchable text layer, as the dialog says. |
| 4:00 | **History.** Open **History** in the left rail, type "Before clean-up" as the *Checkpoint name* and click **Save checkpoint**. Delete a note on the Retro frame, then restore it from **Recently deleted** in the same panel. | The note comes back where it was, on both screens. The checkpoint can also be opened with **Restore as new board**. |
| 4:45 | **Wrap.** Back to the dashboard. | The board is in the list with the rest of the lobby's boards. |

### More to show (swap in, or for Q&A)

- **A client on their phone.** **Share** → **Share with a client** → **Create and copy link** (guests can
  join with just a name). Open the link on a phone, type a name, **Join**. They show as "Sam (guest)" on
  cursors, see only this board, and can comment; the owner's bell shows their comment. Revoke the link and
  their view ends within seconds.
- **Private brainstorm.** **Private notes** in the left rail → **Start a private brainstorm…** → a prompt
  and **A new frame, "Private ideas", in view**. Everyone gets an "Add your notes" prompt and sees only the
  counts until **Reveal**, when the notes land as real sticky notes (anonymous if chosen). An automatic
  checkpoint is saved just before.
- **Mind map.** The **Mind map** tool, type a topic, then **Tab** for a child and **Enter** for the next
  one; the layout tidies itself.
- **Tags and search.** Tag notes or images from the selection bar, filter by tag; the dashboard's search
  finds text inside every board you can open.
- **Safety answers.** **Share** → the export setting stops viewers and commenters exporting or downloading
  (not screenshots, like Miro); owners can switch **AI** off per board or workspace; **History** keeps
  automatic checkpoints; every board is backed up to Cloudflare R2 with a tested restore drill.

### If something goes wrong

- **The status pill says Offline or Reconnecting**: wait a few seconds. Edits made meanwhile stay in the
  tab and sync when it reconnects. A reload is safe.
- **Present starts on the wrong slide**: it starts at the selected frame. Press **Home** for slide 1.
- **Browser B cannot open the link**: it must be signed in (or, with guests merged, use *Join as a
  guest*). Links expire; create a new one from **Share**.

## Local checklist (`pnpm dev`)

Start everything with one command from the repo root:

```bash
pnpm dev
```

That runs the API (127.0.0.1:5859, with an in-process Postgres under `./.data/pg`), the sync server (127.0.0.1:5858), the preview worker (since milestone 3 an HTTP client of the api, using the dev-only worker token in both `dev.env` files; uploaded files are under `./.data/blobs`), and the web app at http://127.0.0.1:5173. Sign-in uses **development identities** (the `dev.env` files; never allowed with `NODE_ENV=production`). Board data lives in `./.data` — delete the folder to start fresh. Generate sample files once with `pnpm fixtures` (written to `tests/fixtures/generated/`).

> The **first** person to sign in on a fresh `.data` becomes the owner of the shared **Dev Studio** workspace. Sign in as **alice** first.

1. **Sign in and create a board.** Open http://127.0.0.1:5173 → *Development sign-in* → pick **alice**. On an empty dashboard, **Start with the sample board** creates the Lobby tour; **New board** opens the template gallery (Lobby tour first, then Blank board and the six templates). New boards are private.
2. **Share it.** On the board, open **Share**: add **bob** as *Can view* (bob must have signed in once, e.g. in a private window), or create an invite link with a role and open it in another browser profile as **carol**.
3. **Two people on one board.** bob opens the board: he sees alice's avatar and live cursor, a *View only* pill and a reduced toolbar. The server refuses his edits even if forced.
4. **Change access live.** alice changes bob to *Can edit*: bob's board reconnects and becomes editable. alice removes bob: within a moment bob sees "You no longer have access to this board".
5. **Edit together.** Add sticky notes, text, a frame and an arrow between two shapes; move a shape the arrow is attached to — the arrow follows on the other screen. Undo/redo affects your own changes (see the known undo limitation in `docs/FEASIBILITY.md`).
6. **Reload and restart.** Reload either tab: everything is still there. Stop `pnpm dev` (Ctrl+C): the status pill turns **Offline** and a banner says changes are kept in this tab until reconnect. Make an edit, start `pnpm dev` again: both tabs go **Live** and the edit appears on the other screen.
7. **Same-note typing.** alice types in a note; bob sees "alice is editing" on it. If bob types in it, his change is reverted and he sees who is editing. A few seconds after alice stops, bob can edit it.
8. **Files.** Press Ctrl+U (or drop files) and add `tests/fixtures/generated/document.pdf`, `video.mp4`, `image.png`, `encrypted.pdf`, `notes.zip`: PDF cover + "4 pages", a playable video with a poster, a normal image, a readable error for the encrypted PDF (download still offered), and an attachment card for the ZIP — on both screens. Drop an image onto one of the Lobby tour's mood-board slots: it fits the slot.
9. **Dashboard.** Rename, archive, move to trash and restore boards; search by title; archived boards open read-only.

Expected: the top bar says **Saved** only once the server has acknowledged every local change (see `docs/research/saved-indicator.md`), and the tldraw "Get a license for production" notice shows on localhost.
