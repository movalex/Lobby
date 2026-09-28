# Miro-style features phase: contracts (milestones 2, 4, 5 scope)

Integration owner: main session. Requirements source: `docs/research/miro-ux-checklist.md` (IDs below, P0 first), `docs/research/miro-official-behaviors.md`, the build plan §4/§9. Builds on M0/M1 contracts (still binding) and `docs/FEATURES-CONTRACTS.md` (board-ops, templates).

## 1. Extension points (already in place — do not edit these files)

**Web** — `apps/web/src/features/`:
- `types.ts`: `BoardFeature` (panels for the left dock, `TopBarItem`, `Overlay` rendered as a child of `<Tldraw>` so `useEditor`/`useValue` work, `overrides` (tldraw `TLUiOverrides`, merged as an array), `components` (shallow-merged `TLComponents`), `options` (shallow-merged `TldrawOptions`), `onMount`). `FeatureContext` gives `editor, board, role, me, workspace, api (with api.request for typed calls), events, notify, dismiss, openPanel, activePanel`.
- `registry.ts` lists the features; each feature owns exactly `apps/web/src/features/<id>/**` and exports its `BoardFeature` from `<id>/index.tsx`.
- `events.ts`: `createBoardEvents(boardId)` → `on(type, fn)`, `onResync(fn)` (called after every (re)connect — refetch authoritative state), `serverOffsetMs()`, `onAccessLost(fn)`.
- `FeatureHost.tsx` renders the dock rail/panel, top-bar items and overlays.

