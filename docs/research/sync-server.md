# Research: tldraw sync server on Node.js (`@tldraw/sync-core@5.4.2`)

Status: verified 2026-09-26 against the published npm tarballs for `@tldraw/sync-core@5.4.2`, `@tldraw/tlschema@5.4.2`, `@tldraw/store@5.4.2` and `@tldraw/sync@5.4.2`. The tarballs ship `src/`, so the line references below point at `node_modules/@tldraw/<pkg>/src/...`. Behavior was checked with probe scripts on Node 24.19.0 / Windows 11 (see §11). Anything marked **UNVERIFIED** was not confirmed by source or experiment.

Confidence tags used below:
- **[src]**: read in the 5.4.2 source or `.d.ts`
- **[run]**: confirmed by running a probe
- **[docs]**: taken from tldraw docs or templates at tag `v5.4.2`

---

## 0. TL;DR (decisions for `apps/sync`)

1. **Use `TLSocketRoom` + `SQLiteSyncStorage` + `NodeSqliteWrapper` on `node:sqlite`, with one `.sqlite` file per board.** Node 24.19 needs no flags and prints no ExperimentalWarning [run]. `better-sqlite3` is optional.
2. **Durability:** each accepted push is one synchronous SQLite transaction. `COMMIT` returns before the server sends `push_result` or broadcasts [src]. A `SIGKILL` test found 0 acked-but-missing records across 5 runs [run].
3. **The library sets no pragmas.** Set them yourself before creating the storage: `journal_mode=WAL`, `synchronous=FULL` (or `NORMAL`, see §4.6), and `busy_timeout`.
4. **Crash bug to work around:** `SQLiteSyncStorage` schedules a trailing tombstone prune 1 s after any delete. If `db.close()` runs inside that second, the timer throws an uncaught exception and **the Node process dies**. This affects `node:sqlite` and `better-sqlite3` [run], and the official example's eviction code has the same bug. Before `db.close()`, call `(storage as any).pruneTombstones.flush()` (§4.8).
5. **Wire sockets by hand; don't pass the raw `ws` to `handleSocketConnect`.** Suppose the old socket of a reconnecting tab closes late. With the raw `ws` (official example), that close event **kills the new session** that shares its `sessionId` [run]. With a wrapper that has no `addEventListener` and forwards events only from the current socket, the new session survives. The wrapper also gives you a place for rate limiting and message-size caps (§5.3).
6. **Read-only is enforced on the server.** Document writes from `isReadonly` sessions are skipped and the client gets `push_result: 'discard'`. The socket stays open, and presence is still accepted [run].
7. **Every record in a client push is validated against the server schema.** Invalid records close the socket with `4099 INVALID_RECORD` [run]. Server-side `storage.transaction` writes are **not** validated [run].
8. **Never roll back the server schema after data has migrated.** `TLSocketRoom`'s constructor throws `Incompatible schema?` [run]. Never delete a shape type from the schema either.
9. **Pins:** `@tldraw/sync-core@5.4.2`, `@tldraw/tlschema@5.4.2`, `@tldraw/validate@5.4.2`, `ws@8.22.0`, `@types/ws@8.18.1`, `@types/node@24.19.0`. Type-check with `typescript@7.0.2`. Run with Node 24's native type stripping; `tsx@4.23.15` also works for watch mode. No `better-sqlite3`.

---

## 1. Versions and pins

| Package | Pin | Why |
|---|---|---|
| `@tldraw/sync-core` | `5.4.2` (exact) | Server room plus storage. Must match the client's `tldraw` and `@tldraw/sync` exactly; tldraw docs say to deploy backend and client together [docs: apps/docs/content/docs/sync.mdx "Deployment concerns"]. |
| `@tldraw/tlschema` | `5.4.2` (exact) | `createTLSchema`, `defaultShapeSchemas`, `defaultBindingSchemas`, migration helpers. |
| `@tldraw/validate` | `5.4.2` (exact) | `T` validators for custom shape `props` in the shared schema package. `tlschema` does **not** re-export `T` [src: tlschema/src/index.ts]. |
| `@tldraw/store` | `5.4.2` (types only, optional) | `StoreSchema` type. It is installed transitively anyway. |
| `ws` | `8.22.0` | `sync-core` itself depends on `ws@^8.18.0` [src: package.json]. |
| `@types/ws` | `8.18.1` | Latest on npm. |
| `@types/node` | `24.19.0` | Matches the runtime and includes `node:sqlite` types (`DatabaseSync`, `backup()`). |
| `typescript` | `7.0.2` | What tldraw 5.4.2 builds with (`devDependencies`). It type-checked all probe code [run]. |
| `tsx` | `4.23.15` (dev, optional) | Works [run]. Only needed for `tsx watch`, because Node 24 runs `.ts` natively. |
| `better-sqlite3` | **not needed** | 13.0.3 ships win/linux/mac prebuilds (no install script) and works on Node 24 [run]. `node:sqlite` is enough and needs no native build. |

- `sync-core` and `tlschema` declare `peerDependencies: react ^18.2.0 || ^19.2.1, react-dom` even though the server never imports React. npm and pnpm 10 both auto-install them (pnpm installed `react@19.3.0`) [run]. This is harmless.
- `engines.node` is `>=22.12.0`.
- The tarball's `DOCS.md` shows **stale APIs** that do not exist in 5.4.2, such as `new TLSyncRoom({ store, roomId, persistenceAdapter })` and `room.handleSocketConnect(socket, {...})`. **Don't use `node_modules/@tldraw/sync-core/DOCS.md` as a reference.** Use the `.d.ts` and this document.

Import paths (all from the package root; `sync-core` has only a `"."` export) [src: package.json `exports`]:

```ts
import {
  TLSocketRoom, SQLiteSyncStorage, NodeSqliteWrapper, InMemorySyncStorage,
  DurableObjectSqliteSyncWrapper, TLSyncErrorCloseEventCode, TLSyncErrorCloseEventReason,
  loadSnapshotIntoStorage, DEFAULT_INITIAL_SNAPSHOT,
  type TLSyncStorage, type TLSyncSqliteWrapper, type WebSocketMinimal, type RoomSnapshot,
  type TLSocketRoomOptions, type TLRecordAuthorizers, type SessionStateSnapshot, type TLSyncLog,
} from '@tldraw/sync-core'
import { createTLSchema, defaultShapeSchemas, defaultBindingSchemas, type TLRecord } from '@tldraw/tlschema'
import { T } from '@tldraw/validate'
import { DatabaseSync, backup } from 'node:sqlite'
```

`chunk`, `ClientWebSocketAdapter`, `ServerSocketAdapter` and `TLSyncRoom` exist at runtime but are `@internal`: they are excluded from the `.d.ts`, and TypeScript reports `TS2305` for them [run].

---

## 2. Wire protocol facts the server depends on [src: sync-core/src/lib/protocol.ts]

- `TLSYNC_PROTOCOL_VERSION = 8`. The server accepts 5, 6 and 7 through a legacy path; 7 disables string-append ops [src TLSyncRoom.ts:1005-1033]. A 7 connected, 4 was rejected with `CLIENT_TOO_OLD` and 9 with `SERVER_TOO_OLD` [run].
- Client to server: `{type:'connect', connectRequestId, lastServerClock, protocolVersion, schema}`, `{type:'push', clientClock, diff?, presence?}`, `{type:'ping'}`.
- Server to client: `connect` (includes `isReadonly`, `objectAccess`, `serverClock`, `hydrationType: 'wipe_all'|'wipe_presence'`), `data` (a batch of `patch` and `push_result`), `pong`, `custom`, and the legacy `incompatibility_error`.
- `RecordOpType = { Put:'put', Patch:'patch', Remove:'remove' }` [src diff.ts:10].
- `TLSyncErrorCloseEventCode = 4099`. `TLSyncErrorCloseEventReason` is one of `NOT_FOUND | FORBIDDEN | NOT_AUTHENTICATED | UNKNOWN_ERROR | CLIENT_TOO_OLD | SERVER_TOO_OLD | INVALID_RECORD | RATE_LIMITED | ROOM_FULL` [src TLSyncClient.ts:74-126].
- **A close with code 4099 is terminal on the client.** `ClientWebSocketAdapter` moves to status `'error'`, `TLSyncClient` calls `onSyncError(reason)` and `close()`, and `useSync` sets `error` and stops reconnecting [src ClientWebSocketAdapter.ts:125-160, TLSyncClient.ts:593-606, sync/src/useSync.ts:355-377]. Any other close code, including a normal `ws.close()` or a rejected HTTP upgrade, sends the client to `'offline'`, and it keeps retrying with backoff (500 ms to 2 s active, up to 5 min hidden).
- Client timing: it pings every 5 s (`PING_INTERVAL`), and push sync is throttled to 30 fps in collaborative mode [src TLSyncClient.ts:50,287].
- `useSync` appends the reserved query params `sessionId` (the per-tab `TAB_ID`) and `storeId` to the `uri`. `uri: string | (() => string | Promise<string>)` is re-evaluated on every reconnect attempt, so a short-lived ticket in the URL works [src sync/src/useSync.ts:284-298, d.ts:364].

