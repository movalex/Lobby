# Draftroom repository rules

This repository implements `docs/Miro_Clone_Build_Plan.md` (product + architecture baseline) using the milestone sequence in `docs/Cursor_Start_Here.md`. Read `docs/PROGRESS.md` before making changes and update it when a milestone or workflow finishes. Verified engine facts live in `docs/research/` and `docs/FEASIBILITY.md`.

## Working rules

- Work from the queued milestones and their acceptance gates. Independent tasks may run in parallel only with explicit file ownership and shared contracts; serialize changes to shared schemas, dependency versions and the lockfile.
- Keep code deployable in small increments. Inspect current library docs and installed exports (`node_modules/**/*.d.ts`) before relying on an API name — tldraw 5.x is newer than most model training data. Pin exact dependency versions (via the pnpm `catalog:`) and record migrations.
- Run meaningful targeted checks, review changes, and record evidence. Do not broaden scope or upgrade unrelated dependencies. Do not provision paid resources, contact vendors, or publish an unreviewed deployment.
- Do not present a demo, mock, or unverified benchmark as a finished feature. Do not mark unrun checks as passing.

## Architecture invariants

- Canvas state has one authority: native tldraw sync (`@tldraw/sync-core` `TLSocketRoom`). Exactly one room owner per board, one SQLite database per board.
- Do not combine native tldraw sync with Yjs or Liveblocks. Do not add a whole-board overwrite save loop or debounce board JSON into a last-writer-wins endpoint.
- Never put base64 uploads or signed/expiring URLs into durable canvas records; store stable asset IDs and resolve access when needed.
- Shared shape schemas and migrations live in `packages/canvas-schema` and must be used by both client and server. Test reconnects, process restarts, stale clients and concurrent modifications when those paths change.
- Presence (cursors/selection) is ephemeral and never written to board storage.
- File processing (thumbnails, PDF pages, media probes) stays outside the live sync loop. Treat uploaded files as untrusted; impose size/page/pixel/duration/time limits.
- (From milestone 1) Every API, WebSocket, asset, worker, export and AI action enforces board/workspace permissions server-side; derive authorship from the authenticated session. Development identities exist only behind an explicit local-dev guard.
- Do not show "Saved" until sync/persistence semantics actually support it. Do not claim a file is natively editable when it is a flattened preview.
- Keep secrets server-side. Never log session tokens, private content, signed URLs or OAuth tokens.

## Local environment (this Windows PC)

- Node 24 LTS + pnpm 10 are installed but may be missing from the Git Bash PATH. Prefix: `export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"`.
- Board data lives in the configurable `DRAFTROOM_DATA_DIR` (default `./.data`). Never place SQLite databases on a network share (e.g. `V:\`).
