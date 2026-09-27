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

import type { TLPersistentClientSocket, TLSocketStatusChangeEvent, UseSyncConnectFn } from '@tldraw/sync'
import * as tlsync from '@tldraw/sync'
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
type AdapterCtor = new (
  getUri: () => string | Promise<string>,
) => TLPersistentClientSocket<Outgoing, Incoming>
function requireAdapter(): AdapterCtor {
  const ctor = (tlsync as unknown as { ClientWebSocketAdapter?: AdapterCtor }).ClientWebSocketAdapter
  if (typeof ctor !== 'function')
    throw new Error('@tldraw/sync no longer exports ClientWebSocketAdapter: re-check the saved indicator')
  return ctor
}
const ClientWebSocketAdapter = requireAdapter()

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

  constructor(
    storeId: string,
    inner: TLPersistentClientSocket<Outgoing, Incoming>,
    opts: SaveTrackerOptions = {},
  ) {
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
    this.unlistenStore = store.listen(({ changes }) => this.onLocalChange(changes), {
      source: 'user',
      scope: 'document',
    })
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
    if (diff)
      for (const v of this.verifying) {
        const op = diff[v.id]
        if (op) addPaths(v.writtenLater, op)
      }
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
    const sent = head.diff
    if (!sent) return // presence-only push: never counts as a document save
    this.stats.ackMs.push(now() - head.sentAt)
    const later = this.inflight.filter((p) => p.diff)
    const toVerify = (ids: string[]) => {
      for (const id of ids) {
        const writtenLater = new Set<string>()
        for (const p of later) if (p.diff?.[id]) addPaths(writtenLater, p.diff[id])
        const op = sent[id]
        if (!op) continue
        this.verifying.push({
          id,
          op,
          writtenLater,
          dueAt: now() + this.opts.verifyAfterMs,
          ready: false,
        })
      }
      this.startLoop()
    }
    if (r.action === 'commit') {
      this.stats.commits++
      this.lastSavedAt = Date.now()
      this.rejection = null
    } else if (r.action === 'discard') {
      this.stats.discards++
      toVerify(Object.keys(sent))
    } else {
      this.stats.rebases++
      const applied = r.action.rebaseWithDiff
      const notVerbatim = Object.keys(sent).filter((id) => !isEqual(applied[id], sent[id]))
      if (notVerbatim.length) toVerify(notVerbatim)
      else this.lastSavedAt = Date.now()
    }
    this.opts.onEvent?.({
      ev: 'result',
      clock: r.clientClock,
      action: typeof r.action === 'string' ? r.action : 'rebase',
    })
    this.emit()
  }

  private onLocalChange(changes: RecordsDiff<TLRecord>) {
    this.opts.onEvent?.({ ev: 'local' })
    if (this.phase === 'connected') {
      this.unsent = this.unsent
        ? squashRecordDiffs([this.unsent, changes], { mutateFirstDiff: true })
        : squashRecordDiffs([changes])
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

  private reject(
    id: string,
    op: RecordOp,
    rec: Record<string, unknown> | undefined,
    kind: 'vetoed' | 'deleted-remotely',
  ) {
    this.stats.rejected++
    const typeName = String(
      (rec?.typeName ?? (op[0] === 'put' ? op[1].typeName : id.split(':')[0])) as string,
    )
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
    if ((k === 'props' || k === 'meta') && v[0] === 'patch')
      for (const k2 of Object.keys(v[1])) out.add(`${k}.${k2}`)
    else out.add(k)
  }
}

/** Did the server end up with what this op asked for (ignoring paths later pushes rewrote)? */
function judge(
  rec: Record<string, unknown> | undefined,
  op: RecordOp,
  later: Set<string>,
): 'ok' | 'vetoed' | 'deleted-remotely' {
  if (later.has('*')) return 'ok' // superseded; the later push is judged on its own
  if (op[0] === 'remove') return rec ? 'vetoed' : 'ok'
  if (!rec) return op[0] === 'patch' ? 'deleted-remotely' : 'vetoed'
  const checks: Array<[string, () => boolean]> = []
  const add = (path: string, fn: () => boolean) => void (later.has(path) || checks.push([path, fn]))
  if (op[0] === 'put') {
    for (const [k, v] of Object.entries(op[1])) {
      if ((k === 'props' || k === 'meta') && v && typeof v === 'object')
        for (const [k2, v2] of Object.entries(v))
          add(`${k}.${k2}`, () => isEqual((rec[k] as Record<string, unknown>)?.[k2], v2))
      else add(k, () => isEqual(rec[k], v))
    }
  } else {
    for (const [k, v] of Object.entries(op[1])) {
      if ((k === 'props' || k === 'meta') && v[0] === 'patch')
        for (const [k2, v2] of Object.entries(v[1]))
          add(`${k}.${k2}`, () => satisfied((rec[k] as Record<string, unknown>)?.[k2], v2))
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
      return (
        !!cur &&
        typeof cur === 'object' &&
        Object.entries(op[1]).every(([k, o]) => satisfied((cur as Record<string, unknown>)[k], o))
      )
  }
}

function netEmpty(d: RecordsDiff<TLRecord>) {
  for (const _ in d.added) return false
  for (const _ in d.removed) return false
  for (const id in d.updated) {
    const pair = d.updated[id as keyof typeof d.updated]
    if (pair && !isEqual(pair[0], pair[1])) return false
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
    const inner = new ClientWebSocketAdapter(async () => {
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
