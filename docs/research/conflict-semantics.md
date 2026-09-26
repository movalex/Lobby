# Conflict semantics of native tldraw sync (5.4.2)

Research for the milestone 0 gate "Same-note typing, edit/delete, undo-after-remote documented", and for build-plan section 7 ("Reliable shared editing"). Researched on 2026-09-26.

**Versions examined.** `@tldraw/sync-core`, `@tldraw/sync`, `@tldraw/store`, `@tldraw/tlschema`, `@tldraw/editor` and `tldraw` are all at **5.4.2**. TipTap `@tiptap/core` is at 3.31.3, pulled in by `^3.12.1`. Node is v24.19.0.

**Method.**
- I read the published `src/` trees. The npm tarballs ship `src/` next to `dist-*`. The `dist-cjs` constants match `src/`: `MAX_TOMBSTONES = 5e3`, `TOMBSTONE_PRUNE_BUFFER_SIZE = 1e3`, `TLSYNC_PROTOCOL_VERSION = 8`.
- I ran an in-process Node probe: a real `TLSocketRoom` with real `TLSyncClient`s, joined by a socket adapter whose delivery I can control. It is described in Appendix A.
- Every behavior marked **[probe]** was observed in that run. Behaviors marked **[source]** come from reading the code. Anything I could not confirm is marked **UNVERIFIED**.

All citations use the form `package src/lib/File.ts:line`.

---

## TL;DR (read this if nothing else)

| Question | Answer (5.4.2) | Evidence |
|---|---|---|
| Two users change **different** props of one record at the same time | **Both are kept.** Diffs are patches at property level: top-level record fields, plus the first-level keys of `props` and `meta`. | [source] `diff.ts:185-236`, [probe 1b] |
| Two users change the **same** prop | **The last write the server *processes* wins** (arrival order). There is no version check, compare-and-swap, or timestamp. | [source] `TLSyncRoom.ts:1233-1287`, [probe 1a] |
| String `append` op | Emitted whenever the new string starts with the old one. The server applies it only if the current length equals the offset. Otherwise it is **dropped silently**, and so is that client's edit. It can also produce a merged string neither user wrote (`"Plans!2"`). | [source] `diff.ts:243-246, 359-374`, [probe 1e/1f] |
| Two users typing in the same note | `props.richText` is a nested object, so it goes over the wire as a **whole-value `put`**. There is no character or node merge. If edits cross in flight, the later push replaces the whole document and the other user's text is lost, even on their own screen. Edits that don't overlap survive. | [source] `diff.ts:212-226`, [probe 1c/1d] |
| Edit arrives for a record already deleted | The patch is **skipped**. The client gets `push_result: 'discard'` and reverts. **Delete wins** in either order. | [source] `TLSyncRoom.ts:1423-1427`, [probe 3] |
| Can a stale client bring a deleted shape back? | Not through an edit (a `patch`). **Yes** through any `put` of that id: an **undo/redo** of an earlier change, a re-create or paste with the same id, or a server write. A `put` clears the tombstone. | [source] `TLSyncRoom.ts:1220-1228`, `InMemorySyncStorage.ts:358-361`, [probe 3, 4] |
| Tombstones | They are persisted, with **no time-based expiry**. Pruning is count-based: once there are more than 5000, the oldest are pruned so that 4000 remain. Clients whose clock is older than the pruned history get a `wipe_all` full reload. | [source] `InMemorySyncStorage.ts:25-85`, [probe 3b] |
| Undo after a remote edit | The undo stack records only local (`'user'`) changes. But undo **writes back the whole earlier version of the record**, so it overwrites every remote change to that record made since, **including props A never touched**. It also brings back records that someone else deleted. | [source] `HistoryManager.ts:45-65, 193`, `Store.ts:1055-1102`, [probe 4] |
| Reconnect | The client sends its `lastServerClock`. The server sends every record changed since then (full records) plus deletions, or `wipe_all` if its history is too short or the client's clock is ahead. Unacknowledged pushes are **thrown away and recomputed** from the pending local changes against the fresh server state. **The client never uploads a snapshot**; it only re-sends the fields it changed. Those fields still overwrite newer values, **last writer wins**. | [source] `TLSyncClient.ts:691-816`, [probe 5a/5b] |
| Server restart with `SQLiteSyncStorage` | The clock and tombstones are persisted in SQLite, and reconnecting clients get correct incremental diffs. | [source] `SQLiteSyncStorage.ts:130-137, 351-353`, [probe 5c] |
| Client clock ahead of the server | The server treats the client's clock as −1, which forces `wipe_all`. **Hazard:** once the server's clock passes the stale client's clock again (after a restore from backup), the client receives a partial diff and keeps "ghost" records. | [source] `InMemorySyncStorage.ts:428-431`, [probe 5d] |
| Schema or protocol mismatch | The server closes the socket with code **4099** and reason `CLIENT_TOO_OLD`, `SERVER_TOO_OLD` or `INVALID_RECORD`. The client calls `onSyncError(reason)` and closes permanently. `useSync` then reports `{status:'error', error: TLRemoteSyncError}`. | [source] `TLSyncRoom.ts:1005-1050`, `useSync.ts:355-378`, [probe 6] |
| Locks, leases, "editing by" | **None built in.** Presence has no editing-shape field, but `presence.meta` passes through the server unchanged. **`TLSocketRoomOptions.authorizeRecord`** (new, public) can veto individual record writes on the server, which is enough for a lightweight text-edit lease. | [source] `TLSyncRoom.ts:124-185`, [probe 7, 7b] |

---

## 0. Wire model (the facts everything else rests on)

Protocol types, from `@tldraw/sync-core src/lib/protocol.ts` (the protocol version is `8`, at `:4`):

```ts
// server -> client
type TLSocketServerSentEvent<R> =
  | { type: 'connect'; hydrationType: 'wipe_all' | 'wipe_presence'; connectRequestId: string;
      protocolVersion: number; schema: SerializedSchema; diff: NetworkDiff<R>; serverClock: number;
      isReadonly: boolean; objectAccess?: TLObjectStoreAccess }
  | { type: 'incompatibility_error'; reason: TLIncompatibilityReason } // legacy (v5/v6 clients only)
  | { type: 'pong' }
  | { type: 'data'; data: TLSocketServerSentDataEvent<R>[] }
  | { type: 'custom'; data: any }
  | TLSocketServerSentDataEvent<R>
type TLSocketServerSentDataEvent<R> =
  | { type: 'patch'; diff: NetworkDiff<R>; serverClock: number }
  | { type: 'push_result'; clientClock: number; serverClock: number;
      action: 'discard' | 'commit' | { rebaseWithDiff: NetworkDiff<R> } }
// client -> server
interface TLPushRequest<R> { type: 'push'; clientClock: number; diff?: NetworkDiff<R>;
  presence?: ['patch', ObjectDiff] | ['put', R] }
interface TLConnectRequest { type: 'connect'; connectRequestId: string; lastServerClock: number;
  protocolVersion: number; schema: SerializedSchema }
interface TLPingRequest { type: 'ping' }
```

