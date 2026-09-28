// A real TLSyncClient (the class useSync drives in the browser) on a Node Store, speaking to the real
// server over a real WebSocket. The socket adapter below replaces ClientWebSocketAdapter so a test
// can see and steer the wire: count push vs push_result, hold outgoing frames to force concurrency,
// go offline on purpose, and record close codes and custom messages.
import type { TicketRole } from '@draftroom/auth-tickets'
import { draftroomSchema } from '@draftroom/canvas-schema'
import {
  type TLPersistentClientSocket,
  type TLPresenceMode,
  type TLSocketStatusChangeEvent,
  TLSyncClient,
} from '@tldraw/sync-core'
import {
  createUserId,
  InstancePresenceRecordType,
  PageRecordType,
  type TLInstancePresence,
  type TLRecord,
  type TLSchema,
  type TLStore,
} from '@tldraw/tlschema'
import { WebSocket } from 'ws'
import type { ShapeRecord } from './records.ts'
import { mintTicket } from './tickets.ts'
import { clientSignals, createAtom, createStore, type MutableSignal } from './tldraw-runtime.ts'
import { waitFor } from './wait.ts'

// Wire types (protocol.ts in sync-core; @internal there, so restated minimally).
export type RecordOp = ['put', unknown] | ['patch', unknown] | ['remove']
export type NetworkDiff = Record<string, RecordOp>
export type PushAction = 'commit' | 'discard' | { rebaseWithDiff: NetworkDiff }
export type DataEvent =
  | { type: 'patch'; diff: NetworkDiff; serverClock: number }
  | { type: 'push_result'; clientClock: number; serverClock: number; action: PushAction }
export type ServerMessage =
  | {
      type: 'connect'
      hydrationType: 'wipe_all' | 'wipe_presence'
      connectRequestId: string
      protocolVersion: number
      serverClock: number
      isReadonly: boolean
      diff: NetworkDiff
    }
  | { type: 'data'; data: DataEvent[] }
  | { type: 'custom'; data: unknown }
  | { type: 'pong' }
  | { type: 'incompatibility_error'; reason: string }
  | DataEvent
export type ClientMessage =
  | {
      type: 'connect'
      connectRequestId: string
      lastServerClock: number
      protocolVersion: number
      schema: unknown
    }
  | { type: 'push'; clientClock: number; diff?: NetworkDiff; presence?: unknown }
  | { type: 'ping' }

export interface CloseRecord {
  code: number
  reason: string
  /** socket generation the close belongs to (1 = first socket) */
  gen: number
}

export interface PushResultRecord {
  clientClock: number
  action: PushAction
  gen: number
  raw: boolean
}

export interface SyncClientOptions {
  /** ws://127.0.0.1:<port> */
  wsUrl: string
  boardId: string
  /**
   * User id (the ticket's uid). With it, a fresh ticket for (boardId, user, role) is minted with the
   * test secret on EVERY (re)connect, like the web client's uri function asking the API.
   */
  user?: string
  /** Role claimed in minted tickets (default editor); change later with setRole(). */
  role?: TicketRole
  /**
   * Overrides minting: a fixed ticket, or a function called on every (re)connect. Without `user`
   * and `ticket` the client connects with no ticket at all.
   */
  ticket?: string | (() => string | undefined)
  /** Extra query parameters on the connect URL (e.g. the retired devUser/devRole, to prove they are ignored). */
  extraQuery?: Record<string, string>
  /** the useSync TAB_ID stand-in; defaults to a random id */
  sessionId?: string
  /** store/client schema; defaults to the shared draftroomSchema */
  schema?: TLSchema
  /** reconnect after a non-terminal close (like useSync does), unless goOffline() blocked it */
  autoReconnect?: boolean
  reconnectDelayMs?: number
  name?: string
}

/**
 * ClientWebSocketAdapter's framing for large messages (sync-core chunk.ts, @internal there): each
 * frame is "<frames still to come>_<slice>", so the last one starts with "0_".
 */
export function chunkFrames(text: string, size: number): string[] {
  const n = Math.ceil(text.length / size)
  return Array.from({ length: n }, (_, i) => `${n - 1 - i}_${text.slice(i * size, (i + 1) * size)}`)
}

// Raw pushes use a clock range TLSyncClient never reaches, so their results can be filtered out
// before TLSyncClient sees a push_result it did not send (it would reset the connection).
const RAW_CLOCK_BASE = 1_000_000_000

let seq = 0

