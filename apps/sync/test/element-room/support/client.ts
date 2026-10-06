// A raw WebSocket speaker of the ElementRoom protocol (packages/canvas-schema protocol.ts) for the room's
// protocol tests against the REAL server process: it opens `/connect/:boardId?sessionId=` with the ticket in
// the offered subprotocol (as browsers send it since L7; `ticketIn: 'url'` for the old `?ticket=`), says
// hello, keeps the server's copy of every element (the gzip snapshot, catch-ups and `changes`, applied
// with canvas-schema's `overlayPatch`), and validates EVERY server message with the frozen schemas. It
// pushes exactly what a test gives it, so it can also forge frames (B5, B6). O2's headless client (the
// engine core) replaces it in wave 2; nothing of O2's is used here.

import { signTicket, type TicketRole } from '@draftroom/auth-tickets'
import { overlayPatch } from '@draftroom/canvas-schema/groups'
import { hashElements } from '@draftroom/canvas-schema/hash'
import {
  type Ack,
  decodeSnapshotFrame,
  ELEMENT_SCHEMA_VERSION,
  type LeaseDeny,
  type LeaseGrant,
  PROTO,
  type ServerMessage,
  ServerMessage as ServerMessageSchema,
  type ServerOp,
  type Welcome,
} from '@draftroom/canvas-schema/protocol'
import WebSocket from 'ws'
import { boardSocketTarget, TEST_TICKET_SECRET, type TicketIn } from '../../harness/tickets.ts'
import type { El } from './elements.ts'

export interface ClientOptions {
  readonly wsUrl: string
  readonly boardId: string
  readonly user: string
  readonly role?: TicketRole
  readonly guest?: boolean
  readonly tab?: string
  /** a ticket to use as is (forgeries) */
  readonly ticket?: string
  /** where the ticket goes (default: the offered subprotocol, as browsers send it; harness/tickets.ts) */
  readonly ticketIn?: TicketIn
  /** say hello on open (default true) */
  readonly hello?: boolean
  readonly since?: number
  readonly epoch?: string | null
  /** the elements this client already holds (a reconnect with `since`) */
  readonly confirmed?: ReadonlyMap<string, El>
}

export const ticketFor = (boardId: string, user: string, role: TicketRole = 'editor', guest = false) =>
  signTicket(TEST_TICKET_SECRET, {
    bid: boardId,
    uid: user,
    name: `${user}-name`,
    color: '#1971c2',
    role,
    ...(guest ? { guest: true } : {}),
  }).ticket

