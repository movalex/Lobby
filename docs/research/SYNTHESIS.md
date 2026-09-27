# Milestone 0 research synthesis (implementation reference)

Date: 2026-09-26. Engine: **tldraw 5.4.2** with native `@tldraw/sync` / `@tldraw/sync-core` 5.4.2 on Node 24.19.0.

This file reconciles the six research reports in this folder. Where they disagreed, I checked the 5.4.2 tarballs myself and wrote down the verified answer. It then gives the reference wiring for milestone 0.

**Everything in §3–§6 was run together in one workspace:** `docs/research/m0-skeleton/`, a runnable copy with its source and lockfile. The following all passed there:
- `pnpm install --frozen-lockfile` (pnpm 10.34.5, with `strictDepBuilds`)
- `tsc` 7.0.2 on all packages
- `vitest` 5.0.2 (8 tests)
- Biome 2.5.14 (0 errors)
- a Playwright 1.63.0 e2e test with two browser contexts, a reload, a SIGKILL and restart of the server, and an offline edit followed by reconnect
- the file-preview prototype running inside the same pnpm workspace

Source reports: [sync-server.md](sync-server.md), [sync-client.md](sync-client.md), [conflict-semantics.md](conflict-semantics.md), [tooling-versions.md](tooling-versions.md), [file-previews.md](file-previews.md), [license.md](license.md).

Tags:
- **[critic-run]**: I ran it myself in `m0-skeleton` or the critic scratch space.
- **[critic-src]**: I read it in the 5.4.2 tarball source.
- **[report-run] / [report-src]**: a researcher verified it (see the linked report).
- **UNVERIFIED**: nobody verified it.

Source paths are `node_modules/@tldraw/<pkg>/src/...` in the 5.4.2 tarballs, which ship `src/`.

---

## 1. Contradictions between reports, resolved

