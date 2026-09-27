# Spike: truthful save indicator (WRK-03) on tldraw 5.4.2 native sync

Date: 2026-09-26/27. Engine: `tldraw`, `@tldraw/sync` and `@tldraw/sync-core` **5.4.2** (sync protocol v8). Client: React 19.3.0, Vite 8.3.1, TypeScript 7.0.2. Browser: Chrome 153 (headless, `channel: 'chrome'`), driven by playwright-core 1.63.0. Server: a scratch `TLSocketRoom` + `SQLiteSyncStorage` (WAL, `synchronous=FULL`), wired like `apps/sync/src/app.ts` and `rooms.ts`, with the Draftroom text lease copied in. Checklist item: [miro-ux-checklist.md](miro-ux-checklist.md) WRK-03.

Tags:
- **[src]**: read in the 5.4.2 package source. Every package ships `src/`. Paths are `node_modules/@tldraw/<pkg>/src/...`.
- **[run]**: observed in the spike, in Chrome, against the real server.
- **UNVERIFIED**: not demonstrated.

Prototype (scratch, not in the repo): `C:/Users/Chase/AppData/Local/Temp/claude/C--Users-Chase-Documents-GitHub-Draftroom/3dc84691-7141-4bcc-93bd-450e201c602f/scratchpad/spikes/saved-indicator/`
- `src/saveTracker.ts` and `src/useSaveStatus.ts`: the code in §5, byte-for-byte.
- `src/App.tsx`: the spike board.
- `server/server.ts`: the scratch sync server.
- `scripts/s1…s9-*.mjs`: the Chrome scenarios.
- `results/*.json`: raw evidence.
- `results/final-run.txt`: the final tally, **88/88 checks passed**.

---

## 0. TL;DR

- **Recommendation.** Use `useSync({ connect })`. Its `connect` returns a pass-through `TLPersistentClientSocket` that wraps tldraw's own `ClientWebSocketAdapter`. Pair it with a `store.listen(…, { source: 'user', scope: 'document' })` listener. The wrapper sees every outgoing `connect`/`push` and every incoming `connect`/`data`/`push_result`/`custom` as whole objects. It sits above chunking, so chunked frames are not an issue.
- **Definition.** "Saved" = every document change the user made was answered by the server, and each answer was checked:
  - `commit`: applied verbatim. It is sent only after the SQLite `COMMIT`.
  - `discard` / `rebaseWithDiff`: each op is re-checked against the store *after the client's rebase*. A benign no-op (the server already had that value) passes. A veto, a read-only skip, or an edit to a record someone else deleted becomes a **Rejection**. The indicator then shows "Change not saved" plus a toast, and **never** "Saved" first.
- **Private state.** No `TLSyncClient` private fields are used. The design relies on two `@internal` items, both runtime-exported in 5.4.2:
  - the `ClientWebSocketAdapter` class;
  - the protocol v8 message shapes.

  Both are guarded, so an upgrade that breaks them fails loudly (the import check throws) or fails safe (`'unsupported'`, which never says "Saved"). The private `speculativeChanges` / `pendingPushRequests` (via the `window.tlsync` debug global) served only as a **test oracle**. Across ~9,000 per-frame samples the tracker never said "Saved" while the client held an unacknowledged change.
- **Verified in Chrome** against a real room [run]:
  - Typing and dragging show Saving… then Saved.
  - With the server hard-killed, 10 offline edits show "Offline — changes will sync", then Saved after a restart. All 10 reach SQLite and a fresh client.
  - Vetoed edits never show Saved and raise a warning. Tested with a `meta` veto, a partial veto in one push, a patch veto, a forged read-only write, the text lease, and delete-wins.
  - Presence-only activity (179 cursor pushes) never changed either indicator.
  - A 2 s drag with 360 raw state flips showed exactly one Saving…→Saved.
- **How long "Saving…" is visible.**
  - The protocol round trip for one edit is short: change → `push_result` p50 is **56–61 ms** on localhost and **~100 ms** with 50 ms injected latency.
  - The displayed label is held for a 500 ms minimum plus a 250 ms settle, so a single edit shows "Saving…" for **~550 ms**.
  - After a drag or typing ends, "Saved" appears **~250–450 ms** later with two or more participants (30 fps sync). A solo user waits up to **~1 s**, because tldraw throttles a solo client's pushes to one per 900 ms.
- **Engine bug found (affects Draftroom viewers today).** A read-only session in 5.4.2 loops forever:
  1. the editor writes the viewer's own `user:` record;
  2. the server discards it;
  3. the rebase removes it;
  4. the editor writes it again.

  That is **~14 discarded pushes per second, indefinitely**. It reproduces with plain `useSync({ uri })`, with no tracker at all. **Fix (verified):** give read-only roles `currentUser: null`, and stamp their name and color through `getUserPresence`. See §7.

---

## 1. States and labels

| `SaveState` | Label (spike) | Meaning |
|---|---|---|
| `connecting` | Connecting… | First connect has not finished |
| `saved` | **Saved** | Nothing unsent, nothing in flight, nothing awaiting verification |
| `saving` | **Saving…** | Local changes are unsent, in a push awaiting `push_result`, or awaiting post-rebase verification |
| `offline` | Offline | Disconnected with nothing unsaved |
| `offline-pending` | **Offline — changes will sync** | Disconnected with unconfirmed changes. These live in memory only, so a reload loses them. |
| `rejected` | **Change not saved** (+ toast with the reason) | The server did not apply a local change. Held 8 s, or until a later push commits. |
| `error` | Not saved — connection ended | Terminal 4099 close, or `useSync` status `'error'` |
| `unsupported` | Live | Protocol ≠ v8: the indicator never claims "Saved" |
| (display only) `readonly` | View only | `saved` in a session the server marked read-only |

The display layer (`useSaveStatus`) **never delays entering** `saving`, because a delay would briefly claim "Saved" falsely. It only delays **leaving** `saving`: a 500 ms minimum and a 250 ms settle. That is what turns bursts into a single Saving…→Saved.

---

## 2. What 5.4.2 offers (options evaluated)

| Option | Public in 5.4.2? | Verdict |
|---|---|---|
| **`useSync({ connect })` returning a wrapper over `ClientWebSocketAdapter`** | `connect` / `UseSyncConnectFn` and `TLPersistentClientSocket` are public (`@tldraw/sync` d.ts:146, sync-core d.ts:585). `ClientWebSocketAdapter` is **`@internal`**: excluded from the d.ts (sync-core d.ts:27) but runtime-exported and used in the public `TLSyncClient` JSDoc (d.ts:1388-1393). | **Chosen.** It is the only public place to observe `push`/`push_result`. |
| Own `TLPersistentClientSocket` from scratch | fully public | Viable fallback if the adapter export disappears. It would reimplement `ReconnectManager`: backoff, `online`/`visibilitychange`, attempt timeouts (`ClientWebSocketAdapter.ts:374-726`). |
| `TLSyncClient` privates (`speculativeChanges`, `pendingPushRequests`, `unsentChanges`) | private (`TLSyncClient.ts:383-398`). Reachable only through the debug global `window.tlsync`, which points at the newest client (`:556-558`, `:876-878`) | **Rejected** for product use: private and not reactive. Used as a test oracle only. |
| `onCustomMessageReceived` | public | Cannot see `push_result`. Used to attach the *reason* for a rejection (`text-lease-denied`, `write-vetoed`). |
| `store.listen({ source: 'user', scope: 'document' })` | public | Needed for the unsent window (edit → push). Cannot see acknowledgements. |
| `connectionStatus` / `useCollaborationStatus` | public | Socket up or down only. This is what `TopBar` shows today ("Live"). Never evidence of saving. |
| Server-sent "saved up to clock N" custom message (from `onCommittedChanges`) | public | Redundant with `push_result`. Cannot see vetoes or no-ops, and adds traffic. Not needed. |