---

## 3. `TLSocketRoom<R, SessionMeta>`

### 3.1 Constructor options (exact `.d.ts`)

```ts
export declare class TLSocketRoom<R extends UnknownRecord = UnknownRecord, SessionMeta = void> {
    readonly opts: TLSocketRoomOptions<R, SessionMeta>;
    readonly log?: TLSyncLog;
    storage: TLSyncStorage<R>;
    constructor(opts: TLSocketRoomOptions<R, SessionMeta>);
    ...
}
export declare interface TLSocketRoomOptions<R extends UnknownRecord, SessionMeta> {
    storage?: TLSyncStorage<R>;
    /** @deprecated use the storage option instead */
    initialSnapshot?: RoomSnapshot | TLStoreSnapshot;
    /** @deprecated use the storage option with an onChange callback instead */
    onDataChange?(): void;
    schema?: StoreSchema<R, any>;
    clientTimeout?: number;
    log?: TLSyncLog;
    onSessionRemoved?: (room: TLSocketRoom<R, SessionMeta>, args: {
        meta: SessionMeta; numSessionsRemaining: number; sessionId: string;
    }) => void;
    onBeforeSendMessage?: (args: { meta: SessionMeta; sessionId: string; stringified: string }) => void;   // + internal `message`
    onAfterReceiveMessage?: (args: { meta: SessionMeta; sessionId: string; stringified: string }) => void; // + internal `message`
    onCommittedChanges?: (args: { diff: TLSyncForwardDiff<R>; documentClock: number }) => void;
    objectTypes?: readonly string[];
    authorizeRecord?: TLRecordAuthorizers<R, SessionMeta>;
    onSessionSnapshot?: (sessionId: string, snapshot: SessionStateSnapshot) => void;
}
export interface TLSyncLog { warn?(...args: any[]): void; error?(...args: any[]): void }
```

Behavior [src TLSocketRoom.ts:251-299, TLSyncRoom.ts:341-452]:
- **`storage` and `initialSnapshot` are mutually exclusive.** Passing both throws `Cannot provide both storage and initialSnapshot options`. With neither, you get an `InMemorySyncStorage` seeded with `DEFAULT_INITIAL_SNAPSHOT`: `document:document` plus `page:page` named "Page 1".
- **`schema`** defaults to `createTLSchema()`, which includes the default shapes, bindings and assets. For custom shapes you must pass the same schema the client uses (§6).
- **On construction, the room runs `storage.transaction(txn => schema.migrateStorage(txn))`** [TLSyncRoom.ts:421-423]. Stored records are migrated to the server schema inside one transaction, and the constructor throws if that fails (§6.4).
- **`clientTimeout`** is the idle timeout for a connected session and defaults to `SESSION_IDLE_TIMEOUT = 20000` ms. When it is finite and greater than 0, a prune interval of `min(2000, clientTimeout/4)` ms runs. **That interval keeps the Node event loop alive until `room.close()`** [run]: a script that forgets to close the room never exits. `Infinity` or `0` disables the interval; the Cloudflare template uses `Infinity` together with hibernation.
- **`log`** defaults to `{ error: console.error }` when the key is absent. Pass your own logger, and don't log record contents.
- **`TLSyncRoom` asserts native `structuredClone`** (Node ≥18).
- **`objectTypes`, `authorizeRecord`, `onCommittedChanges` and `onSessionSnapshot` are newer 5.x features:**
  - `objectTypes` is the object-store lane for comments.
  - `authorizeRecord` holds per-type write authorizers.
  - `onCommittedChanges` fires only for **client pushes**, never for `updateStore`, `loadSnapshot` or direct storage writes.
  - `onSessionSnapshot` supports hibernation.

### 3.2 Methods (exact `.d.ts` signatures)

```ts
getNumActiveSessions(): number;   // includes sessions in AwaitingConnectMessage/AwaitingRemoval, not just open sockets
handleSocketConnect(opts: {
    isReadonly?: boolean;                 // default false
    objectAccess?: TLObjectStoreAccess;   // 'read' | 'write', default 'write' (only matters with objectTypes)
    sessionId: string;
    socket: WebSocketMinimal;
} & (SessionMeta extends void ? object : { meta: SessionMeta })): void;
handleSocketMessage(sessionId: string, message: AllowSharedBufferSource | string): void;
handleSocketError(sessionId: string): void;
handleSocketClose(sessionId: string): void;
handleSocketResume(opts: { sessionId: string; snapshot: SessionStateSnapshot; socket: WebSocketMinimal }
    & (SessionMeta extends void ? object : { meta: SessionMeta })): void;   // hibernation only
getSessionSnapshot(sessionId: string): null | SessionStateSnapshot;
getCurrentDocumentClock(): number;
getRecord(id: string): R;             // actually R | undefined at runtime (structuredClone of txn.get)
getSessions(): Array<{ isConnected: boolean; isReadonly: boolean; meta: SessionMeta; objectAccess: TLObjectStoreAccess; sessionId: string }>;
getCurrentSnapshot(): RoomSnapshot;   // JSDoc says "@deprecated if you need to do this use" (sentence truncated upstream); delegates to storage.getSnapshot()
getCurrentObjectsSnapshot(): RoomSnapshot['documents'];
loadSnapshot(snapshot: RoomSnapshot | TLStoreSnapshot): void;   // replaces the whole doc in one storage txn, then migrates
/** @deprecated use the storage.transaction method instead */
updateStore(updater: (store: RoomStoreMethods<R>) => Promise<void> | void): Promise<void>;
sendCustomMessage(sessionId: string, data: any): void;
closeSession(sessionId: string, fatalReason?: string | TLSyncErrorCloseEventReason): void;
close(): void;
isClosed(): boolean;

export interface WebSocketMinimal {
    addEventListener?: (type: 'message' | 'close' | 'error', listener: (event: any) => void) => void;
    removeEventListener?: (type: 'message' | 'close' | 'error', listener: (event: any) => void) => void;
    send: (data: string) => void;
    close: (code?: number, reason?: string) => void;
    readyState: number;   // 1 === OPEN is the only value checked
}
```

Key behaviors [src TLSocketRoom.ts]:
- **`handleSocketConnect`** (346-392) creates a `JsonChunkAssembler` per session and calls `room.handleNewSession`. If `socket.addEventListener` exists, it attaches `message`, `close` and `error` listeners that forward `event.data`.
  - If an entry with the same `sessionId` already exists, it is **overwritten without detaching the old socket's listeners**. See §5.3 for why that matters.
  - Reconnecting with the same `sessionId` keeps the same presence id [TLSyncRoom.ts:695-708].
- **`handleSocketMessage`** (441-489) decodes non-string input with `TextDecoder`, reassembles chunks, calls `onAfterReceiveMessage`, then `room.handleMessage` (which is async, with rejections caught), then `pruneSessions()`.
  - A thrown error or an assembly error rejects the session with `UNKNOWN_ERROR`.
  - Messages for an unknown `sessionId` are ignored with a warning.
- **`closeSession(id)`** without a reason removes the session and calls `socket.close()`, and the client reconnects. With a reason, it closes with 4099 plus the reason, and the client stops (§2). Both were confirmed with `FORBIDDEN` [run].
- **`close()`** (950-957) disposes timers and the storage `onChange` subscription, closes every session's socket, and marks the room closed. **It does not touch or close the storage or DB.** After `room.close()`, `storage.getClock()` still works [run].
  - Sessions still in the map are pruned on timers, and **`onSessionRemoved` fires about 5 s after `close()` for each of them, with `room.isClosed() === true`, counting down to `numSessionsRemaining: 0`** [run: probe-lifecycle I]. An `onSessionRemoved` handler that calls `room.close(); db.close()` on 0 therefore fires again after a forced close. Guard it with `if (room.isClosed()) return`.