export class NodeSyncClient {
  readonly name: string
  readonly sessionId: string
  /** Every URL this client connected with, in order (tickets included: test-only secrets). */
  readonly connectUrls: string[] = []
  readonly store: TLStore
  readonly presence: MutableSignal<TLRecord | null>
  readonly sent: ClientMessage[] = []
  readonly received: ServerMessage[] = []
  readonly closes: CloseRecord[] = []
  readonly pushResults: PushResultRecord[] = []
  readonly customMessages: unknown[] = []
  readonly syncErrors: string[] = []
  readonly socketErrors: string[] = []
  status: 'offline' | 'online' | 'error' = 'offline'

  private readonly opts: SyncClientOptions
  private readonly client: TLSyncClient<TLRecord, TLStore>
  private readonly messageListeners = new Set<(msg: ServerMessage) => void>()
  private readonly statusListeners = new Set<(ev: TLSocketStatusChangeEvent) => void>()
  private readonly pushResultListeners = new Set<(r: PushResultRecord) => void>()
  private ws: WebSocket | null = null
  private gen = 0
  private syncedGen = -1
  private inflight = 0
  private held: { text: string; isPush: boolean }[] | null = null
  private blocked = false
  private disposed = false
  private terminal = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private rawClock = RAW_CLOCK_BASE
  private readonly rawClocks = new Set<number>()
  private role: TicketRole

  constructor(opts: SyncClientOptions) {
    this.opts = opts
    this.name = opts.name ?? opts.user ?? 'anon'
    this.sessionId =
      opts.sessionId ?? `node-${process.pid}-${++seq}-${Math.random().toString(36).slice(2, 8)}`
    this.role = opts.role ?? 'editor'
    this.store = createStore(opts.schema ?? draftroomSchema)
    this.presence = createAtom<TLRecord | null>(`presence:${this.name}`, null)

    const self = this
    const socket: TLPersistentClientSocket<ClientMessage, ServerMessage> = {
      get connectionStatus() {
        return self.status
      },
      sendMessage: (msg) => this.sendFromClient(msg),
      onReceiveMessage: (cb) => {
        this.messageListeners.add(cb)
        return () => this.messageListeners.delete(cb)
      },
      onStatusChange: (cb) => {
        this.statusListeners.add(cb)
        return () => this.statusListeners.delete(cb)
      },
      // TLSyncClient calls this when it decides the connection is unusable (e.g. a rebase error)
      restart: () => {
        this.closeSocket(1000, 'client restart')
        this.scheduleReconnect(0)
      },
      close: () => this.dispose(),
    }

    this.client = new TLSyncClient<TLRecord, TLStore>({
      store: this.store,
      socket,
      // presenceMode 'full' = what useSync uses once another tab is present; presence is only pushed then
      ...clientSignals(this.presence, createAtom<TLPresenceMode>('presenceMode', 'full')),
      onLoad: () => {},
      onSyncError: (reason) => this.syncErrors.push(reason),
      onCustomMessageReceived: (data) => this.customMessages.push(data),
      onAfterConnect: () => {
        this.syncedGen = this.gen
      },
    })
    this.connect()
  }

  // ---------------------------------------------------------------- connection control

  /** The URL of the most recent connection attempt. */
  get url(): string {
    return this.connectUrls.at(-1) ?? ''
  }

  /** Role for tickets minted from now on (the API would issue the new role after a change). */
  setRole(role: TicketRole): void {
    this.role = role
  }

  private connectUrl(): string {
    const q = new URLSearchParams({ sessionId: this.sessionId })
    const { ticket, user, boardId } = this.opts
    const t =
      typeof ticket === 'function'
        ? ticket()
        : (ticket ?? (user !== undefined ? mintTicket(boardId, user, this.role) : undefined))
    if (t !== undefined) q.set('ticket', t)
    for (const [k, v] of Object.entries(this.opts.extraQuery ?? {})) q.set(k, v)
    const url = `${this.opts.wsUrl}/connect/${boardId}?${q}`
    this.connectUrls.push(url)
    return url
  }

  /** Simulates a network drop that stays down: the socket is closed and reconnects are blocked. */
  goOffline(): void {
    this.blocked = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.closeSocket(1000, 'test: offline')
  }

  goOnline(): void {
    this.blocked = false
    if (!this.ws) this.connect()
  }

  /**
   * Queue outgoing frames instead of sending them (for TLSyncClient they are already in flight).
   * Holding ends when the socket closes; frames still queued then are dropped.
   */
  holdOutgoing(): void {
    this.held ??= []
  }