Diff types, from `src/lib/diff.ts:10-159`. All are `@internal`, which means they are exported at runtime but left out of the public `.d.ts`:

```ts
type RecordOp<R> = ['put', R] | ['patch', ObjectDiff] | ['remove']
interface NetworkDiff<R> { [id: string]: RecordOp<R> }
type PutOp    = ['put', value: unknown]
type AppendOp = ['append', value: unknown[] | string, offset: number]
type PatchOp  = ['patch', diff: ObjectDiff]
type DeleteOp = ['delete']
interface ObjectDiff { [k: string]: PutOp | AppendOp | PatchOp | DeleteOp }
```

Key server facts, all [source]:

- **One transaction per push.** `TLSyncRoom.handlePushRequest` runs the whole push inside one `storage.transaction(...)` (`TLSyncRoom.ts:1289-1506`). The document clock goes up **once per writing transaction** (`InMemorySyncStorage.ts:333-340` and `SQLiteSyncStorage.ts:610-617` `getNextClock`). Every record written in that transaction gets `lastChangedClock = clock`.
- **Pushes are handled one at a time, in the order they arrive.** `handleMessage` is `async` but never awaits (`TLSyncRoom.ts:869-901`). So "who wins" means "whoever the server processed last".
- **The pushing session never receives its own change as a `patch`.** It gets a `push_result` instead. Every other session gets a `patch` (`broadcastPatch(..., sourceSessionId)`, `TLSyncRoom.ts:605-637, 1554-1572`).
- **Per-session messages stay in order.** The first data message after a quiet period is sent immediately. Later ones are batched every `1000/60` ms (`DATA_MESSAGE_DEBOUNCE_INTERVAL`, `TLSyncRoom.ts:87, 466-524`). Messages that are not data flush the batch first.

---

## 1. Diff granularity

### 1.1 How a local change becomes wire ops (client)

`getNetworkDiff(RecordsDiff)` (`diff.ts:74-98`) handles the three kinds of change:
- `added` records become `['put', fullRecord]`.
- `removed` records become `['remove']`.
- `updated` records become `['patch', diffRecord(from, to)]`.

`diffRecord` (`diff.ts:185-191`) is `diffObject(prev, next, new Set(['props','meta']))`. `diffObject` (`diff.ts:193-236`) recurses into a key through `diffValue` only in three cases:

1. the key is `props` or `meta` (top level only), **or**
2. both values are arrays, **or**
3. both values are strings.

Any other change emits `['put', nextValue]` for that key. A key that was removed emits `['delete']`. A key that was added emits `['put', value]`.

`diffValue` (`diff.ts:238-254`):
- **strings:** if `!legacyAppendMode && next.startsWith(prev)`, it emits `['append', suffix, prev.length]`; otherwise `['put', next]`.
- **arrays:** handled by `diffArray` (`diff.ts:256-306`).
  - Same length: if at most `max(len/5, 1)` items changed, it emits `['patch', {index: op}]`; otherwise `['put', array]`.
  - Different length: if the old array is a prefix of the new one, it emits `['append', tail, prevLen]`; otherwise `['put', array]`.
- **objects** (reached only through `props`/`meta`, or through object items inside arrays): recursive `diffObject` with **no nested keys**. So the *next* level of plain objects is compared as a whole with `isEqual`, and any change becomes a `put`.

**Resulting granularity, for tldraw records:**

| Location | Granularity |
|---|---|
| Top-level fields (`x`, `y`, `rotation`, `parentId`, `index`, `opacity`, `isLocked`, …) | per field (strings may `append`) |
| `props.<key>` and `meta.<key>` | per key |
| An object *inside* `props` (e.g. **`props.richText`**, arrow `props.start`/`end`, line `props.points` map) | **whole-value `put`** |
| An array inside `props` (e.g. draw `props.segments`) | index patch or append; each item is an object patched per key (e.g. `segment.path` base64 string → `append` while drawing) |

### 1.2 How the server applies ops

- **`patch`.** `patchDocument` (`TLSyncRoom.ts:1233-1287`) calls `applyAndDiffRecord(doc, patch, …)` (`recordDiff.ts:45-56`). That function applies `applyObjectDiff` to the **current server record**, validates the result, and **recomputes** the diff that actually changed. That recomputed diff is what gets broadcast and compared for `push_result`. Fields the client didn't send are left alone. A `put` of a field replaces it outright, whatever its current value.
- **`applyObjectDiff`** (`diff.ts:331-402`) has three quiet rules:
  - A `patch` on a key that isn't an object is ignored (`:375-384`).
  - An `append` is applied **only if** `currentValue.length === offset` (`:359-374`, comment: "If validation fails … silently ignore").
  - A `put` equal to the current value is a no-op.
- **`put`** (`addDocument`, `TLSyncRoom.ts:1181-1231`).
  - If the record exists, the server replaces it with the client's full record, but broadcasts only the diff. This is a **whole-record last-writer-wins**.
  - If the record doesn't exist, the server **creates it**. Per the comment at `:1223`, "set automatically clears tombstones if they exist".
- **`remove`** (`TLSyncRoom.ts:1460-1498`). If the record is already gone, nothing happens. Otherwise the server runs `txn.delete(id)`, which writes a tombstone.

### 1.3 Same prop, concurrent [probe 1a]

A sets `x=100` and B sets `x=200`. Both pushes are held and then released, A's first.
- A sent `{"shape:note1":["patch",{"x":["put",100]}]}`.
- Final state: **server `x=200`, A `x=200`, B `x=200`**. Both pushes returned `commit`.
- B never saw 100 on screen: its rebase re-applied its own pending change on top of A's patch.

### 1.4 Different props, concurrent [probe 1b]

A sets `x=100`; B sets `props.color='red'`, sent as `["patch",{"props":["patch",{"color":["put","red"]}]}]`. Final state on the server and both clients: **`x=100, color='red'`**. Both changes are kept.