- **`updateStore`** (853-876) is deprecated but still works.
  - It builds a full in-memory copy from `getCurrentSnapshot()`, which is O(document) per call.
  - Each `put` runs `recordType.validate(record, before)`, so invalid records throw [run].
  - Changes are applied in one `storage.transaction`, and connected clients get them through the storage `onChange` broadcast.
  - Calling it after `close()` throws `Cannot update store on a closed room` [run].
- **`storage.transaction(txn => …)` is the preferred server-side mutation API.**
  - It is synchronous; an async callback is a type error and throws at runtime.
  - **It does NOT validate.** A garbage shape was accepted by `txn.set` until the callback threw [run]. Validate first with `schema.types[rec.typeName].validate(rec)`, which is the public `RecordType.validate(record: unknown, recordBefore?: R): R`.
  - Throwing inside the callback rolls back the SQLite transaction [run].
  - Committed changes are broadcast to connected clients, because the room listens to `storage.onChange` for transaction ids that aren't its own [TLSyncRoom.ts:427-433]. A connected peer received the patch [run].

### 3.3 Session lifecycle constants [src RoomSession.ts:45-65]

| Constant | Value | Meaning | Verified |
|---|---|---|---|
| `SESSION_START_WAIT_TIME` | 10000 ms | A socket that never sends `connect` is dropped. | [run] closed after about 10 s |
| `SESSION_IDLE_TIMEOUT` | 20000 ms | Default `clientTimeout`; a connected session with no messages is cancelled. The client pings every 5 s. | [run] with `clientTimeout: 1000` |
| `SESSION_REMOVAL_WAIT_TIME` | 5000 ms | Grace period between cancel (socket closed) and removal. `onSessionRemoved` fires after it, and presence is deleted then. | [run] |

`getNumActiveSessions()` drops to 0 only after that grace period, which is why eviction happens roughly 5 s or more after the last tab closes.

### 3.4 Read-only enforcement (server-side) [src TLSyncRoom.ts:1325-1331, 1341, 1427, 1466; run]

```ts
const canWrite = (typeName: string) =>
    !session || (this.objectTypes.has(typeName) ? session.objectAccess !== 'read' : !session.isReadonly)
```

- The check runs **per op, before type validation**:
  - `put` is gated on the incoming typeName.
  - `patch` and `remove` are gated on the stored record's typeName.
- A denied op is skipped, not rejected. The client gets `push_result {action:'discard'}` (or a rebase) and rolls back; the socket stays open.
  - Verified: a forged put and a forged `remove` of `page:page` from `isReadonly: true` both returned `discard` with nothing on disk, and the socket stayed at `readyState 1`.
- **Presence pushes from read-only sessions are accepted and broadcast** [run], because presence isn't gated. The server also overrides the pushed presence `id`/`typeName` with the session's own presence id [src 1298-1324].
- A put that changes an existing record's `typeName` is skipped with a warning [src 1363-1373].
- For finer rules, `authorizeRecord`'s signature is below. It runs synchronously inside the commit transaction on up-migrated records, client pushes only. Returning `null` vetoes the op; a throw counts as a veto. On create, the returned record is what gets stored. Presence types can't be registered.

```ts
export type TLRecordAuthorizer<Rec extends UnknownRecord, SessionMeta> = (args: {
  session: { sessionId: string; isReadonly: boolean; meta: SessionMeta }
} & ({ type: 'create'; prev: null; next: Rec } | { type: 'update'; prev: Rec; next: Rec } | { type: 'delete'; prev: Rec; next: null })) => Rec | null
export type TLRecordAuthorizers<R extends UnknownRecord, SessionMeta> = { [K in R['typeName']]?: TLRecordAuthorizer<Extract<R, { typeName: K }>, SessionMeta> }
```

Since `isReadonly` is fixed when the session connects, a permission downgrade means calling `room.closeSession(sid)` with no reason. The client reconnects, and the upgrade handler re-authorizes it with the new `isReadonly`. For a full revoke, call `room.closeSession(sid, 'FORBIDDEN')`, which is terminal (§2).

---

## 4. Storage

### 4.1 `TLSyncStorage<R>` interface (exact `.d.ts`) [src TLSyncStorage.ts:13-146]

```ts
export interface TLSyncStorage<R extends UnknownRecord> {
  transaction<T>(callback: TLSyncStorageTransactionCallback<R, T>, opts?: TLSyncStorageTransactionOptions): TLSyncStorageTransactionResult<T, R>
  getClock(): number
  onChange(callback: (arg: TLSyncStorageOnChangeCallbackProps) => unknown): () => void
  getSnapshot?(): RoomSnapshot                    // document lane only
  getObjectsSnapshot?(): RoomSnapshot['documents']
  getObjectsByIds?(ids: Iterable<string>): RoomSnapshot['documents']
}
export interface TLSyncStorageTransaction<R> extends SynchronousStorage<R> {   // get/set/delete/keys/values/entries/getSchema/setSchema
  getClock(): number
  getChangesSince(sinceClock: number): TLSyncStorageGetChangesSinceResult<R> | undefined
}
export interface TLSyncStorageTransactionOptions { id?: string; emitChanges?: 'always' | 'when-different' }
export type TLSyncStorageTransactionCallback<R, T> = (txn: TLSyncStorageTransaction<R>) =>
  T extends Promise<any> ? { __error: 'Transaction callbacks cannot be async. Use synchronous operations only.' } : T
export interface TLSyncStorageTransactionResult<T, R> { documentClock: number; didChange: boolean; result: T; changes?: TLSyncForwardDiff<R> }
export interface TLSyncStorageOnChangeCallbackProps { id?: string; documentClock: number }
export interface TLSyncForwardDiff<R> { puts: Record<string, R | [before: R, after: R]>; deletes: string[] }
export declare function loadSnapshotIntoStorage<R>(txn, schema: StoreSchema<R, any>, snapshot: RoomSnapshot | TLStoreSnapshot): void
export interface RoomSnapshot { clock?: number; documentClock?: number; documents: Array<{ state: UnknownRecord; lastChangedClock: number }>;
  tombstones?: Record<string, number>; tombstoneHistoryStartsAtClock?: number; schema?: SerializedSchema }
```

- **The clock** is one integer, `documentClock`. It increments **once per transaction that writes**, not once per record: a transaction that set two records took the clock from 0 to 1 [run].
- **`onChange`** listeners are called on a microtask after the transaction returns, so after `COMMIT`. A listener registered during a transaction doesn't see that transaction [src MicrotaskNotifier.ts].

### 4.2 `SQLiteSyncStorage<R>` (exact `.d.ts`)

```ts
export declare class SQLiteSyncStorage<R extends UnknownRecord> implements TLSyncStorage<R> {
    static hasBeenInitialized(storage: TLSyncSqliteWrapper): boolean;   // metadata.schema non-empty
    static getDocumentClock(storage: TLSyncSqliteWrapper): null | number;
    constructor({ sql, snapshot, objectTypes, onChange }: {
        objectTypes?: readonly string[];
        onChange?(arg: TLSyncStorageOnChangeCallbackProps): unknown;
        snapshot?: RoomSnapshot | StoreSnapshot<R>;
        sql: TLSyncSqliteWrapper;
    });
    onChange(callback: (arg: TLSyncStorageOnChangeCallbackProps) => void): () => void;
    transaction<T>(callback: TLSyncStorageTransactionCallback<R, T>, opts?: TLSyncStorageTransactionOptions): TLSyncStorageTransactionResult<T, R>;
    getClock(): number;
    getSnapshot(): RoomSnapshot;
    getObjectsSnapshot(): RoomSnapshot['documents'];
    getObjectsByIds(ids: Iterable<string>): RoomSnapshot['documents'];
}
export interface TLSyncSqliteWrapper {
    readonly config?: TLSyncSqliteWrapperConfig;   // { tablePrefix?: string }
    prepare<TResult extends TLSqliteRow | void, TParams extends TLSqliteInputValue[] = []>(sql: string): TLSyncSqliteStatement<TResult, TParams>;
    exec(sql: string): void;
    transaction<T>(callback: () => T): T;
}
export interface TLSyncSqliteStatement<TResult, TParams> { iterate(...b: TParams): IterableIterator<TResult>; all(...b: TParams): TResult[]; run(...b: TParams): void }
```

