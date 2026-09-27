# Manual demo checklist (milestone 0)

Start everything with one command from the repo root:

```bash
pnpm dev
```

That runs the sync server (127.0.0.1:5858), the preview worker, and the web app (http://127.0.0.1:5173) with **development identities** (`dev.env` files; never used in a deployment). Board data goes to `./.data` (delete it to start fresh). Generate sample files once with `pnpm fixtures` (written to `tests/fixtures/generated/`).

1. **Two people on one board.** Open http://127.0.0.1:5173, click **New board**, pick **alice**. Copy the link, open it in a second browser profile or a private window, pick **bob**. Each sees the other's avatar in the top bar and live cursor.
2. **Edit together.** Add sticky notes, text, a frame, and an arrow between two shapes. Move a shape the arrow is attached to — the arrow follows on the other screen. Undo/redo (Ctrl+Z / Ctrl+Shift+Z) affects your own changes.
3. **Reload.** Reload either tab: everything is still there.
4. **Kill the server.** Stop `pnpm dev` (Ctrl+C) while both tabs are open: the status pill turns **Offline** and a banner says changes are kept in this tab until reconnect. Make an edit, start `pnpm dev` again: both tabs go **Live** and the edit appears on the other screen.
5. **Same-note typing.** alice double-clicks a note and types. bob sees "alice is editing" on it; if bob tries to type in it, his change is reverted and he sees "alice is editing this text". Five seconds after alice stops, bob can edit it.
6. **Files.** Press Ctrl+U (or drop files) and add `tests/fixtures/generated/document.pdf`, `video.mp4`, `image.png`, `encrypted.pdf`, `notes.zip`. The PDF card shows its cover and "4 pages", the video card shows a poster and plays, the image becomes a normal image, the encrypted PDF explains it is password-protected and still offers a download, and the ZIP is an attachment card. The other tab sees the same.
7. **Read-only viewer.** Add `?role=viewer` to a board URL (dev only): the toolbar is reduced and edits are refused by the server.

Expected: no "Saved" indicator anywhere (by design), and the tldraw "unlicensed" watermark on localhost.