### 1.5 The string `append` op

- **When it is emitted.** Always, from `TLSyncClient`: `getNetworkDiff` calls `diffRecord` with append mode on. It is emitted for any string field or `props`/`meta` key where the new value starts with the old one.
  - Examples: a page or frame `name` typed at the end, a shape's fractional `index` getting longer (`'a1'` → `'a1V'`), draw-segment `path` strings while drawing.
- **Legacy mode.** When any connected session speaks protocol v7 (`supportsStringAppend=false`), the server only *emits* `put` instead of `append` (`getCanEmitStringAppend`, `TLSyncRoom.ts:775-784, 1147`). All our clients will be v8.
- **Anomaly 1: two appends race [probe 1f].**
  - Base `"Page 1"`. B appends `"BB"`, A appends `"A"`, and B arrives first.
  - The server has `"Page 1BB"` (length 8). A's `["append","A",6]` fails the length check and is ignored.
  - A gets **`discard`** and its local name reverts to `"Page 1BB"`. **A's edit is lost without any error.**
- **Anomaly 2: an append lands on a different base of the same length [probe 1e].**
  - Base `"Page 1"`. B puts `"Plans!"` (also 6 characters) and arrives first. A sends `["append","2",6]`.
  - The length check passes, so the server stores **`"Plans!2"`**, a value neither user typed.
  - A even gets `commit`, because the recomputed diff equals the append it sent.
  - For fractional `index` strings this can produce an unexpected z-order. It is still a valid index, but not what either user meant.

### 1.6 Two users typing in one note (`props.richText`) [probe 1c, 1d]

`TLNoteShape.props.richText` is a TipTap/ProseMirror JSON document: `{type:'doc', content:[{type:'paragraph', content:[{type:'text', text}]}]}` (`@tldraw/tlschema src/misc/TLRichText.ts:68-87`). It is an object one level below `props`, so the wire op is always a full replacement. This is what A actually sent [probe 1c]:

```json
{"shape:note1":["patch",{"props":["patch",{"richText":["put",{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hello NOTE"}]}]}]}]}]}
```

**The requested scenario.** The note contains `"NOTE"`. A types `"hello "` at the start while B types `" world"` at the end.

- **Edits that cross in flight** [probe 1c]. A sends `"hello NOTE"` and B sends `"NOTE world"`, and neither has seen the other's.
  - The server processes A, then B.
  - Final server, A and B all show **`"NOTE world"`**. A's `"hello "` is gone everywhere, including on A's screen.
  - Both pushes returned `commit`. Nobody is told about the conflict.
  - There is no partial or nested merge. The result is always one user's complete document.
- **Edits that don't overlap** [probe 1d]. A's update reaches B before B types. B's full-document `put` is then based on `"hello NOTE"`, and the final text is **`"hello NOTE world"`**.
- **What happens in the real editor** [source]. `tldraw src/lib/shapes/text/RichTextArea.tsx:69-79`:

  ```ts
  useLayoutEffect(() => {
    if (!rTextEditor.current) { rInitialRichText.current = richText }
    else if (!isEqual(rInitialRichText.current, richText)) {
      rTextEditor.current.commands.setContent(richText as JSONContent)
    }
  }, [richText])
  ```

  - A remote `richText` change while you are editing **replaces the whole TipTap document** in your open editor.
  - TipTap 3's `setContent` defaults to `emitUpdate = true` and does `tr.replaceWith(0, doc.content.size, …)` without restoring the selection (`@tiptap/core src/commands/setContent.ts:52-66`).
  - Each keystroke is pushed on its own: `useEditableRichText.handleChange` calls `editor.updateShape({props:{richText}})` (`useEditableRichText.ts:42-53`), and pushes are throttled to at most 30 per second (`COLLABORATIVE_MODE_FPS`, `TLSyncClient.ts:50`).
  - So during simultaneous typing, characters typed within roughly one sync round-trip of the other person's typing get lost, and the text flickers between the two versions.
  - **UNVERIFIED:** exactly where the caret ends up after `setContent`. ProseMirror maps the selection through a whole-document replace, so it probably jumps. This needs a browser test.
- **Attribution side effect** [source]. The note's `onBeforeUpdate` stamps `props.textLastEditedBy` with the local user whenever `richText` changes (`NoteShapeUtil.tsx:540-563`). That runs only on the local `editor.updateShape` path (`Editor.ts:9115-9118`), never for remote changes.

**Conclusion for the plan's §7 test.** Native sync does **not** merge characters in rich text. The plan's fallback, a server-enforced short text-edit lease, is required if we don't want lost characters (§7 below). We verified it works.

---

## 2. Speculative client changes and rebase

The client state lives in `TLSyncClient` (`TLSyncClient.ts:372-1025`):
- `speculativeChanges: RecordsDiff` (`:394-398`) is every local change not yet confirmed by the server. "If we take this diff, reverse it, and apply that to the store, our store will match exactly the most recent state of the server that we know about."
- `pendingPushRequests: TLPushRequest[]` (`:383`) are pushes in flight.
- `unsentChanges.nextDiff` (`:384-387`) holds changes not yet sent because of throttling.
- `lastServerClock` (`:374`) starts at `-1`.

The flow, all [source]:

1. **Local edit, applied optimistically.** The store has already changed; the user sees it immediately.
   - `store.listen(..., {source:'user', scope:'document'})` calls `push(changes)` (`:572-579`).
   - `push` (`:897-909`) squashes the change into `speculativeChanges`. If offline, it stops there.
   - Otherwise it squashes into `unsentChanges.nextDiff` and calls `sendUnsentChanges()`.
2. **Send.** `sendUnsentChanges` is `fpsThrottle`d at 30 fps with collaborators and **1 fps in solo mode** (`SOLO_MODE_FPS`, `:47, 510-554`).
   - It builds `{type:'push', clientClock, diff: getNetworkDiff(nextDiff), presence}`, increments `clientClock`, and appends the request to `pendingPushRequests`.
   - It does nothing while disconnected or while `store.isPossiblyCorrupted()`.
3. **The server decides the result** (`TLSyncRoom.ts:1516-1549`), comparing the *actually applied* network diff with the one the client sent:
   - they are equal: `action:'commit'`;
   - nothing was applied (everything skipped: deleted records, vetoed, read-only, no-ops): `action:'discard'`;
   - something different was applied: `action:{rebaseWithDiff: actualDiff}`.

   [probe 2] B had already set `y=5`. A then sent `{x:100, y:5}` and got `rebaseWithDiff: {"shape:note1":["patch",{"x":["put",100]}]}`.