Constructor behavior [src SQLiteSyncStorage.ts:278-445]:
1. It runs the table migrations with `exec`/`prepare`, not inside `sql.transaction`, and prepares all statements once.
2. **`if (snapshot || !hasData)`, it DELETEs all documents, objects and tombstones and seeds from `snapshot ?? DEFAULT_INITIAL_SNAPSHOT`.**
   - **Passing `snapshot` to an already-initialized DB wipes it.** In the probe, the clock went from 2 to 0 and 0 docs remained [run]. Only pass `snapshot` when `!SQLiteSyncStorage.hasBeenInitialized(sql)`, the pattern tldraw's docs use for legacy import.
3. The seeding statements are separate autocommit statements, so first-time init is **not atomic**. A crash there self-heals because `hasBeenInitialized` looks at `metadata.schema`, which is written last. A crash in the middle of the DDL (`exec` of a multi-statement script) could leave half-created tables that make the next open throw.
   - Mitigation (verified): wrap the constructor in `db.exec('BEGIN IMMEDIATE') … db.exec('COMMIT')`. The constructor never calls `sql.transaction()`, so nothing nests [run].

### 4.3 Tables (with `tablePrefix` `''`) [src SQLiteSyncStorage.ts:85-184; run: sqlite_master dump]

```sql
CREATE TABLE documents (id TEXT PRIMARY KEY, state BLOB NOT NULL, lastChangedClock INTEGER NOT NULL);
CREATE INDEX idx_documents_lastChangedClock ON documents(lastChangedClock);
CREATE TABLE tombstones (id TEXT PRIMARY KEY, clock INTEGER NOT NULL);
CREATE INDEX idx_tombstones_clock ON tombstones(clock);
CREATE TABLE metadata (migrationVersion INTEGER NOT NULL, documentClock INTEGER NOT NULL,
                       tombstoneHistoryStartsAtClock INTEGER NOT NULL, schema TEXT NOT NULL);  -- exactly one row
CREATE TABLE objects (id TEXT PRIMARY KEY, state BLOB NOT NULL, lastChangedClock INTEGER NOT NULL); -- object lane (migration 3)
CREATE INDEX idx_objects_lastChangedClock ON objects(lastChangedClock);
```

- `metadata.migrationVersion` is 3 in 5.4.2 [run].
- `state` is `JSON.stringify(record)` encoded as UTF-8 bytes. `node:sqlite` reads it back as a `Uint8Array` and `better-sqlite3` as a `Buffer`, and both decode fine [run].
- Every `txn.set` does `INSERT OR REPLACE` with the transaction's clock and deletes any tombstone for that id. `txn.delete` inserts a tombstone at the new clock only if the row existed.
- Presence records are never stored. They live in memory only (`PresenceStore`).

### 4.4 Clock and tombstones survive restarts [run]

After a server-side delete, a close and a reopen, the probe saw `documentClock` go from 2 to 2 and `tombstones { 'shape:b': 2 }` persisted, with `tombstoneHistoryStartsAtClock 0`.

Reconnecting clients send `lastServerClock` and get `getChangesSince(clock)` (puts plus tombstone deletes). The result is `wipe_all` when `lastServerClock < tombstoneHistoryStartsAtClock` or when the client's clock is ahead of the server's.

Tombstones are pruned when there are more than `MAX_TOMBSTONES = 5000`. The oldest ones go, plus a buffer of `TOMBSTONE_PRUNE_BUFFER_SIZE = 1000`, and `tombstoneHistoryStartsAtClock` advances. After that, very stale clients get `wipe_all` [src InMemorySyncStorage.ts:25-85, SQLiteSyncStorage.ts:514-533].

### 4.5 Write path: push → SQLite COMMIT → ack/broadcast [src]

`TLSyncRoom.handlePushRequest` (TLSyncRoom.ts:1134-1590) runs these steps in order:
1. `const { result, documentClock, changes } = this.storage.transaction(txn => { … }, { id: this.internalTxnId, emitChanges: 'when-different' })` (1289-1506). Inside the callback it:
   - flushes any external changes (`broadcastChanges`)
   - migrates each incoming record up to the server version
   - runs the authorizer
   - validates (§7.3)
   - calls `txn.set` / `txn.delete`
2. `SQLiteSyncStorage.transaction` (452-488) wraps the callback in `this.sql.transaction(...)`.
3. `NodeSqliteWrapper.transaction` (NodeSqliteWrapper.ts:87-101) runs `db.exec('BEGIN')`, then `callback()`, then `db.exec('COMMIT')`. On any throw, including a failed `COMMIT`, it runs `db.exec('ROLLBACK')` and rethrows. **Everything is synchronous.**
4. Only after the transaction returns does the room call `_unsafe_sendMessage(session, push_result)` (1552), which is `commit`, `discard` or `rebaseWithDiff`, and then `broadcastPatch(...)` to the other sessions (1554-1572). `onCommittedChanges` and `onPresenceChange` are queued as microtasks.
5. A validation error thrown in the callback is a `TLSyncError`. It rolls back SQLite and the `@tldraw/state` transaction, then `rejectSession(INVALID_RECORD)`. Nothing is written [run: probe C, disk unchanged].

**Every acknowledged change is therefore committed to SQLite before any client hears about it.** How durable that commit is depends on the pragmas (§4.6). The first data message goes out immediately; any more within `DATA_MESSAGE_DEBOUNCE_INTERVAL = 1000/60` ms are batched into one `data` frame [src 466-524].

Empirical check (`kill-test.ts`): a separate server process received paced pushes and was sent `SIGKILL` (TerminateProcess on Windows) the moment the client got its 50th `commit`. On restart, **acked-but-missing = 0** in 3 runs with `synchronous=FULL` and 2 with `NORMAL`. Sometimes 1–2 extra un-acked pushes were persisted, which the client reconciles on reconnect [run].

### 4.6 Pragmas: the library sets NONE [src: grep for `pragma` finds nothing in sync-core/src]

Defaults observed:

| Setting | `node:sqlite` 24.19 (SQLite 3.53.3) | `better-sqlite3` 13.0.3 (SQLite 3.53.4) |
|---|---|---|
| `journal_mode` (file DB) | `delete` | `delete` (`memory` for `:memory:`) |
| `synchronous` | 2 = FULL | 2 = FULL |
| `busy_timeout` | 0 | UNVERIFIED |
| `foreign_keys` | 1 (node:sqlite enables FKs by default) | not measured |

All values [run].

Recommended, set right after `new DatabaseSync(path)` and **outside** any transaction:

```ts
db.exec('PRAGMA journal_mode = WAL')     // persistent in the file; readers don't block the writer; enables hot backup
db.exec('PRAGMA synchronous = FULL')     // or NORMAL - see below
db.exec('PRAGMA busy_timeout = 5000')    // or new DatabaseSync(path, { timeout: 5000 })
```

- **`FULL` vs `NORMAL` in WAL mode:**
  - **`FULL`** fsyncs the WAL on every commit, so it survives power loss.
  - **`NORMAL`** skips that fsync. Committed transactions survive a **process** crash (verified above) but may be lost on an OS crash or power loss.
  - Local benchmark (NVMe, Windows): FULL **0.90 ms** per single-record commit, NORMAL **0.07 ms** [run: bench-sync.ts]. Performance on a Render persistent disk is **UNVERIFIED**.
  - Because `node:sqlite` is synchronous, **that fsync blocks the whole event loop, across all rooms**.
  - The plan's requirement ("no lost committed changes on an ordinary process restart", with a 15-minute disaster-recovery objective) is met by `NORMAL`. Choose `FULL` if acks must survive host power loss, then load-test on Render.
- Two connections to the same file in the same process are fine in WAL mode, because every sync-core transaction is synchronous and never interleaves.

### 4.7 Wrappers

