# Milestone 0 contracts (integration owner: main session)

These are the interfaces between the parallel M0 work areas. Change them only through the integration owner. Verified engine facts: `docs/research/SYNTHESIS.md` (read it before touching sync or client code).

## 1. Ownership

| Area | Owner | Paths |
|---|---|---|
| Shared canvas schema | integration owner | `packages/canvas-schema/**` |
| Asset contract + job queue | integration owner | `packages/dev-assets/**` |
| Sync server, dev file routes, text lease | sync | `apps/sync/src/**`, `apps/sync/test/http/**`, `apps/sync/test/lease/**` |
| Protocol-level behavior tests | protocol-tests | `apps/sync/test/protocol/**`, `apps/sync/test/harness/**` |
| Web client | web | `apps/web/**`, plus the `open()` helper / test ids in `e2e/tests/m0.spec.ts` |
| Preview worker + fixtures | worker | `apps/worker/**` (fixtures are written to `tests/fixtures/generated/`, gitignored) |
| Browser e2e | e2e | `e2e/**` |
| Workspace config, deps, lockfile, docs/PROGRESS.md, docs/FEASIBILITY.md | integration owner | root files |

Rules for every owner: do not add/upgrade dependencies or touch `pnpm-lock.yaml` / `pnpm-workspace.yaml` (everything in the catalog is already installed — if you truly need something else, stop and report it). Do not commit. Do not edit other owners' files; report contract problems instead.

## 2. Processes, ports, environment

| Process | Dev command | Default | Env |
|---|---|---|---|
| sync | `pnpm --filter @draftroom/sync dev` | `127.0.0.1:5858` | `DRAFTROOM_DEV_AUTH=1` (required), `DRAFTROOM_DATA_DIR` (required), `HOST`, `PORT`, `IDLE_EVICT_MS` (30000), `TEXT_LEASE_MS` (5000) |
| worker | `pnpm --filter @draftroom/worker dev` | — | `DRAFTROOM_DATA_DIR` (required, same dir), `FFMPEG_PATH`, `FFPROBE_PATH`, `WORKER_POLL_MS` (500) |
| web | `pnpm --filter @draftroom/web dev` | `127.0.0.1:5173` | `DRAFTROOM_SYNC_ORIGIN` (vite proxy target, default `http://127.0.0.1:5858`), `WEB_PORT`, `VITE_DRAFTROOM_DEV_AUTH=1` for production builds used by e2e |

`pnpm dev` at the root runs all three (the `dev.env` files set the dev guard and `DRAFTROOM_DATA_DIR=../../.data`). The browser only talks to the web origin; Vite proxies `/connect` (WebSocket), `/files` and `/dev-api` to sync.

Data layout (`packages/dev-assets`): `rooms/board-<id>.sqlite`, `assets/<ast>/<ver>/{original,meta.json,derivatives/}`, `jobs/{queued,processing,done,failed}/<ver>.json`. Never on a network share.

Port ranges for agents testing in parallel: sync tests use ephemeral ports (`0`); protocol tests pick free ports; web manual checks use web `5190` + sync `5891`; only the web/e2e owners run Playwright (`5881`/`4191`).

## 3. Identifiers and board ids

- Board id: `BOARD_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/` (lowercase only; case-insensitive filesystems would split rooms). New boards: `b-` + 10 lowercase base36 chars.
- Asset/version/derivative ids: `newId('ast'|'ver'|'drv')` → `<prefix>_` + 20 base62 chars (`@draftroom/dev-assets/shared`).
- Dev user id: `/^[a-z0-9-]{1,32}$/` (dev only; replaced by signed tickets in M1).

## 4. Sync WebSocket

`GET /connect/<boardId>?sessionId=<useSync tab id>&devUser=<id>[&devRole=viewer]`

- Invalid board id / missing sessionId → HTTP 400 before upgrade.
- Unauthenticated → upgrade then close `4099 NOT_AUTHENTICATED` (terminal on the client; an HTTP 401 would retry forever).
- Room open failure → `4099 UNKNOWN_ERROR`. Rate limit → `closeSession(sid, 'RATE_LIMITED')`.
- `devRole=viewer` → `isReadonly: true` (server skips document writes, client receives `discard`).

### Text-edit lease (server-enforced, `authorizeRecord`)

Applies to any shape whose props contain `richText` (note, text, geo, arrow labels…). The first session to change a shape's `richText` holds the lease for `TEXT_LEASE_MS`, renewed on each text change. While held by another user: text changes and deletes of that shape are vetoed (whole record op; client gets `discard`/rebase and reverts). Moves/resizes that leave `richText` unchanged are allowed. Leases for a user are released when that user has no remaining sessions in the room.

Denial custom message (server → the denied session, `useSync({ onCustomMessageReceived })`):

```ts
{ type: 'text-lease-denied', shapeId: string, holderUserId: string, expiresInMs: number }
```

Presence hint (client-set, informational only — the lease is the enforcement): `presence.meta.editingShapeId: string | null` (the shape the user is currently text-editing).

## 5. Dev file routes (sync process, only when `DRAFTROOM_DEV_AUTH=1`)

Milestone-0 stand-in for signed object-storage URLs + the M1 API. Types are `AssetVersionMeta` etc. from `@draftroom/dev-assets/shared`. Errors are JSON `{ "error": { "code": string, "message": string } }` (user-safe messages; never paths).