4. **Receive and rebase.** `handleServerEvent` (`:821-856`) buffers `patch` and `push_result` messages (from `data` batches), then schedules `rebase` (`:958-1024`). Inside `store.mergeRemoteChanges`, so everything is tagged `source:'remote'` and is **not recorded in undo history**:
   1. apply `reverseRecordsDiff(speculativeChanges)` to return to the last known server state;
   2. for each buffered message, in order:
      - `patch`: `applyNetworkDiff(diff)`;
      - `push_result`: it must match `pendingPushRequests[0].clientClock`, otherwise the client throws and resets the connection;
        - `commit`: re-apply the request's own diff;
        - `discard`: drop it;
        - `rebaseWithDiff`: apply the server's diff instead;
   3. `speculativeChanges = extractingChanges(re-apply every remaining pending request's diff + unsentChanges)`;
   4. `lastServerClock = lastMessage.serverClock`.
5. **`applyNetworkDiff`** (`:921-955`):
   - a `put` replaces the record whole;
   - a `patch` on a record that no longer exists locally is **skipped** ("the record was removed upstream");
   - a `remove` removes the record if present.

**Consequences.**
- Your own pending local change always stays visible until the server rules on it.
- A `discard` or a partial rebase reverts your edit **without any notification**. The client has no public hook for push results.

**"Saved" indicator note (build plan §7.5).** `pendingPushRequests` and `speculativeChanges` are private, and `TLSyncClient` has no public "all changes acknowledged" API. [source]
- A `push_result` is sent only after `storage.transaction` returns, which for SQLite is after `COMMIT` (`NodeSqliteWrapper.ts` `transaction`, then `TLSyncRoom.ts:1551-1553`). So a `push_result` is a real persistence acknowledgement.
- To build a saved indicator, wrap the socket through `useSync({ connect })`. Its type is `UseSyncConnectFn = (query:{sessionId, storeId}) => TLPersistentClientSocket` (`@tldraw/sync dist-cjs/index.d.ts:146-149`). Count outgoing `push.clientClock` against incoming `push_result.clientClock`. **UNVERIFIED** as an implementation; the types were checked.
- Solo mode pushes at most about once per 0.9 s. An edit made less than about 1 s before the tab closes can be lost.

---

## 3. Edit vs delete, resurrection, tombstones

**Edit arrives after delete** [probe 3 `deleteArrivesFirst`].
- A removes the note while B holds a `patch x=999`.
- The server runs `case 'patch'`: `const doc = txn.get(id); if (!doc) continue` (`TLSyncRoom.ts:1423-1427`).
- B gets **`discard`**. B's rebase drops its change and applies the `remove`.
- Final: gone on the server, on A and on B. Tombstone `{"shape:note1": 2}`.

**Edit arrives before delete** [probe 3 `editArrivesFirst`]. The patch applies, then the remove deletes the record. Final: gone everywhere. **Delete wins in both orders.** B's edits after the deletion are silently discarded.

**Resurrection.**
- A `patch` can never recreate a record.
- A **`put` always can**, and it clears the tombstone (`InMemorySyncStorage.ts:354-370`, `SQLiteSyncStorage.ts:638-649`).
- [probe 3 `putAfterDelete`]: after A's delete, B `put` a record with the same id. It came back (`"resurrected by B"`), and the tombstones list was `{}` afterwards.
- Real-world ways a `put` for an existing id happens:
  1. **Undo or redo** on a client restores a record someone else deleted [probe 4 `undoAfterRemoteDelete`, §4].
  2. Code that creates shapes with deterministic ids, such as templates. Also pasting the same id, although tldraw normally re-ids pasted content.
  3. Server-side writes (`storage.transaction`, the deprecated `updateStore`, `loadSnapshot`).
- Delete-then-re-add *within one client's pending changes* is squashed into an `updated` entry (`@tldraw/store src/lib/RecordsDiff.ts:279-286`). It goes out as a `patch`, so it does **not** resurrect a record deleted by someone else.

**Cross-record invariants are not enforced on the server** [probe, `probe4.cjs`].
- A deletes frame F while B reparents shape S into F.
- Result: `server_child_parentId: "shape:frame1"` while `server_frame_exists: false`, and B got `commit`.
- The server validates each record's shape (`recordType.validate`), not references. The same goes for bindings to deleted shapes.
- **UNVERIFIED:** how the editor renders a shape whose parent is missing. It is probably invisible. This case needs a browser test and possibly a server-side repair: `onCommittedChanges` followed by `room.storage.transaction(...)` to reparent orphans to their page.

**Tombstone lifetime** [source + probe 3b].
- Tombstones are stored in the `tombstones` AtomMap or SQLite table and included in `getSnapshot()`.
- There is **no time-based expiry**. `pruneTombstones` is a trailing-throttled job that runs 1 s after a delete (`InMemorySyncStorage.ts:252-273`, `SQLiteSyncStorage.ts:514-533`).
- It runs only when `count > MAX_TOMBSTONES (5000)`. It deletes the oldest `count - 5000 + 1000` tombstones, never splitting a single clock value (`computeTombstonePruning`, `:52-85`), and sets `tombstoneHistoryStartsAtClock` to the oldest remaining clock.
- [probe 3b]: 6100 deletes left 4000 tombstones, with `tombstoneHistoryStartsAtClock=2102` and `documentClock=6101`.
  - `getChangesSince(1)` returned `wipeAll: true`, because the client is older than the tombstone history.
  - `getChangesSince(6091)` returned 10 deletes.
- A `wipe_all` on reconnect is **safe**: the client wipes its document records, loads the full server state, and then re-applies its pending local changes (§5).
- When `InMemorySyncStorage` is built from a snapshot where `tombstoneHistoryStartsAtClock === documentClock`, the snapshot's tombstones are dropped (`InMemorySyncStorage.ts:191-198`).

---

## 4. Undo after a remote edit

From `@tldraw/editor src/lib/editor/managers/HistoryManager/HistoryManager.ts`:
- **Only local changes are recorded.** `this.store.addHistoryInterceptor((entry, source) => { if (source !== 'user') return; … })` (`:45-65`). Changes the sync client applies run inside `mergeRemoteChanges`, where `source` is `'remote'` (`Store.ts:1025-1039`, `:1266-1268`).
  - [probe 4 `remoteChangeNotInUndoStack`]: after only a remote edit, A's `getNumUndos()` was 1. That entry is only the mark A had placed.
  - A remote change also does not clear A's redo stack. Only local changes in `Recording` state do (`:49-56`).