| # | Topic | Report A says | Report B says | Verified truth (5.4.2) |
|---|---|---|---|---|
| 1 | Server socket wiring | tooling-versions: `room.handleSocketConnect({ sessionId, socket: ws })` with the raw `ws` works | sync-server: don't pass the raw `ws`, because a stale socket kills the reconnected session | **sync-server is right.** `TLSocketRoom.handleSocketConnect` (`sync-core/src/lib/TLSocketRoom.ts:346-392`) overwrites `this.sessions[sessionId]` without calling the old entry's `unlisten`. It then binds `close`/`error` listeners to the socket with `handleSocketClose.bind(this, sessionId)`. A late `close` from the old socket therefore calls `room.handleClose(sessionId)`, which cancels the **new** session. `TLSyncRoom.handleNewSession` (`TLSyncRoom.ts:687-709`) also never closes the old socket. Use the wrapper with no `addEventListener` (§3.2). The raw form works in a smoke test only because nothing reconnects there. [critic-src] |
| 2 | TypeScript version | sync-client: 5.9.3 (TS 7 "untested") | tooling / sync-server / file-previews: 7.0.2 | **7.0.2.** I type-checked the full sync-client-style web code under tsc 7.0.2: `TLUserStore`, `getUserPresence`, `TLRemoteSyncError`, `@tldraw/assets/imports.vite`, `TLIndicatorPath` and the custom-shape augmentation. That includes `@ts-expect-error` negative checks (`userInfo` is rejected; bad props, bad enum and unknown shape type are all rejected). `skipLibCheck: true` is required on every TS version. [critic-run] |
| 3 | `ws` pin | sync-server: 8.22.0 | tooling: 8.21.3 (8.22.0 is under 24 h old and blocked by `minimumReleaseAge`); sync-client probe used 8.18.3 | **8.21.3, forced by `overrides: { ws: 'catalog:' }`.** The lockfile holds a single `ws@8.21.3`. The `maxPayload` default is `100 * 1024 * 1024` in 8.21.3 (`ws/lib/websocket-server.js:74`), the same as in 8.22.0. Moving to 8.22.0 after 2026-09-27 15:00 UTC is optional. [critic-run] |
| 4 | Protocol versions accepted | conflict-semantics: "`< 8` gives CLIENT_TOO_OLD" | sync-server: 5, 6 and 7 are accepted through a legacy path | **sync-server is right.** `TLSyncRoom.ts:1012-1033` maps 5→6, 6→7 (with `requiresLegacyRejection`) and 7→8 (with `supportsStringAppend=false`). Only a raw version of 4 or lower (or `null`) gets `CLIENT_TOO_OLD`, and 9 or higher gets `SERVER_TOO_OLD`. This doesn't matter for us, since all our clients speak 8. [critic-src] |
| 5 | Diff granularity of `richText` | sync-client: "anything else inside richText becomes a nested patch or put" | conflict-semantics: always a whole-value `put` | **Whole-value `put`.** `diffRecord` recurses only into `props`/`meta` (`diff.ts:185-191`). Inside `props`, `diffObject` is called with `nestedKeys = undefined`, so an object-valued key like `richText` goes through `isEqual` and then `['put', next]` (`diff.ts:193-236`). Only arrays and strings get finer ops. [critic-src] |
| 6 | Can `onAfterReceiveMessage` drop a message? | conflict-semantics: observe-only, cannot filter | sync-server: `closeSession` inside it drops the message (UNVERIFIED) | **Both are true.** The hook's return value is ignored, so it can't filter. But `closeSession` → `rejectSession` → `removeSession` deletes the session **synchronously** (`TLSocketRoom.ts:925-927`, `TLSyncRoom.ts:918-924, 527-534`). The `room.handleMessage` call that follows (`TLSocketRoom.ts:472`) then hits `if (!session) return` (`TLSyncRoom.ts:869-874`). Prefer the manual-wiring pre-filter (§3.2); it's simpler and was verified. [critic-src] |
| 7 | Must `useSync` get `bindingUtils`? | sync-client: pass `[...defaultBindingUtils]`, and passing only custom shapes with default bindings throws | tooling: passes only `shapeUtils: [...defaultShapeUtils, Card]` | **Either works.** `createTLSchemaFromUtils` leaves `bindings` `undefined` when `bindingUtils` is absent, and `createTLSchema` then defaults to `defaultBindingSchemas` (`editor/src/lib/config/createTLStore.ts:116-139`, `tlschema/src/createTLSchema.ts:339-345`). What throws is **omitting `defaultShapeUtils`**, because the arrow binding needs the arrow shape. A vitest test asserts that both client variants serialize identically to the server schema, and that omitting the defaults throws. [critic-run] |
| 8 | Durability after a process kill | conflict-semantics: "not tested" | sync-server: SIGKILL test with 0 acked-but-missing | **Verified.** `push_result` is sent only after `storage.transaction` returns (`TLSyncRoom.ts:1289` → COMMIT in `NodeSqliteWrapper.ts:87-101` → send at `:1552`). I also ran it through the browser: B rendered A's edit (which implies commit), then I sent SIGKILL, restarted, and a fresh context saw the edit. [critic-run] + [report-run] |
| 9 | Offline edits pushed on reconnect | sync-client: UNVERIFIED | conflict-semantics: probe 5a verified at protocol level | **Verified in a browser as well.** A edited while the server was dead, then reconnected. The edit reached B, and neither client was rolled back. [critic-run] |
| 10 | Same-note simultaneous typing | sync-client: "not tested" | conflict-semantics: probes 1c/1d show last push wins for the whole document | **Last push wins.** Characters are lost when two edits cross in flight (see §8). [report-run] |
| 11 | Import of `isEqual` in the lease recipe | conflict-semantics imports it from `@tldraw/utils` | n/a | **That import fails under pnpm**, because `@tldraw/utils` is not a direct dependency of `apps/sync` (I saw `ERR_MODULE_NOT_FOUND`). Use `node:util` `isDeepStrictEqual`, which is what `m0-skeleton/apps/sync/src/lease.ts` does (type-checked with TS 7), or add `@tldraw/utils` to the catalog. The same rule covers sync-server's `import type { StoreSchema } from '@tldraw/store'`: use `TLSchema` from `@tldraw/tlschema` instead. [critic-run] |
| 12 | Vite config | sync-client: `optimizeDeps.exclude: ['@tldraw/assets']` is needed | tooling: none (it didn't use `@tldraw/assets`) | **Needed only when self-hosting through `@tldraw/assets/imports.vite`.** Without it, `vite` dev crashes with `[UNLOADABLE_DEPENDENCY] Could not load …@tldraw/assets/translations/bn.json?url`. With it, dev serves normally. `vite build` works either way. [critic-run] |
| 13 | Board-id regex | all reports: `/^[A-Za-z0-9_-]{1,64}$/` (the official example also allows mixed case) | n/a | **Mixed case is a split-room bug on Windows and macOS.** I opened `Board1.sqlite`, then opened `board1.sqlite`, and the second handle saw the first file's data (NTFS is case-insensitive). The registry keys by exact string, so it would create **two `TLSocketRoom`s on one file**. Use lowercase-only ids (`/^[a-z0-9][a-z0-9_-]{2,63}$/`) and a `board-<id>.sqlite` filename. Device names (`con.sqlite`) opened fine on this Windows 11, and the prefix makes that moot anyway. [critic-run] |
| 14 | Shape type name | sync-client: `dr-card` (prefix it); tooling: `card`; file-previews: `file-card` | n/a | "Global" in RELEASE_NOTES (v4.3) means the TypeScript `TLGlobalShapePropsMap` registry, not a runtime registry. It is still persisted data and becomes part of the migration ids (`com.tldraw.shape.<type>/<n>`), so choose once. **Use `dr-file-card`**, verified end to end. |
| 15 | Is presence persisted? | n/a | n/a | No contradiction. `instance_presence` lives only in the in-memory `PresenceStore`. **But `user:` records are persisted** whenever attribution is stamped, e.g. on note text edits [report-run]. |

---

## 2. Final pinned versions (mutually consistent; installed and run together)

Every row was installed from one lockfile (`m0-skeleton/pnpm-lock.yaml`) with the §2.1 settings and exercised by typecheck, test, e2e or the prototype run [critic-run].

| Package | Exact version | Where | Notes |
|---|---|---|---|
| node | 24.19.0 | runtime | `.node-version` 24.19.0; `engines: ">=24.15.0 <25"`. `node:sqlite` needs no flag and prints no warning; native type stripping runs the server. |
| pnpm | 10.34.5 | `packageManager` | catalogs, `catalogMode: strict`, `overrides`, `allowBuilds: {}`, `strictDepBuilds: true`, `minimumReleaseAge: 1440` |
| typescript | 7.0.2 | root dev | CLI only (no tsserver, no compiler API). `skipLibCheck: true` is mandatory. |
| @types/node | 24.19.0 | root dev + override | `minimumReleaseAgeExclude: ['@types/node@24.19.0']` until about 2026-09-26 22:10 UTC |
| tldraw | 5.4.2 | web | all `@tldraw/*` pin each other exactly; keep them in lockstep |
| @tldraw/sync | 5.4.2 | web | |
| @tldraw/sync-core | 5.4.2 | sync | |
| @tldraw/tlschema | 5.4.2 | canvas-schema, sync | MIT, React-free |
| @tldraw/validate | 5.4.2 | canvas-schema | source of `T` (not re-exported by tlschema) |
| @tldraw/assets | 5.4.2 | web | self-hosted fonts, icons and translations (`optimizeDeps.exclude`) |
| react / react-dom | 19.3.0 | web (sync gets it as an auto-installed peer) | peer range `^18.2.0 \|\| ^19.2.1` |
| @types/react / @types/react-dom | 19.3.0 | web dev | |
| vite | 8.3.1 | web dev | |
| @vitejs/plugin-react | 6.1.1 | web dev | |
| vitest | 5.0.2 | root dev | `test.projects`: canvas-schema, sync, web (node env) |
| @playwright/test | 1.63.0 | e2e | `playwright install --only-shell chromium` (headless shell 153.0.8010.12) |
| ws | 8.21.3 | sync + override | single copy (sync-core wants `^8.18.0`) |
| @types/ws | 8.18.1 | sync dev | |
| @biomejs/biome | 2.5.14 | root dev | only lint/format tool (typescript-eslint requires TS below 6.1) |
| sharp | 0.35.4 | worker | no install script; ESM is **default export only** at runtime |
| pdfjs-dist | 6.3.289 | worker | use the `legacy/build/pdf.mjs` entry in Node |
| @napi-rs/canvas | 1.0.9 | worker | pdf.js Node canvas; no install script |
| pdf-lib | 1.17.1 | worker dev | fixtures |
| @cantoo/pdf-lib | 2.11.1 | worker dev | encrypted fixture only |
| file-type | 22.1.1 | worker dev | first-gate sniffing only |
| ffmpeg / ffprobe | 9.0.1 (Windows dev, system install) | worker | Linux target: Debian trixie `7:7.1.5-0+deb13u1` (UNVERIFIED at runtime). Do not use `ffmpeg-static`. |

Transitives worth knowing: `@tiptap/core` 3.31.3 (via tldraw `^3.12.1`), which drives the same-note behavior, and `lodash.throttle` 4.1.1, which implements `pruneTombstones` (it has `.flush()`/`.cancel()`).

Optional and not in the default set: `tsx` 4.23.15 (needs `allowBuilds: { esbuild: true }`), `better-sqlite3` 13.0.3 (needs `allowBuilds: { better-sqlite3: false }`; same `NodeSqliteWrapper`), and `esbuild` 0.28.2 as a bundle fallback [report-run].

### 2.1 Workspace settings (verified in `m0-skeleton/pnpm-workspace.yaml`)

```yaml
catalogMode: strict
minimumReleaseAge: 1440
minimumReleaseAgeExclude: ['@types/node@24.19.0']
allowBuilds: {}          # nothing in the set needs a build script (sharp/@napi-rs/canvas included)
strictDepBuilds: true
overrides: { '@types/node': 'catalog:', ws: 'catalog:' }
```

Layout: `apps/web`, `apps/sync`, `apps/worker`, `packages/canvas-schema` (exports `./src/index.ts`, no build step) and `e2e`.

Rules:
- Don't use `pnpm deploy` or injected deps. They break native type stripping with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` [report-run].
- The server uses erasable TS only: no enums, no parameter properties, `.ts` import extensions, and `import type`.

---

## 3. Server wiring (verified: `m0-skeleton/apps/sync/src/{rooms.ts,server.ts}`)

### 3.1 Exact APIs used (`@tldraw/sync-core@5.4.2 dist-esm/index.d.mts`)

```ts
class TLSocketRoom<R extends UnknownRecord = UnknownRecord, SessionMeta = void> {
  constructor(opts: TLSocketRoomOptions<R, SessionMeta>)   // d.ts:1264: storage?, schema?, clientTimeout?, log?,
  //   onSessionRemoved?(room, {meta, numSessionsRemaining, sessionId}), onBeforeSendMessage?, onAfterReceiveMessage?,
  //   onCommittedChanges?({diff, documentClock}), objectTypes?, authorizeRecord?, onSessionSnapshot?
  //   (initialSnapshot/onDataChange are deprecated; storage+initialSnapshot together throws)
  handleSocketConnect(opts: { sessionId: string; socket: WebSocketMinimal; isReadonly?: boolean;
    objectAccess?: TLObjectStoreAccess } & (SessionMeta extends void ? object : { meta: SessionMeta })): void  // d.ts:893
  handleSocketMessage(sessionId: string, message: AllowSharedBufferSource | string): void
  handleSocketClose(sessionId: string): void;  handleSocketError(sessionId: string): void
  closeSession(sessionId: string, fatalReason?: string | TLSyncErrorCloseEventReason): void  // d.ts:1217
  close(): void; isClosed(): boolean; getNumActiveSessions(): number; getCurrentDocumentClock(): number
  getRecord(id: string): R /* undefined at runtime if missing */; sendCustomMessage(sessionId: string, data: any): void
  storage: TLSyncStorage<R>   // storage.transaction(txn => {...}) is SYNC and does NOT validate
}
interface WebSocketMinimal { addEventListener?; removeEventListener?; send(data: string): void;
  close(code?: number, reason?: string): void; readyState: number }                          // d.ts:1889
class SQLiteSyncStorage<R> { static hasBeenInitialized(sql: TLSyncSqliteWrapper): boolean
  constructor({ sql, snapshot, objectTypes, onChange }: { sql: TLSyncSqliteWrapper; snapshot?: RoomSnapshot | StoreSnapshot<R>; ... }) }
class NodeSqliteWrapper { constructor(db: SyncSqliteDatabase, config?: { tablePrefix?: string }) }  // d.ts:252
```

### 3.2 Upgrade handler: essential shape

```ts
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
const liveSockets = new Map<string, WebSocket>()           // `${boardId}/${sid}` -> current ws
http.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const boardId = /^\/connect\/([^/]+)$/.exec(url.pathname)?.[1]
  const clientSessionId = url.searchParams.get('sessionId')   // appended by useSync (per-tab TAB_ID)
  if (!boardId || !BOARD_ID_RE.test(boardId) || !clientSessionId || clientSessionId.length > 128) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return void socket.destroy() }
  const auth = await authorize(url)                            // ALL async work before getOrCreate
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!auth) return ws.close(4099, 'NOT_AUTHENTICATED')      // 4099 = terminal on client; an HTTP 401 => endless retry
    const room = registry.getOrCreate(boardId)                 // synchronous => race-free
    const sid = `${auth.userId}:${clientSessionId}`            // namespace client-chosen id by user
    const liveKey = `${boardId}/${sid}`
    const prev = liveSockets.get(liveKey); liveSockets.set(liveKey, ws)
    if (prev && prev !== ws) prev.close(1000, 'replaced')
    room.handleSocketConnect({ sessionId: sid, isReadonly: !auth.canEdit, meta: { userId: auth.userId },
      socket: { send: (d) => ws.send(d), close: (c, r) => ws.close(c, r), get readyState() { return ws.readyState } } })
    const isCurrent = () => liveSockets.get(liveKey) === ws
    ws.on('message', (data, isBinary) => { if (!isCurrent()) return
      /* token bucket -> room.closeSession(sid,'RATE_LIMITED'); chunk-count cap ("<n>_" prefix > 40) */
      room.handleSocketMessage(sid, isBinary ? Buffer.from(data as Buffer).toString('utf8') : data.toString()) })
    ws.on('close', () => { if (isCurrent()) { liveSockets.delete(liveKey); room.handleSocketClose(sid) } })
    ws.on('error', () => { if (isCurrent()) { liveSockets.delete(liveKey); room.handleSocketError(sid) } })
  })
})
```

The skeleton has the full version, including the token bucket, the chunk cap, the room-open failure path (`4099 UNKNOWN_ERROR`) and `/healthz`.

**Dev identity:** the skeleton only boots with `DRAFTROOM_DEV_AUTH=1`, and takes `?devUser=` / `?devRole=viewer` from the URL. Replace this with signed short-lived tickets in milestone 1. The `uri` function is re-evaluated on every reconnect, so a ticket can be fetched there.

### 3.3 Room registry pattern (race-safe, evicting, crash-safe)

```ts
export const BOARD_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/        // lowercase: case-insensitive FS => split room
const path = join(resolve(dataDir), `board-${boardId}.sqlite`)  // DATA_DIR env = configurable data dir
getOrCreate(boardId) {                                          // NO await anywhere in here
  const existing = this.rooms.get(boardId)
  if (existing && !existing.room.isClosed()) { clearTimeout(existing.evictTimer); return existing.room }
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL'); db.exec('PRAGMA synchronous = FULL'); db.exec('PRAGMA busy_timeout = 5000')
  const sql = new NodeSqliteWrapper(db)
  db.exec('BEGIN IMMEDIATE')                                    // atomic first-time DDL+seed (ctor never calls sql.transaction)
  const storage = new SQLiteSyncStorage<TLRecord>({ sql })      // NEVER pass `snapshot` to an existing DB: it wipes it
  db.exec('COMMIT')
  const room = new TLSocketRoom<TLRecord, SessionMeta>({ schema: draftroomSchema, storage,
    onSessionRemoved: (room, { numSessionsRemaining }) => {
      if (room.isClosed() || this.rooms.get(boardId) !== entry) return   // fires ~5 s after close() too
      if (numSessionsRemaining === 0) entry.evictTimer = setTimeout(() => this.evict(boardId, entry), 30_000) } })
  // on any throw: db.close() and rethrow (e.g. 'Incompatible schema?' after a server rollback)
}
closeEntry(e) { this.rooms.delete(e.roomId); e.room.close()
  ;(e.storage as any).pruneTombstones?.flush?.()                // REQUIRED before db.close() (see §7)
  e.db.close() }
```

Rules:
- There is one `TLSocketRoom` per board per process. Never call `room.close()` except through `closeEntry`.
- `room.close()` never deletes storage.
- Shut down with `SIGINT`/`SIGTERM` → `closeAll()` → `exit`. On Windows, `SIGTERM` can't be caught (Node docs); Ctrl+C sends `SIGINT`. Data is still safe, because acknowledgements happen after commit.

---

## 4. Client wiring (verified: `m0-skeleton/apps/web/src/App.tsx`)

```ts
useSync(opts: UseSyncOptions & TLStoreSchemaOptions): RemoteTLStoreWithStatus   // @tldraw/sync d.ts:143
// UseSyncOptionsBase: assets: TLAssetStore (required); users?: TLUserStore; getUserPresence?(store, user);
//   onCustomMessageReceived?(data); themes?.   Plus EITHER uri: string | (() => string | Promise<string>) OR connect.
// TLStoreSchemaOptions: { shapeUtils?, bindingUtils?, assetUtils?, records?, migrations? } | { schema? }
// status: 'loading' | 'synced-remote' (store, connectionStatus 'online'|'offline', objectAccess) | 'error' (TLRemoteSyncError.reason)
```

```tsx
const customShapeUtils = [FileCardShapeUtil]                          // module level: STABLE
const syncShapeUtils = [...defaultShapeUtils, ...customShapeUtils]    // useSync does NOT add defaults
const assetUrls = getAssetUrlsByImport()                              // '@tldraw/assets/imports.vite'
async function getSyncUri() { return `${SYNC_URL}/connect/${encodeURIComponent(BOARD_ID)}?devUser=${DEV_USER}` }
// in the component:
const users = useMemo<TLUserStore>(() => ({ currentUser: computed('currentUser', () =>
  UserRecordType.create({ id: createUserId(DEV_USER), name: DEV_USER, color: '#1971c2' })) }), [])
const store = useSync({ uri: getSyncUri, assets, users, shapeUtils: syncShapeUtils,
  getUserPresence(s, u) { const p = getDefaultUserPresence(s, u); return p && { ...p, meta: { app: 'draftroom' } } } })
if (store.status === 'loading') return <Connecting/>
if (store.status === 'error') return <SyncError reason={store.error instanceof TLRemoteSyncError ? store.error.reason : store.error.message}/>
return <Tldraw store={store.store} shapeUtils={customShapeUtils} assetUrls={assetUrls} licenseKey={...} />  // ONLY custom utils here
```

Rules:
- **Stability.** `uri`, `assets`, `users`, `connect` and the utils arrays are effect dependencies. An inline `uri` function causes a reconnect storm, and an inline utils array causes React error #301 [report-run].
- **Errors are terminal.** A `4099` error is not retried; remount with a `key` to retry. Transient drops stay `synced-remote` with `connectionStatus: 'offline'`, and the editor stays editable [report-run, critic-run].
- **Assets.** `TLAssetStore.upload(asset, file, abortSignal?) → Promise<{ src: string; meta?: JsonObject }>`, `resolve?(asset, ctx)` and `remove?(ids)`. Store a stable app reference in `src` and sign it in `resolve`. Don't delete bytes in `remove`, because undo can bring the shape back [report-src].
- **Required CSS:** `import 'tldraw/tldraw.css'`.
- **Deep links:** use `options={{ deepLinks: true }}`, not the deprecated prop.

---

## 5. Custom file-card shape + migration + shared schema (verified client AND server)

`packages/canvas-schema` imports only `@tldraw/tlschema` and `@tldraw/validate`. The server imports it with no React. The web `ShapeUtil` reuses the same `props` and `migrations` objects.

```ts
// packages/canvas-schema/src/file-card.ts
export const FILE_CARD_TYPE = 'dr-file-card' as const
declare module '@tldraw/tlschema' { interface TLGlobalShapePropsMap { [FILE_CARD_TYPE]: FileCardShapeProps } }
export type FileCardShape = TLShape<typeof FILE_CARD_TYPE>
export const fileCardShapeProps: RecordProps<FileCardShape> = {
  w: T.nonZeroNumber, h: T.nonZeroNumber, assetId: appId('ast'), versionId: appId('ver'),   // app ids, never URLs
  kind: T.literalEnum('image', 'pdf', 'video', 'other'), name: T.string, mimeType: T.string,
  sizeBytes: T.positiveInteger /* >= 0 */, status: T.literalEnum('queued', 'processing', 'ready', 'failed'),
  pageCount: T.nullable(T.positiveInteger), durationMs: T.nullable(T.positiveInteger), posterDerivativeId: T.nullable(appId('drv')) }
export const fileCardVersions = createShapePropsMigrationIds(FILE_CARD_TYPE, { AddPosterDerivativeId: 1 })  // 'com.tldraw.shape.dr-file-card/1'
export const fileCardShapeMigrations = createShapePropsMigrationSequence({ sequence: [
  { id: fileCardVersions.AddPosterDerivativeId, up(p) { p.posterDerivativeId = null }, down(p) { delete p.posterDerivativeId } } ] })
// packages/canvas-schema/src/index.ts  (the ONE server schema)
export const draftroomSchema = createTLSchema({ shapes: { ...defaultShapeSchemas, [FILE_CARD_TYPE]: { props: fileCardShapeProps,
  migrations: fileCardShapeMigrations } }, bindings: defaultBindingSchemas })
// apps/web: class FileCardShapeUtil extends BaseBoxShapeUtil<FileCardShape> { static override type = FILE_CARD_TYPE;
//   static override props = fileCardShapeProps; static override migrations = fileCardShapeMigrations;
//   getDefaultProps(); component(); getIndicatorPath(shape): TLIndicatorPath /* abstract in 5.x */ }
// apps/sync: new TLSocketRoom({ schema: draftroomSchema, storage, ... })
```

Verified [critic-run]:
- `file-card.test.ts`: a valid record is accepted. Signed URLs, `data:` URLs, an unknown status and an extra prop are rejected. A v0 record migrates up (`posterDerivativeId: null`) and back down, and the sequence version is 1.
- `schema.test.ts`: the client schema built from `[...defaultShapeUtils, FileCardShapeUtil]`, with or without `bindingUtils`, serializes identically to `draftroomSchema` with sorted keys. **Keep this test in CI.**
- The e2e test: a `dr-file-card` created in A renders in B and in a fresh context, including after a SIGKILL and restart.

Rules:
- Migrations are append-only, record-scoped and have `down`. With `down`, older tabs are served during a deploy; without it they get `CLIENT_TOO_OLD` [report-run].
- Never remove a shape type or migration. A rolled-back server throws `Incompatible schema?` and the room can't open [report-run].
- **Deploy the server before the web client.** A server that lacks a shape the client knows accepts the connection and then fails the first push with `INVALID_RECORD`, which is terminal [report-run].
- A `StyleProp` in props (e.g. `DefaultColorStyle`) is overridden by the editor's "next shape" style at creation [report-run].
- Server-side `storage.transaction` writes are **not** validated. Call `draftroomSchema.types.shape.validate(rec)` first [report-run, critic-run].

---

## 6. File preview path (outside the sync loop)

The full detail is in [file-previews.md](file-previews.md). The prototype (`file-previews/prototype.mjs`) ran **inside the pnpm workspace** as `apps/worker`, installed from the §2 catalog under `strictDepBuilds`. All 5 assets reached `ready` and all 14 negative cases were classified, in 5.2 s [critic-run].
- **Image:** sharp with `limitInputPixels: 100_000_000`, `failOn: 'warning'` and a loader allowlist via `sharp.block`/`unblock`. The GIF loader is `VipsForeignLoadNsgif*`. Outputs are `thumb-512.webp` and `display-2048.webp`, auto-oriented with EXIF stripped.
- **PDF:** pdfjs-dist legacy build with @napi-rs/canvas, **in a child process** with a SIGKILL timeout and a 4096² canvas clamp. Pass a `Uint8Array` (not a `Buffer`), set `standardFontDataUrl` (with a trailing `/`), and call `loadingTask.destroy()`. Render the cover eagerly and other pages lazily.
- **MP4:** `ffprobe -protocol_whitelist file -f mov …`. Accept H.264 (Baseline/Main/High, yuv420p) with AAC. Extract a poster through ffmpeg to PNG on stdout, then sharp to WebP. Run a box scan or decode check, because a truncated file passes probe and poster extraction.
- **The canvas stores only ids and facts** (the file-card props above). URLs are resolved per render through the API. The worker never touches the room. In M0 the uploading client patches the hint props.

---

## 7. Durability facts (all [report-run] unless marked)

- **Commit before acknowledgement.** Each push is one synchronous SQLite transaction (`BEGIN`/`COMMIT`). `push_result` and the broadcast go out only after `COMMIT` [critic-src]. A `push_result: commit` is therefore a persistence acknowledgement.
- **Kill tests.** SIGKILL tests with `synchronous` FULL and NORMAL gave 0 acked-but-missing records. The browser kill and restart also passed [critic-run].
- **Pragmas.** The library sets **none**. The `node:sqlite` defaults are `journal_mode=delete`, `synchronous=FULL` and `busy_timeout=0`. Set WAL, FULL (0.90 ms per commit locally; NORMAL is 0.07 ms) and `busy_timeout` yourself.
- **Blocking I/O.** `node:sqlite` is synchronous, so each commit's fsync blocks the event loop for every room. Render disk latency is UNVERIFIED.
- **What survives restart.** `documentClock`, tombstones and `schema` persist in the `metadata` table, so reconnecting clients get correct incremental diffs after a restart.
- **`snapshot` wipes the database.** `new SQLiteSyncStorage({ sql, snapshot })` on an initialized DB **deletes all data** (`SQLiteSyncStorage.ts:391`) [critic-src]. Only pass it when `!SQLiteSyncStorage.hasBeenInitialized(sql)`.
- **Crash bug.** `pruneTombstones` is `lodash.throttle(fn, 1000, { leading: false })` (`SQLiteSyncStorage.ts:514-533`). If `db.close()` runs within 1 s of any delete, the process dies with `Error: statement has been finalized (ERR_INVALID_STATE)`. I reproduced it: naive close gave exit 1, and calling `.pruneTombstones.flush()` first gave exit 0 [critic-run]. The official example's `room.close(); db.close()` has this bug.
- **Backups.** Use `node:sqlite` `backup(db, path)` on the live connection, which is consistent under WAL. Never copy only the `.sqlite` file.
- **Restores.** Restoring an older backup can leave ghost records on clients once the clock catches up. Raise `documentClock` and `tombstoneHistoryStartsAtClock` on restore, or use `room.loadSnapshot` (the mitigation is source-derived and UNVERIFIED).
- **Tombstone pruning.** Tombstones are pruned only above 5000, down to 4000. Clients older than the retained history get `wipe_all`, which is safe.

---

## 8. Conflict semantics (5.4.2, [report-run] via conflict-semantics.md probes)

| Situation | Outcome |
|---|---|
| Different props of one record, concurrently | Both kept (per-prop patches on top-level fields and first-level `props`/`meta` keys) |
| Same prop, concurrently | **Last push processed by the server wins.** No CAS, no timestamps. |
| Two users typing in one note/text (`props.richText`) | **No merge.** Each keystroke sends the whole doc as a `put`. When edits cross in flight, the later one replaces the other user's characters, including on the loser's screen. Needs the server-enforced lease (§8.1). |
| String `append` race (page/frame names, `index`) | Can be silently discarded, or produce a value neither user typed (`"Plans!2"`) |
| Edit vs delete, either order | **Delete wins.** The editing client gets `discard` and reverts. |
| Resurrection | A `patch` never resurrects. Any `put` of the id does (undo/redo, same-id create, server write) and clears the tombstone. |
| Undo after a remote edit | Remote changes aren't on your stack, but undo **writes back your whole earlier record**. That reverts other users' props on that object, even ones you never touched, and can resurrect objects others deleted. (Native behaviour. Draftroom replaces it with per-property undo since 2026-09-27: `apps/web/src/sync-quality/perPropUndo.ts`, undo-per-prop.md.) |
| Reconnect after offline edits | The client sends `lastServerClock` and gets the diff since then (or `wipe_all`), then re-pushes **only fields it changed**. It never uploads a snapshot, but its changed fields overwrite newer values (last writer wins). Verified in a browser [critic-run]. |
| Concurrent reparent into a deleted frame | Committed; the orphan's `parentId` points to a missing record. How the editor renders it is UNVERIFIED. |
| Read-only session writes | Skipped per op on the server, and the client gets `discard`. The socket stays open. Presence is still accepted. |
| Invalid record / unknown shape in a push | The whole push rolls back, then `4099 INVALID_RECORD` (terminal) |

### 8.1 Minimal text lease (typed in `m0-skeleton/apps/sync/src/lease.ts`)

Pass it as `authorizeRecord` in the `TLSocketRoom` options:

```ts
type TLRecordAuthorizer<Rec, SessionMeta> = (args: { session: { sessionId: string; isReadonly: boolean; meta: SessionMeta } }
  & ({ type: 'create'; prev: null; next: Rec } | { type: 'update'; prev: Rec; next: Rec } | { type: 'delete'; prev: Rec; next: null })) => Rec | null
```

How it behaves:
- The first writer of a shape's `richText` holds a 5 s lease, renewed on each edit.
- Other users' text edits and deletes on that shape return `null`. The client gets `discard`, and the server sends a `text-lease-denied` custom message.
- The veto drops the **whole record op**, including non-text props in the same push.
- It runs synchronously inside the commit transaction and can't read other records.

Its runtime behavior was probed by conflict-semantics (probe 7). The Draftroom version, using `isDeepStrictEqual`, was type-checked by me.

For the UI, show the lease holder through `presence.meta.editingShapeId`. It's a hint only, since the client sets it.

---

## 9. License status ([report-src/run], license.md)

- **Development.** Free with no key on `http:`, on `https` loopback hosts, or when `NODE_ENV !== 'production'`. The editor shows an "unlicensed" watermark (observed on `http://localhost`).
- **Production.** HTTPS on a real host with `NODE_ENV=production` and no valid domain-matching key gives a console error, a beacon to `cdn.tldraw.com`, and **after 5000 ms the editor is replaced by a hidden div (blank canvas)**.
  - The internal pilot and external reviewers **are production** under the license.
  - Staging on `*.onrender.com` must be in the key's hosts.
- **Trial.** 100 days, no grace period, all features enabled, and it sends the full `window.location.href`, so strip tokens from the URL before mounting.
- **Annual key.** 30-day grace period after expiry.
- **Key delivery.** Use the `licenseKey` prop or `VITE_TLDRAW_LICENSE_KEY`, which Vite inlines at build time. Renewal therefore needs a rebuild.
- **Sync.** `@tldraw/sync` and `sync-core` fall under the same license and have **no runtime key check**. The pricing page says "Multiplayer sync included".
- **Commenting.** Commenting (`@tldraw/commenting`/`mentions`/`sync-collaboration`/`collaboration`) is premium. Don't depend on those packages.
- **Price is quote-only and unresolved.** Open questions for sales are in license.md §10.

---

## 10. Top risks (ranked)

1. **License blanking and unknown price.** Any HTTPS production or staging deploy without a domain-matching key goes blank after 5 s. The commercial price is unquoted.
2. **Same-note typing loses characters** (whole-`richText` put). A server lease (§8.1) is needed for v1.
3. **Undo reverts others' edits on the same object and can resurrect deleted objects.** This is native HistoryManager behavior. Document it, or build a per-prop undo filter or a server veto. **Mitigated (2026-09-27):** per-prop undo adopted, verified in two browsers (e2e conflicts.spec.ts "WRK-05"); it and the rebase guard rest on `@internal` engine details, so re-run those tests on every tldraw bump.
4. **Process crash from the tombstone-prune timer after `db.close()`.** The workaround relies on the `@internal` `pruneTombstones.flush()`. Re-check on every tldraw upgrade and consider filing upstream.
5. **Split rooms.**
   - Mixed-case board ids on a case-insensitive filesystem open two rooms on one file.
   - The raw-`ws` wiring kills reconnected sessions.
   - Both are fixed in the skeleton. Never run two sync processes on one data dir.
6. **Schema drift or rollback.** A late `INVALID_RECORD`, `Incompatible schema?` on rollback, and deploy order matter. Mitigate with the CI schema-equality test, append-only migrations with `down`, and deploying the server first.
7. **`SQLiteSyncStorage({ snapshot })` wipes an existing room.** Backup restore can also create ghost records.
8. **Synchronous SQLite fsync blocks the event loop** for all rooms. Render disk latency is unmeasured.
9. **No built-in size or rate limits.** A 5M-character record was accepted, and `ws` `maxPayload` defaults to 100 MiB. You must set `maxPayload`, a chunk cap and a token bucket.
10. **`user:` records (name, color, imageUrl) persist in the board document.** This is a privacy and retention concern.
11. **Preview worker native crashes and slower hardware.** pdf.js/Skia can abort the process (SIGILL was seen at over 260-character Windows paths), so keep it in a child process. All timings were measured on a 32-core workstation.
12. **TS 7 has no compiler API.** Cursor's editor will run a different TS language service from CLI `tsc` 7. CI is the source of truth.

---

## 11. UNVERIFIED claims implementers must check

- **Render/Linux:**
  - pnpm/corepack in Render's Node build
  - fsync latency and p99 event-loop delay on the persistent disk
  - `--watch-path` on Linux
  - `playwright install --with-deps` on the CI runner
  - sharp and @napi-rs/canvas Linux prebuilds at runtime
  - Debian trixie ffmpeg 7.1.5 flags and HLS behavior
  - the `node:24.19.0-trixie-slim` image
- The license's HTTPS-production blanking was observed only in a Node probe of the real `LicenseManager`, not in a deployed browser. The hosts in a trial key are also unknown.
- TipTap caret position after a remote `setContent` while editing, and possible echo pushes.
- Editor rendering of orphaned shapes (parent deleted) and arrows bound to deleted shapes. Server-side orphan repair is still a design.
- The backup-restore mitigation (raising `documentClock` and `tombstoneHistoryStartsAtClock`) is source-derived only.
- The "Saved" indicator built by counting `push`/`push_result` through `useSync({ connect })`. There's no public all-acknowledged API.
- Offline edits live only in memory. I grepped `@tldraw/sync/src` and `TLSyncClient.ts` and found no IndexedDB or persistence of document changes [critic-src], so a reload while offline should lose them. That consequence was not exercised in a browser.
- `useSync({ schema })` as an alternative to `shapeUtils`, at runtime.
- Permission-revocation loop (`closeSession(sid)` for a downgrade, `closeSession(sid, 'FORBIDDEN')` for a revoke) against the 15 s target.
- React 18.2 at runtime; Firefox and Safari MP4 playback; Playwright's bundled-Chromium codecs (use `channel: 'chrome'` for video e2e).
- Ultra HDR JPEGs under the sharp allowlist; HEIC (unsupported by the prebuilt); the effect of pdf.js `maxImageSize`; CMap and non-Latin PDFs; decode-check cost for long videos.
- Which TS version Cursor bundles (TS 7's native-preview extension is not on Open VSX).
- Whether identical dropped files dedupe to one asset id.

---

## 12. M0 gate → evidence map

| Gate | Evidence |
|---|---|
| Versions verified and pinned | §2; `m0-skeleton/pnpm-lock.yaml`, frozen install [critic-run] |
| Two sessions see each other and their edits | `e2e/tests/m0.spec.ts` step 1 (custom shape, geo shape, and presence `getCollaborators()` includes the peer) [critic-run] |
| Reload preserves content | e2e step 2 [critic-run] |
| Killed/restarted server keeps acknowledged changes | e2e step 3 (SIGKILL, restart, fresh context) [critic-run]; sync-server `kill-test.ts`, 5 runs [report-run] |
| Reconnect does not restore an old board | e2e step 4 (offline edit pushed, no rollback) [critic-run]; conflict-semantics probe 5a/5b [report-run] |
| Same-note typing, edit/delete, undo-after-remote documented | §8; conflict-semantics probes 1c/1d, 3, 4 [report-run]. Still needs the browser-level lease demo. |
| Custom file-card with shared schema and migration | §5; `file-card.test.ts`, `schema.test.ts`, e2e [critic-run] |
| Image / PDF / MP4 preview path | §6; prototype run in the workspace [critic-run] |
| Engine recommendation | Technically viable for M0. It is contingent on the license quote (§9) and on accepting or mitigating §8 (lease, undo). |

Reproduce: `cd docs/research/m0-skeleton && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test`. For the e2e run, also do `pnpm --filter @draftroom/e2e exec playwright install --only-shell chromium && pnpm e2e`. For the preview run, copy `../file-previews/{prototype.mjs,mp4-boxes.mjs}` into `apps/worker` and run `pnpm --filter @draftroom/worker prototype` (needs ffmpeg and ffprobe on PATH). To run the server by hand: `DRAFTROOM_DEV_AUTH=1 DATA_DIR=./.data/rooms node apps/sync/src/server.ts`. The prune crash repro is `node apps/sync/probes/prune-crash.ts naive|flush`.

I left `biome.json` out of the skeleton on purpose: a nested root Biome config would interfere with the real repo's root config later. Its verified content is in [tooling-versions.md §4](tooling-versions.md). The skeleton is reference material to lift into the repo root, not the application.