- **`NodeSqliteWrapper`** (exact `.d.ts`: `constructor(db: SyncSqliteDatabase, config?: TLSyncSqliteWrapperConfig)`) accepts anything with `exec(sql)` and `prepare(sql)` returning `{iterate, all, run}`. That covers `node:sqlite` `DatabaseSync` and `better-sqlite3` `Database`; both were verified [run]. It passes statements through unchanged, and its `transaction` is plain `BEGIN`/`COMMIT`/`ROLLBACK` (deferred `BEGIN`).
- **`DurableObjectSqliteSyncWrapper(storage: { sql: { exec(...) }, transactionSync(cb) }, config?)`** is for Cloudflare only.
- With `new NodeSqliteWrapper(db, { tablePrefix: 'tldraw_' })`, several rooms or apps can share one DB file.
- **`InMemorySyncStorage`** (`constructor({ snapshot?: RoomSnapshot, objectTypes?, onChange? } = {})`) is the default. It needs a persistence callback, loses data on crash, and is only for tests.

### 4.8 BUG: the tombstone prune timer crashes the process after `db.close()` [run]

`SQLiteSyncStorage.pruneTombstones` is `lodash.throttle(fn, 1000, { leading: false })` and is called from every `txn.delete` [src SQLiteSyncStorage.ts:514-533, 651-661]. If `db.close()` runs less than 1 s after any delete, the trailing call runs a finalized statement and throws from a timer:
- `node:sqlite`: `Error: statement has been finalized` (`ERR_INVALID_STATE`), as an uncaught exception that ends the process
- `better-sqlite3`: `TypeError: The database connection is not open`

The official `simple-server-example` does `room.close(); db.close()` in `onSessionRemoved` (§5.1), so it is exposed whenever a delete lands within 1 s of the last session's removal. That can happen with `closeSession`, a server-side write, or a shutdown hook.

Fix (verified: the naive version crashed, the flushed version survived):

```ts
room.close()
;(storage as unknown as { pruneTombstones?: { flush?: () => void } }).pruneTombstones?.flush?.()  // @internal in 5.4.2
db.close()
```

A delay also works: `setTimeout(() => db.close(), 1100)` survived [run].

`TLSocketRoom` itself doesn't touch storage after `close()` except through messages. A message that arrives after `db.close()` makes `storage.transaction` throw inside an async `handleMessage`; that rejection is caught, so it only logs.

Consider filing this upstream; it's a one-line `pruneTombstones.cancel()` in a storage `close()`.

### 4.9 Backups [run]

`node:sqlite` exports `backup(sourceDb: DatabaseSync, path: PathLike, options?: BackupOptions): Promise<number>` (@types/node 24.19.0). Running it on a live WAL room DB, **with a write in progress during the backup**, produced a consistent copy with all 503 docs and `documentClock 2`. Use this; never copy only the main `.sqlite` file of a WAL database.

---

## 5. Room lifecycle and registry

### 5.1 Official Node example (verbatim, `templates/simple-server-example` @ `v5.4.2`)

Sources:
- https://github.com/tldraw/tldraw/blob/v5.4.2/templates/simple-server-example/src/server/rooms.ts
- https://github.com/tldraw/tldraw/blob/v5.4.2/templates/simple-server-example/src/server/server.ts
- https://github.com/tldraw/tldraw/blob/v5.4.2/templates/simple-server-example/src/server/assets.ts
- Dependencies: fastify ^5.8.1, @fastify/websocket ^11.0.0, better-sqlite3 ^12.10.0, ws ^8.18.0, tsx ^4.19.2 (`tsx watch ./src/server/server.ts`).

`rooms.ts`:

```ts
import { mkdirSync } from 'fs'
import { join } from 'path'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import Database from 'better-sqlite3'

const DIR = './.rooms'
mkdirSync(DIR, { recursive: true })

function sanitizeRoomId(roomId: string): string {
	return roomId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

const rooms = new Map<string, TLSocketRoom<any, void>>()

export function makeOrLoadRoom(roomId: string): TLSocketRoom<any, void> {
	roomId = sanitizeRoomId(roomId)
	const existing = rooms.get(roomId)
	if (existing && !existing.isClosed()) {
		return existing
	}
	console.log('loading room', roomId)
	const db = new Database(join(DIR, `${roomId}.db`))
	const sql = new NodeSqliteWrapper(db)
	const storage = new SQLiteSyncStorage({ sql })
	const room = new TLSocketRoom({
		storage,
		onSessionRemoved(room, args) {
			console.log('client disconnected', args.sessionId, roomId)
			if (args.numSessionsRemaining === 0) {
				console.log('closing room', roomId)
				room.close()
				db.close()
				rooms.delete(roomId)
			}
		},
	})
	rooms.set(roomId, room)
	return room
}
```

`server.ts` (trimmed comments):

```ts
const app = fastify()
app.register(websocketPlugin)
app.register(cors, { origin: '*' })
app.register(async (app) => {
	app.get('/connect/:roomId', { websocket: true }, async (socket, req) => {
		const roomId = (req.params as any).roomId as string
		const sessionId = (req.query as any)?.['sessionId'] as string
		// attach a message handler before any async work, buffer, then replay
		const caughtMessages: RawData[] = []
		const collectMessagesListener = (message: RawData) => { caughtMessages.push(message) }
		socket.on('message', collectMessagesListener)
		const room = makeOrLoadRoom(roomId)
		room.handleSocketConnect({ sessionId, socket })
		socket.off('message', collectMessagesListener)
		for (const message of caughtMessages) { socket.emit('message', message) }
	})
	app.addContentTypeParser('*', (_, __, done) => done(null))
	app.put('/uploads/:id', {}, async (req, res) => {
		const id = (req.params as any).id as string
		await storeAsset(id, req.raw)            // writeFile(join(DIR, id), stream)
		res.send({ ok: true })
	})
	app.get('/uploads/:id', async (req, res) => {
		const id = (req.params as any).id as string
		const data = await loadAsset(id)          // readFile(join(DIR, id))
		res.header('Content-Security-Policy', "default-src 'none'")
		res.header('X-Content-Type-Options', 'nosniff')
		res.send(data)
	})
	app.get('/unfurl', async (req, res) => { res.send(await unfurl((req.query as any).url as string)) })
})
app.listen({ port: 5858 }, …)
```

The client counterpart (`src/client/App.tsx`) calls `useSync({ uri: \`${WORKER_URL}/connect/${roomId}\`, assets: multiplayerAssets })`. The asset store PUTs to `/uploads/${encodeURIComponent(uniqueId() + '-' + file.name)}` and resolves `asset.props.src`.

**Problems in the official example for our use:**
1. **Crash:** `room.close(); db.close()` runs with no prune flush (§4.8). There is also no `isClosed` guard against the `onSessionRemoved` calls that arrive after close (§3.2).
2. **Stale-socket kill:** passing the raw `ws` means a late `close` from an old socket kills the new session that shares its `sessionId` [run: e2e G, `wiring=auto`: the new socket was closed by the server].
3. **Path traversal in the assets endpoint:** Fastify decodes `%2F` inside route params. `GET /uploads/..%2F..%2Fetc%2Fpasswd` gives `id === '../../etc/passwd'` [run: fastify-probe.ts], and `join(DIR, id)` then escapes the directory. In our plan, assets go to private object storage with signed URLs rather than through the sync server anyway.
4. No auth, no origin check, no rate limit, no size limits. The example says so itself.
5. It uses the default schema, so custom shapes would be rejected (§6).
6. The async handler plus message-buffering hack is only needed because the handler is `async`. Do auth before the upgrade and keep the post-upgrade code synchronous. With `@fastify/websocket@11.3.1`, a route `preValidation` hook runs before the upgrade and can reply 401 [run]; with raw `ws` it's `server.on('upgrade')` (§5.3).

The other official templates at v5.4.2:
- `templates/socketio-server-example` uses the same `rooms.ts` and a `WebSocketMinimal` adapter over socket.io.
- `templates/sync-cloudflare/worker/TldrawDurableObject.ts` uses `DurableObjectSqliteSyncWrapper`, `clientTimeout: Infinity`, hibernation with `handleSocketResume`, and a schema built from `createTLSchema({ shapes: { ...defaultShapeSchemas } })`.

### 5.2 Registry rules