- **Undo applies the reverse of the local change as whole records.**
  - `_undo` builds `reverseRecordsDiff(entry.diff)`; for updated records that is `[to, from]` (`RecordsDiff.ts:80-92`). It then calls `this.store.applyDiff(diffToUndo, { ignoreEphemeralKeys: true })` (`:193`).
  - `Store.applyDiff` (`Store.ts:1055-1102`) **puts the whole `from` record** for every updated entry, and every re-added removed record.
  - The only exception is types with ephemeral keys (`instance`, `instance_page_state`); shapes have none.
  - The sync client then diffs the *current* state (which includes remote edits) against the restored old record and pushes every field that differs.

**The requested scenario** [probe 4 `undoAfterRemoteEdit`]. A moves a note (`x: 0→100`). B then moves it again and recolors it (`x=300`, `color='red'`). A presses undo.
- A pushed: `{"shape:note1":["patch",{"x":["put",0],"props":["patch",{"color":["put","black"]}]}]}`.
- Final server and B: **`x=0, color='black'`**. B's move is overwritten, which is probably acceptable. **B's recolor, which A never touched, is also reverted.**
- Undo is *local* in which records it touches, but *whole-record* in what it writes.

**Undo after a remote delete** [probe 4 `undoAfterRemoteDelete`]. A moves a note, B deletes it, A undoes. A's push is `{"shape:note1":"put"}`, and **the note is resurrected** on the server and on B, at A's pre-move state.

The same whole-record write applies to redo (`:210-252`).

**Mitigation options** (design only; **UNVERIFIED**, not implemented):
- (a) Accept the behavior, but document it as "undo restores your last version of the object".
- (b) Before undo, rewrite the undo diff so that for each `[to, from]` pair only the keys *this* user changed are restored, i.e. those in `diffRecord(from, to)` from the original entry. Also skip records the client has seen deleted remotely. This needs its own history layer or patching `HistoryManager`, which is not a public extension point.
- (c) Server side: an `authorizeRecord.shape` rule can veto a create for an id that was recently deleted by someone else, e.g. by tracking deletes seen in `onCommittedChanges`. The veto sends a `discard` to the undoing client, so the resurrection is reverted.

---

## 5. Reconnect, restart, clocks

### 5.1 What the client sends and how the server answers

- **Client** [source]. `sendConnectMessage` (`TLSyncClient.ts:691-705`) sends `{type:'connect', connectRequestId: uniqueId(), schema: store.schema.serialize(), protocolVersion: 8, lastServerClock}`. `lastServerClock` is `-1` on first load.
- **Server** [source]. `handleConnectRequest` (`TLSyncRoom.ts:1005-1132`):
  - After the version checks (§6), it calls `txn.getChangesSince(message.lastServerClock)`.
  - It replies `connect` with `hydrationType: docChanges?.wipeAll ? 'wipe_all' : 'wipe_presence'`, `serverClock`, and a `diff`. The diff contains every presence record except the client's own, plus the document changes.
- **`getChangesSince(since)`** (`InMemorySyncStorage.ts:425-453`, `SQLiteSyncStorage.ts:705-740`) has four cases:
  - `since === clock` returns `undefined` (nothing to send, `wipe_presence`);
  - `since > clock` means the client is ahead, so `since = -1`;
  - `wipeAll = since < tombstoneHistoryStartsAtClock`;
  - otherwise: `put`s of **full records** with `lastChangedClock > since`, plus `remove` for tombstones with `clock > since`.
- **Client** `didReconnect` (`TLSyncClient.ts:737-816`), inside one `mergeRemoteChanges`:
  1. stash `speculativeChanges`;
  2. if not `wipe_all`, apply their reverse;
  3. remove all presence records (and, if `wipe_all`, all document records);
  4. apply `event.diff`;
  5. **re-apply `getNetworkDiff(stashed)`** as one new push, based on the fresh state;
  6. `lastServerClock = event.serverClock`.

### 5.2 Unacknowledged pushes on reconnect

- On any drop, `resetConnection` (`TLSyncClient.ts:708-730`) sets `pendingPushRequests = []` and `unsentChanges = {}` but **keeps `speculativeChanges`**. Nothing is lost; after reconnect everything unconfirmed is recomputed as a single push.
- If `pendingPushRequests` is somehow non-empty at connect time, the client does a hard reset that sets `lastServerClock = 0` (`:750-754`).
- [probe 5b] The server applied A's `x=4242`, then the connection dropped before the `push_result` arrived.
  - After reconnect the server's diff already contained `x=4242`, so re-applying A's stashed patch was a no-op.
  - **No duplicate push was sent** (`re_pushed_after_reconnect: []`), and everyone ended at 4242.
  - An `append` replayed after the server already applied it fails the length check and is ignored, so it is not applied twice. [source]

### 5.3 Can an offline client overwrite newer state? [probe 5a]

Setup:
- The server clock was 2 when A went offline.
- Offline, A set `x=111, color='blue'` on the note and moved shape T.
- Online, B set `y=222, color='red'` and **deleted T**. The server clock was now 4.

