# Manual demo checklist (through milestone 1)

Start everything with one command from the repo root:

```bash
pnpm dev
```

That runs the API (127.0.0.1:5859, with an in-process Postgres under `./.data/pg`), the sync server (127.0.0.1:5858), the preview worker, and the web app at http://127.0.0.1:5173. Sign-in uses **development identities** (the `dev.env` files; never allowed with `NODE_ENV=production`). Board data lives in `./.data` — delete the folder to start fresh. Generate sample files once with `pnpm fixtures` (written to `tests/fixtures/generated/`).

> The **first** person to sign in on a fresh `.data` becomes the owner of the shared **Dev Studio** workspace. Sign in as **alice** first.

1. **Sign in and create a board.** Open http://127.0.0.1:5173 → *Development sign-in* → pick **alice**. On the dashboard, create a board in Dev Studio. New boards are private.
2. **Share it.** On the board, open **Share**: add **bob** as *Can view* (bob must have signed in once, e.g. in a private window), or create an invite link with a role and open it in another browser profile as **carol**.
3. **Two people on one board.** bob opens the board: he sees alice's avatar and live cursor, a *View only* pill and a reduced toolbar. The server refuses his edits even if forced.
4. **Change access live.** alice changes bob to *Can edit*: bob's board reconnects and becomes editable. alice removes bob: within a moment bob sees "You no longer have access to this board".
5. **Edit together.** Add sticky notes, text, a frame and an arrow between two shapes; move a shape the arrow is attached to — the arrow follows on the other screen. Undo/redo affects your own changes (see the known undo limitation in `docs/FEASIBILITY.md`).
6. **Reload and restart.** Reload either tab: everything is still there. Stop `pnpm dev` (Ctrl+C): the status pill turns **Offline** and a banner says changes are kept in this tab until reconnect. Make an edit, start `pnpm dev` again: both tabs go **Live** and the edit appears on the other screen.
7. **Same-note typing.** alice types in a note; bob sees "alice is editing" on it. If bob types in it, his change is reverted and he sees who is editing. A few seconds after alice stops, bob can edit it.
8. **Files.** Press Ctrl+U (or drop files) and add `tests/fixtures/generated/document.pdf`, `video.mp4`, `image.png`, `encrypted.pdf`, `notes.zip`: PDF cover + "4 pages", a playable video with a poster, a normal image, a readable error for the encrypted PDF (download still offered), and an attachment card for the ZIP — on both screens.
9. **Dashboard.** Rename, archive, move to trash and restore boards; search by title; archived boards open read-only.

Expected: no "Saved" indicator yet (it arrives once it can be truthful), and the tldraw "unlicensed" watermark on localhost.