- **One `TLSocketRoom` per room id per deployment.** Two rooms on the same file means users don't see each other and overwrite each other [docs callout]. This is why the plan runs a single process with a persistent disk and no autoscaling.
- **Creation is race-free when there's no `await` between `map.get` and `map.set`.** `new DatabaseSync`, `new SQLiteSyncStorage` and `new TLSocketRoom` are all synchronous, so put all async work (auth, ACL lookup) *before* `getOrCreate`.
- **Evict on idle, not immediately.** Schedule eviction when `onSessionRemoved` reports `numSessionsRemaining === 0` (about 5 s after the last socket closes), then close after a further grace period (e.g. 30 s). Cancel eviction in `getOrCreate`.
- **`room.close()` never deletes storage.** Data stays in the `.sqlite` file, and the next `getOrCreate` reopens it, reads the clock and tombstones, and migrates. Verified: `roomA` was evicted, reloaded, and `shape:one.x === 42` [run: e2e F].
- **Handle constructor failure.** Schema incompatibility or a corrupt file throws. Close the DB, then accept the upgrade and close with `4099` (`UNKNOWN_ERROR`/`SERVER_TOO_OLD`) so the client stops, rather than letting it retry forever.
- **Shutdown (SIGTERM):** call `closeAll()`, which closes each room, flushes the prune and closes each DB, then exit.

### 5.3 Reference implementation (tested: e2e.ts, real-client.ts, kill-test.ts)

`rooms.ts`:

```ts
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import type { TLRecord } from '@tldraw/tlschema'
import type { StoreSchema } from '@tldraw/store'

export interface SessionMeta { userId: string }
interface RoomEntry {
	roomId: string; room: TLSocketRoom<TLRecord, SessionMeta>; db: DatabaseSync
	storage: SQLiteSyncStorage<TLRecord>; evictTimer: ReturnType<typeof setTimeout> | null
}
const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export class RoomRegistry {
	private readonly rooms = new Map<string, RoomEntry>()
	// NB: no TS parameter properties - Node's native type stripping rejects them.
	private readonly opts: { dir: string; schema: StoreSchema<TLRecord, any>; idleEvictMs?: number; log?: (...a: unknown[]) => void }
	constructor(opts: RoomRegistry['opts']) { this.opts = opts; mkdirSync(opts.dir, { recursive: true }) }

	/** Synchronous on purpose: no await between lookup and insert, so creation is race-free. */
	getOrCreate(roomId: string): TLSocketRoom<TLRecord, SessionMeta> {
		if (!ROOM_ID_RE.test(roomId)) throw new Error('invalid room id')
		const existing = this.rooms.get(roomId)
		if (existing && !existing.room.isClosed()) {
			if (existing.evictTimer) { clearTimeout(existing.evictTimer); existing.evictTimer = null }
			return existing.room
		}
		const db = new DatabaseSync(join(this.opts.dir, `${roomId}.sqlite`))
		const entry: RoomEntry = { roomId, db, storage: null as any, evictTimer: null, room: null as any }
		try {
			db.exec('PRAGMA journal_mode = WAL')          // outside any transaction
			db.exec('PRAGMA synchronous = FULL')          // or NORMAL (§4.6)
			db.exec('PRAGMA busy_timeout = 5000')
			const sql = new NodeSqliteWrapper(db)
			db.exec('BEGIN IMMEDIATE')                    // make first-time DDL + seed atomic (§4.2)
			try { entry.storage = new SQLiteSyncStorage<TLRecord>({ sql }); db.exec('COMMIT') }
			catch (e) { db.exec('ROLLBACK'); throw e }
			entry.room = new TLSocketRoom<TLRecord, SessionMeta>({
				schema: this.opts.schema,
				storage: entry.storage,
				log: { warn: (...a) => this.opts.log?.('[room warn]', roomId, ...a), error: (...a) => this.opts.log?.('[room error]', roomId, ...a) },
				onSessionRemoved: (room, { numSessionsRemaining }) => {
					if (room.isClosed() || this.rooms.get(roomId) !== entry) return   // stale callbacks fire after close
					if (numSessionsRemaining > 0) return
					if (entry.evictTimer) clearTimeout(entry.evictTimer)
					entry.evictTimer = setTimeout(() => this.evict(roomId, entry), this.opts.idleEvictMs ?? 30_000)
				},
			})
		} catch (e) {
			db.close()   // e.g. 'Incompatible schema?' (§6.4)
			throw e
		}
		this.rooms.set(roomId, entry)
		return entry.room
	}
	private evict(roomId: string, entry: RoomEntry) {
		if (this.rooms.get(roomId) !== entry || entry.room.getNumActiveSessions() > 0) return
		this.closeEntry(entry)
	}
	private closeEntry(entry: RoomEntry) {
		if (entry.evictTimer) clearTimeout(entry.evictTimer)
		entry.evictTimer = null
		if (this.rooms.get(entry.roomId) === entry) this.rooms.delete(entry.roomId)
		entry.room.close()
		;(entry.storage as unknown as { pruneTombstones?: { flush?: () => void } }).pruneTombstones?.flush?.()  // §4.8
		entry.db.close()
	}
	closeAll() { for (const e of [...this.rooms.values()]) this.closeEntry(e) }
}
```

`server.ts` uses the WebSocket upgrade with auth first, then manual wiring:

```ts
import { createServer, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })  // per-frame cap (§7.1)
const liveSockets = new Map<string, WebSocket>()   // key `${roomId}/${sid}` -> current ws

server.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
	const url = new URL(req.url ?? '/', 'http://localhost')
	const m = /^\/connect\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname)
	const clientSessionId = url.searchParams.get('sessionId')
	if (!m || !clientSessionId || clientSessionId.length > 128) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return socket.destroy() }
	// TODO(prod): check Origin header against allowlist here
	const auth = await authorize(req, m[1])     // verify ticket, ACL lookup - all async work happens BEFORE the upgrade
	wss.handleUpgrade(req, socket, head, (ws) => {
		// Terminal auth failures: complete the upgrade and close 4099 so the client stops retrying (§2).
		// (Rejecting at HTTP level makes the client retry forever with backoff.) Verified: client sees {4099,'FORBIDDEN'}.
		if (!auth) return ws.close(4099, 'FORBIDDEN')
		const roomId = m[1]
		const room = registry.getOrCreate(roomId)                 // synchronous from here on
		const sid = `${auth.userId}:${clientSessionId}`           // namespace client-chosen TAB_ID by user
		const liveKey = `${roomId}/${sid}`
		const prev = liveSockets.get(liveKey)
		liveSockets.set(liveKey, ws)
		if (prev && prev !== ws) prev.close(1000, 'replaced')
		room.handleSocketConnect({
			sessionId: sid,
			// wrapper WITHOUT addEventListener: the room won't attach listeners to the raw ws
			socket: { send: (d: string) => ws.send(d), close: (c?: number, r?: string) => ws.close(c, r), get readyState() { return ws.readyState } },
			isReadonly: !auth.canEdit,
			meta: { userId: auth.userId },
		})
		const isCurrent = () => liveSockets.get(liveKey) === ws
		let tokens = 400, last = Date.now()                      // token bucket: 200 msg/s, burst 400
		ws.on('message', (data, isBinary) => {
			if (!isCurrent()) return
			const now = Date.now(); tokens = Math.min(400, tokens + ((now - last) / 1000) * 200); last = now
			if (--tokens < 0) return room.closeSession(sid, 'RATE_LIMITED')
			const text = isBinary ? Buffer.from(data as Buffer).toString('utf8') : data.toString()
			const chunkHead = /^(\d+)_/.exec(text)                  // chunk frames: "<remaining>_<payload>"
			if (chunkHead && Number(chunkHead[1]) > 40) return room.closeSession(sid, 'INVALID_RECORD')  // cap logical msg ~10M chars
			room.handleSocketMessage(sid, text)
		})
		ws.on('close', () => { if (isCurrent()) { liveSockets.delete(liveKey); room.handleSocketClose(sid) } })
		ws.on('error', () => { if (isCurrent()) { liveSockets.delete(liveKey); room.handleSocketError(sid) } })
	})
})
```

Verified behavior of this wiring [run: e2e.ts, real-client.ts]:
- A real `TLSyncClient` + `ClientWebSocketAdapter` (the classes `useSync` uses) on Node 24's global `WebSocket` connected with two tabs, and a shape put in tab A appeared in tab B and on the server, with no sync errors.
- Reconnecting with the same `sessionId` while the old socket closes late gave `push ok: "commit"` with manual wiring. With auto wiring (raw `ws`) the new socket was closed by the server (code 1005).
- 1000 pings in a burst led to a close with `{4099, RATE_LIMITED}`.
- A bad token rejected at HTTP level before the upgrade produces a client `error` event. Remember the client treats that as offline and retries, which is why the terminal-failure path above uses `4099` instead.