Result:
- A reconnected with `lastServerClock: 2` and got `hydrationType: 'wipe_presence'`, `serverClock: 4`, `diff: {note1: put, other: remove}`.
- A's only push after reconnect was `{"shape:note1":["patch",{"x":["put",111],"props":["patch",{"color":["put","blue"]}]}]}`. **No snapshot and no `y`.** A's patch to T was skipped because T no longer existed.
- Final on all three: **`x=111` (A), `y=222` (B), `color='blue'` (A wins; B's red is lost)**, T stays deleted.

**Confirmed:** the client never uploads an old full snapshot. **But** every field the offline user changed overwrites newer values on reconnect. That includes **whole `richText` documents**: an offline edit to a note's text replaces text others typed in the meantime. Records the offline user deleted are deleted even if others edited them since.

### 5.4 Server restart

- **`SQLiteSyncStorage`** [source + probe 5c].
  - The `metadata` table persists `documentClock`, `tombstoneHistoryStartsAtClock` and `schema` (`SQLiteSyncStorage.ts:130-137`).
  - The clock is incremented with `UPDATE metadata SET documentClock = documentClock + 1` in the same SQL transaction as the record writes (`:351-353, 610-617`, and `NodeSqliteWrapper.transaction` does `BEGIN`/`COMMIT`/`ROLLBACK`).
  - [probe 5c]: the clock was 2 before `room.close(); db.close()` and **2 after reopening**. B edited after the restart. A reconnected with `lastServerClock: 2` and got `wipe_presence`, `serverClock: 3`, `diffKeys: ["shape:note1"]`. That is a correct incremental diff.
- **Pitfall** [source]. `new SQLiteSyncStorage({ sql, snapshot })` **erases existing data** whenever `snapshot` is passed (`SQLiteSyncStorage.ts:391-425`: `if (snapshot || !hasData) { … DELETE FROM documents; … }`). Only pass `snapshot` when `!SQLiteSyncStorage.hasBeenInitialized(sql)`.
- **Durability** [source]. `NodeSqliteWrapper` sets **no PRAGMAs**. `journal_mode`/`synchronous` are ours to choose on the `DatabaseSync`, and to verify against the plan's "killed process" gate.
- **`InMemorySyncStorage`**: everything is lost unless we persist `getSnapshot()`, which includes `documentClock`, `tombstones` and `tombstoneHistoryStartsAtClock`. Persisting only a `TLStoreSnapshot` resets the clock to 0 (`convertStoreSnapshotToRoomSnapshot`, `TLSyncStorage.ts:219-233`) and leads to the hazard below.

### 5.5 Client clock ahead of the server [probe 5d]

- **Fresh server** (data lost, clock 0) and a client at clock 2: `since > clock` becomes `-1`, which forces **`wipe_all`**. A's store dropped the note because the server doesn't have it. This is the intended self-healing path.
- **Hazard: restore from backup, then the clock catches up.**
  - The backup was taken at clock 1. A (at clock 3) had created `shape:ghost` after the backup.
  - The server restarted from the backup. B then made 6 edits, taking the server clock to 7. A reconnected with `lastServerClock: 3`.
  - Because 3 < 7 and 3 ≥ the tombstone-history start, A got **`wipe_presence`** and only the records changed after clock 3.
  - Result: **A still has `shape:ghost`** (`A_has_ghost: true`, `server_has_ghost: false`). A diverges silently until it reloads. The ghost is never pushed, because it isn't among A's pending changes.
  - **Mitigation** [source-derived; the probe only showed the failure]: when restoring a backup, initialize storage with `documentClock` raised above any clock a client could have seen, and set `tombstoneHistoryStartsAtClock` to that same value. `SQLiteSyncStorage` accepts both through `snapshot` (`:394-395`). This forces every existing client into `wipe_all`. Alternatively, restore into the live room with `TLSocketRoom.loadSnapshot(snapshot)`, which writes the differences and tombstones through a normal transaction (`TLSyncStorage.ts:194-217`).
- Related: if the storage changes underneath the room (`storage.onChange` from another transaction) and the change set is `wipeAll`, the room force-disconnects every session (`TLSyncRoom.ts:969-981`, "not part of the protocol yet").

---

## 6. Schema or protocol mismatch

**Server** (`TLSyncRoom.ts:1005-1050`, `getVersionMismatchReason :987-1003`). Every rejection closes the socket with code **`TLSyncErrorCloseEventCode = 4099`** and the reason string (`removeSession`, `:527-560`):

1. **Protocol.** Versions 5→6→7→8 are normalized: v6 sets `requiresLegacyRejection`, and v7 sets `supportsStringAppend=false`.
   - `< 8` gives `CLIENT_TOO_OLD`.
   - `> 8` gives `SERVER_TOO_OLD`.
   - [probe 6]: protocol 9 → `{code:4099, reason:'SERVER_TOO_OLD'}`; protocol 4 → `{code:4099, reason:'CLIENT_TOO_OLD'}`.
2. **No schema** gives `CLIENT_TOO_OLD`.
3. **`schema.getMigrationsSince(clientSchema)` fails.**
   - The client is ahead in a sequence both sides know → `SERVER_TOO_OLD`. [probe 6 `schemaSequenceNewer`, where `com.tldraw.shape.note` was 13+1]
   - Otherwise → `CLIENT_TOO_OLD`.
4. **The client is behind but can't be served.** If any needed migration is not record-scoped or has no `down`, the result is `CLIENT_TOO_OLD`.
   - Otherwise the server serves the older client: it migrates pushes up and broadcasts down (`migrateDiffOrRejectSession`, `:803-852`). If a later migration fails, the session is rejected mid-session with `CLIENT_TOO_OLD`.
   - [probe 6]: `note` one version older → accepted; `com.tldraw.store` one version older → accepted (store/5 is record-scoped with `down`; store/3 and store/4 are storage-scoped with no `down`, so older clients are rejected).
5. **Unknown sequences in the client schema are ignored at connect.** `computeMigrationsSince` only looks at sequences both sides share (`@tldraw/store src/lib/StoreSchema.ts:444-447`). [probe 6 `schemaHasUnknownSequence`: accepted]
   - The first **push** of a record the server can't validate then fails with `TLSyncError INVALID_RECORD`, which closes with 4099. [probe 6b]: an unknown `typeName` gave `INVALID_RECORD`; `x:'not-a-number'` gave `INVALID_RECORD`.
   - A patch to a missing record is not an error; it just returns a `push_result`.
   - **Custom shapes must be registered in the server schema**, i.e. share `createTLSchema({ shapes })` between client and server.

Error reasons (`TLSyncClient.ts:106-125`): `NOT_FOUND | FORBIDDEN | NOT_AUTHENTICATED | UNKNOWN_ERROR | CLIENT_TOO_OLD | SERVER_TOO_OLD | INVALID_RECORD | RATE_LIMITED | ROOM_FULL`. Hosts can close with their own string via `room.closeSession(sessionId, reason)` (`TLSocketRoom.ts:925`).

**How the client surfaces it** [source + probe 6c]:
- `ClientWebSocketAdapter._handleDisconnect` maps close code 4099 to status `{status:'error', reason}` (`ClientWebSocketAdapter.ts:121-168`).
- `TLSyncClient` then runs `resetConnection()`, `onSyncError(reason)` and `close()` (`TLSyncClient.ts:594-607`). The sync client is dead; there is **no automatic reconnect**.
- `useSync` runs `setState({ error: new TLRemoteSyncError(reason) })` and `socket.close()` (`@tldraw/sync src/useSync.ts:355-378`), and returns `{ status: 'error', error }` (`:421-436`).
- `TLRemoteSyncError` has `name = 'RemoteSyncError'` and `readonly reason`.
- [probe 6c]: a client with a newer note schema saw `onSyncError_reasons: ["SERVER_TOO_OLD"]` and socket status `error`.
- **Unpushed local changes stay only in memory and are lost on reload.** Deploy the server before the clients, and keep migrations record-scoped with `down` so older tabs keep working.

---

## 7. Locks, leases, "someone else is editing"

**Nothing built in** [source]:
- `TLInstancePresence` (`@tldraw/tlschema src/records/TLPresence.ts:42-62`) has `userId, userName, lastActivityTimestamp, color, camera, selectedShapeIds, currentPageId, brush, scribbles, screenBounds, followingUserId, cursor, chatMessage, meta`. **There is no `editingShapeId`.** `editingShapeId` lives on `instance_page_state`, which is session-scoped and never synced.
- `getDefaultUserPresence` sets `meta: {}` (`createPresenceStateDerivation.ts:120-155`).
- The closest built-in is the note prop `textLastEditedBy`, which records *who last edited* the text, not who is editing it now.

**Presence can carry the indicator** [probe 7b].
- `presence.meta.editingShapeId` survived server validation and reached the other client unchanged (`B_sees_presence: [{ userName:'Alice', meta:{ editingShapeId:'shape:note1' } }]`).
- The server replaces the presence **id** with its own per-session id (`TLSyncRoom.ts:1298-1323`).
- Presence records are removed from others' stores `SESSION_REMOVAL_WAIT_TIME = 5000` ms after a socket closes (`RoomSession.ts:55`, `TLSyncRoom.ts:527-593`). Expect up to about 5 s of a stale "editing" badge.
- Presence is pushed only in `presenceMode 'full'`, i.e. when other sessions exist (`useSync.ts:340-344`, `TLSyncClient.ts:665-675`).

Client code (typechecked against 5.4.2 with `tsc` 5.9.3 in strict mode):

```ts
import { getDefaultUserPresence, TLINSTANCE_ID, InstancePageStateRecordType,
  type TLStore, type TLUser, type TLPresenceStateInfo } from '@tldraw/tlschema'

export function getUserPresence(store: TLStore, user: TLUser): TLPresenceStateInfo | null {
  const base = getDefaultUserPresence(store, user)
  if (!base) return null
  const instance = store.get(TLINSTANCE_ID)
  const pageState = instance ? store.get(InstancePageStateRecordType.createId(instance.currentPageId)) : undefined
  return { ...base, meta: { editingShapeId: pageState?.editingShapeId ?? null } }
}
// useSync({ uri, assets, getUserPresence, onCustomMessageReceived })
```

This is only a hint: `userId` inside presence is set by the client and is not trustworthy. The server-trusted identity is `session.meta`, which we pass to `handleSocketConnect({ sessionId, socket, meta })`.

**Server enforcement hook: `authorizeRecord`** [source + probe 7].
- `TLSocketRoomOptions.authorizeRecord?: TLRecordAuthorizers<R, SessionMeta>` (`TLSocketRoom.ts:152`; public in `dist-cjs/index.d.ts:1320`).

  ```ts
  type TLRecordAuthorizer<Rec, SessionMeta> = (args: {
    session: { sessionId: string; isReadonly: boolean; meta: SessionMeta }
  } & ( { type: 'create'; prev: null; next: Rec }
      | { type: 'update'; prev: Rec;  next: Rec }
      | { type: 'delete'; prev: Rec;  next: null } )) => Rec | null
  type TLRecordAuthorizers<R, SessionMeta> = { [K in R['typeName']]?: TLRecordAuthorizer<Extract<R,{typeName:K}>, SessionMeta> }
  ```
- It runs synchronously inside the push transaction, only for client pushes, on records migrated **up** to the server's version (`TLSyncRoom.ts:124-155, 1374-1491`).
- Return `null` to reject. The op is skipped and the client gets `discard` or `rebaseWithDiff`, which reverts it. A throw counts as a rejection (`:323-339`).
- On `update` and `delete` the return value is used only to allow or veto. On `create` the returned record is what gets stored.
- It **vetoes the whole record op, not individual props**. [probe 7]: B's push changed the text *and* `x=42`; both were dropped.
- It can't be registered for the presence type; that throws at construction (`:412-419`).
- It **can't read other records**: nested `storage.transaction` calls are not safe, and SQLite would reject a nested `BEGIN`. Keep lease state in an in-memory `Map`.
- `onBeforeSendMessage` and `onAfterReceiveMessage` are observe-only; they cannot filter. `onCommittedChanges` fires after commit (a microtask), for client pushes only.

**Smallest server-enforced text lease**:
- It is implicit: the first user to change a shape's `richText` holds the lease for `TEXT_LEASE_MS`, renewed on each accepted change.
- Verified in [probe 7] and `probe3.cjs`, and typechecked.
- It needs no client protocol changes. The client learns it was denied either from the text reverting or from a custom message.

```ts
import { TLSocketRoom, type TLRecordAuthorizers, SQLiteSyncStorage, NodeSqliteWrapper } from '@tldraw/sync-core'
import { createTLSchema, type TLRecord, type TLShape } from '@tldraw/tlschema'
import { isEqual } from '@tldraw/utils'
import { DatabaseSync } from 'node:sqlite'

type SessionMeta = { userId: string; displayName: string }
const TEXT_LEASE_MS = 5_000
const leases = new Map<string, { userId: string; sessionId: string; expiresAt: number }>()
const textOf = (s: TLShape): unknown => ('richText' in s.props ? s.props.richText : undefined)
let room: TLSocketRoom<TLRecord, SessionMeta>

const authorizeRecord: TLRecordAuthorizers<TLRecord, SessionMeta> = {
  shape: (args) => {
    if (args.type === 'create') return args.next
    const { session } = args
    const now = Date.now()
    const lease = leases.get(args.prev.id)
    const heldByOther = !!lease && lease.userId !== session.meta.userId && lease.expiresAt > now
    if (args.type === 'delete') return heldByOther ? null : args.prev    // no deleting a note mid-edit
    if (isEqual(textOf(args.prev), textOf(args.next))) return args.next    // non-text edits pass
    if (heldByOther) {
      // no I/O inside the txn: notify after it
      queueMicrotask(() => room.sendCustomMessage(session.sessionId,
        { type: 'text-lease-denied', shapeId: args.prev.id, holder: lease!.userId }))
      return null
    }
    leases.set(args.prev.id, { userId: session.meta.userId, sessionId: session.sessionId, expiresAt: now + TEXT_LEASE_MS })
    return args.next
  },
}

room = new TLSocketRoom<TLRecord, SessionMeta>({
  schema: createTLSchema(/* { shapes, bindings } shared with the client */),
  storage: new SQLiteSyncStorage<TLRecord>({ sql: new NodeSqliteWrapper(new DatabaseSync('board.db')) }),
  authorizeRecord,
  onSessionRemoved: (_room, { meta }) => {                 // expiry recovery on disconnect
    for (const [id, l] of leases) if (l.userId === meta.userId) leases.delete(id)
  },
})
```

Observed [probe 7, `probe3.cjs`]:
- A edits the text and takes the lease. B's text edit gets `discard`, and B's note shows `"A typing"` again.
- B's delete of the note gets `discard`, and the note reappears on B.
- B receives the custom message `{type:'text-lease-denied', shapeId:'shape:note1', holder:'A'}`.
- After the lease expired, B's edit got `commit`.

Caveats:
- The lease map is process memory, which is fine for one room instance per board.
- The window between a user entering edit mode and their first keystroke is not covered. Presence `meta.editingShapeId` covers it for the UI.
- The lease is keyed by `session.meta.userId`, so two tabs of the same user share it.
- `room.getPresenceRecords()` exists at runtime but is `@internal` (left out of the `.d.ts`, `TLSocketRoom.ts:776`). The presence→session mapping is private, so server logic should not depend on presence.

---

## 8. Implications for Draftroom (inputs to the milestone 0 and 2 gates)

1. **Same-note typing.** Enforce the §7 text lease in v1, and show the holder's name from presence `meta.editingShapeId` plus the denial custom message. Without a lease, simultaneous typing loses characters (probe 1c).
2. **Delete while typing.** Delete wins. If a lease is in place, the lease holder's note can't be deleted by others until it expires.
3. **Undo after remote change.** Document the behavior: undo restores *your* last version of the whole object, including other users' prop edits since, and it can bring back objects others deleted. Decide whether to add mitigation 4(b) or 4(c).
4. **Reconnect** is safe against snapshot overwrite, but uses last writer wins per field (probe 5a). No action needed beyond the UI states.
5. **Restart.** Use `SQLiteSyncStorage` and never pass `snapshot` to a database that is already initialized. Set and verify `PRAGMA journal_mode/synchronous`. **For backup restore, raise `documentClock` and `tombstoneHistoryStartsAtClock`** (or use `loadSnapshot` on the live room) to avoid ghost records (probe 5d).
6. **Deploys.** Deploy the sync server before the web client. Keep custom shape migrations record-scoped with `down`. Map `useSync` `status:'error'` with `CLIENT_TOO_OLD` to a "refresh to update" screen, and `SERVER_TOO_OLD` to "server updating, retry".
7. **Referential integrity.** Test reparenting into a frame that is concurrently deleted, and binding to a shape that is concurrently deleted, in the browser. Plan a server-side orphan repair with `onCommittedChanges` if the editor hides orphans.
8. **Saved indicator.** Track acknowledgements by wrapping the socket (`useSync({ connect })`). A `push_result` means the SQLite commit happened.

---

## Appendix A — Probe harness (reproducible)

Scratch location: `C:/Users/Chase/AppData/Local/Temp/claude/C--Users-Chase-Documents-GitHub-Draftroom/3dc84691-7141-4bcc-93bd-450e201c602f/scratchpad/research/conflict-semantics/`:
- `harness.cjs`
- `probe.cjs` (1a–1f, 3, 4, 5a–5d, 6, 7, 7b)
- `probe2.cjs` (2, 3b, 6b, 6c)
- `probe3.cjs` (lease delete veto and custom message)
- `probe4.cjs` (orphan parentId)
- `probe-results.json`, `probe2-results.json`
- `ts/lease.ts` (typechecked recipe)

Setup: `npm i @tldraw/sync-core@5.4.2 @tldraw/tlschema@5.4.2 @tldraw/store@5.4.2 @tldraw/editor@5.4.2`, then run `node probe.cjs [scenario]`.

The essentials, which are what make it deterministic:

```js
process.env.NODE_ENV = 'test' // FpsScheduler.fpsThrottle becomes synchronous (@tldraw/utils src/lib/throttle.ts isTest())
globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(Date.now()), 16)
const sc = require('@tldraw/sync-core')            // TLSocketRoom, TLSyncClient, SQLiteSyncStorage, NodeSqliteWrapper, ...
const store = new Store({ schema: createTLSchema(), props: { defaultName: '', assets: {...}, users: {...}, onMount() {} } })
// client socket: implements TLPersistentClientSocket
const sock = { connectionStatus: 'offline', sendMessage(msg) { c2s.push(JSON.stringify(msg)) },
  onReceiveMessage(cb) {...}, onStatusChange(cb) {...}, restart() {...}, close() {...} }
new sc.TLSyncClient({ store, socket: sock, presence: atom('p', null), onLoad() {}, onSyncError(r) {...} })
// server socket: implements WebSocketMinimal { send, close, readyState }
room.handleSocketConnect({ sessionId, socket: { readyState: 1, send: s => s2c.push(s), close(code, reason) {...} }, meta })
// delivery (can be held per direction to force concurrency):
room.handleSocketMessage(sessionId, c2s.shift()); for (const cb of listeners) cb(JSON.parse(s2c.shift()))
// "online" is signalled by setting sock.connectionStatus='online' and emitting {status:'online'};
// a 4099 close from the server is mapped to {status:'error', reason}, mirroring ClientWebSocketAdapter.
```

`HistoryManager` is the real one from `@tldraw/editor` (`new HistoryManager({ store })`, `_mark()`, `undo()`), attached to client A's store.

## Appendix B — UNVERIFIED items

- Where the caret lands in TipTap after a remote `setContent` while editing, and whether TipTap's `doc.toJSON()` normalizing incoming JSON can cause an echo push. This needs a browser test.
- How the editor renders shapes whose `parentId` points to a deleted frame, or arrows bound to deleted shapes. The sync layer accepts both (verified).
- Undo mitigations 4(b) and 4(c), orphan repair with `onCommittedChanges`, and the saved indicator built on `useSync({ connect })`. These are designs, not implemented.
- The backup-restore mitigation (raising `documentClock` and `tombstoneHistoryStartsAtClock`) is derived from the `getChangesSince` source. Only the failure case was probed.
- SQLite durability under a killed process depends on PRAGMAs we choose. Not tested here.