**API** — `apps/api/src/features/`:
- `context.ts`: `FeatureContext` = M1 `AppContext` + `events: EventHub` + `sync: SyncInternalClient` (snapshot/seed) + `layout` (file store).
- `index.ts` registers each feature's `register<Name>(app, ctx)` from `features/<name>/index.ts`; each feature owns `apps/api/src/features/<name>/**` and `apps/api/test/features/<name>/**`.
- Events: `ctx.events.publish(boardId, { type, data })` **after the transaction commits**. Payloads must be safe for every viewer of the board; per-user secrets (e.g. unrevealed ballots) are never published — publish a hint and let each client refetch its own view.
- `GET /api/boards/:bid/events` (SSE) and `GET /healthz` exist. (Validation phase: the stream's heartbeat is a data event `{type:'ping'}` every 15 s instead of an SSE comment, and the web client replaces a stream that delivered nothing for 40 s; features never see `ping` unless they subscribe to it.) Reuse `requireBoardAction` / `requireWorkspaceRole` / `connectionRole` from `apps/api/src/access.ts` for every decision (packages/permissions semantics, 404 = no existence leak).

**Contracts** — each feature owns `packages/contracts/src/<feature>.ts` (comments, history, workshops, dashboard; already created and re-exported from `index.ts` — never edit `index.ts`).

**CSS** — each web feature keeps its styles in `apps/web/src/features/<id>/<id>.css` (or next to its dashboard/share files) imported from its own module. Never edit `apps/web/src/styles.css`; reuse its tokens (`--dr-*`) and classes (`dr-btn`, `dr-pill`, `dr-iconbtn`).

**Migrations** — pre-allocated: `0002_comments.sql` (comments), `0003_history.sql` (history), `0004_workshops.sql` (workshops), `0005_dashboard.sql` (dashboard-share). Every tenant row carries `workspace_id`; constraints/CHECKs like 0001.

**Integration notes (2026-09-27, features-integration pass)**
- DEVIATION: `apps/web/src/board/BoardPage.tsx` creates the shared event stream in an effect (`useState` + `useEffect`), not `useMemo`. Under React StrictMode (`pnpm dev`) the simulated unmount closed the memoized stream for good (`close()` is permanent) and leaked a second, unlistened EventSource, so no feature received board events in dev. A `FeatureContext` now exists only once the editor AND the stream exist; `useFeatureMounts` runs per editor + stream. Verified in dev: one open stream per board page, live comment pins, timer, votes and summon.
- DEVIATION: `apps/api/src/events/routes.ts` ends every open stream in a Fastify `preClose` hook. Before, one connected client made `app.close()` (SIGTERM on deploy) take the 5 s force-exit path (exit 1). Test: `apps/api/test/events.test.ts` "ends open streams when the app closes".
- DEVIATION: files outside the owner lists that changed, accepted by integration: history — `apps/api/src/files/deps.ts` (optional `FileAuthorizer.linkedAsset`), `apps/api/src/files/serve.ts` (asks `linkedAsset` only when `meta.boardId` differs), `apps/sync/src/http/router.ts` (two `INTERNAL_ROUTES` entries); dashboard-share — the `draftroom:open-share` listener in `BoardPage.tsx` (allowed above); platform — `apps/sync/test/http/origin.test.ts` and one `trustProxy` line in `apps/api/src/app.ts`; integration — `apps/sync/package.json` script `backup:restore-drill` (the command this contract names).
- RESOLVED (declarations added and installed; the four imports now use the package names — re-checked in the validation phase): `apps/web` did not declare `@draftroom/board-ops` / `@draftroom/templates`, and `apps/api` does not declare `@draftroom/board-ops`. Each is imported by relative path from one file: web `features/canvas-ux/deps.ts`, `features/present-export/board-ops.ts` (+3 of its tests import `packages/board-ops/src/test-fixtures.ts`), `dashboard/template-catalog.ts`; api `features/history/board-ops.ts`. That works with a full workspace install (dev, CI, e2e), but filtered installs do not create `packages/board-ops/node_modules` or `packages/templates/node_modules`: the api Docker images (`pnpm install --filter "@draftroom/api..."`) and the Render static-site build (`--filter "@draftroom/web..."`) would fail to resolve those packages' own imports (`@tldraw/tlschema`, `@draftroom/canvas-schema`). This is an analysis of the install filters; neither build was run here (no Docker on this PC). Fix: add `"@draftroom/board-ops": "workspace:*"` (web, api) and `"@draftroom/templates": "workspace:*"` (web), run `pnpm install`, switch the four imports to the package names.
- Migrations 0002..0005 apply in order on an empty database and on a milestone-1 database that already holds data, and the checksum guard covers them (`packages/db/test/migrate.test.ts`).
- Keyboard: every binding features add or change is checked together against tldraw 5.4.2's default table (parsed from `node_modules/tldraw/src` on each run) in `apps/web/src/features/keyboard-map.test.ts`: no chord is bound twice, on editable or read-only boards, and no two features replace the same tldraw component slot or option. The bindings:

| Key | Does | Feature |
|---|---|---|
| L (A kept) | connector (tldraw `arrow`) | canvas-ux |
| P (D, B, X kept) | pen (`draw`) | canvas-ux |
| — (was L) | `line` tool has no key | canvas-ux |
| Alt/Option+1, Alt/Option+2 (Shift+1/2 kept) | zoom to fit / to selection | canvas-ux |
| Ctrl/Cmd+0 (Shift+0 kept) | zoom to 100% (browser zoom untouched) | canvas-ux |
| Ctrl/Cmd+Shift+L (bare Shift+L removed) | lock/unlock, keeps the selection | canvas-ux |
| PgUp / PgDn (] [ kept); Shift+PgUp / Shift+PgDn (Alt+] Alt+[ kept) | front / back; one step | canvas-ux |
| M | show/hide minimap | canvas-ux |
| Ctrl/Cmd+F | board search (also while editing text: document capture listener) | canvas-ux |
| printable key with exactly one unlocked note selected | type-to-edit (appends) — takes precedence over single-key shortcuts, as COL-04 specifies | canvas-ux |
| C | comment tool (action `dr-comments-select-tool`; tldraw ignores the `comment` tool's own kbd without licensed commenting) | comments |
| Shift+C | show/hide comment markers (this user) | comments |
| Ctrl/Cmd+Alt+Enter | present | present-export |
| Ctrl/Cmd+Shift+C | copy as PNG (tldraw's key, rerouted to our export pipeline) | present-export |
| Ctrl/Cmd+P | PDF export dialog (tldraw's `print`, relabelled) | present-export |
| while presenting: → ↓ Space PgDn / ← ↑ PgUp / Home End / G / Esc | slides; all other board keys are blocked | present-export |
| Ctrl/Cmd+E (dashboard) | focus board search | dashboard-share |
| Alt/Option+Shift+M | start a mind map (the selected note/text/shape becomes its central topic; nothing selected: a new map) | mindmap (wave 4) |
| with one mind-map topic selected or being typed in: Tab / Enter / Shift+Tab | add child / add sibling / move up a level (read in mindmap's capture listener, not tldraw kbds; they shadow no action or tool) | mindmap (wave 4) |
| with one topic selected: ← → ↑ ↓, F2, printable keys | move through the map (replaces nudging for topics), edit, type-to-edit (appends; RETRO-02 exception) | mindmap (wave 4) |

- Presentation: present-export sets `html[data-dr-presenting]`. Comments hides its whole layer then (integration fix: pins showed on slides); workshops hides its prompts, bars and toasts but keeps the user's own dots, revealed result badges and a floating timer (FAC-03); canvas-ux hides its selection bar.
- tldraw component slots: canvas-ux owns `Toolbar`, `NavigationPanel`, `StylePanel`, `KeyboardShortcutsDialog`, `ContextMenu` (validation phase: tldraw's menu plus "Unlock all" while the page has locked shapes); present-export owns `CollaboratorCursor`; BoardPage keeps `SharePanel: null` and `InFrontOfTheCanvas`. Dock panels: `search`, `frames`, `templates` (canvas-ux), `comments`, `voting` (workshops), `history`.

## 2. Features and owners

### canvas-ux (web only: `apps/web/src/features/canvas-ux/**`)
Checklist: COL-01..08, MAK-01..13, PRE-04..06, WRK-02 (people "+N" — as a TopBarItem is not needed; skip unless cheap), PRF-02 (raise `maxShapesPerPage`), PRF-09 (no tours/popups).
- Miro keyboard parity via `overrides` (verify tldraw 5.4.2 action/tool ids and `kbd` format in node_modules/tldraw/src): L = arrow/connector (keep A), Alt+1 zoom to fit, Alt+2 zoom to selection, Ctrl/Cmd+0 zoom 100%, Ctrl/Cmd+Shift+L lock/unlock, PgUp/PgDn bring to front/send to back (Shift for one step), M toggle minimap, Ctrl/Cmd+F board search panel, Shift+C (reserved for comments — do not bind). Update the keyboard-shortcuts dialog labels accordingly.
- Alignment guides on by default (verify the user-preference `isSnapMode` and how to default it without overriding an explicit user choice), `options.maxShapesPerPage` ≥ 10000.
- Type-to-edit on a single selected note (COL-04: decide append vs replace, document it).
- Bulk paste (COL-05): an external-content handler for multi-line/TSV/CSV text asking "Paste as sticky notes or as text?" (small inline prompt), using `@draftroom/board-ops` `notesFromText` at the paste point/viewport center; all created notes selected; one undo; truncation notice beyond the cap. Must not break single-line text/URL paste.
- Note palette (COL-06): Draftroom's own ≥12-colour sticky palette via tldraw theme/colour overrides if 5.4.2 supports it (verify); WCAG AA text contrast on every colour.
- Toolbar (COL-07): Select, Hand, Note, Text, Shape, Pen/draw, Arrow (connector), Frame, Insert file, plus slots for Comment (comments feature adds its tool) and Templates (this feature adds a Templates tool/button that opens a template picker in the dock and inserts `@draftroom/templates` at the viewport centre, selected, one undo — PRE-02/03).
- Minimap (MAK-11) visible/toggleable; zoom menu shows %, fit, selection, 100%.
- Frame outline panel (MAK-13, dock panel id `frames`): `frameOutline`/`presentationOrder` from board-ops; click → zoom to frame; drag to reorder writes `meta.presentationIndex` on frames (one undo); "Auto-order" button; skip toggle writes `meta.presentationSkip`.
- Board search panel (MAK-12, dock id `search`, Ctrl/Cmd+F): `searchBoard` from board-ops, results with snippets, Enter/click zooms to the shape and selects it, highlight matches / dim non-matches on canvas while the panel is open.
- Copy link to selection/frame (PRS-04 part): tldraw deep links (`options.deepLinks`, `editor.createDeepLink` — verify), opening such a link zooms there.
- Start view (PRE-06): a board opens on the user's last camera for that board (localStorage per board+user), else zoom-to-fit content; never an empty viewport when content exists.
- Test ids: `bulk-paste-prompt`, `bulk-paste-notes`, `bulk-paste-text`, `template-picker`, `template-option[data-template-id]`, `frame-outline`, `frame-row[data-frame-id]`, `frames-auto-order`, `search-input`, `search-result[data-shape-id]`, `copy-link-selection`.
- DEVIATION: copy-link uses `Editor.createDeepLink` / `navigateToDeepLink` with the param `d` (removed after navigating), NOT `options.deepLinks`, which rewrites the address bar on every camera move and would fight the per-user camera restore and `?template=`.
- DEVIATION: type-to-edit APPENDS (caret at the end; Enter still selects all text, so "Enter, then type" replaces). Bulk paste offers notes or text, not "grid/table". Search covers the current page, no tag filter (no tags yet), no comment text.
- DEVIATION: the Templates toolbar entry is a pseudo-tool `dr-templates` (test id `tools.dr-templates`) that toggles the `templates` dock panel. Extra actions: `dr-board-search`, `dr-toggle-minimap`, `dr-copy-link`. `toggle-lock` keeps the locked selection selected. Lock is enforced by tldraw on the client only.
- Extra test ids: `frame-row` children `frame-skip`, `frame-copy-link`; `search-filter[data-filter]`, `search-highlights[data-match-count]`; `note-palette`, `note-color[data-color]`; `bulk-paste-notice`; `canvas-ux-overlay`; selection bar `align-*`, `distribute-*`.

### comments (API `features/comments` + `0002_comments` + web `features/comments`)
Checklist: REV-01..06 (email notifications: not available — in-app only; say so in the UI copy).
- Tables: `comment_threads(id thr_, workspace_id, board_id, anchor jsonb, status open|resolved, created_by, created_at, updated_at, resolved_by, resolved_at)`, `comments(id cmt_, thread_id, workspace_id, board_id, author_id, body text ≤ 5000, created_at, edited_at, deleted_at)`, `comment_mentions(comment_id, user_id)`, `comment_reads(thread_id, user_id, read_at)`, `notifications(id, workspace_id, user_id, kind mention|reply|resolved|access_request, board_id, thread_id null, comment_id null, actor_id, created_at, read_at)`.
- Anchor: `{ kind: 'point', x, y }` | `{ kind: 'shape', shapeId, u, v }` (u,v ∈ [0,1] relative to the shape's page bounds) | `{ kind: 'asset', shapeId, assetId, versionId, page?, timeMs? }`. Validated with zod.
- Routes: `GET /api/boards/:bid/threads?status=open|resolved|all` (view), `POST /api/boards/:bid/threads {anchor, body}` (comment), `POST /api/threads/:tid/comments {body}` (comment), `PATCH /api/comments/:cid {body}` (author only), `DELETE /api/comments/:cid` (author or board owner; soft), `POST /api/threads/:tid/{resolve,reopen}` (comment), `POST /api/threads/:tid/read` (view), `GET /api/me/notifications`, `POST /api/me/notifications/read {ids}`. Mentions: body tokens `@[Display Name](usr_…)`; only users who can view the board are notified (others are ignored server-side); authorship from the session.
- Events (after commit): `comments.thread` `{ thread }` (full thread incl. comments; visible to every viewer anyway), `comments.deleted` `{ threadId, commentId }`.
- Web: a Comment tool (C) — click a shape to anchor to it (moves with the shape), click empty canvas for a point pin; composer (Enter posts, Shift+Enter newline, draft survives closing); pins overlay with unread/read/resolved/mentioned states; hover preview; thread popover with replies, edit/delete own, resolve/reopen; dock panel `comments` with filters (open, resolved, mine, mentions), click → zoom + open; Shift+C toggles pins (per user); @mention autocomplete from board members (`GET /api/boards/:bid/members`); orphaned threads (shape deleted) listed as "on a deleted object" and re-attach if the shape returns; a notifications bell TopBarItem with unread count. Commenters can use all of this while the canvas is read-only.
- Test ids: `comment-tool`, `comment-pin[data-thread-id][data-state]`, `comment-composer`, `comment-submit`, `thread-popover`, `comment-item[data-comment-id]`, `thread-resolve`, `thread-reopen`, `comments-panel`, `comments-filter`, `mention-option[data-user-id]`, `notifications-bell`, `notification-item`.
- DEVIATION: the StateNode/tool id is `comment` (registered at runtime with `editor.root.addChild`); C is bound through the action `dr-comments-select-tool` because tldraw 5.4.2 skips the kbd of a tool named `comment` unless its licensed commenting is on. Shift+C = action `dr-comments-toggle-pins`. Both work on read-only canvases.
- DEVIATION (additive): point anchors carry an optional `pageId`; shape anchors' u,v are relative to the shape's own geometry bounds mapped through its page transform (equal to the page bounds when unrotated). `comment_mentions`/`comment_reads` also carry `workspace_id`; every table has a `seq` identity column; `notifications.id` defaults to `'ntf_' + 32 hex` so other features insert without an id.
- DEVIATION (route details): `GET /threads` defaults to `status=all` and returns `{threads, reads}`; create/reply return 201 `{thread}`; resolve/reopen are idempotent (event only on change); `DELETE /api/comments/:cid` → 204; `POST /threads/:tid/read` also marks that thread's notifications read; `GET /api/me/notifications` → latest 100 across boards, access re-checked on every read, `?unread=1`; `POST /api/me/notifications/read` takes `{ids}` or `{all:true}`. Replying to a resolved thread reopens it. 120 writes/min per user (429).
- Email notifications are not built (in-app only; the UI says so). "Invite with Share" and access-request notifications dispatch `draftroom:open-share` (BoardPage listens).

### history (API `features/history` + `0003_history` + sync changes + web `features/history`)
Checklist: REV-07, REV-08, DSH-02 (duplicate), DSH-03 (restore has content+files), PRS-06 export archive part, build plan §7 backups.
- Tables: `board_snapshots(id snp_, workspace_id, board_id, name, kind manual|auto|pre_restore, created_by, created_at, document_clock bigint, record_count, size_bytes, storage_key)`, `board_asset_links(workspace_id, board_id, asset_id, version_id, created_at, pk(board_id, asset_id, version_id))` — **extend the file authorizer** (`apps/api/src/files-auth.ts` is yours this phase) so an asset is viewable on board B if `meta.boardId === B` OR a link row exists for (B, asset, version) in the same workspace.
- Snapshot storage: `${DATA}/snapshots/<boardId>/<snp>.json` (object-storage stand-in), written atomically.
- Routes: `GET /api/boards/:bid/snapshots` (view), `POST /api/boards/:bid/snapshots {name}` (edit) → sync snapshot → stored, `POST /api/snapshots/:sid/restore-as-new {title?}` (view on source + member of workspace) → new private board owned by caller, seeded via `ctx.sync.seed`, asset links copied, never inherits grants/links (PRF-08), `POST /api/boards/:bid/duplicate {title?}` (view + member) → same as snapshot-now + restore-as-new, `GET /api/boards/:bid/export` (view) → `BoardArchiveV1` (board-ops `exportBoardArchive`, asset refs from the file store), `POST /api/workspaces/:wid/boards/import` (member; JSON ≤ 25 MB) → `importBoardArchive` → new private board seeded; imported asset refs that the caller can view in this workspace get links, others are dropped with a warning.
- Recently deleted (REV-07), in **apps/sync** (you own `apps/sync/src/rooms.ts`, `apps/sync/src/http/internal.ts` and new `apps/sync/src/deleted/**` this phase; NOT `config.ts`/`app.ts` upgrade handling, which platform owns): capture the `prev` record of every committed shape delete (compose with the existing lease `authorizeRecord`: lease veto first; record only if allowed) into a per-board SQLite side table in the same board database (never touching tldraw's tables), bounded (last 1,000 + this session), including its bindings; internal endpoints `GET /internal/boards/:bid/deleted` and `POST /internal/boards/:bid/deleted/restore {ids}` (puts records back via a validated storage transaction, restores bindings whose both ends exist, re-parents to the page if the parent is gone). API proxies: `GET /api/boards/:bid/deleted` (edit, since authz-001: the list carries deleted text, so viewers, commenters and review-link guests never see it), `POST /api/boards/:bid/deleted/restore {ids}` (edit).
- Backups: periodic consistent SQLite backups of active boards via `node:sqlite` `backup()` (every 15 min if changed; keep last N) to `${DATA}/backups/<boardId>/…` with a manifest (board id, schema, document clock, sha256) — in sync; plus a scripted restore drill (`pnpm --filter @draftroom/sync backup:restore-drill`) that restores a backup into a clean data dir and checks the records match.
- Web: dock panel `history` (named checkpoints list, "Save checkpoint", "Restore as new board", "Duplicate board", "Recently deleted" list with restore, "Export .json"). Dashboard import/duplicate buttons are the dashboard-share feature's; they call your routes.
- Test ids: `history-panel`, `checkpoint-save`, `checkpoint-row[data-snapshot-id]`, `checkpoint-restore`, `deleted-row[data-shape-id]`, `deleted-restore`, `export-json`.
- DEVIATION: the file authorizer could not do this alone (`serve.ts` compared `meta.boardId` itself): `FileAuthorizer` gained an optional `linkedAsset(req, boardId, {assetId, versionId, ownerBoardId})`, consulted by `serve.ts` only when `meta.boardId` differs (see §1 notes).
- DEVIATION (additive): `board_snapshots.storage_key` has a CHECK tying it to `snapshots/<board_id>/<id>.json`; the deleted-restore response adds `reparented`; `DuplicateBoardInput.keepSharing` (owner only: copies people grants and visibility, never links); import takes the archive as the raw JSON body with optional `?title=&projectId=` (BoardArchiveV1 has no title). Events `history.snapshot {snapshotId}` and `history.deleted {restored}`.
- Not built: checkpoint deletion/retention (cap 500 per board → 409 `SNAPSHOT_LIMIT`), automatic checkpoints (REV-10, P1; the `auto`/`pre_restore` kinds exist). Archives carry files by reference only. Backups: every 15 min when changed + before idle eviction (rooms open ≥ 60 s), newest 12 kept; `pnpm --filter @draftroom/sync backup:restore-drill` runs the drill.
- Extra test ids: `checkpoint-name`, `deleted-select`, `deleted-restore-selected`, `history-duplicate`, `history-keep-sharing`, `history-status`, `history-error`, `history-open-board`.

### present-export (web only: `apps/web/src/features/present-export/**`)
Checklist: PRS-01, PRS-05, PRS-06 (rasterized pages are acceptable if vector text is not achievable with the installed deps — say so honestly in the UI), CSV export.
- Present mode: TopBarItem "Present" + shortcut; fullscreen (Fullscreen API with a fallback), starts at the first frame in `presentationOrder` (board-ops) or the selected frame, →/Space/PgDn next, ←/PgUp previous, skips `meta.presentationSkip`, hides tldraw UI chrome and other users' cursors, shows a small slide counter and exit; Esc exits and restores the previous camera. Animate the camera between frames (respect reduced motion).
- Export menu (TopBarItem or dock panel `export`): PNG (selection / a frame / whole board; 1×/2×/4×; transparent option) and SVG via tldraw's export APIs (verify 5.4.2 names: `editor.toImage`, `exportAs`, `copyAs`); Ctrl/Cmd+Shift+C copies the selection as PNG; PDF = one page per frame in presentation order (or selected frames) using `pdf-lib` (installed) with images rendered from high-resolution sources (`shouldResolveToOriginal` for asset resolution during export — verify how 5.4.2 passes it); CSV via board-ops `boardToCsv`; file names from the board title. Large exports show progress and never freeze the UI for more than a moment (yield between pages).
- Test ids: `present-button`, `present-overlay`, `present-counter`, `export-button`, `export-png`, `export-svg`, `export-pdf`, `export-csv`, `export-scale`.
- DEVIATION: PDF pages are rasters of each frame (3×, from original uploads) with an invisible, searchable/copyable Helvetica text layer (Windows-1252 characters only), not vector text: no installed dependency turns tldraw's HTML-rendered text into PDF text. The dialog says so. pdf-lib runs in a module worker.
- DEVIATION: export is a dialog (`export-dialog`) opened from the top bar, not a dock panel. Present = Ctrl/Cmd+Alt+Enter (action `dr-present`); Ctrl/Cmd+P opens the PDF export; tldraw's own export menu entries and Ctrl/Cmd+Shift+C go through the same pipeline. Present is local (nobody else is taken along), and `components.CollaboratorCursor` is owned by present-export. Every role that can view can present and export (PRS-12 not built).
- Extra test ids: `export-dialog`, `export-area-selection|frame|board`, `export-frame`, `export-transparent`, `export-copy-png`, `export-pdf-summary`, `export-pdf-include-skipped`, `export-progress`, `export-cancel`, `export-status`, `present-prev|next|exit|grid-toggle|grid`, `present-empty-toast`.

### workshops (API `features/workshops` + `0004_workshops` + web `features/workshops`)
Checklist: facilitation items (FAC-* in the checklist), PRF-07 for ballots.
- Tables: `workshop_timers(board_id pk, workspace_id, status running|paused|stopped|finished, duration_ms, started_at, ends_at, remaining_ms, started_by, updated_at)`, `vote_sessions(id vot_, workspace_id, board_id, title, votes_per_person 1..99, one_per_object bool, scope board|frame, frame_id null, status open|closed|revealed, created_by, created_at, closed_at, revealed_at)`, `votes(session_id, user_id, shape_id, count, pk(session_id, user_id, shape_id))`, `vote_done(session_id, user_id)`. Budgets enforced transactionally (`SELECT … FOR UPDATE` on the session row); one open session per board (partial unique index).
- Routes: `GET /api/boards/:bid/workshop` (view) → `{ timer, vote: { session, myVotes, myRemaining, done, participantsDone, totalVotesCast, results | null } }` — `results` only when revealed; before that no other user's ballots are ever returned; `POST /api/boards/:bid/timer {action: start|pause|resume|stop|add, durationMs?, addMs?}` (edit = facilitator); `POST /api/boards/:bid/votes {title, votesPerPerson, onePerObject, scope, frameId?}` (edit), `POST /api/votes/:vid/cast {shapeId, delta: 1|-1}` (view — viewers and commenters participate; one-person-one-vote comes from the signed-in user), `POST /api/votes/:vid/done`, `POST /api/votes/:vid/{close,reveal}` (edit), `POST /api/boards/:bid/summon` (edit) → event only.
- Events: `workshop.timer` `{ timer }`, `workshop.vote` `{ sessionId, status, totalVotesCast, participantsDone }` (aggregates only; clients refetch their own votes), `workshop.vote.results` `{ results }` (only on reveal), `workshop.summon` `{ userId, name }`.
- Web: timer TopBarItem (countdown from server timestamps + `events.serverOffsetMs()`, late joiners correct; facilitator controls: presets, +1m/+5m, pause/resume/stop; a gentle chime + visual flash at zero, mutable); voting: facilitator setup dialog (votes per person, one per object, scope board/frame), participants click notes/shapes to vote (dots overlay on shapes with their own votes, remaining count, "I'm done"), facilitator sees totals/done count, reveal shows counts on shapes + ranked results panel (top 3 then all); "Bring everyone to me" (summon → others follow the facilitator via tldraw follow API until they move; a toast lets them stop).
- Test ids: `timer-pill`, `timer-start`, `timer-pause`, `timer-add-1m`, `timer-stop`, `vote-start`, `vote-setup-dialog`, `vote-dot[data-shape-id]`, `vote-remaining`, `vote-done`, `vote-reveal`, `vote-results`, `summon-button`.
- DEVIATION (additive routes): `GET /api/boards/:bid/votes` (past votes, aggregates only), `GET /api/votes/:vid/results` (revealed only, else 409), `POST /api/votes/:vid/extend {addMs}`. `CreateVoteInput` adds `durationMs?`, `shapeTypes?`; title optional. `POST /done` accepts `{done:false}`; `POST /summon {targetUserId?}` → 202 with a 3 s cooldown (429). `GET /workshop` returns `{timer|null, vote|null, serverNow}`; vote status is effective (an open vote past its end reads as closed). Events add `participants`, `endsAt`, `sessionId`, `targetUserId`.
- DEVIATION: schema adds `vote_sessions.shape_types`/`ends_at`; votes/vote_done carry `workspace_id`; timer `finished` is derived from `ends_at` at read time. Eligibility (`isVoteEligible` in contracts) is checked server-side against the sync snapshot and fails closed (503). No "selection" scope and no draft ("Save for later") status. Stop-following on a plain canvas click applies to every follow. Dock panel id `voting`.

### dashboard-share (web `apps/web/src/dashboard/**`, `apps/web/src/board/ShareDialog.tsx`, `apps/web/src/features/sharing/**`, `apps/web/src/invite/**`, `apps/web/src/ui/screens.tsx` (NoAccessScreen request-access), API `features/dashboard` + `0005_dashboard`)
Checklist: PRE-01, DSH-01..03, PRS-02..04, and review links.
- Tables: `board_stars(user_id, board_id, workspace_id, created_at)`, `access_requests(id, workspace_id, board_id, user_id, role_requested, status pending|approved|denied, created_at, decided_by, decided_at)`, `invitations.multi_use boolean default false` + `max_uses` (review links; ALTER in 0005).
- Routes: `PUT/DELETE /api/boards/:bid/star` (view), starred in `GET /api/workspaces/:wid/boards` (add `starred: boolean` via a contracts extension — do it in `packages/contracts/src/dashboard.ts` as a new response schema rather than changing M1's), `GET /api/workspaces/:wid/boards/starred`, move to project (`PATCH` exists), `POST /api/boards/:bid/access-requests {role}` (signed-in, no access required; rate-limited; creates a notification for board owners — insert into the comments feature's `notifications` table if present, otherwise just the request row; the Share dialog lists pending requests to approve/deny), `GET /api/boards/:bid/invitations` (manage_access; lists pending links incl. review links so they can be revoked), multi-use review links (role viewer|commenter, expiry ≤ 30 days).
- Web dashboard: grid/list toggle, Starred section + star toggle on cards, board card menu adds duplicate (calls history `POST /api/boards/:bid/duplicate`), move to project, share, details; New board → template picker (Blank prominent + the six templates with names/descriptions/section previews, search, categories; "Don't show on new boards" per-user preference in localStorage); creating from a template navigates to the board with `?template=<id>` and the **board page inserts it once** on first open when the board is empty (implement in `features/sharing`? no — implement in the canvas-ux template inserter is canvas-ux's; coordinate by URL param contract: canvas-ux reads `?template=` and inserts, then removes the param); Import board (.json) button → history import route; Trash shows "deleted boards stay here until restored" (no purge yet).
- Board header sharing-state badge (PRS-03) as the `sharing` feature's TopBarItem: Private / Workspace can view|edit / Link: role, expires …; click opens the Share dialog (expose a way: the Share dialog is rendered by BoardPage — the badge opens it by dispatching a DOM CustomEvent `draftroom:open-share` that you listen for inside ShareDialog's host… simplest: you may edit BoardPage ONLY to add that event listener next to `setSharing`).
- Share dialog: invite by handle/email field (email is display-only: no mail is sent — say "copy the link to send it"), roles incl. transfer ownership, workspace-wide access select, list of who has access and through which grant, pending access requests (approve/deny), review links (create/copy/revoke, expiry).
- NoAccessScreen: "Request access" (role) when signed in.
- Test ids: `view-toggle`, `board-star[data-board-id]`, `starred-section`, `new-board`, `template-gallery`, `template-card[data-template-id]`, `template-blank`, `import-board`, `card-duplicate`, `card-move`, `share-badge`, `access-request-button`, `access-request-row[data-user-id]`, `review-link-create`, `review-link-row`.
- DEVIATION (test ids): the New board button keeps M1's `create-board`; `card-duplicate`/`card-move` are `[role=menuitem][data-action=duplicate|move]`; dialogs `duplicate-dialog`, `move-dialog`. The M1 dashboard e2e card-menu lists were updated for the new items (integration).
- DEVIATION: `starred` on M1's `GET /api/workspaces/:wid/boards` is added by a root `preSerialization` hook (routes/boards.ts untouched). Review links reuse M1's unchanged accept route; a `BEFORE UPDATE OF redeemed_by` trigger in 0005 records each use in `invitation_redemptions`. Review-link tokens are HMAC(ticket-secret-derived key, id) so managers can copy them again. Workspace-wide "comment" access is NOT available (the visibility enum is M1's). Review links require signing in (no anonymous visitors, no password).
- Integration fix: the card menu (ten items) slid under the next row of cards because the hover lift makes a card a stacking context; a click on "Duplicate…" opened the board underneath. `dashboard.css` now raises a card with an open menu.
- Added route (invite by email; supersedes "no mail is sent" above when the server signs in with Clerk): `POST /api/boards/:bid/invitations/email {email, role: editor|commenter|viewer}` (manage_access, Origin-checked, 20 per inviter per hour → 429; schemas `EmailInviteInput` / `EmailInviteResult` in `packages/contracts/src/dashboard.ts`; code `features/dashboard/email-invites.ts` + `clerk-directory.ts`). Answers one of three modes. `granted` (200): the address is a VERIFIED address of a Clerk account that already has a Draftroom identity (`identities` clerk + Clerk user id); they get the role now like `PUT …/members/:uid` (guest membership for an outsider, `board.member.put` audit with `via: 'email_invite'`, access-changed push), but an invite never lowers a role. `emailed` (201): a normal single-use board invitation (M1 `createInvitation`, 7 days, audit `via: 'email'`) whose link is the `redirectUrl` of Clerk's `invitations.createInvitation({ emailAddress, redirectUrl, notify: true, ignoreExisting: true, expiresInDays: 7 })`; the link is not returned. `link` (201, `reason`): no email went out — `email_not_configured` (dev provider), `existing_account` (a Clerk account without a Draftroom identity; Clerk is not called), `invalid_email` / `rate_limited` / `provider_error` (Clerk refused or failed; a failed lookup also sends nothing); the single-use link is for the inviter to send. Clerk error text never reaches the client or the logs (log lines carry the address domain, a keyed hash, Clerk status/codes/trace id). **UNVERIFIED against a live Clerk instance** (fake Backend API in `apps/api/test/features/dashboard/email-invites.test.ts`). Web: Share dialog "Invite by email" section (`share-email-input`, `share-email-role`, `share-email-submit`, `share-email-error`, `share-email-hint`, `share-email-result[data-mode=granted|emailed|link]`, `share-email-link`, `share-email-copy`); e2e `e2e/tests/invite-email.spec.ts` (link mode).

### platform (hardening; `apps/api/src/config.ts`, `apps/sync/src/config.ts`, `apps/sync/src/app.ts` upgrade/Origin handling, `apps/web/src/board/ticket.ts`, `render.yaml`, `docker/**`, `docs/DEPLOY.md`, `.env.example`)
Resolve the deploy-config blockers from milestone 1 (docs/DEPLOY.md):
- Production refuses loopback defaults for `DRAFTROOM_SYNC_INTERNAL_URL` / `DRAFTROOM_API_INTERNAL_URL` and requires `PUBLIC_ORIGIN` explicitly; accept `host:port` (Render `hostport`) and build the URL.
- `TRUST_PROXY` (api) config wired into Fastify so rate limits key on the real client; documented for Render.
- Web: optional build-time `VITE_DRAFTROOM_SYNC_ORIGIN` so the board WebSocket can go to a separate sync origin (Render static sites cannot proxy WebSockets); sync: `ALLOWED_ORIGINS` allowlist checked before upgrade (required in production; tickets remain the authentication).
- `render.yaml` + DEPLOY.md updated to the chosen topology; re-validate against Render's schema; Docker images rebuilt and smoke-run on the NAS again (same isolation and cleanup rules as milestone 1).
- Tests for every config rule.

## 3. As built (features-integration, 2026-09-27; verified in browsers in the validation phase, 2026-09-27)

Status per checklist ID (`docs/research/miro-ux-checklist.md`), proven by the browser suite in `e2e/tests/` (spec › test title, abbreviated to its leading clause). The whole suite (113 tests, 13 files, real api + sync + worker per stack, one Playwright worker) passed three consecutive full runs with the final code (113/113 each, 7.7 min) and once more inside `pnpm verify`; the series before the last two fixes was 113/113, 112/113 (saving › "an image stays…", fixed below), 113/113. Every scenario of docs/E2E-PLAN.md is mapped to its test there. This replaces the integration smoke-run table (53/53 manual checks in `pnpm dev`), whose findings are all covered below.

Legend: **Verified** = asserted end to end in the browser (two browsers, a fresh context or the API where it matters) · **Partial** = verified except the stated part · **Built, no e2e** = unit/API tests only · **Not built** · **FREE** = tldraw 5.4.2 default this phase did not change, not re-verified.

### canvas-ux

| ID | Status | Evidence | Gaps / deviations |
|---|---|---|---|
| COL-04 | Verified | canvas-ux › "type-to-edit" | Appends (caret at the end), documented |
| COL-05 | Verified | canvas-ux › "bulk paste: a 3×3 spreadsheet selection…", "bulk paste: "Text"…", "bulk paste cap" | Offers notes or text, no "grid/table" |
| COL-06 | Verified | canvas-ux › "note palette" (13 colours, rendered fill, one undo); contrast in `palette.test.ts` | |
| COL-07 | Verified | canvas-ux › "toolbar layout pin" (ids in order + snapshot) | Snapshot baseline made on Windows |
| PRF-09 | Partial | canvas-ux › "toolbar layout pin" | "No tours or pop-ups" is not asserted by a test |
| MAK-02 | Verified | canvas-ux › "alignment" (on by default, snaps, Ctrl disables, explicit off survives reload) | |
| MAK-03 | Verified | canvas-ux › "alignment" (align-* with 2, distribute-* with 3, one undo) | |
| MAK-05 | Verified | canvas-ux › "two-browser lock" (B sees it within 2 s; B's drag and Delete do nothing, fresh context too; Menu → Unlock all; right-click → Unlock all) | Lock is enforced by the clients (tldraw), not the server |
| MAK-06 | Verified | canvas-ux › "Miro keys" | |
| MAK-07 | Partial | canvas-ux › "Miro keys" (L = connector), "templates in a board" (bound arrows follow) | Binding to images/text and Ctrl-to-not-bind not tested |
| MAK-10 | Verified | canvas-ux › "Miro keys" (Alt+1, Alt+2, Ctrl+0 with devicePixelRatio 1) | |
| MAK-11 | Partial | canvas-ux › "Miro keys" (M shows/hides the minimap) | Clicking/dragging inside the minimap not tested |
| MAK-12 | Verified (deviation) | canvas-ux › "board search" | Current page only, no tag filter (no tags), no comment text; Esc keeps the camera on the last result |
| MAK-13 | Verified | canvas-ux › "frame outline" (bob sees the reorder within 2 s) | |
| PRE-02 | Verified | canvas-ux › "templates in a board"; `packages/templates` tests (plain editable shapes) | |
| PRE-03 | Verified | canvas-ux › "templates in a board" | |
| PRE-06 | Verified | canvas-ux › "start view", "?template= on first open" | |
| PRF-02 | Partial | canvas-ux › "heavy board" (4,500 + 500 pasted notes = 5,000, on the server too) | Frame rate while panning and the 200 images not measured |
| PRS-04 (copy link) | Verified | canvas-ux › "copy link" | |
| WRK-02 | Not built | | Searchable people list |
| COL-01..03, COL-08, MAK-01, MAK-04, MAK-08, MAK-09, PRE-04, PRE-05 | FREE | | |

### comments

| ID | Status | Evidence | Gaps / deviations |
|---|---|---|---|
| REV-01 | Verified | comments › "commenter on a read-only canvas", "pin follows its shape", "a point pin on page 2" | |
| REV-02 | Verified | comments › "resolve and reopen", "edit and delete" | |
| REV-03 | Verified | comments › "pin states are per person", "mention" | |
| REV-04 | Verified | comments › "resolve and reopen" (Resolved filter), "pin states are per person" (Mine, Mentioning me), "mention" (click → zoom + open) | |
| REV-05 | Partial | comments › "mention", "mention without access", "notifications across boards" | In-app only; no email (the UI says so) |
| REV-06 | Verified | comments › "orphaned thread" (undo and Recently deleted re-attach it) | |
| (contract) drafts, Shift+C, viewer, hover preview, deep link | Verified | comments › "drafts", "Shift+C hides comment pins", "viewer", "hover preview and deep link", "after posting, Esc leaves the thread…" | |
| REV-09, FIL-11 UI | Not built | | Also not built: re-anchor by drag, Alt+C, reactions |

### history

| ID | Status | Evidence | Gaps / deviations |
|---|---|---|---|
| REV-07 | Verified | history › "recently deleted frame", "…note and connector" (multi-select), "…note whose frame is gone", "…files", "live list", "sync SIGKILL and restart" | |
| REV-08 | Verified | history › "checkpoint round trip" | |
| PRF-08 | Verified | history › "checkpoint round trip" (private, bob 404), "duplicate from the history panel" (no links copied) | |
| DSH-02 (duplicate) | Verified | history › "duplicate from the history panel", "duplicate from the dashboard card menu"; dashboard-share › "card menu" | Default names differ: panel "Copy of X", dashboard "X (copy)" |
| DSH-03 | Verified | history › "trash restore keeps content and files"; dashboard-share › "trash explains…"; dashboard › "dashboard: create, search, rename, archive, trash and restore" | No purge after 30 days (not built) |
| PRS-11 | Verified (deviation) | history › "export .json and import it"; dashboard-share › "import" | Files travel by reference only |
| Backups (build plan §7) | Verified | history › "backup restore drill"; automatic backups: `apps/sync/test/backup/backup.test.ts` only | |
| REV-10 | Not built | | Also: checkpoint deletion/retention |

### present-export

| ID | Status | Evidence | Gaps / deviations |
|---|---|---|---|
| PRS-01 | Verified | present-export › the seven "present: …" tests | Swipe and transition animation not asserted |
| PRS-05 | Verified | present-export › "PNG and SVG export", "context menu: tldraw's own Export as…", "copy as PNG" | |
| PRS-06 | Partial | present-export › "PDF export: one frame-sized page per slide…", "Ctrl+P opens the PDF export…" | Raster pages (3×, originals) + searchable text layer, not vector text (the dialog says so) |
| PRS-07 | Partial | present-export › "present: Ctrl+Alt+Enter starts at the selected note's frame, the slide list jumps…" | "Invite everyone to join" not built |
| PRS-10 | Partial | present-export › "PDF export…" (bookmarks = frame names) | Embedded PDF pages are not re-rendered |
| PRS-13 | Partial | present-export › "CSV export" | No tags column (no tags) |
| PRS-12 | Not built | | Also: presenter follow/hand-off |
| (integration) presenting is clean | Verified | present-export › "presentation is clean" | |
| (integration) event stream after an api restart | Verified | present-export › "event stream survives an API restart" | Fixed in this phase (below) |

### workshops

| ID | Status | Evidence | Gaps / deviations |
|---|---|---|---|
| PRF-07 (ballots) | Verified | workshops › "ballot privacy" (DOM, every /api body, every SSE event and the canvas socket's presence, 3 browsers) | Private drafts and hidden frames are not built, so only the ballot part applies |
| FAC-02 | Verified | workshops › "gather everyone" | |
| FAC-03 | Verified | workshops › "timer sync", "time's up" | The ± stepper and +5 min buttons not tested; editors are facilitators by design |
| FAC-04 | Partial | workshops › "vote setup" (frame scope, one per object, notes only; the server refuses the rest) | No "selection" scope, no "Save for later"; timed votes not tested in the browser |
| FAC-05 | Verified | workshops › "ballot privacy", "vote setup" (join prompt, click to vote, budget, "I'm done") | Skip-then-join-later not tested |
| FAC-06 | Verified | workshops › "ballot privacy" (reveal, ranked results, CSV), "end without results" | Top-3 cut / "See all" not exercised |
| FAC-01 | Partial | workshops › "gather everyone" (following) | No "who follows me" indicator |
| FAC-07..FAC-10 | Not built | | Also: per-person "Bring to me" UI |

### dashboard-share

| ID | Status | Evidence | Gaps / deviations |
|---|---|---|---|
| PRE-01 | Verified | dashboard-share › "new board from the template gallery", "Don't show templates on new boards", "a viewer opening ?template=…", "leaving a board right away keeps its last changes" | |
| DSH-01 | Verified | dashboard-share › "stars"; dashboard › "dashboard: create, search, rename…" | |
| DSH-02 | Verified | dashboard-share › "card menu" (order, stacking, duplicate/move/details/share/copy link) | |
| DSH-03 | Verified | see history | |
| DSH-04 | Built, no e2e | | Sort/filter (`dashboard-sort`) |
| DSH-06 | Verified | dashboard-share › "grid/list toggle" (Ctrl+E) | |
| PRS-02 | Partial | dashboard-share › "invite" | No workspace-wide "comment"; no email is sent (the UI says so) |
| PRS-03 | Verified | dashboard-share › "share badge" (live for another viewer) | |
| PRS-04 | Verified | dashboard-share › "request access", "request access variants", "a viewer asks for edit"; canvas-ux › "copy link" | |
| PRS-08 | Partial | dashboard-share › "review link: two outsiders join…", "review link revoked without removing access" | Sign-in required; no password or named visitors; expiry sweeper API-tested only |
| (contract) transfer ownership, removal note | Verified | dashboard-share › "transfer ownership", "removal note" | Transfer to a guest is allowed (product question) |
| DSH-05 | Not built | | Thumbnails; email |

### platform, collaboration quality, and the M0/M1 suites

| ID | Status | Evidence | Gaps / deviations |
|---|---|---|---|
| Separate sync origin, Origin allowlist | Verified | dashboard-share › "separate sync origin › board sockets go straight to the sync origin…", "…a sync origin with a path…" (the whole file runs with ALLOWED_ORIGINS) | Render itself unverified; Clerk and tldraw license keys need the user |
| WRK-03 | Verified | saving › the eight tests ("each edit shows Saving… then Saved", "with the sync server killed…", forged write, lease veto, presence-only, viewer/commenter, upgrade, image upload) | Terminal 4099 state not forced in a browser |
| WRK-05 | Verified | conflicts › the seven "WRK-05: …" tests | Undo under concurrency not exercised per tool (paste, rotate, crop…) |
| WRK-04 | Verified | conflicts › "text lease" | |
| WRK-06 | Partial | canvas-ux › "toolbar layout pin" (a viewer has no Templates or note tool); saving › "a viewer and a commenter see "View only"…"; permissions › "shared as viewer…"; comments › "viewer" (read-only notice) | Why-disabled explanations on each tool not checked |
| PRF-05 | Verified | collab-lifecycle › "3) SIGKILLed sync server…"; network-interruption; saving › "with the sync server killed…"; history › "sync SIGKILL and restart" | |
| PRF-06 | Verified | permissions › "shared as viewer…", "a user from another workspace…"; every feature's forged-POST checks | |
| FIL-01..05 | Partial (M0) | files › "6) custom dr-file-card…", "7) uploads…", "7) video card plays the original MP4…" (branded Chrome) | M0 scope; size/count limits and 10 % zoom loads not re-measured |
| WRK-01 | Partial | collab-lifecycle › "1) two sessions see one another and their edits" | The 250 ms p95 is not measured |

### Validation-phase changes (2026-09-27)

Bugs the browser suites found, fixed at the root. Each integration fix below was checked by removing it and watching its test fail; the feature engineers' fixes (last bullet) are evidenced in their reports.
- **Event stream never recovered after the api died** ([integration] P0). The vite proxy (dev and preview) ended a proxied response only if its headers were not sent yet, so a streaming SSE response stayed open forever after a SIGKILL, and the api's heartbeat was an SSE comment the page cannot see. Fixes: `apps/web/vite.config.ts` aborts a half-sent response when the upstream fails; `apps/api/src/events/routes.ts` pings with a data event; `apps/web/src/features/events.ts` replaces a stream silent for 40 s (covers proxies we do not control, e.g. the Render rewrite). The test's `test.fail` marker is gone.
- **Leaving a board within a second of an edit lost it.** Alone on a board, tldraw sends at most once a second and unmounting the sync client drops what is unsent; in-app navigation (the "Back to <workspace>" link, a notification for another board, the browser Back) unmounted it at once. Seen as a template inserted on a new board that was gone when the board was reopened. Fix: `apps/web/src/lib/routing.ts` gained a leave guard (`setLeaveGuard`; it holds `navigate()` and back/forward), and `BoardPage.tsx` holds the navigation until the save tracker says nothing is unsent or in flight (bounded to 5 s; offline changes are not waited for). Test: dashboard-share › "leaving a board right away keeps its last changes" (was `test.fixme`).
- **MAK-05 "right-click > Unlock all" was missing** (tldraw 5.4.2's canvas menu has none). `apps/web/src/features/canvas-ux/ContextMenu.tsx` (slot `ContextMenu`, added to the slot map in `keyboard-map.test.ts`).
- **Esc right after clicking a comment pin left the thread open** (seen once as a flake in comments › "drafts": `thread-popover` still 1). The popover takes the focus on the next frame; until then the pin has it, and an Esc on a pin went to tldraw, whose cancel closes threads only in the comment tool. `features/comments/CommentsOverlay.tsx` now closes the open thread on that Esc (and hands the focus to the board). Deterministic test: comments › "after posting, Esc…" step "Esc right after a pin opens its thread…".
- Test-side: `e2e/tests/support/comments.ts` `waitForSaved` now waits two frames before reading the indicator (it could read the "Saved" from before the edit it was meant to cover), like canvas-ux's helper. saving › "an image stays "Saving…" until its bytes are uploaded" failed once in a full run: after the upload the app also writes the worker's preview status into the asset record (`watchImagePreview`), a second save that sometimes lands just after the first; the test now waits for it and accepts that one extra Saving… → Saved (still never "Saved" while the upload is held).
- From the feature validation engineers (their reports): viewer/commenter user-record loop (no `currentUser` for read-only roles), per-property undo adopted (WRK-05) plus a guard for a tldraw rebase that wiped the redo stack (`sync-quality/rebaseGuard.ts`), "Saving…" while an image uploads, the start view's result on `canvas-ux-overlay[data-start-view]`, comment Esc/focus (the smoke run's "left as is" item is fixed: `focusBoard` in `features/comments/controller.ts`), restore summary counting connections not binding ends, PNG exports with exactly one pHYs chunk (`present-export/png-density.ts`; tldraw's `setPhysChunk` added a second), workshops click-to-vote no longer selecting (ballots leaked through selection presence), a new vote startable after "End without results", the workshop timer offset from round trips (the event stream's offset is one-way), live `sharing.changed` events for M1 visibility/member changes, the open Share dialog refreshing on them, and `importTitle` for `<title>.draftroom.json`.

New test ids, attributes and events since the table in §2: `save-status[data-state=connecting|saved|saving|offline|offline-pending|rejected|error|unsupported|readonly]` (labels "Saved", "Saving…", "Offline", "Offline — changes will sync", "Change not saved", "Not saved — connection ended", "View only"; the title is the tooltip), `save-rejected-toast`, `undo-notice`, `canvas-ux-overlay[data-start-view=template:<id>|deep-link|restore|restore+fit|fit|none|failed]`, `context-menu.unlock-all`; api event `sharing.changed {reason: 'visibility'|'grant'}`; window event `draftroom:share-remote-changed`; SSE `{type:'ping'}`. Workshops behaviour: while a participant is voting, a plain click on an eligible object only votes (Shift+click/drag selects and moves); the countdown never shows more than the server's last `remainingMs`.

Still open (decisions, not defects): the viewer sees "View only" twice (role pill and save status); duplicate default names differ ("Copy of X" in the History panel, "X (copy)" on the dashboard); a review-link guest can be made owner; other people's cursors stay visible during a vote; plain drags on eligible objects do not move them while voting. Not covered anywhere yet: Firefox/Safari, touch, phone width (the top bar overflows), hidden tabs, real network latency.

### Persona-review fixes (2026-09-27)

Four Miro-user persona reviews (facilitator, creative director, client reviewer, performance) produced 78 findings, and four fix batches followed. The findings, their final status and the measured performance gates are in [`docs/REVIEW-2026-09-27.md`](REVIEW-2026-09-27.md). New browser tests live in `e2e/tests/canvas-ux.fix.spec.ts`, `facilitation-review.fix.spec.ts`, `shell-sharing-platform.fix.spec.ts` and `files.spec.ts` (F1–F7a), each titled with its finding ID. The suite grew from 113 to 152 tests. Checklist rows whose status changed:

| ID | Status now | Evidence | Gaps / deviations |
|---|---|---|---|
| FIL-06 | Verified | files › "F1/F2 uploads with the view on "3 · Imagery"…" (grid, on-screen size, inside a frame or on the page, one undo, Alt+1, a second user's first view) | Upscaling is capped at 2× native; Ctrl+U never fills a template slot, only a real drop/paste point does |
| FIL-01..05 (errors, previews) | Verified | files › "F4 previews in progress…" (0 `/original` while processing), "F5 bad files together…", "F6 a frame grab dropped on a Storyboard slot…", "F7a double-clicking a PDF or video card…" | Placeholders `/img/image-unavailable.svg`, `/img/image-processing.svg` (never written into records). Any empty `.tl-image-container` now shows a loading tile, foreign URLs included |
| PRE-07 | Verified | canvas-ux › "templates in a board"; `packages/templates` tests | Headings, instructions and image slots arrive locked (slots carry `meta.draftroomSlot = 'image'`); frames, notes and starter values stay unlocked |
| COL-04 | Verified (changed) | canvas-ux.fix › "RETRO-02…", "RETRO-09…" | After Esc the note that was just edited takes tool keys, not typing; typing after Tab is buffered. "Tab to a note, then C" still types "c" into a lone selected note |
| COL-05 | Verified | canvas-ux.fix › "RETRO-01…" | Placed at the pointer; a single row or column of more than 3 cells reflows to a ceil(√n) grid; parented into the frame under the pointer |
| COL-09 | Verified | canvas-ux.fix › "RETRO-21b…" | `createTextOnCanvasDoubleClick: false`; new notes default to the sans font (per session) |
| MAK-09 | Verified (fix) | canvas-ux.fix › "F3…" | Space on a mouse-focused button pans; a button reached by keyboard keeps Space as a press |
| MAK-11 | Verified (changed) | canvas-ux › "Miro keys"; canvas-ux.fix › "PERF-03…" | Minimap **closed by default** and unmounted when closed (PERF-03); an explicit choice survives reloads |
| MAK-13 | Verified | canvas-ux › "frame outline"; canvas-ux.fix › "Frames panel: no doubled numbers…" | Shift/Ctrl-click multi-select (no range select); zoom-to-frame fits within the free area, at most 100% |
| MAK-12 | Verified | canvas-ux.fix › "F15…" | Images and videos are also found by file name |
| MAK-05 | Verified | canvas-ux.fix › "F8…" | Locked-hint bar with Unlock; lock badge on locked frames' titles |
| PRF-02 / PRF-03 | Partial | Measured: `docs/REVIEW-2026-09-27.md` §2 | Heavy board below 30 fps at fit; mood-board images load with 0 broken and 0 originals; iPad unmeasured |
| REV-04 / REV-05 | Verified (extended) | facilitation-review.fix › "PRI-01…", "PRI-03…", "PRI-06…", "PRI-12…", "PRI-17 + F24b…", "PRI-09a…"; shell-sharing-platform.fix › "PRI-05a…" | Dashboard bell and card badges; still no email |
| FAC-03 | Verified (changed) | workshops › "time's up" | The pill returns to "Timer" 10 s after time's up; one time's-up message; the floating timer is hidden in Present unless running or paused |
| FAC-05 / FAC-06 | Verified (extended) | facilitation-review.fix › "RETRO-06…", "RETRO-08 + RETRO-23a…", "RETRO-11…" | Keyboard voting; "Results are in" card with the top 3 for everyone |
| FAC-07 | Partial (mitigation) | facilitation-review.fix › "RETRO-03a + RETRO-07a…" | "Hide note authors" and "Hide cursors" session settings (document record `meta.drWorkshop`); private drafting is not built |
| PRS-06 / PRS-10 | Verified (extended) | facilitation-review.fix › "RETRO-05a + F13…"; present-export › "PDF export…" | A title band on every page (+28 pt); page size Fit each frame / 16:9 / A4 landscape; text under images is left out of the text layer |
| PRS-08 | Partial (extended) | shell-sharing-platform.fix › "RETRO-04a…"; `apps/api/test/features/dashboard/workshop-links.test.ts` | Workshop (edit) links: 3 h default, 24 h cap, +1 h; migration `0006_workshop_links`; sign-in still required |
| PRS-04 | Verified (extended) | dashboard-share › "review link revoked without removing access"; shell-sharing-platform.fix › "PRI-08/PRI-09b…" | A gone link opens the board for members; blocked-edit hint with Request; role-change toasts |
| WRK-06 | Verified (extended) | saving › "a viewer sees View only, a commenter Can comment…"; shell-sharing-platform.fix › "RETRO-17/PRI-07…"; canvas-ux.fix › "PRI-13…" | Save status hidden when the role pill states it; read-only roles on touch start on the Hand tool |
| (phone/tablet) | Verified | shell-sharing-platform.fix › "PRI-02 at 390×844 (touch)", "…at 768×1024" | Feature items move to a "⋯" menu at 768 px and below |
| DSH (edited time, card) | Verified | shell-sharing-platform.fix › "RETRO-19…", "PRI-11…" | The sync server reports canvas writes through `GET /internal/boards/:bid/touched?at=` (a GET because the api's CSRF hook refuses Origin-less POSTs; internal secret required); at most once a minute per board |

New or changed ids and interfaces:
- **canvas-ux:**
  - options `cameraMovingTimeoutMs` (280) and `createTextOnCanvasDoubleClick` (false);
  - `locked-hint`, `locked-hint-unlock`, `locked-hint-dismiss`, `locked-frame-badges`, `navigation.zoom-to-fit`;
  - nested frame rows carry `data-selected`.
- **comments / workshops / present-export:**
  - `new-comment-where`, `notification-request`, `session-settings`, `session-hide-authors`, `session-hide-cursors`, `vote-announce`, `vote-keys-hint`, `vote-results-card`, `vote-results-card-row`, `vote-results-card-all`, `workshop-stack`, `export-pdf-page-size`;
  - `timer-pill[data-state=ended]`;
  - removed: `follow-stop`; `timer-finished` is now the flash text;
  - mention and resolve toasts are tldraw toasts;
  - `NotificationItem.accessRequest` added.
- **shell / sharing:**
  - `topbar-overflow`, `dashboard-bell`, `dashboard-bell-count`, `dashboard-notifications`, `dashboard-notification-item`, `board-card-news`, `share-link-note`, `workshop-links`, `workshop-link-create`, `workshop-link-extend`, `workshop-link-expiry`, `member-remove-confirm`, `member-remove-question`;
  - `POST /api/boards/:bid/review-links/:id/extend`;
  - contracts `ReviewLinkRole` includes `editor`, plus `InvitationGoneBody`.
- **sync:** a join queue that processes one TLSync connect per macrotask (`apps/sync/src/join-queue.ts`).
- **assets:** metadata GETs are capped at 6 in flight, with retries after 0.5, 1 and 2 s.

Earlier "still open" items this closes:
- a viewer seeing "View only" twice;
- other people's cursors during a vote (a facilitator can now hide them);
- phone-width top-bar overflow.