---

## 6. Schema on the server

### 6.1 Building it (exact `.d.ts`, tlschema)

```ts
export declare function createTLSchema({ shapes, bindings, assets, user, records, migrations }?: {
    assets?: Record<string, SchemaPropsInfo>;
    bindings?: Record<string, SchemaPropsInfo>;
    migrations?: readonly MigrationSequence[];
    records?: Record<string, CustomRecordInfo>;
    shapes?: Record<string, SchemaPropsInfo>;
    user?: UserSchemaInfo;
}): TLSchema;
export declare interface SchemaPropsInfo {
    migrations?: LegacyMigrations | MigrationSequence | TLPropsMigrations;
    props?: Record<string, StoreValidator<any>>;
    meta?: Record<string, StoreValidator<any>>;
}
export declare function createShapePropsMigrationIds<const S extends string, const T extends Record<string, number>>(shapeType: S, ids: T): { [k in keyof T]: `com.tldraw.shape.${S}/${T[k]}` };
export declare function createShapePropsMigrationSequence(migrations: TLPropsMigrations): TLPropsMigrations;
// TLPropsMigration: { id: MigrationId; dependsOn?: MigrationId[]; up(props): any; down?: 'none' | 'retired' | ((props) => any) }
```

- The defaults are `shapes = defaultShapeSchemas`, `bindings = defaultBindingSchemas` and `assets = defaultAssetSchemas`. **Passing `shapes` replaces the defaults**, so spread `...defaultShapeSchemas` [src tlschema/src/createTLSchema.ts:339-353].
- A props migration mutates `props` in place or returns new props.

Shared schema module used by the probes (put it in `packages/shared-schema` and import it from both the client ShapeUtil and the server):

```ts
import { createShapePropsMigrationIds, createShapePropsMigrationSequence, createTLSchema,
         defaultBindingSchemas, defaultShapeSchemas } from '@tldraw/tlschema'
import { T } from '@tldraw/validate'

export const stickyVersions = createShapePropsMigrationIds('sticky', { AddColor: 1 })
export const stickyMigrations = createShapePropsMigrationSequence({
  sequence: [{ id: stickyVersions.AddColor, up: (p: any) => { p.color = 'yellow' }, down: (p: any) => { delete p.color } }],
})
export const stickyProps = { w: T.number, h: T.number, text: T.string, color: T.string }
export const schema = createTLSchema({
  shapes: { ...defaultShapeSchemas, sticky: { props: stickyProps, migrations: stickyMigrations } },
  bindings: defaultBindingSchemas,
})
// server: new TLSocketRoom<TLRecord, SessionMeta>({ schema, storage, ... })
// client: useSync({ uri, assets, shapeUtils: [StickyShapeUtil, ...defaultShapeUtils], bindingUtils: [...defaultBindingUtils] })
//   where StickyShapeUtil.props = stickyProps and StickyShapeUtil.migrations = stickyMigrations
```

`useSync`'s `shapeUtils` doesn't include the defaults automatically, so pass `...defaultShapeUtils` [docs sync.mdx "On the client"]. The server-side shared module must not import from `tldraw`, which would pull in React and the DOM; use only `@tldraw/tlschema` and `@tldraw/validate`.

### 6.2 Connect-time negotiation (`handleConnectRequest`, TLSyncRoom.ts:1005-1132, `getVersionMismatchReason` 987-1003)

| Client state | Result | Verified |
|---|---|---|
| Same schema | `connect`, `hydrationType: 'wipe_presence'` | [run] |
| **Older** client: its sequence is at a lower version and every newer migration is `scope:'record'` with a `down` | Accepted, `requiresDownMigrations`. The server down-migrates everything it sends and up-migrates the client's pushes. | [run] old client saw `{w,h,text}` (no `color`); its put was stored with `color: 'yellow'`, and it got `rebaseWithDiff` |
| Older client where any needed migration has no `down` or isn't record-scoped | close `4099 CLIENT_TOO_OLD` | [src 1045-1050] |
| **Newer** client: a sequence version the server doesn't have | close `4099 SERVER_TOO_OLD` | [run] |
| Client knows a shape type the server doesn't (an extra sequence) | **Connect succeeds**, because unknown client sequences are ignored. The first push of that shape closes with `4099 INVALID_RECORD`. | [run] |
| `schema: null` | `CLIENT_TOO_OLD` | [run] |
| protocol < 5 / > 8 | `CLIENT_TOO_OLD` / `SERVER_TOO_OLD` | [run] 4 → CLIENT_TOO_OLD, 9 → SERVER_TOO_OLD |

So a missing custom shape on the server fails late, at push time, not at connect. **Keep the client and server schema in one shared package and deploy the server first** [docs "Deployment concerns"].

### 6.3 Server-side migration of stored records on load [src store/src/lib/StoreSchema.ts:425-640; run: probe-migrate.ts]

- `new TLSocketRoom` calls `schema.migrateStorage(txn)` in one storage transaction. `getMigrationsSince(storedSchema)` then works like this:
  - It includes every sequence both schemas share, plus every server sequence missing from the stored schema that is `retroactive` (the default is `true`).
  - For each one, it runs the migrations after the stored version. Record-scoped `up` runs over `storage.entries()`, collecting changes first and then calling `set`, which bumps the clock once.
  - Only when migrations run does it write the server schema back (`setSchema`).
  - A new SQLite room stores the **default** schema from `DEFAULT_INITIAL_SNAPSHOT`. That's fine, because custom sequences missing from it apply retroactively, and there are no records yet.
- Verified: data written under schema v0 (no `color`) and reopened with v1 was migrated on load to `color: 'yellow'`, stored sequence 1, clock +1.
- Migrated records are written like any other change. Clients reconnecting with an old `lastServerClock` receive them as puts.

### 6.4 Hazards [run]

- **Rolling the server back** after data migrated means the stored sequence version isn't in the server's sequence. `migrateStorage` throws `Incompatible schema?` and the `TLSocketRoom` constructor throws, so the room can't open until you roll forward. **Migrations are forward-only; never remove a migration id from the sequence.**
- **Removing a shape type from the server schema:** the room still opens and still serves the old records (verified), and clients will then fail to validate them. Keep a legacy definition instead.
- If migrations run and a stored record's `typeName` is missing from the schema, `migrateStorage`'s final cleanup asserts `record type does not exist` [src StoreSchema.ts:808-811, 626-636].

---

## 7. Limits and validation

### 7.1 Message size [src chunk.ts; run]

- **Client to server:** `ClientWebSocketAdapter` splits outgoing JSON into chunks of `MAX_SAFE_MESSAGE_SIZE = (1024*1024)/4 = 262144` UTF-16 units, prefixed `"<remaining>_"`. Worst case is about 786 KB of UTF-8 per frame.
- **Server side:** `JsonChunkAssembler` enforces only ordering. **There's no cap on the reassembled size.** A 5M-character record in about 21 chunks was accepted and committed [run].
- **Server to client:** there's no chunking; the whole message is sent as one frame (e.g. the full `connect` diff).
- **`ws` `maxPayload`** defaults to 100 MiB (ws 8.22.0 `websocket-server.js:74`). Set 1 MiB: an unchunked 1.2 MB frame was closed with **1009** [run], while normal chunked traffic passes.
- For the total, cap the chunk count in manual wiring (§5.3) and enforce product limits on text length in shape `props` validators, e.g. `T.string.check((v) => { if (v.length > 20_000) throw new Error('text too long') })`. The signature `check(checkFn: (value: T) => void): Validator<T>` is in @tldraw/validate 5.4.2 d.ts:1093, but the length-cap usage was not probed.
- `ws` `perMessageDeflate` is off by default on the server (ws docs; not measured).

### 7.2 Rate limiting

There's no built-in rate limiter. `RATE_LIMITED` and `ROOM_FULL` exist only as close reasons you send yourself. Hooks:
- **Manual wiring (recommended):** count frames before `room.handleSocketMessage`, and `room.closeSession(sid, 'RATE_LIMITED')`, which is terminal for that `useSync` instance [run].
- **`onAfterReceiveMessage({ sessionId, stringified, meta })`** is called after reassembly, before handling. Calling `closeSession` inside it removes the session synchronously, so the message is then dropped as "unknown session" [src TLSocketRoom.ts:456-475; UNVERIFIED by probe].
- **`ROOM_FULL`:** check `room.getSessions().length` before `handleSocketConnect`, then close with `4099 'ROOM_FULL'`.