---

## 3. The engine facts the design rests on (all [src], confirmed [run])

The quoted source is `@tldraw/sync-core` unless noted.

1. **A local change reaches the socket two frames later.**
   - The store flushes history to listeners on the next frame: `Store.historyReactor` with `throttleToNextFrame` (`@tldraw/store Store.ts:497-505`).
   - `TLSyncClient` listens with exactly `{ source: 'user', scope: 'document' }` (`TLSyncClient.ts:572-579`), and `push()` squashes the change into `speculativeChanges` and `unsentChanges.nextDiff` (`:897-909`).
   - `sendUnsentChanges` is an `FpsScheduler.fpsThrottle`, which always waits for a `requestAnimationFrame` and never sends synchronously (`@tldraw/utils throttle.ts:48-79, 110-116`). It runs at **30 fps**, or **1 fps when no other session is present** ("solo": `SOLO_MODE_FPS`, `TLSyncClient.ts:47`; `presenceMode` in `@tldraw/sync useSync.ts:340-344`). The frame budget is `floor(1000/fps)*0.9`: **900 ms solo**, 29.7 ms full (`throttle.ts:10-11`).
   - A push carries **all** unsent changes and clears `nextDiff` (`TLSyncClient.ts:535-551`).
   - [run] Change → listener p50 5–14 ms, → push sent p50 36–44 ms.
2. **Presence and document share one message.** `{ type:'push', clientClock, diff?, presence? }` (`protocol.ts`, `TLSyncClient.ts:535-540`). Cursor moves produce pushes with `presence` and **no `diff`**. The server answers **every** push with a `push_result`, and a presence-only push gets `action:'commit'` because `isEqual(undefined, undefined)` (`TLSyncRoom.ts:1516-1522`). So presence commits must be ignored. [run] S2: 179 presence pushes, 0 with a diff, no indicator change.
3. **`push_result` comes after COMMIT.**
   - The whole push runs inside `storage.transaction` (`TLSyncRoom.ts:1289-1506`). `NodeSqliteWrapper.transaction` does `BEGIN` … `COMMIT` (`NodeSqliteWrapper.ts:87-101`).
   - Only after that is the result computed and sent (`TLSyncRoom.ts:1516-1553`):
     - `commit` when the applied network diff equals the sent one;
     - `discard` when nothing was applied;
     - `{ rebaseWithDiff }` otherwise.
   - Skipped ops include:
     - read-only (`canWrite`, `:1329-1331`);
     - `authorizeRecord` vetoes (`:1205-1209`, `:1261`, `:1467-1491`);
     - patches to already-deleted records (`:1424-1426`);
     - **no-op writes**, where the server already had the value (`diffAndValidateRecord` returns nothing).
   - The last one means **`discard` does not always mean rejected**. [run] S4 4d: two users set the same color at once; one got `discard`, and the tracker classified it benign.
4. **Results are ordered and batched.** The first data message after a quiet period is sent immediately; later ones are batched every 1000/60 ms into `{ type:'data', data:[…] }` (`TLSyncRoom.ts:87, 466-524`). The client requires each `push_result` to match the head of its queue, or it throws and resets the connection (`TLSyncClient.ts:979-986, 1019-1022`).
5. **The rebase is deferred.** Incoming `patch`/`push_result` messages are buffered and applied by `rebase` on the **same** `FpsScheduler`: up to 900 ms later in solo mode (`TLSyncClient.ts:554, 821-856, 958-1024`). Until then, the store still shows the user's speculative value even for a discarded push. Verification must therefore wait for the rebase (§4, and S9).
6. **Offline and reconnect.**
   - On any drop, `resetConnection` clears `pendingPushRequests` and `unsentChanges` but **keeps `speculativeChanges`** (`TLSyncClient.ts:708-730`). Edits made while not connected only accumulate there (`:901`).
   - On `connect`, `didReconnect` re-applies the stash against the fresh server state and calls `push()` (`:789-799`), then `pushPresence()` (`:809-812`).
   - So **the first push after a reconnect** carries a `diff` if and only if something is still unsaved. If the server already had the change (commit happened, ack lost), that push is presence-only. [run] S3 (b): the tracker resolves on that, deterministically, with no timer.
7. **Chunking is below the wrapper.**
   - `ClientWebSocketAdapter.sendMessage` stringifies, then `chunk()`s into frames of at most 262,144 characters prefixed `"<n>_"` (`ClientWebSocketAdapter.ts:275-287`, `chunk.ts:1-48`).
   - Server-to-client frames are **never chunked**: the client does a plain `JSON.parse` (`ClientWebSocketAdapter.ts:210-229`). The server reassembles incoming chunks in `TLSocketRoom.handleSocketMessage` (`TLSocketRoom.ts:441-455`).
   - A wrapper at the `TLPersistentClientSocket` level therefore sees whole objects in both directions. [run] S6 6c: a 1500-shape push went out as 4 frames (`3_`…`0_`), one `push_result: commit`, then Saved.
8. **`connect` details.**
   - `useSync` calls `connect({ sessionId: TAB_ID, storeId })` inside its effect (`useSync.ts:264-275`) and creates the store with `id: storeId` (`:215, 317-327`). That is how the hook matches a tracker to its store (`Store.id`, `Store.ts:346, 479`).
   - With `connect`, **you** must append `sessionId`/`storeId` to the URL (useSync does it only for `uri`, `:284-299`).
   - `connect` is an effect dependency (`:407-419`), so it must be referentially stable.

---

## 4. Design

The tracker is a state machine fed by four event streams:

| Event | Source | Effect |
|---|---|---|
| status `online` / `offline` / `error` | `inner.onStatusChange` (registered before `TLSyncClient`'s, so it runs first) | `offline`/`error`: everything in flight or unsent becomes `offlineDirty`, mirroring `resetConnection` |
| outgoing `connect` | wrapper `sendMessage` | remember `connectRequestId`; if `protocolVersion !== 8`, go `unsupported` |
| incoming `connect` (matching id) | `inner.onReceiveMessage` | `connected`; if `offlineDirty`, wait for the first push |
| user document change | `store.listen({source:'user',scope:'document'})` | connected: squash into `unsent` (`squashRecordDiffs`, public); otherwise `offlineDirty` |
| outgoing `push` (socket online) | wrapper `sendMessage` | queue `{clock, diff\|null}`; clear `unsent`; the first push after a reconnect resolves `offlineDirty` |
| `push_result` (plain or inside `data`) | `inner.onReceiveMessage` | must match the queue head (else desync, then reset). No diff: ignore. `commit`: saved. `discard`: verify every op. `rebaseWithDiff`: verify the ops not applied verbatim. |

**Verification of `discard` / `rebaseWithDiff`.**
- **When.** At least `verifyAfterMs` (1100 ms, above the 900 ms solo rebase throttle) after the result. **And** once the record is quiescent: no later in-flight push and no unsent change touches it. **And** one frame *after* it first came due (two-phase). The client's rebase is due no later than ours and flushes in the first frame it is due, but within that frame it can run after our rAF callback. S9 showed that single-phase checks after a 1.5–4 s main-thread stall misclassified vetoes as benign. The two-phase check fixed all 4.
- **What.** For each op, check whether the rebased record satisfies it at the diff's own granularity: top-level keys, `props.*`, `meta.*`.
  - `put`: equal.
  - `delete`: absent.
  - `append`: the slice at `offset` equals the appended text.
  - `patch`: checked recursively.
  - Paths that later pushes rewrote are excluded, so continuing to drag a shape is never a false rejection. Keys the client did not send are ignored, so a server that stamps extra `meta` on create still passes.
- **Verdict.**
  - satisfied: benign, counts as saved;
  - record missing after a patch: `deleted-remotely`;
  - otherwise: `vetoed`.
  - A custom message received within 1.5 s (for example `text-lease-denied`) is attached as the reason.

**Edit then revert inside one throttle window** (for example in one task). The client squashes the pair to nothing and sends nothing. The tracker checks its own squashed `unsent` for net emptiness after 1.1 s, so it is never stuck. [run] S6 6d.

**Why not "Saved on commit count only".** It would show "Saved" after a veto: the push was answered, but the change is gone. It would also show "Saving…" forever after the ack-lost reconnect.

---

## 5. Code to adopt

Target: `apps/web/src/board/saveTracker.ts` and `useSaveStatus.ts`. The code below is the spike's source verbatim. It was typechecked with tsc 7.0.2 using `strict`, `verbatimModuleSyntax`, `isolatedModules`, `skipLibCheck`, `moduleResolution: bundler` and `allowImportingTsExtensions`; the repo's own tsconfig was not used. `onEvent` is optional and can feed telemetry.

### 5.1 `saveTracker.ts` (socket wrapper + tracker)

```ts
/**
 * Truthful "Saved" tracking for native tldraw sync (@tldraw/sync 5.4.2, protocol v8).
 *
 * "saved" = every local document change has been answered by the server with a push_result whose
 * effect is verified: 'commit' (applied verbatim, sent only after the SQLite COMMIT), or a
 * 'discard'/'rebaseWithDiff' whose ops are verified against the rebased store (benign no-ops pass;
 * vetoes, read-only skips and edits to remotely-deleted records become a Rejection).
 *
 * Wiring: useSync({ connect }) where connect() wraps tldraw's own ClientWebSocketAdapter in a
 * pass-through TLPersistentClientSocket. The wrapper sits ABOVE chunking (the adapter chunks
 * inside sendMessage; server->client frames are never chunked), so it sees whole message objects.
 */
import * as tlsync from '@tldraw/sync'
import type { TLPersistentClientSocket, TLSocketStatusChangeEvent, UseSyncConnectFn } from '@tldraw/sync'
import { atom, isEqual, type RecordsDiff, squashRecordDiffs, type TLRecord, type TLStore } from 'tldraw'

// ---- wire protocol v8 (types are @internal in 5.4.2: re-declared here, only the fields we read) ----
type ValueOp = ['put', unknown] | ['append', unknown[] | string, number] | ['patch', ObjectDiff] | ['delete']
interface ObjectDiff {
	[key: string]: ValueOp
}
type RecordOp = ['put', Record<string, unknown>] | ['patch', ObjectDiff] | ['remove']
type NetDiff = Record<string, RecordOp>
type Outgoing =
	| { type: 'connect'; connectRequestId: string; protocolVersion: number }
	| { type: 'push'; clientClock: number; diff?: NetDiff; presence?: unknown }
	| { type: 'ping' }
type PushResult = {
	type: 'push_result'
	clientClock: number
	action: 'commit' | 'discard' | { rebaseWithDiff: NetDiff }
}
type Incoming =
	| { type: 'connect'; connectRequestId: string; isReadonly: boolean }
	| { type: 'data'; data: Array<PushResult | { type: 'patch' }> }
	| PushResult
	| { type: 'custom'; data: unknown }
	| { type: 'patch' | 'pong' | 'incompatibility_error' }

/** The protocol this tracker understands. Anything else => 'unsupported' (never claims "Saved"). */
export const SUPPORTED_PROTOCOL_VERSION = 8

// ClientWebSocketAdapter is exported at runtime by @tldraw/sync (re-export of sync-core) but is
// `@internal` (excluded from the public .d.ts) in 5.4.2. It is the same class useSync uses for `uri`.
type AdapterCtor = new (getUri: () => string | Promise<string>) => TLPersistentClientSocket<Outgoing, Incoming>
const ClientWebSocketAdapter = (tlsync as unknown as { ClientWebSocketAdapter?: AdapterCtor }).ClientWebSocketAdapter
if (typeof ClientWebSocketAdapter !== 'function')
	throw new Error('@tldraw/sync no longer exports ClientWebSocketAdapter: re-check the saved indicator')

export type SaveState =
	| 'connecting' // first connect not finished
	| 'saved' // everything acknowledged + verified
	| 'saving' // local changes unsent, in flight, or being verified
	| 'offline' // disconnected, nothing unsaved
	| 'offline-pending' // disconnected with unsaved changes (kept in memory only)
	| 'rejected' // the server did not apply a local change (held for rejectionHoldMs)
	| 'error' // terminal socket error (4099); unsaved changes are lost
	| 'unsupported' // unknown protocol version: fail safe

export interface Rejection {
	at: number
	records: Array<{ id: string; typeName: string; kind: 'vetoed' | 'deleted-remotely' }>
	/** The last custom message from the server (e.g. text-lease-denied), if it arrived within 1 s. */
	serverMessage: unknown
}

export interface SaveSnapshot {
	state: SaveState
	readonly: boolean
	inFlight: number // diff-carrying pushes awaiting push_result
	unsent: boolean // local changes not yet in any push
	offlineChanges: boolean // unconfirmed changes that will be re-pushed on reconnect
	verifying: number // discarded/rebased ops awaiting post-rebase verification
	rejection: Rejection | null
	lastSavedAt: number | null
	errorReason: string | null
}

export interface SaveTrackerOptions {
	/** Delay before verifying a discarded/rebased op. Must exceed the client's solo-mode rebase
	 *  throttle (900 ms = floor(1000/1 fps) * 0.9, @tldraw/utils throttle.ts:10-11). */
	verifyAfterMs?: number
	/** How long 'rejected' is shown unless a later push commits. */
	rejectionHoldMs?: number
	/** Test/debug hook. */
	onEvent?: (e: Record<string, unknown>) => void
}

interface InFlight {
	clock: number
	diff: NetDiff | null // null => presence-only push (ignored for saving)
	sentAt: number
}
interface Verify {
	id: string
	op: RecordOp
	writtenLater: Set<string> // paths written by pushes sent after this op's push
	dueAt: number
	ready: boolean // due was seen in an earlier frame => the client's rebase has run
}

const now = () => performance.now()

export class SaveTracker {
	readonly socket: TLPersistentClientSocket<Outgoing, Incoming>
	readonly storeId: string
	private readonly inner: TLPersistentClientSocket<Outgoing, Incoming>
	private readonly opts: Required<Omit<SaveTrackerOptions, 'onEvent'>> & Pick<SaveTrackerOptions, 'onEvent'>
	private phase: 'loading' | 'handshaking' | 'connected' | 'offline' | 'error' | 'unsupported' = 'loading'
	private everConnected = false
	private readonlySession = false
	private latestConnectRequestId: string | null = null
	private inflight: InFlight[] = []
	private unsent: RecordsDiff<TLRecord> | null = null
	private unsentAt = 0
	private offlineDirty = false
	private awaitFirstPush = false
	private verifying: Verify[] = []
	private rejection: Rejection | null = null
	private lastCustom: { at: number; data: unknown } | null = null
	private lastSavedAt: number | null = null
	private errorReason: string | null = null
	private store: TLStore | null = null
	private unlistenStore: (() => void) | null = null
	private raf: number | null = null
	private holdTimer: ReturnType<typeof setTimeout> | null = null
	private disposers: Array<() => void> = []
	private listeners = new Set<() => void>()
	private snapshot: SaveSnapshot
	readonly stats = { commits: 0, discards: 0, rebases: 0, benign: 0, rejected: 0, ackMs: [] as number[] }

	constructor(storeId: string, inner: TLPersistentClientSocket<Outgoing, Incoming>, opts: SaveTrackerOptions = {}) {
		this.storeId = storeId
		this.inner = inner
		this.opts = { verifyAfterMs: 1100, rejectionHoldMs: 8000, ...opts }
		this.snapshot = this.compute()
		// Registered before TLSyncClient subscribes, so these run first for every event.
		this.disposers.push(
			inner.onReceiveMessage((m) => this.onIncoming(m)),
			inner.onStatusChange((e) => this.onStatus(e)),
		)
		this.socket = {
			get connectionStatus() {
				return inner.connectionStatus
			},
			sendMessage: (msg) => {
				this.onOutgoing(msg)
				inner.sendMessage(msg)
			},
			onReceiveMessage: (cb) => inner.onReceiveMessage(cb),
			onStatusChange: (cb) => inner.onStatusChange(cb),
			restart: () => inner.restart(),
			close: () => {
				this.dispose()
				inner.close()
			},
		}
	}

	/** Call once the store exists (useSync 'synced-remote'). Returns the detach function. */
	attachStore(store: TLStore): () => void {
		if (store.id !== this.storeId) throw new Error('store does not belong to this tracker')
		this.unlistenStore?.()
		this.store = store
		// Same filter TLSyncClient uses to decide what to push (TLSyncClient.ts:572-579).
		this.unlistenStore = store.listen(({ changes }) => this.onLocalChange(changes), { source: 'user', scope: 'document' })
		return () => {
			this.unlistenStore?.()
			this.unlistenStore = null
			this.store = null
		}
	}

	subscribe = (cb: () => void) => {
		this.listeners.add(cb)
		return () => void this.listeners.delete(cb)
	}
	getSnapshot = () => this.snapshot

	dispose() {
		for (const d of this.disposers.splice(0)) d()
		this.unlistenStore?.()
		if (this.raf !== null) cancelAnimationFrame(this.raf)
		if (this.holdTimer) clearTimeout(this.holdTimer)
		this.listeners.clear()
	}

	// ---------------------------------------------------------------- events
	private onStatus(e: TLSocketStatusChangeEvent) {
		if (this.phase === 'unsupported') return
		if (e.status === 'online') {
			this.phase = 'handshaking'
		} else {
			// TLSyncClient.resetConnection drops pendingPushRequests + unsentChanges but keeps
			// speculativeChanges (TLSyncClient.ts:708-730): everything unconfirmed is re-pushed later.
			if (this.inflight.some((p) => p.diff) || this.unsent || this.awaitFirstPush) this.offlineDirty = true
			this.inflight = []
			this.unsent = null
			this.awaitFirstPush = false
			this.phase = e.status === 'error' ? 'error' : 'offline'
			if (e.status === 'error') this.errorReason = e.reason
		}
		this.emit()
	}

	private onOutgoing(msg: Outgoing) {
		if (msg.type === 'connect') {
			this.latestConnectRequestId = msg.connectRequestId
			if (msg.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
				this.phase = 'unsupported'
				this.emit()
			}
			return
		}
		if (msg.type !== 'push' || this.phase !== 'connected') return
		if (this.inner.connectionStatus !== 'online') return // the adapter drops it (ClientWebSocketAdapter.ts:278-286)
		const diff = msg.diff && Object.keys(msg.diff).length > 0 ? msg.diff : null
		this.inflight.push({ clock: msg.clientClock, diff, sentAt: now() })
		this.opts.onEvent?.({ ev: 'push', clock: msg.clientClock, hasDiff: !!diff })
		// A push carries ALL unsent changes (the client clears unsentChanges.nextDiff when it sends,
		// TLSyncClient.ts:550). No diff => whatever was unsent netted out to nothing.
		this.unsent = null
		// The first push after a reconnect carries the re-applied speculative changes
		// (didReconnect -> push, TLSyncClient.ts:789-799). No diff => the server already had them.
		if (this.awaitFirstPush) {
			this.awaitFirstPush = false
			this.offlineDirty = false
		}
		if (diff) for (const v of this.verifying) if (diff[v.id]) addPaths(v.writtenLater, diff[v.id])
		this.emit()
	}

	private onIncoming(msg: Incoming) {
		if (this.phase === 'unsupported') return
		switch (msg.type) {
			case 'connect':
				if (msg.connectRequestId !== this.latestConnectRequestId) return // same check as TLSyncClient.ts:739
				this.latestConnectRequestId = null
				this.phase = 'connected'
				this.everConnected = true
				this.readonlySession = msg.isReadonly
				if (this.offlineDirty) this.awaitFirstPush = true
				this.emit()
				return
			case 'data':
				if (this.phase !== 'connected') return // the client ignores data before connect (TLSyncClient.ts:838)
				for (const d of msg.data) if (d.type === 'push_result') this.onResult(d as PushResult)
				return
			case 'push_result':
				if (this.phase === 'connected') this.onResult(msg)
				return
			case 'custom':
				this.lastCustom = { at: now(), data: msg.data }
				if (this.rejection && now() - this.rejection.at < 1000 && this.rejection.serverMessage == null) {
					this.rejection = { ...this.rejection, serverMessage: msg.data }
					this.emit()
				}
				return
		}
	}

	private onResult(r: PushResult) {
		const head = this.inflight[0]
		if (!head || head.clock !== r.clientClock) {
			// TLSyncClient throws in rebase and resets the connection (TLSyncClient.ts:979-986,1019-1022);
			// the status change that follows folds everything into offlineDirty.
			this.opts.onEvent?.({ ev: 'desync', clock: r.clientClock })
			this.offlineDirty = true
			return
		}
		this.inflight.shift()
		if (!head.diff) return // presence-only push: never counts as a document save
		this.stats.ackMs.push(now() - head.sentAt)
		const later = this.inflight.filter((p) => p.diff)
		const toVerify = (ids: string[]) => {
			for (const id of ids) {
				const writtenLater = new Set<string>()
				for (const p of later) if (p.diff?.[id]) addPaths(writtenLater, p.diff[id])
				this.verifying.push({ id, op: head.diff![id], writtenLater, dueAt: now() + this.opts.verifyAfterMs, ready: false })
			}
			this.startLoop()
		}
		if (r.action === 'commit') {
			this.stats.commits++
			this.lastSavedAt = Date.now()
			this.rejection = null
		} else if (r.action === 'discard') {
			this.stats.discards++
			toVerify(Object.keys(head.diff))
		} else {
			this.stats.rebases++
			const applied = r.action.rebaseWithDiff
			const notVerbatim = Object.keys(head.diff).filter((id) => !isEqual(applied[id], head.diff![id]))
			if (notVerbatim.length) toVerify(notVerbatim)
			else this.lastSavedAt = Date.now()
		}
		this.opts.onEvent?.({ ev: 'result', clock: r.clientClock, action: typeof r.action === 'string' ? r.action : 'rebase' })
		this.emit()
	}

	private onLocalChange(changes: RecordsDiff<TLRecord>) {
		this.opts.onEvent?.({ ev: 'local' })
		if (this.phase === 'connected') {
			this.unsent = this.unsent ? squashRecordDiffs([this.unsent, changes], { mutateFirstDiff: true }) : squashRecordDiffs([changes])
			this.unsentAt = now()
			this.startLoop()
		} else {
			this.offlineDirty = true // pushed after reconnect (TLSyncClient.push, :897-909)
		}
		this.emit()
	}

	// ------------------------------------------------ rAF loop (paused in hidden tabs, like the client)
	private startLoop() {
		if (this.raf === null) this.raf = requestAnimationFrame(this.tick)
	}
	private tick = () => {
		this.raf = null
		const t = now()
		let changed = false
		// Edit + undo inside one throttle window: the client sends nothing. Detect it ourselves.
		if (this.unsent && t - this.unsentAt > this.opts.verifyAfterMs && netEmpty(this.unsent)) {
			this.unsent = null
			changed = true
		}
		const keep: Verify[] = []
		for (const v of this.verifying) {
			const busy = this.inflight.some((p) => p.diff?.[v.id]) || (this.unsent && touches(this.unsent, v.id))
			if (t < v.dueAt || busy || !this.store || !v.ready) {
				// Two-phase: the client's rebase is due no later than we are (same rAF clock, shorter
				// throttle) and flushes in the first frame it is due, but it may run AFTER this callback in
				// that frame (e.g. after a long task). Evaluate one frame later, never in the same frame.
				if (t >= v.dueAt && !busy && this.store) v.ready = true
				keep.push(v)
				continue
			}
			changed = true
			const rec = this.store.get(v.id as never) as Record<string, unknown> | undefined
			const verdict = judge(rec, v.op, v.writtenLater)
			if (verdict === 'ok') this.stats.benign++
			else this.reject(v.id, v.op, rec, verdict)
		}
		this.verifying = keep
		if (changed) this.emit()
		if (this.unsent || this.verifying.length) this.startLoop()
	}

	private reject(id: string, op: RecordOp, rec: Record<string, unknown> | undefined, kind: 'vetoed' | 'deleted-remotely') {
		this.stats.rejected++
		const typeName = String((rec?.typeName ?? (op[0] === 'put' ? op[1].typeName : id.split(':')[0])) as string)
		const entry = { id, typeName, kind }
		const recent = this.lastCustom && now() - this.lastCustom.at < 1500 ? this.lastCustom.data : null
		if (this.rejection && now() - this.rejection.at < 1000) this.rejection.records.push(entry)
		else this.rejection = { at: now(), records: [entry], serverMessage: recent }
		this.rejection = { ...this.rejection }
		if (this.holdTimer) clearTimeout(this.holdTimer)
		this.holdTimer = setTimeout(() => this.emit(), this.opts.rejectionHoldMs + 10)
		this.opts.onEvent?.({ ev: 'rejected', id, kind })
	}

	// -------------------------------------------------------------- snapshot
	private compute(): SaveSnapshot {
		const inFlight = this.inflight.filter((p) => p.diff).length
		const rejectionActive = !!this.rejection && now() - this.rejection.at < this.opts.rejectionHoldMs
		let state: SaveState
		if (this.phase === 'unsupported') state = 'unsupported'
		else if (this.phase === 'error') state = 'error'
		else if (this.phase === 'connected') {
			const busy = this.awaitFirstPush || this.unsent !== null || inFlight > 0 || this.verifying.length > 0
			state = rejectionActive ? 'rejected' : busy ? 'saving' : 'saved'
		} else if (!this.everConnected) state = 'connecting'
		else state = this.offlineDirty || this.verifying.length > 0 ? 'offline-pending' : 'offline'
		return {
			state,
			readonly: this.readonlySession,
			inFlight,
			unsent: this.unsent !== null,
			offlineChanges: this.offlineDirty,
			verifying: this.verifying.length,
			rejection: rejectionActive ? this.rejection : null,
			lastSavedAt: this.lastSavedAt,
			errorReason: this.errorReason,
		}
	}
	private emit() {
		const next = this.compute()
		if (isEqual(next, this.snapshot)) return
		this.snapshot = next
		this.opts.onEvent?.({ ev: 'state', ...next, rejection: next.rejection?.records ?? null })
		for (const l of this.listeners) l()
	}
}

// ------------------------------------------------------------------ helpers
/** Paths an op writes, at sync diff granularity (top-level keys, props.*, meta.*; '*' = whole record). */
function addPaths(out: Set<string>, op: RecordOp) {
	if (op[0] !== 'patch') return void out.add('*')
	for (const [k, v] of Object.entries(op[1])) {
		if ((k === 'props' || k === 'meta') && v[0] === 'patch') for (const k2 of Object.keys(v[1])) out.add(`${k}.${k2}`)
		else out.add(k)
	}
}

/** Did the server end up with what this op asked for (ignoring paths later pushes rewrote)? */
function judge(rec: Record<string, unknown> | undefined, op: RecordOp, later: Set<string>): 'ok' | 'vetoed' | 'deleted-remotely' {
	if (later.has('*')) return 'ok' // superseded; the later push is judged on its own
	if (op[0] === 'remove') return rec ? 'vetoed' : 'ok'
	if (!rec) return op[0] === 'patch' ? 'deleted-remotely' : 'vetoed'
	const checks: Array<[string, () => boolean]> = []
	const add = (path: string, fn: () => boolean) => void (later.has(path) || checks.push([path, fn]))
	if (op[0] === 'put') {
		for (const [k, v] of Object.entries(op[1])) {
			if ((k === 'props' || k === 'meta') && v && typeof v === 'object')
				for (const [k2, v2] of Object.entries(v)) add(`${k}.${k2}`, () => isEqual((rec[k] as Record<string, unknown>)?.[k2], v2))
			else add(k, () => isEqual(rec[k], v))
		}
	} else {
		for (const [k, v] of Object.entries(op[1])) {
			if ((k === 'props' || k === 'meta') && v[0] === 'patch')
				for (const [k2, v2] of Object.entries(v[1])) add(`${k}.${k2}`, () => satisfied((rec[k] as Record<string, unknown>)?.[k2], v2))
			else add(k, () => satisfied(rec[k], v))
		}
	}
	return checks.every(([, fn]) => fn()) ? 'ok' : 'vetoed'
}

function satisfied(cur: unknown, op: ValueOp): boolean {
	switch (op[0]) {
		case 'put':
			return isEqual(cur, op[1])
		case 'delete':
			return cur === undefined
		case 'append': {
			const [, v, offset] = op
			if (typeof cur !== typeof v && !(Array.isArray(cur) && Array.isArray(v))) return false
			const c = cur as string | unknown[]
			return c.length >= offset + v.length && isEqual(c.slice(offset, offset + v.length), v)
		}
		case 'patch':
			return !!cur && typeof cur === 'object' && Object.entries(op[1]).every(([k, o]) => satisfied((cur as Record<string, unknown>)[k], o))
	}
}

function netEmpty(d: RecordsDiff<TLRecord>) {
	for (const _ in d.added) return false
	for (const _ in d.removed) return false
	for (const id in d.updated) {
		const [from, to] = d.updated[id as keyof typeof d.updated]
		if (!isEqual(from, to)) return false
	}
	return true
}
function touches(d: RecordsDiff<TLRecord>, id: string) {
	return id in d.added || id in d.updated || id in d.removed
}

// ------------------------------------------------------------------ connect factory
/**
 * Build a STABLE `connect` for useSync (module level or useMemo: it is an effect dependency).
 * `getUri` is called on every (re)connect, exactly like useSync's `uri` option.
 */
export function createTrackedConnect(getUri: () => string | Promise<string>, opts?: SaveTrackerOptions) {
	const current = atom<SaveTracker | null>('save tracker', null)
	const connect: UseSyncConnectFn = ({ sessionId, storeId }) => {
		const inner = new ClientWebSocketAdapter!(async () => {
			// useSync only appends these for `uri`; with `connect` we must (useSync.ts:284-299).
			const url = new URL(await getUri())
			url.searchParams.set('sessionId', sessionId)
			url.searchParams.set('storeId', storeId)
			return url.toString()
		})
		const tracker = new SaveTracker(storeId, inner, opts)
		current.set(tracker)
		return tracker.socket as TLPersistentClientSocket
	}
	return { connect, current }
}
```

### 5.2 `useSaveStatus.ts` (hook, display smoothing, beforeunload guard)

```ts
import type { RemoteTLStoreWithStatus } from '@tldraw/sync'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { type Atom, useValue } from 'tldraw'
import type { SaveSnapshot, SaveState, SaveTracker } from './saveTracker.ts'

export type DisplayState = SaveState | 'readonly'

const CONNECTING: SaveSnapshot = {
	state: 'connecting',
	readonly: false,
	inFlight: 0,
	unsent: false,
	offlineChanges: false,
	verifying: 0,
	rejection: null,
	lastSavedAt: null,
	errorReason: null,
}
const noSubscribe = () => () => {}
const connecting = () => CONNECTING

export interface SaveStatusOptions {
	/** Keep showing "Saving…" this long after everything is acknowledged (bursts don't flicker). */
	settleMs?: number
	/** Once shown, "Saving…" stays at least this long. */
	minVisibleMs?: number
}

/**
 * Display status for the save indicator. `raw` is the tracker's exact state; `state` only ever
 * delays LEAVING 'saving' (never delays entering it, which would briefly claim "Saved" falsely).
 */
export function useSaveStatus(
	sync: RemoteTLStoreWithStatus,
	current: Atom<SaveTracker | null>,
	{ settleMs = 250, minVisibleMs = 500 }: SaveStatusOptions = {},
): { state: DisplayState; raw: SaveSnapshot } {
	const tracker = useValue('save tracker', () => current.get(), [current])
	const store = sync.status === 'synced-remote' ? sync.store : undefined
	useEffect(() => {
		if (tracker && store && store.id === tracker.storeId) return tracker.attachStore(store)
	}, [tracker, store])
	const raw = useSyncExternalStore(tracker ? tracker.subscribe : noSubscribe, tracker ? tracker.getSnapshot : connecting)

	let state: DisplayState = sync.status === 'error' ? 'error' : raw.state
	if (state === 'saved' && raw.readonly) state = 'readonly'

	const [held, setHeld] = useState(false)
	const since = useRef<number | null>(null)
	useEffect(() => {
		if (state === 'saving') {
			since.current ??= performance.now()
			setHeld(true)
			return
		}
		if (!held) return
		if (state !== 'saved' && state !== 'readonly') {
			since.current = null
			setHeld(false)
			return
		}
		const shown = performance.now() - (since.current ?? 0)
		const t = setTimeout(() => {
			since.current = null
			setHeld(false)
		}, Math.max(settleMs, minVisibleMs - shown))
		return () => clearTimeout(t)
	}, [state, held, settleMs, minVisibleMs])

	// Leaving the page with unacknowledged changes loses them (offline edits live in memory only).
	const unsafe = raw.state === 'saving' || raw.state === 'offline-pending' || (raw.state === 'error' && raw.offlineChanges)
	useEffect(() => {
		if (!unsafe) return
		const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
		addEventListener('beforeunload', onBeforeUnload)
		return () => removeEventListener('beforeunload', onBeforeUnload)
	}, [unsafe])

	return { state: held && (state === 'saved' || state === 'readonly') ? 'saving' : state, raw }
}
```

### 5.3 Wiring in `BoardPage.tsx` (sketch; not applied, since other engineers own `apps/**`)

```tsx
// ticketUri.uri is already stable (useMemo on boardId) and re-evaluated on every reconnect.
const tracked = useMemo(() => createTrackedConnect(ticketUri.uri), [ticketUri])   // stable: effect dependency
const store = useSync({
  connect: tracked.connect,            // replaces `uri` (the wrapper appends sessionId/storeId itself)
  assets, users, shapeUtils: syncShapeUtils,
  getUserPresence: getDraftroomPresence, onCustomMessageReceived,
})
const save = useSaveStatus(store, tracked.current)
// TopBar: render save.state with the labels in §1 (replaces the socket-only 'Live'/'Offline' pill).
// Toast: when save.raw.rejection changes, notify(); the reason is rejection.serverMessage (text-lease-denied, ...)
//        or rejection.records[0].kind ('deleted-remotely'), or save.raw.readonly.
```

The server needs no changes. `push_result` already follows the commit. `apps/sync` already sends `text-lease-denied`, which the tracker attaches as the reason. Other `authorizeRecord` rules should send a similar custom message so the toast can explain itself. The spike's veto rule sends `write-vetoed`.

### 5.4 CI guard (add to the web vitest project)

```ts
import * as tlsync from '@tldraw/sync'
it('save indicator internals still exist', () => {
  expect(typeof (tlsync as any).ClientWebSocketAdapter).toBe('function')   // @internal, runtime export
  expect((tlsync as any).getTlsyncProtocolVersion()).toBe(8)               // @internal, protocol.ts:4
})
```

[run] in Node 24: `ClientWebSocketAdapter: function`, `getTlsyncProtocolVersion(): 8`. The vitest form itself was not run in the repo (UNVERIFIED).

---

## 6. Verified behaviors (Chrome 153, real `TLSocketRoom` + `SQLiteSyncStorage`) [run]

Final run: `results/final-run.txt`, **88/88 checks**. Every scenario ran under React StrictMode (double `connect`). Most scenarios also ran a per-frame **oracle**: it compares the tracker's raw state with the private client state (`unsent`, pending diff pushes not yet answered on the wire, `speculativeChanges`). Result: **0 false "Saved" samples**, and never "Saving…" for more than 1.5 s while the client was idle.

| # | Scenario | Result |
|---|---|---|
| S1 | Solo. Programmatic create, **real mouse drag**, **real typing** into a note (21 chars), reload in a 2nd client | Saving→Saved each time. Drag: mouse-up → Saved **283 ms**. Typing: stays "Saving…" throughout, last key → Saved **399 ms**. The 2nd client sees the shape and the text. Oracle: 0 false Saved. 9/9 |
| S2 | Two users. B moves its cursor for 3 s (179 presence pushes). A drags continuously for 2 s. Server inbound delay 0 / 50 / 150 ms | **Neither indicator changed** during cursor-only activity. A's drag: 360 raw transitions → **one** Saving…→Saved. B's indicator is unaffected by A's remote edits. Ack (push → `push_result`) p50/p95: **9.4/18.9 ms**, 62.8/80.3 ms, 161.8/171.1 ms. Mouse-up → Saved: 257 / 280 / 423 ms. 10/10 at each latency |
| S3a | **WRK-03**: server hard-killed (TerminateProcess), 10 creates while down, restart | `offline` (14 ms after the kill) → **`offline-pending` "Offline — changes will sync"** (held through the failed reconnects) → `saving` → **`saved`**, 1028 ms after the restart. **10/10 rows in SQLite**, and a fresh client sees all 10 |
| S3b | Commit happened, ack lost: 1.5 s outbound delay, killed after the logged `commit` | At the kill: "Saving…". After the restart the first push had **no diff**, and the tracker resolved to Saved with no timer. Record durable |
| S3c | Push sent, never processed: 1.5 s inbound delay, killed | Re-pushed after the restart with the diff, then Saved. Record durable |
| S4a | Create vetoed by `authorizeRecord` (`meta.veto`) | `discard` → **Saving… → Change not saved** (never Saved). Toast shown. Shape reverted. Server reason `write-vetoed` attached. A later edit → Saved |
| S4b | Allowed and vetoed create **in one push** | `rebaseWithDiff`. **Only the vetoed record** reported. The allowed one stays. The hold expires after 8 s → Saved |
| S4c | Patch veto (existing shape) | Warning; `meta` reverted locally |
| S4d | Two users set the same color at once | One `discard` (no-op) → classified **benign**: no warning, both Saved |
| S4e | P deletes, Q moves the same shape | Q: `deleted-remotely` → "…that item was deleted by someone else" |
| S4f | Viewer (`isReadonly`) with the §7 fix: "View only". Forged write via `editor.store.put` | `discard` → warning "you can only view this board". Record reverted |
| S4g | **Text lease** (the Draftroom `lease.ts`): alice types (real keyboard), bob edits the same note's text | Bob: warning with `text-lease-denied` (holder alice), never Saved first. His note shows alice's text. Alice Saved |
| S5 | Viewer push loop (engine) | See §7: 57 discarded pushes in 4 s with the tracker **and without it**; 0 with the fix |
| S6 | Bursts | Solo, 100 shapes moved every frame for 3 s (165 frames): **5 pushes**, 15 raw transitions → one Saving…→Saved, end → Saved 1010 ms. With 2 users: 14 pushes → one cycle, end → Saved 644 ms, peer unaffected. **Chunked** ~1 M-char push: 4 frames, then commit, then Saved. Edit+revert in one task: **0 pushes**, ends Saved (net-empty check) |
| S7 | Latency breakdown for one discrete edit (idle scheduler), 12 edits per row | change → `push_result` p50: solo 56, 2-user 61 (lat 0); 100 / 96 ms (lat 50). Display "Saving…" p50 **543–549 ms** (500 ms minimum) |
| S8 | 4099 `INVALID_RECORD` close; `beforeunload`; overhead | Error → "Not saved — connection ended", never Saved. Leaving while offline-pending → **`beforeunload` dialog**; dismiss keeps the page; after Saved, no prompt. Overhead: 157 vs 161 frames per 3 s (200 shapes/frame), about 2% |
| S9 | 1.5 / 2.5 / 4 s main-thread stall right after a `discard` | Before the two-phase fix: 3/3 **misclassified as benign** (false Saved). After: 4/4 warned |

**How long "Saving…" is typically visible:**

| Situation | Raw (protocol) | Displayed |
|---|---|---|
| One discrete edit, 2+ users, localhost | ~60–90 ms (change → commit) | ~550 ms (500 ms minimum-visible) |
| One discrete edit, solo, idle scheduler | ~56 ms | ~545 ms |
| One edit soon after another, solo (inside the 900 ms window) | p50 ~300 ms, max ~320 | ~580 ms |
| 50 ms injected latency | ~100 ms | ~550 ms |
| Continuous drag or typing | whole interaction | whole interaction + ~250–450 ms (2+ users) or up to ~1 s (solo) |

Knobs: `minVisibleMs` (500) and `settleMs` (250) in `useSaveStatus`, and `verifyAfterMs` (1100) in the tracker. The last one only affects the rare discard/rebase path, which stays "Saving…" for about 1.1 s before it resolves.

---

## 7. Engine finding: read-only sessions loop on their `user:` record

**Mechanism** [src]. The loop runs as follows:
1. `Editor` has `react('sync current user record', () => { const user = users.currentUser.get(); if (user) this._ensureUserRecord(user) })` (`@tldraw/editor Editor.ts:967-973`).
2. `_ensureUserRecord` reads `store.get(user.id)`, which is reactive, and `put`s the user when the record is missing or differs (`:4409-4425`).
3. For a read-only session the server skips the put (`canWrite`) and answers `discard`.
4. The rebase removes the record locally.
5. The reaction fires again, and the cycle repeats.

**Observed** [run], S5, 4 s with a second user present:

| Variant | Pushes | With document diff | Server `discard`s | Indicator |
|---|---|---|---|---|
| tracked, `currentUser` set (what `BoardPage` does today) | 57 | 57 (`user:vic` only) | 57 | Saving… forever |
| **plain `useSync({ uri })`, no tracker** | 57 | 57 | 57 | n/a |
| tracked, **`currentUser: null`** + name/color via `getUserPresence` | 1 | **0** | 0 | **View only**; peers still see the name |

The loop runs at about 14 pushes/s in full mode, and presumably about 1/s when solo, for as long as a viewer or commenter has the board open. Each push is a room transaction. Draftroom's `BoardPage` passes a `currentUser` to every role, so it very likely has this loop today. That was not run against `apps/web` itself (UNVERIFIED there).

**Fix** (verified in the spike). For roles without canvas write:
1. Keep the `users` object stable: it is a `useSync` effect dependency, and changing it reconnects.
2. Make `currentUser` a `computed` that returns `null` when the role is read-only.
3. Put the identity into presence through `getUserPresence`, for example `{ ...getDefaultUserPresence(store, user), userId: createUserId(id), userName: name, color }`.

Viewers cannot edit, so they lose no attribution. The fix also keeps viewer names out of the durable board (see the privacy note on `user:` records in SYNTHESIS §1 #15).

---

## 8. Edge cases and risks

1. **`@internal` surface.** `ClientWebSocketAdapter` (a runtime export) and the protocol v8 message shapes (`TLPushRequest` d.ts:632, `TLSocketClientSentEvent` :766, `TLSocketServerSentEvent` :1332, all excluded from the types) are re-declared locally.
   - Mitigations:
     - the import throws at module load if the class is gone;
     - an outgoing `connect` with `protocolVersion !== 8` switches to `unsupported` ("Live", never "Saved");
     - the CI guard in §5.4;
     - re-running the spike scenarios on every tldraw bump.
   - Fallback if the class is removed: implement `TLPersistentClientSocket` directly with a WebSocket and backoff.
2. **Behavioral assumptions that are not types.** Re-check each on upgrade; the citations are in §3.
   - (a) Sends only go out through the rAF-throttled `sendUnsentChanges`, and a push clears all unsent changes.
   - (b) Presence-only pushes have no `diff`.
   - (c) The first push after `connect` carries the re-pushed stash.
   - (d) The rebase runs on the same scheduler with a budget of 900 ms or less. If tldraw lowers `SOLO_MODE_FPS` (not exported), `verifyAfterMs` must grow. The two-phase check covers stalls, not a longer throttle.
   - (e) `push_result`s arrive in push order.
3. **Chunking.** The wrapper is above it (§3.7), so there is nothing to parse. Limits on the server side:
   - `ws` `maxPayload` is 1 MiB per frame, and chunks are at most 262,144 chars (at most 1 MiB UTF-8).
   - Draftroom's 40-frame cap (`apps/sync/src/app.ts`) closes a push of roughly 10 M+ chars with `INVALID_RECORD`. That is terminal, and the indicator shows `error`.
   - If a future server chunks server-to-client frames inside the adapter, the wrapper still sees parsed objects.
4. **Hidden tabs.** rAF is paused, so tldraw sends nothing and the tracker verifies nothing. Unsent edits stay "Saving…" until the tab is visible again. That is truthful, but a user who closes a hidden tab relies on the `beforeunload` guard. UNVERIFIED in a browser: headless pages stayed `visible`.
5. **One-frame lag.** A change is invisible to every listener, the client included, until the next frame's history flush (`Store.ts:497-505`). The indicator can say "Saved" for up to one frame after an edit. Nobody can see that, but the `beforeunload` effect also attaches one render later.
6. **Solo 900 ms push throttle.** An edit made within about 1 s of closing the tab is lost unless the user answers the `beforeunload` prompt. Chrome shows that prompt only after a user gesture on the page (sticky activation). [run] S8.
7. **Rejection UX.**
   - `rejected` holds for 8 s, or until a later push commits. Continued successful edits therefore flip back to "Saved", while the toast carries the event.
   - `deleted-remotely` is honest but may feel noisy on busy boards; downgrading it to an info toast is a product decision.
   - Undoing a rejected change was not tested (UNVERIFIED).
8. **Server-side normalization.** A server that rewrites a key the client *sent* is reported as a veto. The known cases are an authorizer that modifies values on update, and down/up migration for an older client (SYNTHESIS: `posterDerivativeId` reset). Stamping *new* keys passes. The migration case is UNVERIFIED.
9. **Null presence.** Offline resolution depends on the presence push that `didReconnect` always sends when presence is non-null. With `getUserPresence` returning `null` (a spectator), offline changes the server already had would keep "Saving…" forever. That is fail-safe but stuck. Draftroom presence is never null. UNVERIFIED.
10. **What "Saved" covers.** It covers canvas records only. It does **not** cover:
    - uploads in flight: the asset record commits with `src: ''` before the bytes finish, so combine with the upload queue (for example "Uploading…");
    - comments stored in Postgres;
    - durability beyond a process kill (OS crash and power loss are UNVERIFIED; FEASIBILITY).
11. **Offline edits are in memory only.** A reload while `offline-pending` loses them. The existing banner text stays correct, and the guard prompts.
12. **Several tabs.** Each tab reports only its own changes, which is correct: another tab's unsaved edits are not this tab's.
13. **Cost.** The tracker squashes every user change a second time (the client already does once) and compares values only on the rare discard/rebase path. Measured about 2% frame-rate cost at 200 shapes per frame.

---

## 9. UNVERIFIED

- Hidden or background-tab behavior (§8.4) and frozen-tab resume.
- The §5.3 wiring and the §5.4 vitest guard inside the repo (the spike used the same APIs, but `apps/web` was not modified).
- The viewer loop in `apps/web` itself (same wiring shape as the spike). Its effect on Draftroom's server rate limiter and CPU was not measured.
- Migration-driven `rebaseWithDiff` for an older client (§8.8). A null-presence client (§8.9). Undo of a rejected change.
- Firefox and Safari (Chrome only).
- Real network (latency was injected server-side on localhost). Render disk fsync latency, which adds directly to "Saving…".

## 10. Reproduce

```bash
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"
cd <scratchpad>/spikes/saved-indicator
pnpm install                                  # exact pins: tldraw/@tldraw/* 5.4.2, react 19.3.0, vite 8.3.1, ts 7.0.2, ws 8.21.3, playwright-core 1.63.0
npx tsc -p .                                  # typecheck
node node_modules/vite/bin/vite.js &          # web on 127.0.0.1:5976 (each script starts its own sync server on 5977)
node scripts/s1-solo.mjs; node scripts/s2-collab.mjs 0; node scripts/s2-collab.mjs 150; node scripts/s3-offline.mjs
node scripts/s4-rejections.mjs; node scripts/s5-viewer-loop.mjs; node scripts/s6-bursts.mjs; node scripts/s7-latency.mjs
node scripts/s8-error-unload-perf.mjs; node scripts/s9-stall.mjs   # results/*.json
```

Ports 5960/5961 were already taken by another process during this spike, so it used 5976/5977.
