# Wave Q contracts: the Elements panel

Wave Q gives the board one **Elements** panel with three sources: built-in **icons** (Lucide and Tabler outline),
built-in **shapes** (today's pieces plus new kits) and a **library** of saved selections (per workspace and per
person). The foundation (branch `wave-q/foundation`) lands the shared contracts, the migration, the dependency commit,
the shared insert and serializer, and tested stubs. Nothing changes for a user until the workstreams land: every
library route is pending (404, like any unknown route), the web's library client answers empty without a request, and
the `elements` feature contributes nothing while `ELEMENTS_PANEL` is `false`.

What does not change in wave Q: the sync protocol (`CONTRACTS_REV` stays 13), `ELEMENT_SCHEMA_VERSION`, the room's
validation. Every insert is existing element types with existing `customData.lobby` keys (`kind`, `alt`, `file`), so a
week-old tab reads every frame. Excalidraw's own library (`libraryItems`, `updateLibrary`, `useHandleLibrary`, its
sidebar) stays unused: it is a second store outside Lobby's permissions, and it fetches from other origins.

## 1. Workstreams and file ownership

| Workstream | Owns | Reads (does not edit) |
|---|---|---|
| **WS1 Icons** | `packages/icon-sets/**` (generator `src/generate.ts`, converter `src/convert.ts`, build report, checksum and fidelity tests); `apps/web/build/lobby-assets.ts` and its test; the plugin line in `apps/web/vite.config.ts`; `apps/web/src/features/elements/icons/**` (the index and shard loader, client-side search, `iconElements()` that turns geometry into elements at a size and colour); `packages/contracts/src/icons.ts` after the foundation | `contracts` library and panel files, `features/elements/place.ts` |
| **WS2 API** | `apps/api/src/features/library/**` and `apps/api/test/features/library/**`; removing its keys from `apps/api/src/features/pending-routes.ts` and `apps/api/test/features/pending-routes.test.ts` (the guard rows are already in place); `apps/api/src/files/gc.ts` (library_item_files as a reference source) and its tests; the library audit events; `packages/contracts/src/library.ts` and `packages/board-ops/src/elements/library.ts` after the foundation; the library `*.pg.test.ts` files | `packages/db/migrations/0033_library.sql` (shipped: never edited) |
| **WS3 Panel UX** | `apps/web/src/features/elements/**` except `icons/` (the panel, tabs, search, Recents and Favourites, the insert options bar, tiles, the drop handler, the phone sheet, the "Save to library" dialog and its selection-bar and context-menu entries, library management, `client.ts`, `place.ts`, `flags.ts`); `apps/web/src/features/pieces/**` (retiring the Shapes panel's dock entry; the `pieces.*` command ids stay); `packages/contracts/src/elements-panel.ts` and the wave Q rows of `packages/contracts/src/usage.ts` after the foundation; `apps/web/src/features/wave-q-stubs.test.ts`; `e2e/excalidraw/q3-*.spec.ts` | WS1's `icons/` API, WS2's routes |
| **WS4 Kits and import** | `packages/templates/src/pieces/**` (new categories and kits: arrows, callouts, badges, sticky-note kits, device frames, storyboard frames); `apps/web/src/canvas/library/**` (the `.excalidrawlib` normaliser, the only new `@excalidraw/*` importer); `e2e/excalidraw/q4-*.spec.ts` | `ImportLibraryInput`, `serializeLibraryItem` |

Lead-only (serialize through the lead): `pnpm-workspace.yaml`, `pnpm-lock.yaml` (no further dependency is planned in
wave Q), `apps/web/src/features/canvas-registry.ts`, `vitest.config.ts`, `docs/PROGRESS.md`, `render.yaml`.

## 2. The library (WS2; contracts `library.ts`, migration `0033_library`)

### 2.1 Routes

| Route | Body / query | Answer |
|---|---|---|
| `GET /api/workspaces/:wid/library` | `ListLibraryQuery` (`scope` default workspace, `q`, `folder` id or `none`, `tag`, `deleted=1`, `cursor`) | `ListLibraryResponse` (≤ 60 summaries, newest change first, `nextCursor`) |
| `GET …/library/items/:id` | | `LibraryItem` (summary + elements + files + source) |
| `POST …/library/items` | `CreateLibraryItemInput` (`scope`, `name`, `tags`, `folderId`, `sourceBoardId`, `elements`) | 201 `LibraryItemSummary` |
| `PATCH …/library/items/:id` | `PatchLibraryItemInput` (`revision` required; `elements` needs `sourceBoardId`) | `LibraryItemSummary`; stale revision 409 `LIBRARY_STALE_REVISION` |
| `DELETE …/library/items/:id` | | 204 (soft delete) |
| `POST …/library/items/:id/restore` | | `LibraryItemSummary` (within 30 days) |
| `GET …/library/items/:id/files/:ver/thumb` | | the thumb derivative, only for a version listed in `library_item_files` for that item |
| `POST …/library/import` | `ImportLibraryInput` (`scope`, `fileName`, `licence`, `author`, `folderId`, `items[]`; body ≤ 5 MB) | `ImportLibraryResponse` (`created`, `skipped`, `warnings` as counts) |
| `GET …/library/folders` | `scope` | `ListLibraryFoldersResponse` |
| `POST …/library/folders` | `CreateLibraryFolderInput` | 201 `LibraryFolder` |
| `PATCH …/library/folders/:fid` | `PatchLibraryFolderInput` (`name`, `position`) | `LibraryFolder` |
| `DELETE …/library/folders/:fid` | | 204; its items stay, folderless |
| `GET …/library/marks` | | `ListLibraryMarksResponse` (all favourites, the last 12 used) |
| `PUT …/library/marks` | `PutLibraryMarkInput` (`key`, `favourite?`, `used?: true`) | `LibraryMark` |
| `POST /api/boards/:bid/library/items/:id/place` | none | `PlaceLibraryItemResponse` (`item`, `elements`, `files: LibraryFileFacts[]`) |

`LIBRARY_ROUTES`, `LIBRARY_ROUTE_KEYS` and the path builders (`libraryListPath`, `libraryItemPath`, `libraryPlacePath`,
…) are the one spelling. While a key is in `PENDING_ROUTES` the route is not registered; WS2 deletes each key in the
change that implements it, and the refusal and creation matrices then hold the route to its guard rows.

### 2.2 Who may do what (server-side; the guards first, then a fail-closed check in the route)

| Caller | Built-in icons and shapes | Workspace library: read, insert | Save, import, folders in the workspace scope | Edit or delete a workspace item | Personal library |
|---|---|---|---|---|---|
| Workspace owner or admin, creator | yes (if they can edit the board) | yes | yes | any | their own |
| Workspace member, creator | yes | yes | yes | their own items | their own |
| Workspace member, outsider (not a creator) | yes | yes, except `internalOnly` items | 403 `CREATOR_REQUIRED` | no | their own |
| Workspace guest, board-only collaborator | yes | 403 (a stranger to the workspace: 404) | no | no | no |
| Name-only guest | yes (static, client-side) | 403 `GUEST_ACCOUNT_REQUIRED` (the guard) | no | no | no |
| Viewer or commenter of the target board | no panel | `/place` 403 (needs edit; board not archived or trashed) | | | |

- Guard rows (in place): every library route is in `GUEST_REFUSED_ROUTES` (`LIBRARY_GUEST_ROUTE_KEYS`); the eight
  writes are `CREATOR_ROUTES` with `refuse: 'in-route'` (`LIBRARY_CREATOR_IN_ROUTE_KEYS`): the guard freshens the
  caller, the route calls `requireCreator` when the scope is `workspace` (from the body, or the stored item or
  folder). Personal saves are not creator-gated: nobody else sees them.
- A save needs view access to `sourceBoardId` and passes its export policy (`export-control` `mayExport`, as
  ws-templates does), else 403 `LIBRARY_EXPORT_REFUSED`. A save from an internal-only project sets `internalOnly`.
- `/place`: item and board in the same workspace (else 404, no leak); the caller reads the item and edits the board.
- Authorship comes from the session only. Lock order: the workspace row first for create and delete (as ws-templates);
  `/place` takes `FOR SHARE` on the item row, so a delete and a place run one after the other.
- No content and no names in logs; audit events for create, delete and import.
- Rate limits per person (`LIBRARY_RATE_LIMITS`): saves 60/min, imports 5/min, places 120/min.

### 2.3 Limits (`LIBRARY_LIMITS`)

Per item: ≤ 500 elements (= `MAX_OPS_PER_PUSH`: one push), ≤ 256 KiB of element JSON, ≤ 20 images, ≤ 10 tags of ≤ 32
characters, a name ≤ 80. Per workspace ≤ 5,000 items and ≤ 200 folders; per personal library ≤ 500 items and ≤ 50
folders. An import ≤ 5 MB and ≤ 500 items. Over a cap: 413 `LIBRARY_TOO_LARGE` (an item) or 409 `LIBRARY_FULL` (a
library). A folder name taken in its scope (case-insensitively): 409 `LIBRARY_FOLDER_EXISTS`.

### 2.4 Storage (`0033_library`, additive; rollback = `DRAFTROOM_ALLOW_NEWER_SCHEMA=1` + "Deploy a specific commit")

- `library_folders` (`lbf_…`): `owner_id` NULL = the workspace library, else that person's; one name per scope.
- `library_items` (`lbi_…`): `elements` jsonb (validated, portable, item-local ids), `element_count`, `image_count`,
  `bytes`, `width`, `height`, `source` jsonb (`board` | `excalidrawlib`), `internal_only`, `revision` (starts at 1,
  +1 on every change), `deleted_at` (soft delete, purged after 30 days). A folder of the same workspace; deleting it
  sets only `folder_id` to NULL.
- `library_item_files`: `(item_id, version_id)`, each a real version `(asset_id, version_id) → asset_versions` of the
  item's own workspace; cascades with its item and its version.
- `library_marks`: `(user_id, workspace_id, key)`, `favourite`, `used_at`.

### 2.5 Images

Elements keep `fileId = ver_…` and `customData.lobby.file`. On save the api checks each version the way history does
(`filesShownOn` / `isAssetLinked`: the source board owns it or links it), records it in `library_item_files` and
rewrites `customData.lobby.file` from the version row, never from the client (else 400 `LIBRARY_FILE_NOT_SERVABLE`).
On `/place` it inserts `board_asset_links (workspace, target board, asset, version)` in the same transaction, so the
sync's A1 file-refs check and `/files` serve them on the target board. **The client calls `/place` before it pushes**
(sync caches a negative file-refs answer for 30 s). WS2 adds `library_item_files` to `apps/api/src/files/gc.ts` as a
reference source next to `board_asset_links`, read again under the delete-mode row lock; soft-deleted items stay roots
until purged. Files are workspace-scoped: an item with images is never offered to another workspace. Note for later:
`asset_versions` cascade on their home board's hard delete (0007); none exists today, but one must re-home library
versions first.

## 3. Built-in icons (WS1; contracts `icons.ts`, package `@draftroom/icon-sets`)

### 3.1 The packages (the foundation's dependency commit)

| Package | Pin | Licence | Data the generator reads |
|---|---|---|---|
| `lucide-static` | 1.49.0 (2026-09-29) | ISC; its Feather-derived icons MIT (both in one LICENSE) | `icon-nodes.json` (name → `[[element, attrs]]`: path, circle, rect, line, ellipse, polyline, polygon; 1,857 icons), `tags.json` (name → tags). **No categories in the package**: Lucide icons are found by name and tags only. |
| `@tabler/icons` | 3.48.0 (2026-09-22) | MIT | `icons.json` (name → `{category, tags, styles}`; 5,166 icons in 41 categories, all with an outline style), `tabler-nodes-outline.json` (paths only). The filled style is left out. |

Both are data only: no dependencies, no bin, no install script. They are exact catalog pins, dependencies of
`packages/icon-sets` (which `apps/web` depends on, so `pnpm licence:check` sees them). The licence texts ship in
`packages/icon-sets/licenses/`; WS1 emits both to `/lobby-assets/icons/LICENSES.txt`, linked from the panel's footer
("Icons: Lucide (ISC), Tabler (MIT)"). `src/files.ts` finds the installed roots (Tabler's `exports` map hides its
package.json from `require.resolve`). Bump only in a dedicated PR that reruns the checksum and fidelity tests.
Recommendation for WS1: leave out Tabler's `Brand` category (376 brand logos: trademarks, not licences).

### 3.2 Files and formats

Same origin under `ICON_ASSET_PREFIX` = `/lobby-assets/icons/`, generated at build from `node_modules` (never
committed), content-hashed, a 404 (never `index.html`) for a missing file. The web learns the index file's hashed name
at build time (WS1's plugin), never a fixed name. Nothing in the board's main chunk (a lazy `import()`; WS1 adds a
bundle test).

- `index.<hash>.json` = `IconIndex`: `format: 'lobby-icon-index'`, `version: 1`, `sets` (id, version, licence, count),
  `shards` (the 64 file names, `shards[n]` is shard n), `icons`: `[set, name, tags, category | null, shard]`.
- `shard-<n>.<hash>.json` = `IconShard`: `format: 'lobby-icon-shard'`, `version: 1`, `shard`, `icons`: `<set>:<name>` →
  `IconGeometry`, at most 12 `IconPrimitive`s on the 24-unit grid (coordinates in [-1, 25], 2 decimals):
  `{t:'line', p:[x0,y0,…], closed?}`, `{t:'ellipse', x, y, w, h, f?}`, `{t:'rect', x, y, w, h, r?, f?}`.
  **The converter runs at build only** (a path parser for M/L/H/V/C/S/Q/T/A/Z with adaptive flattening), so no SVG
  parser ships to the board; an icon it cannot convert (even-odd or holed fills) is dropped and listed in the report.

### 3.3 An inserted icon

Native `line` (one per subpath; roughness 0, round joins), `ellipse` and `rectangle` (`r` → `roundness {type: 3}`)
elements, grouped with one fresh group id, `customData.lobby.kind = 'icon'` (`ICON_ELEMENT_KIND`) and `alt` =
`iconAltText(set, name)` ("Lucide icon: arrow-right"). Both keys are accepted by the room today. Size presets
`ICON_SIZE_PRESETS`: S 48 px / stroke 4, M 96 / 8, L 192 / 16. Colour from `INSERT_COLOR_NAMES` (Lobby's 13
theme-safe colours) through board-ops `lobbyColor`. Never an image element (Lobby refuses SVG uploads, a raster cannot
be recoloured, `fileId` must be a version id). WS1's `iconElements()` returns `PlaceSource`-ready elements.

## 4. The panel and the insert (WS3; contracts `elements-panel.ts`)

- Panel id `elements` (`ELEMENTS_PANEL_ID`), label "Elements", order 35, hidden for read-only roles
  (`ELEMENTS_PANEL_SPEC`). It replaces the Shapes panel's dock entry when WS3 turns `ELEMENTS_PANEL` on, in the same
  change that retires `pieces`' panel (the `pieces.*` palette commands stay) and moves `elements.open` out of
  `PENDING_PALETTE_COMMAND_IDS`.
- Drag payload text/plain `lobby-element:<source>:<id>` (`elementDragPayload`, `parseElementDrag`): `icon:<set>:<name>`,
  `piece:<pieceId>`, `item:<lbi_…>`. One content handler at priority 200, drops only (a paste is never taken), like
  `lobby-piece:` today.
- `InsertOptions` (`color`, `size`, `keepTogether` default on, `lock` default off) are remembered per viewer in browser
  storage (try/catch; each field falls back to its default).
- Favourites and recents are marks (`libraryMarkKey`): `icon:<set>:<name>@<setVersion>`, `piece:<id>`, `item:<lbi_…>`;
  a key whose icon version is not the current set's, or whose item is gone or unreadable, is hidden.
- **The insert API** (`apps/web/src/features/elements/place.ts`):

  ```ts
  placeElements(canvas, { label, elements, bounds? }, { at?, select?, keepTogether?, lock?, reveal?, newId? })
    → { ok: true, ids, allIds, bounds, frameId } | { ok: false, reason: 'readonly' | 'empty' | 'invalid' | 'too-many-shapes' | 'failed' }
  ```

  It re-keys (board-ops `remapElements`), places (the free spot `spotNear`, or centred on a drop and joining the
  unlocked frame under it unless the set holds a frame), groups and locks on request, checks `checkElement`,
  `checkInvariants` and `MAX_ITEMS` before writing, writes ONE `transact` → `tx.insert` (one undo step), selects the
  top-level elements and reveals them. It never throws and never fetches. `insertPiece` (the Shapes panel) is a wrapper
  of it. A library item: `placeLibraryItem(boardId, id)` first (the files get linked), then `placeElements` with the
  answer's elements.
- Usage events (`USAGE_FIXED_EVENTS`): `elements.insert.icon`, `elements.insert.piece`, `elements.insert.item`,
  `elements.save`, `elements.favourite`, `elements.import`; the palette id `elements.open`.
- The web library client (`features/elements/client.ts`) has frozen signatures; the stub answers empty reads and rejects
  writes with `LibraryRequestError('unavailable')`. The real one parses every answer with its contract schema and
  rejects with the api's error code.

## 5. Saving a selection (contracts `CreateLibraryItemInput`; board-ops `serializeLibraryItem`)

`serializeLibraryItem(selected, { scene, limits })` runs on the web before "Save to library" and again in the api on
what it receives (the api then adds its file checks). It takes the live selection plus, with the scene, the labels of
selected containers and the children of selected frames; refuses refused types (selection, magicframe, iframe,
embeddable), unknown types and any `data:` or `blob:` URL in `link`, `fileId` or `customData`; makes elements portable
(no `lobbyServer`, no identity-bound or identity-stamped keys, no `status`), drops board-bound keys (`tag:*`,
`present.index`) and unknown keys, unlocks them; re-keys them to item-local ids with the box at (0, 0); checks
`checkElement` and `checkInvariants`; holds them to the limits. It answers the elements, the file versions they show,
the box, counts and a suggested name. Problems are codes and counts, never content. `kind` is never overwritten (it
is semantic: `board-card`, `link-card`, `highlight`, `ai-*`). There is no element-level library marker in v1 (a new
`customData.lobby` key needs a `CONTRACTS_REV` bump with the frozen-fixture proof; deferred).

## 6. Importing an `.excalidrawlib` (WS4, then WS2)

`apps/web/src/canvas/library/excalidrawlib.ts` is the only reader: `loadLibraryFromBlob` → `restoreLibraryItems` /
`restoreElements` (pure exports of the pinned engine), fonts 1 → 5, 2 → 6, 3 → 8 (Lobby allows 5-8), bound text laid
out again with the text-metrics provider, image elements and embeds dropped with warnings, each item through
`serializeLibraryItem`. Through an `<input type=file>`, never the File System Access picker. The api validates every
item as a save and stores the licence note per item (`LIBRARY_DEFAULT_LICENCE` when the file states none). Lobby never
fetches libraries.excalidraw.com or any other origin.

## 7. What each workstream proves

- WS1: the converter over every icon (each element `checkElement`-valid, points ≤ the caps, ≤ 12 elements, within a
  Hausdorff distance ≤ 0.15 units of the densely sampled source), the build report of dropped icons, index search
  ranking, a checksum of the generated files per pinned version, the bundle test (no icon data in the board chunk),
  the 404 for a missing asset, and an engine-probe screenshot of icons at three zooms in light and dark.
- WS2: the role matrix of §2.2 (stranger 404, cross-workspace `/place` 404), export-policy and internal-only refusals,
  caps, a stale revision 409, soft delete and restore, rate limits, guard-list membership, and on real Postgres the
  concurrent delete vs place and the GC keeping a version referenced only by `library_item_files`.
- WS3: e2e in both event modes: drag an icon into a frame, click to insert, one Ctrl+Z removes it, a second browser
  sees it; size and colour; save a selection with an image and place it on another board of the workspace (the image
  loads, sync accepts); an outsider cannot save to the workspace; a name-only guest has icons and no Library tab; a
  viewer has no panel; a phone tap inserts; the network assertion (icons same-origin under `/lobby-assets/`).
- WS4: kit tests in the existing `pieces.test.ts` pattern (new `piece-<id>` kinds ≤ 32 characters), `.excalidrawlib`
  fixtures (v1 and v2, fonts, images dropped), the e2e import through the file input.

## 8. Where the foundation differs from the design scout

- **Marks:** `PUT /api/workspaces/:wid/library/marks` takes the key in the body, not in the path (`marks/:key`): keys
  hold `:` and `@`.
- **Shards hold converted primitives,** not SVG paths, so the converter runs only at build and no path parser ships.
- **Creator rows are `in-route`:** the scope is in the body (or the stored row), so the guard cannot decide it alone.
- **Folder names** are unique per scope case-insensitively through an expression index (`COALESCE(owner_id, '')`,
  `lower(name)`) instead of `UNIQUE NULLS NOT DISTINCT`.
- **Stronger keys:** `library_item_files` references `library_items (id, workspace_id)` and `asset_versions
  (asset_id, id)`; items carry `image_count`; the folder FK sets only `folder_id` to NULL.
- **PATCH with new elements names `sourceBoardId`,** so the api re-checks the files and the export policy; the import
  body names its `scope`, `folderId` and `author`.
- **Lucide has no categories in its package**; Tabler's `Brand` category is recommended out.
- The serializer lives in `packages/board-ops/src/elements/library.ts` (as the scout proposed), outside the listed
  foundation folders: the web and the api must agree on it.