### 7.3 Validation on push [src TLSyncRoom.ts:1181-1287, recordDiff.ts; run]

| Push content | Server behavior |
|---|---|
| `put` of a new record | Up-migrated from the client schema, run through the authorizer, then `recordType.validate(state)`. Failure: `TLSyncError INVALID_RECORD`, rollback, close `4099 INVALID_RECORD` [run]. |
| `put` over an existing record | Diff is computed, then `validate(newState)` [src]. |
| `patch` | Applied to the stored record, or to a down-migrated copy that is then up-migrated, then validated [src]. |
| Unknown `typeName` (not a document or object type) | `INVALID_RECORD` [run] |
| Unknown shape `type` (`typeName:'shape'`) | `INVALID_RECORD`, because the shape validator is a union over the registered types [run] |
| Diff key ≠ `record.id` | `txn.set` asserts `Record id mismatch` (a plain Error), which becomes `UNKNOWN_ERROR` [run] |
| `put` that changes an existing record's `typeName` | Skipped with a warning; not an error [src] |
| Presence | Validated like any other record. Invalid presence (e.g. a `userId` without the `user:` prefix) closes with INVALID_RECORD [run] |
| Read-only session doc op | Skipped before validation; the client gets `discard` [run] |

One invalid record rejects the **whole push**, and nothing in it is written [run: disk unchanged].

---

## 8. Node 24 and TypeScript runtime [run]

- **`node:sqlite`** in Node v24.19.0 (`process.versions.sqlite` 3.53.3) loads with **no flag and no `ExperimentalWarning`**. The check used `require('node:sqlite')`, ESM `import 'node:sqlite'`, and a `process.on('warning')` listener in every probe.
- **`SQLiteSyncStorage` + `NodeSqliteWrapper` + `DatabaseSync`** passed the full round trip: create, server write, `updateStore`, delete, close, reopen with data, clock and tombstones intact, WAL mode persisted.
- **Native TypeScript:** `node file.ts` runs the probe TS (imports with `.ts` extensions, `import type`) with no flags and no warning.
  - Constraints: no parameter properties (`constructor(private x)`), enums or namespaces. Enable `erasableSyntaxOnly` to catch these, plus `verbatimModuleSyntax` and `allowImportingTsExtensions`.
  - The tldraw packages are plain JS, so they aren't affected.
- **`tsx@4.23.15`** also runs every probe.
  - With npm 11.17, `esbuild`'s postinstall is blocked by `allow-scripts`, but tsx still works through the `@esbuild/win32-x64` optional dependency. Linux on Render is UNVERIFIED.
  - Recommendation: `node --watch src/server.ts` for dev (UNVERIFIED with native TS, though `--watch` is standard) or `tsx watch`. Production runs `node src/server.ts`, with type-checking in CI.
- **`typescript@7.0.2`** with `module/moduleResolution: nodenext`, `strict`, `allowImportingTsExtensions`, `erasableSyntaxOnly` and `verbatimModuleSyntax` type-checks the server, registry, schema and probe code against the 5.4.2 `.d.ts`. The only errors are the two `@internal` imports used by test clients.
- Probe `tsconfig.json`:

```json
{ "compilerOptions": { "target": "es2023", "module": "nodenext", "moduleResolution": "nodenext", "strict": true, "noEmit": true,
  "allowImportingTsExtensions": true, "erasableSyntaxOnly": true, "verbatimModuleSyntax": true, "skipLibCheck": true, "types": ["node"] } }
```

- Node 24 has a global `WebSocket`, and `TLSyncClient` runs in Node for integration tests with small shims: `window` (an EventTarget with `devicePixelRatio`), `document` (`{hidden:false}`), and `requestAnimationFrame`/`cancelAnimationFrame` [run: real-client.ts].

---

## 9. Mapping to the build plan's requirements

| Plan requirement | How / status |
|---|---|
| One process, room registry, SQLite under `/var/data/rooms`, validated board ids as filenames | §5.3; `ROOM_ID_RE` plus `join(dir, id + '.sqlite')` |
| "Acknowledged changes survive a killed process" | Verified with the kill test (§4.5). Needs WAL + `synchronous` FULL or NORMAL; repeat the test on Render (UNVERIFIED there). |
| Evict idle rooms without deleting data | §5.2/5.3; `close()` never deletes storage; flush the prune before `db.close()` |
| SQLite-consistent backups, no raw WAL copy | `node:sqlite` `backup()` on the live connection (§4.9) |
| Forged read-only writes fail safely | Verified (§3.4) |
| Permission change enforced within 15 s | `closeSession(sid)` (client reconnects and is re-authorized) or `closeSession(sid,'FORBIDDEN')` (terminal). A periodic ACL re-check loop over `room.getSessions()` (with `meta.userId`) is still to be built. |
| Strict origin, rate limits | Origin: check `req.headers.origin` in the upgrade handler. Rate: §7.2 |
| Reconnect never uploads an old snapshot | The protocol sends `lastServerClock`, and the server sends the diff or `wipe_all`; clients push only their pending diffs |
| Saved indicator reflects persistence | `push_result: commit` is sent only after SQLite `COMMIT` (§4.5), so treat it as the "saved" signal. Its durability class is set by `synchronous`. |

---

## 10. Risks and open questions

- **Crash risk:** the prune-after-close bug (§4.8) relies on an `@internal` workaround. Re-check on every tldraw upgrade, or file upstream.
- **Blocking I/O:** `node:sqlite` is synchronous, so every push commit blocks the event loop, including the fsync under `synchronous=FULL`. With 50+ concurrent editors, measure p99 event-loop delay on Render's disk. The mitigations (NORMAL, or sharding rooms across processes) change the architecture.
- **Large documents:** each `connect` sends the full document (for `lastServerClock` 0) as one frame with no server-side chunking. `updateStore` and `getCurrentSnapshot` materialize the whole document. There are no size quotas unless you add them.
- **Stale sessionIds:** the client picks `sessionId`. Namespace it by the authenticated user and use manual wiring (§5.3).
- **Schema drift:** a client with an unknown shape type connects fine and fails on its first push (§6.2). Enforce a single shared schema package and deploy the server first.
- **Package `DOCS.md` is wrong for 5.4.2** (§1).
- **UNVERIFIED:** Render disk fsync latency; `onAfterReceiveMessage` + `closeSession` drop semantics (read from source, not probed); `better-sqlite3` busy_timeout default; `node --watch` with native TS.

---

## 11. Probe inventory (scratch; not in the repo)

`C:/Users/Chase/AppData/Local/Temp/claude/C--Users-Chase-Documents-GitHub-Draftroom/3dc84691-7141-4bcc-93bd-450e201c602f/scratchpad/research/sync-server/`
- `sync-core/`, `tlschema/`, `store/`, `sync/`: extracted 5.4.2 tarballs (`package/src` quoted above)
- `probe/schema.ts`: shared schema with the custom `sticky` shape
- `probe/probe-storage.ts`: SQLite storage round trip, validation, snapshot-wipe, prune-crash discovery
- `probe/probe-close-race.ts`, `probe-close-race-bsq.ts`: crash repro plus `flush`/`delay` fixes (node:sqlite, better-sqlite3)
- `probe/probe-lifecycle.ts`: callbacks after close, duplicate sessionId, idle and start timeouts (fake sockets)
- `probe/rooms.ts`, `probe/server.ts`: the reference implementation (§5.3)
- `probe/rawclient.ts`, `probe/e2e.ts`: protocol-level tests A–H (write/ack/broadcast, read-only, validation, schema negotiation, size limits, auth/eviction/reload, stale socket, rate limit)
- `probe/kill-test.ts`: SIGKILL durability test (child process)
- `probe/real-client.ts`: real `TLSyncClient` against the server
- `probe/probe-migrate.ts`: migrate-on-load, rollback, removed shape, atomic init
- `probe/probe-backup.ts`, `probe/bench-sync.ts`, `probe/probe-4099.ts`, `probe/fastify-probe.ts`, `probe/probe-node-sqlite.mjs`