| Route | Behavior |
|---|---|
| `POST /dev-api/boards/<boardId>/assets?devUser=<id>` | Raw body upload. Headers: `Content-Type` (declared), `Content-Length` (required → 411 if absent), `X-File-Name` (`encodeURIComponent` of the display name). Validates board id + dev user, `kind = classifyUpload()`, size ≤ `LIMITS.maxBytes[kind]` (413 before reading; also enforced while streaming). Streams to a temp file while hashing sha256, renames to `original`, writes `meta.json` (`status: 'queued'`), `enqueueJob()`. Aborted/oversize upload leaves no meta and no original. → `201 AssetVersionMeta` |
| `GET /dev-api/boards/<boardId>/assets/<ast>/<ver>` | `200 AssetVersionMeta`; `404` if missing **or** `meta.boardId !== boardId` (no cross-board existence leak). `Cache-Control: no-store`. |
| `GET /files/<ast>/<ver>/original?board=<boardId>` | Original bytes, board-scoped like above. `Range` → `206`. Headers: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: private, max-age=3600`. Previewable kinds that did not fail (`image`/`pdf`/`video`) → their mime + `Content-Disposition: inline`; everything else → `application/octet-stream` + `attachment` (RFC 5987 `filename*`). |
| `GET /files/<ast>/<ver>/d/<drvId>?board=<boardId>` | Derivative listed in `meta.derivatives` (by id). Its mime; `nosniff`; `Cache-Control: private, max-age=31536000, immutable`. 404 otherwise. |

The durable canvas reference is `stableFileRef(ast, ver)` = `/files/<ast>/<ver>/original` (no host, no board, no signature). Clients resolve it to board-scoped derivative/original URLs at render time.

## 6. Preview worker

Loop: every `WORKER_POLL_MS` claim with `claimNextJob()`; every 10 s `requeueStale(LIMITS.staleProcessingMs)`; heartbeat `touchJob()` ≤ every 5 s while processing. Only the claim holder writes `meta.json` after upload.

Per job (idempotent by `versionId` + `PREVIEW_PROFILE`): if meta already `ready` with derivatives present → finish `done`. Else `status: 'processing'`, `attempts + 1`; confirm type by content (magic bytes), then:

| Kind | Output (`derivatives/<drvId>.webp`, written tmp+rename BEFORE meta references them) | Failure codes |
|---|---|---|
| image | `thumb` (≤512 px edge), `display` (≤2048 px), `probe.width/height` | `IMAGE_TOO_LARGE`, `IMAGE_INVALID`, `TYPE_MISMATCH` |
| pdf (child process, SIGKILL timeout) | `page` role for pages `1..min(pageCount, LIMITS.eagerPdfPages)` (page 1 = cover) + a `thumb` of the cover; `probe.pageCount` | `PDF_ENCRYPTED`, `PDF_INVALID`, `PDF_TOO_MANY_PAGES`, `TIMEOUT` |
| video (ffprobe/ffmpeg child processes) | `poster` + `thumb`; `probe.durationMs/width/height/videoCodec/audioCodec`. Accept H.264 (Baseline/Main/High, yuv420p) + AAC or no audio | `UNSUPPORTED_CODEC` (original stays downloadable), `VIDEO_INVALID`, `VIDEO_TOO_LONG`, `TIMEOUT` |
| other | no derivatives; `ready` (attachment card) | — |

Permanent (validation) failures → `failed` immediately with `error`; transient failures retry up to `LIMITS.maxAttempts`.

## 7. Web client

- Routes: `/` (home: create board / open by id), `/b/<boardId>` (board). Dev identity from `?user=<id>` (and `?role=viewer`), only when `import.meta.env.DEV || import.meta.env.VITE_DRAFTROOM_DEV_AUTH === '1'`; otherwise a "Sign-in arrives in milestone 1" screen. A visible "dev identity" badge whenever dev identities are in use.
- `window.editor` is exposed only under the same dev guard (e2e uses it).
- Asset store: `upload()` POSTs to the dev route and returns `{ src: stableFileRef(ast, ver), meta: { assetId, versionId } }`; `resolve()` maps `/files/…` refs to board-scoped derivative URLs (`thumb` when small on screen, `display` otherwise, original when `ctx.shouldResolveToOriginal` or for video). Images dropped on the canvas → native tldraw image shapes. PDFs, videos and other files → `dr-file-card` shapes.
- File-card status comes from the meta route (polled until `ready`/`failed`). The uploading tab patches the card's hint props (`status`, `pageCount`, `durationMs`, `posterDerivativeId`); every tab renders from meta.
- Test ids (e2e contract):
  - `conn-status` with `data-state` = `connecting | online | offline | error`
  - `sync-error` (terminal error screen, includes the reason, has a retry that remounts)
  - `presence-list` → `presence-user[data-user-id]`
  - `dev-identity-badge`
  - `file-card[data-status][data-kind]`, inside it `file-card-preview` (img), `file-card-pages`, `file-card-duration`, `file-card-play` (button) → `file-card-video` (`<video>`), `file-card-download` (link), `file-card-error`
  - `lease-toast` ("<user> is editing this text"), `editing-badge[data-user-id]` on shapes another user is text-editing
- Never show "Saved". Show "Live" when online; when offline show that changes are kept in this tab only until reconnect (offline edits are in memory; a reload while offline loses them).
