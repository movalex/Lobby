// A raw WebSocket speaker of the Excalidraw-engine protocol (packages/canvas-schema protocol.ts, §2.4.2) for
// protocol tests against the REAL server process. It opens `/connect/:boardId?sessionId=` with the ticket
// in the offered subprotocol (as browsers send it since L7; `ticketIn: 'url'` for the old `?ticket=`), says
// hello, keeps the server's copy of every element (the gzip snapshot, catch-ups and `changes`, applied with
// canvas-schema's `overlayPatch`), and validates EVERY server message with the frozen schemas (a message
// that does not match is recorded in `schemaErrors`, and the harness self-test fails on any). It sends
// exactly what a test gives it, so it can also forge frames (the negative security suite).
//
// For "the client code browsers run" use the headless client instead (ElementStack.headless, O2's engine
// core on a Map scene); this client is for what no well-behaved client sends.

import type { TicketRole } from '@draftroom/auth-tickets'
import { overlayPatch } from '@draftroom/canvas-schema/groups'
import { hashElements } from '@draftroom/canvas-schema/hash'
import {
  type Ack,
  type AckResult,
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
import type { El } from './elements.ts'
import { boardSocketTarget, mintTicket, type TicketIn } from './tickets.ts'

export interface ProtocolClientOptions {
  readonly wsUrl: string
  readonly boardId: string
  /** the ticket's uid (the test user id) */
  readonly user: string
  readonly role?: TicketRole
  readonly guest?: boolean
  /** the connect URL's sessionId (default `tab-<user>`) */
  readonly tab?: string
  /** a ticket to use as is (forgeries); default: a correctly signed one */
  readonly ticket?: string
  /** where the ticket goes (default: the offered subprotocol, as browsers send it; tickets.ts) */
  readonly ticketIn?: TicketIn
  /** say hello on open (default true) */
  readonly hello?: boolean
  readonly since?: number
  readonly epoch?: string | null
  /** the elements this client already holds (a reconnect with `since`) */
  readonly confirmed?: ReadonlyMap<string, El>
  /**
   * More connect URL parameters, e.g. `{ rev: '12' }` (CONTRACTS_REV 12: the revision the client reads,
   * canvas-schema CONNECT_REV_PARAM). Without `rev` the room reads this client as an older one (rev 11).
   */
  readonly query?: Readonly<Record<string, string>>
  /**
   * The schemas this client parses every server frame with, as its build would (default: this tree's). The
   * stale-pair tests give it a previous build's, frozen (packages/canvas-schema/test/fixtures/): a frame that
   * build's socket would drop lands in `schemaErrors` and is not applied, as that socket drops it.
   */
  readonly schemas?: FrameSchemas
}

/** How a client build parses server frames (its `ServerMessage`, and the gzip snapshot's decoder). */
export interface FrameSchemas {
  readonly ServerMessage: {
    safeParse(
      v: unknown,
    ): { success: true; data: unknown } | { success: false; error: { issues: { message: string }[] } }
  }
  readonly decodeSnapshotFrame: (
    bytes: Uint8Array,
  ) => Promise<{ epoch: string; clock: number; elements: readonly unknown[] }>
}

/** A signed test ticket for `user` on `boardId` (the harness secret; `name` = `<user>-name`). */
export const elementTicket = (boardId: string, user: string, role: TicketRole = 'editor', guest = false) =>
  mintTicket(boardId, user, role, { name: `${user}-name`, guest })

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

export type PatchBody = {
  g?: Record<string, Record<string, unknown>>
  c?: Record<string, unknown>
  b?: { add: { id: string; type: 'arrow' | 'text' }[]; rm: string[] }
  fit?: Record<string, number>
  off?: number
  /** the version the patch is based on (default: this client's copy) */
  pv?: number
}

export class ProtocolClient {
  readonly ws: WebSocket
  readonly user: string
  readonly boardId: string
  readonly tab: string
  /** every parsed server message, in order */
  readonly received: ServerMessage[] = []
  /** raw text frames, in order */
  readonly rawFrames: string[] = []
  /** the server's copy of every element this client has seen (tombstones included) */
  readonly confirmed = new Map<string, El>()
  /** server messages that failed the frozen schema (must stay empty) */
  readonly schemaErrors: string[] = []
  clock = 0
  epoch: string | null = null
  welcome: Welcome | null = null
  closeCode: number | null = null
  closeReason = ''
  readonly opened: Promise<void>
  private readonly closedP: Promise<void>
  private seq = 0
  private req = 0
  private welcomeDone = false
  private inbound: Promise<void> = Promise.resolve()
  private readonly waiters: { test: () => boolean; resolve: () => void }[] = []
  private readonly schemas: FrameSchemas

  constructor(opts: ProtocolClientOptions) {
    this.schemas = opts.schemas ?? {
      ServerMessage: ServerMessageSchema as FrameSchemas['ServerMessage'],
      decodeSnapshotFrame,
    }
    this.user = opts.user
    this.boardId = opts.boardId
    this.tab = opts.tab ?? `tab-${opts.user}`
    for (const [k, v] of opts.confirmed ?? []) this.confirmed.set(k, structuredClone(v))
    if (opts.since) this.clock = opts.since
    const ticket = opts.ticket ?? elementTicket(opts.boardId, opts.user, opts.role, opts.guest)
    const target = boardSocketTarget(
      `${opts.wsUrl}/connect/${encodeURIComponent(opts.boardId)}?${new URLSearchParams({ ...opts.query, sessionId: this.tab })}`,
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
          this.notify()
        })
    })
  }

  static async connect(opts: ProtocolClientOptions): Promise<ProtocolClient> {
    const c = new ProtocolClient(opts)
    await within(c.opened, 'open')
    if (opts.hello !== false) await c.hello(opts.since ?? 0, opts.epoch ?? null)
    return c
  }

  /** Sends a message or any string as is. */
  send(msg: unknown): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }

  /**
   * Says hello and resolves once the room has sent everything it answers a hello with, which ends with its
   * `contracts` frame (element-room.ts `hello`): a joiner served a REUSED snapshot (SNAPSHOT_REUSE) gets the
   * welcome at the snapshot's clock, the snapshot, then a `changes` frame with the rows written since it, and
   * resolving on the snapshot alone could hand a test the joiner's copy before that catch-up landed (the same
   * fix as element-room/support/client.ts).
   */
  async hello(since = 0, epoch: string | null = null): Promise<Welcome> {
    const count = this.of('welcome').length
    const contracts = this.of('contracts').length
    this.welcomeDone = false
    this.send({ type: 'hello', proto: PROTO, schema: ELEMENT_SCHEMA_VERSION, since, epoch, tab: this.tab })
    await this.until(
      () => this.of('welcome').length > count && this.welcomeDone && this.of('contracts').length > contracts,
      'welcome',
    )
    return this.welcome as Welcome
  }

  /** Sends a push now; `ack` resolves with its answer. */
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

  /** Creates `els` in one push. */
  create(els: readonly El[]): Promise<Ack> {
    return this.push(els.map((el) => ({ k: 'c', el: structuredClone(el) })))
  }

  /** A patch op on `id`, based on this client's copy unless `pv` is given. */
  patchOp(id: string, body: PatchBody): Record<string, unknown> {
    const { pv, ...rest } = body
    return { k: 'p', id, pv: pv ?? this.confirmed.get(id)?.version ?? 1, ...rest }
  }

  /** Pushes one op and returns its result. */
  async one(op: unknown, opts: { base?: number; doc?: unknown } = {}): Promise<AckResult> {
    const ack = await this.push([op], opts)
    return ack.r[0] as AckResult
  }

  /** Creates one element and returns its result. */
  createOne(el: El): Promise<AckResult> {
    return this.one({ k: 'c', el: structuredClone(el) })
  }

  /** Patches one element and returns its result. */
  patch(id: string, body: PatchBody): Promise<AckResult> {
    return this.one(this.patchOp(id, body))
  }

  ackOf(seq: number): Promise<Ack> {
    return this.until(() => this.of('ack').some((m) => m.seq === seq), `ack ${seq}`).then(
      () => this.of('ack').find((m) => m.seq === seq) as Ack,
    )
  }

  acquire(id: string): Promise<LeaseGrant | LeaseDeny> {
    const req = ++this.req
    this.send({ type: 'lease.acquire', req, id })
    const answer = () =>
      this.received.find((m) => (m.type === 'lease.grant' || m.type === 'lease.deny') && m.req === req) as
        | LeaseGrant
        | LeaseDeny
        | undefined
    return this.until(() => answer() !== undefined, `lease ${id}`).then(
      () => answer() as LeaseGrant | LeaseDeny,
    )
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

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }

  /** The convergence hash of this client's map (canvas-schema hash.ts; tombstones included). */
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
      this.confirmed.set(op.el.id, structuredClone(op.el) as El)
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
      const frame = await this.schemas.decodeSnapshotFrame(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      )
      this.confirmed.clear()
      for (const el of frame.elements as El[]) this.confirmed.set(el.id, structuredClone(el) as El)
      this.epoch = frame.epoch
      this.clock = frame.clock
      this.welcomeDone = true
      this.notify()
      return
    }
    const text = data.toString('utf8')
    this.rawFrames.push(text)
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      this.schemaErrors.push(`a text frame is not JSON (${text.length} chars)`)
      return this.notify()
    }
    const parsed = this.schemas.ServerMessage.safeParse(json)
    if (!parsed.success) {
      this.schemaErrors.push(`${(json as { type?: string }).type}: ${parsed.error.issues[0]?.message}`)
      return this.notify()
    }
    const msg = parsed.data as ServerMessage
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