const within = async <T>(p: Promise<T>, what: string, ms = 20_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no ${what} within ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export class RawClient {
  readonly ws: WebSocket
  readonly user: string
  readonly boardId: string
  readonly tab: string
  /** every parsed server message, in order */
  readonly received: ServerMessage[] = []
  /** raw text frames, in order (for "one serialization" checks) */
  readonly rawFrames: string[] = []
  readonly confirmed = new Map<string, El>()
  clock = 0
  epoch: string | null = null
  welcome: Welcome | null = null
  closeCode: number | null = null
  closeReason = ''
  schemaErrors: string[] = []
  private seq = 0
  private req = 0
  private inbound: Promise<void> = Promise.resolve()
  private readonly waiters: { test: () => boolean; resolve: () => void }[] = []
  readonly opened: Promise<void>
  readonly closedP: Promise<void>

  constructor(opts: ClientOptions) {
    this.user = opts.user
    this.boardId = opts.boardId
    this.tab = opts.tab ?? `tab-${opts.user}`
    for (const [k, v] of opts.confirmed ?? []) this.confirmed.set(k, JSON.parse(JSON.stringify(v)))
    if (opts.since) this.clock = opts.since
    const ticket =
      opts.ticket ?? ticketFor(opts.boardId, opts.user, opts.role ?? 'editor', opts.guest ?? false)
    const target = boardSocketTarget(
      `${opts.wsUrl}/connect/${opts.boardId}?sessionId=${encodeURIComponent(this.tab)}`,
      ticket,
      opts.ticketIn,
    )
    this.ws = target.protocols ? new WebSocket(target.url, target.protocols) : new WebSocket(target.url)
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve())
      this.ws.once('error', reject)
    })
    this.closedP = new Promise((resolve) => {
      this.ws.once('close', (code, reason) => {
        this.closeCode = code
        this.closeReason = reason.toString()
        this.notify()
        resolve()
      })
    })
    this.ws.on('message', (data, isBinary) => {
      this.inbound = this.inbound
        .then(() => this.receive(data as Buffer, isBinary))
        .catch((e: Error) => {
          this.schemaErrors.push(e.message)
        })
    })
  }

  static async connect(opts: ClientOptions): Promise<RawClient> {
    const c = new RawClient(opts)
    await within(c.opened, 'open')
    if (opts.hello !== false) await c.hello(opts.since ?? 0, opts.epoch ?? null)
    return c
  }

  send(msg: unknown): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }

  /**
   * Says hello and resolves once the room has sent everything it answers a hello with, which ends with its
   * `contracts` frame (element-room.ts `hello`). The welcome alone is not enough: a joiner served a REUSED
   * snapshot (SNAPSHOT_REUSE, up to 60 s and 500 rows old) gets the welcome at the snapshot's clock, the
   * snapshot, and then a `changes` frame with the rows written since it. Resolving on the snapshot let a test
   * read the joiner's elements before that catch-up landed whenever the frame came in after the snapshot's
   * gunzip finished (bound-arrows.test.ts read `confirmed.get('A')` as undefined on Linux, 2 vCPUs).
   */
  async hello(since = 0, epoch: string | null = null): Promise<Welcome> {
    const count = this.received.filter((m) => m.type === 'welcome').length
    const contracts = this.of('contracts').length
    this.welcomeDone = false
    this.send({ type: 'hello', proto: PROTO, schema: ELEMENT_SCHEMA_VERSION, since, epoch, tab: this.tab })
    await this.until(
      () =>
        this.received.filter((m) => m.type === 'welcome').length > count &&
        this.welcomeDone &&
        this.of('contracts').length > contracts,
      'welcome',
    )
    return this.welcome as Welcome
  }
  private welcomeDone = false

  /** Sends a push; resolves with its ack. */
  pushNow(
    ops: readonly unknown[],
    opts: { base?: number; doc?: unknown } = {},
  ): { seq: number; ack: Promise<Ack> } {
    const seq = ++this.seq
    this.send({
      type: 'push',
      seq,
      base: opts.base ?? this.clock,
      ops,
      ...(opts.doc !== undefined ? { doc: opts.doc } : {}),
    })
    return { seq, ack: this.ackOf(seq) }
  }
  /** Sends a push and waits for its ack and for this client to have seen the ack's clock. */
  async push(ops: readonly unknown[], opts: { base?: number; doc?: unknown } = {}): Promise<Ack> {
    const ack = await this.pushNow(ops, opts).ack
    await this.untilClock(ack.clock)
    return ack
  }
  create(els: readonly El[]): Promise<Ack> {
    return this.push(els.map((el) => ({ k: 'c', el: JSON.parse(JSON.stringify(el)) })))
  }
  ackOf(seq: number): Promise<Ack> {
    return this.until(() => this.received.some((m) => m.type === 'ack' && m.seq === seq), `ack ${seq}`).then(
      () => this.received.find((m) => m.type === 'ack' && m.seq === seq) as Ack,
    )
  }

  acquireNow(id: string): { req: number; answer: Promise<LeaseGrant | LeaseDeny> } {
    const req = ++this.req
    this.send({ type: 'lease.acquire', req, id })
    const answer = this.until(
      () => this.received.some((m) => (m.type === 'lease.grant' || m.type === 'lease.deny') && m.req === req),
      `lease ${id}`,
    ).then(
      () =>
        this.received.find((m) => (m.type === 'lease.grant' || m.type === 'lease.deny') && m.req === req) as
          | LeaseGrant
          | LeaseDeny,
    )
    return { req, answer }
  }
  acquire(id: string): Promise<LeaseGrant | LeaseDeny> {
    return this.acquireNow(id).answer
  }
  release(id: string): void {
    this.send({ type: 'lease.release', id })
  }
  presence(
    p: Partial<{
      pointer: { x: number; y: number } | null
      sel: unknown
      editing: string | null
      drag: unknown
      view: unknown
    }> = {},
  ): void {
    this.send({
      type: 'presence',
      pointer: p.pointer === undefined ? { x: 1, y: 1 } : p.pointer,
      button: 'up',
      sel: p.sel ?? [],
      view: p.view ?? null,
      idle: false,
      editing: p.editing ?? null,
      ...(p.drag !== undefined ? { drag: p.drag } : {}),
    })
  }

  untilClock(clock: number): Promise<void> {
    return this.until(() => this.clock >= clock, `clock ${clock}`)
  }
  /** Waits until `test` holds (checked after every message and on close). */
  until(test: () => boolean, what: string, ms = 20_000): Promise<void> {
    if (test()) return Promise.resolve()
    return within(
      new Promise<void>((resolve) => {
        this.waiters.push({ test, resolve })
      }),
      `${this.user}: ${what}`,
      ms,
    )
  }
  /** Messages of one type received so far. */
  of<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.received.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[]
  }
  async untilClosed(ms = 20_000): Promise<{ code: number | null; reason: string }> {
    await within(this.closedP, `${this.user}: close`, ms)
    return { code: this.closeCode, reason: this.closeReason }
  }

  hash(): Promise<string> {
    return hashElements(this.confirmed.values())
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // already closed
    }
  }
  terminate(): void {
    this.ws.terminate()
  }

  private notify(): void {
    for (const w of [...this.waiters])
      if (w.test()) {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        w.resolve()
      }
  }

  private applyOp(op: ServerOp): void {
    if (op.k === 'c') {
      this.confirmed.set(op.el.id, JSON.parse(JSON.stringify(op.el)))
      return
    }
    const cur = this.confirmed.get(op.id)
    if (!cur) throw new Error(`${this.user}: a patch for unknown ${op.id}`)
    if (cur.version !== op.pv)
      throw new Error(`${this.user}: patch for ${op.id} at pv ${op.pv}, held ${cur.version}`)
    const next = overlayPatch(cur, { g: op.g, c: op.c, b: op.b, lobbyServer: op.lobbyServer })
    this.confirmed.set(op.id, { ...next, version: op.v, versionNonce: op.vn, updated: op.updated })
  }

  private async receive(data: Buffer, isBinary: boolean): Promise<void> {
    if (isBinary) {
      const frame = await decodeSnapshotFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      this.confirmed.clear()
      for (const el of frame.elements) this.confirmed.set(el.id, JSON.parse(JSON.stringify(el)))
      this.epoch = frame.epoch
      this.clock = frame.clock
      this.welcomeDone = true
      this.notify()
      return
    }
    const text = data.toString('utf8')
    this.rawFrames.push(text)
    const parsed = ServerMessageSchema.safeParse(JSON.parse(text))
    if (!parsed.success) {
      this.schemaErrors.push(`${JSON.parse(text).type}: ${parsed.error.issues[0]?.message}`)
      this.notify()
      return
    }
    const msg = parsed.data
    this.received.push(msg)
    if (msg.type === 'welcome') {
      this.welcome = msg
      this.epoch = msg.epoch
      if (!msg.reset) {
        for (const op of msg.catchUp ?? []) this.applyOp(op)
        this.clock = msg.clock
        this.welcomeDone = true
      }
    } else if (msg.type === 'changes') {
      for (const op of msg.ops) this.applyOp(op)
      this.clock = Math.max(this.clock, msg.clock)
    }
    this.notify()
  }
}