  /** Send every held frame, in order, on the current socket. */
  releaseOutgoing(): void {
    const queued = this.held ?? []
    this.held = null
    for (const item of queued) this.transmit(item.text, item.isPush)
  }

  get heldCount(): number {
    return this.held?.length ?? 0
  }

  isSynced(): boolean {
    return this.status === 'online' && this.syncedGen === this.gen
  }

  async waitForSynced(timeoutMs = 10_000): Promise<void> {
    await waitFor(() => this.isSynced(), { timeoutMs, describe: () => this.describe('synced') })
  }

  /** Synced, nothing held, and every push sent on this socket has its push_result. */
  async waitForAcked(timeoutMs = 10_000): Promise<void> {
    await waitFor(() => this.isSynced() && this.held === null && this.inflight === 0, {
      timeoutMs,
      describe: () => this.describe('acked'),
    })
  }

  async waitForClose(predicate: (c: CloseRecord) => boolean = () => true, timeoutMs = 10_000) {
    return waitFor(() => this.closes.find(predicate), { timeoutMs, describe: () => this.describe('close') })
  }

  /** Called synchronously as each push_result arrives (before TLSyncClient processes it). */
  onPushResult(cb: (r: PushResultRecord) => void): () => void {
    this.pushResultListeners.add(cb)
    return () => this.pushResultListeners.delete(cb)
  }

  /** clientClock of the most recent push TLSyncClient sent (each store change is one push under NODE_ENV=test). */
  lastPushClock(): number | undefined {
    return this.sentPushes().at(-1)?.clientClock
  }

  /** Sends a push that bypasses TLSyncClient (and therefore client-side validation). */
  sendRawPush(diff: NetworkDiff): number {
    const clientClock = ++this.rawClock
    this.rawClocks.add(clientClock)
    this.transmit(JSON.stringify({ type: 'push', clientClock, diff }), true)
    return clientClock
  }

  /**
   * Sends a presence op (and optionally a document diff) in a push that bypasses TLSyncClient: what a
   * forged client can put on the wire. `chunkSize` splits the frame the way ClientWebSocketAdapter
   * chunks large messages ("<remaining>_<payload>").
   */
  sendRawPresence(presence: unknown, opts: { diff?: NetworkDiff; chunkSize?: number } = {}): number {
    const clientClock = ++this.rawClock
    this.rawClocks.add(clientClock)
    const text = JSON.stringify({ type: 'push', clientClock, diff: opts.diff, presence })
    const frames = opts.chunkSize ? chunkFrames(text, opts.chunkSize) : [text]
    // one push, however many frames: only the last one waits for a push_result
    for (const [i, f] of frames.entries()) this.transmit(f, i === frames.length - 1)
    return clientClock
  }

  setPresence(extra: Partial<TLInstancePresence> = {}): void {
    const user = this.opts.user ?? 'anon'
    this.presence.set(
      InstancePresenceRecordType.create({
        id: InstancePresenceRecordType.createId(this.sessionId),
        currentPageId: PageRecordType.createId('page'),
        userId: createUserId(user),
        userName: user,
        ...extra,
      }),
    )
  }

  /** Permanently closes the client (like unmounting useSync). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.blocked = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.client.close()
    this.closeSocket(1000, 'test: dispose')
  }

  // ---------------------------------------------------------------- local edits (source 'user')
  // Each call is one store change, hence one push while connected (sends are synchronous in test mode).

  put(...records: ShapeRecord[]): void {
    this.store.put(records as unknown as TLRecord[])
  }

  update(id: string, fn: (shape: ShapeRecord) => ShapeRecord): void {
    const current = this.get(id)
    if (!current) throw new Error(`${this.name} has no ${id} to update`)
    this.store.put([fn(current) as unknown as TLRecord])
  }

  remove(...ids: string[]): void {
    this.store.remove(ids as TLRecord['id'][])
  }

  // ---------------------------------------------------------------- queries

  get<T = ShapeRecord>(id: string): T | undefined {
    return this.store.get(id as TLRecord['id']) as T | undefined
  }

  shapes(): ShapeRecord[] {
    return this.store.allRecords().filter((r) => r.typeName === 'shape') as unknown as ShapeRecord[]
  }

  presences(): TLInstancePresence[] {
    return this.store.allRecords().filter((r): r is TLInstancePresence => r.typeName === 'instance_presence')
  }

  sentPushes(): Extract<ClientMessage, { type: 'push' }>[] {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: 'push' }> => m.type === 'push')
  }

  connectEvents(): Extract<ServerMessage, { type: 'connect' }>[] {
    return this.received.filter((m): m is Extract<ServerMessage, { type: 'connect' }> => m.type === 'connect')
  }

  /** The server clock TLSyncClient will send as lastServerClock on its next connect. */
  observedServerClock(): number {
    let clock = -1
    for (const m of this.received) {
      if (m.type === 'connect' || m.type === 'patch' || m.type === 'push_result') clock = m.serverClock
      else if (m.type === 'data') clock = m.data.at(-1)?.serverClock ?? clock
    }
    return clock
  }

  get socketGeneration(): number {
    return this.gen
  }

  describe(what: string): string {
    return `${this.name} waiting for ${what}: status=${this.status} gen=${this.gen} syncedGen=${this.syncedGen} inflight=${this.inflight} held=${this.heldCount} closes=${JSON.stringify(this.closes)} syncErrors=${JSON.stringify(this.syncErrors)} socketErrors=${JSON.stringify(this.socketErrors.slice(-3))}`
  }

  // ---------------------------------------------------------------- socket plumbing

  private connect(): void {
    if (this.disposed || this.blocked || this.terminal) return
    const gen = ++this.gen
    const ws = new WebSocket(this.connectUrl())
    this.ws = ws
    ws.on('open', () => {
      if (this.ws !== ws) return
      this.inflight = 0
      this.setStatus({ status: 'online' })
    })
    ws.on('message', (data) => {
      if (this.ws !== ws) return // orphaned socket, like ClientWebSocketAdapter
      const msg = JSON.parse(String(data)) as ServerMessage
      this.received.push(msg)
      const forClient = this.accountFor(msg, gen)
      if (forClient) for (const cb of this.messageListeners) cb(forClient)
    })
    ws.on('error', (err) => {
      this.socketErrors.push(err.message)
    })
    ws.on('close', (code, reasonBuf) => {
      this.closes.push({ code, reason: reasonBuf.toString(), gen })
      if (this.ws !== ws) return
      this.ws = null
      this.held = null // frames queued for a dead socket are lost, as on a real network; holding ends
      if (code === 4099) {
        this.terminal = true
        this.setStatus({ status: 'error', reason: reasonBuf.toString() || 'UNKNOWN_ERROR' })
      } else {
        this.setStatus({ status: 'offline' })
        this.scheduleReconnect(this.opts.reconnectDelayMs ?? 100)
      }
    })
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.opts.autoReconnect === false || this.disposed || this.blocked || this.terminal) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.ws) this.connect()
    }, delayMs)
  }

  /** Orphans the socket immediately (its late events are ignored) and reports offline. */
  private closeSocket(code: number, reason: string): void {
    const ws = this.ws
    if (!ws) return
    this.ws = null
    this.held = null
    ws.close(code, reason)
    this.setStatus({ status: 'offline' })
  }

  private setStatus(ev: TLSocketStatusChangeEvent): void {
    // mirrors ClientWebSocketAdapter._handleDisconnect: no 'error' once already offline
    if (this.status === ev.status || (ev.status === 'error' && this.status === 'offline')) return
    this.status = ev.status
    for (const cb of this.statusListeners) cb(ev)
  }

  private sendFromClient(msg: ClientMessage): void {
    if (!this.ws || this.status !== 'online') return
    this.sent.push(msg)
    this.transmit(JSON.stringify(msg), msg.type === 'push')
  }

  private transmit(text: string, isPush: boolean): void {
    // ClientWebSocketAdapter chunks frames above 256 Ki UTF-16 units; tests stay below that.
    if (text.length > 262_144) throw new Error('NodeSyncClient does not chunk; message too large for a test')
    if (this.held) {
      this.held.push({ text, isPush })
      return
    }
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(text)
    if (isPush) this.inflight++
  }

  /** Counts push_results for this socket and strips the ones answering raw pushes. */
  private accountFor(msg: ServerMessage, gen: number): ServerMessage | null {
    const events: DataEvent[] = msg.type === 'data' ? msg.data : msg.type === 'push_result' ? [msg] : []
    let strippedAny = false
    const keep = events.filter((e) => {
      if (e.type !== 'push_result') return true
      this.inflight--
      const raw = this.rawClocks.has(e.clientClock)
      const record = { clientClock: e.clientClock, action: e.action, gen, raw }
      this.pushResults.push(record)
      for (const cb of this.pushResultListeners) cb(record)
      if (raw) strippedAny = true
      return !raw
    })
    if (!strippedAny) return msg
    if (msg.type === 'push_result') return null
    return keep.length ? { type: 'data', data: keep } : null
  }
}
