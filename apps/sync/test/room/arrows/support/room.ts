// The SERVER side of the arrow acceptance tests: O1's real ElementRoom, in-process, on a temporary data
// dir, reached through the frozen seam of engine-switch.ts (`registerElementRoom`, `connect`) and the
// test hooks (test-hooks.ts `snapshot`). Nothing of O2's is used: the client is `TestClient` below, a
// minimal speaker of the frozen protocol (packages/canvas-schema protocol.ts) that validates every server
// message with the frozen schemas. Frozen with the tests (lead-owned).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fieldGroupOf, overlayPatch, pathUnitOf } from '@draftroom/canvas-schema/groups'
import {
  type Ack,
  type ClientMessage,
  decodeSnapshotFrame,
  ELEMENT_SCHEMA_VERSION,
  type LeaseDeny,
  type LeaseGrant,
  type Op,
  PROTO,
  type ServerMessage,
  ServerMessage as ServerMessageSchema,
  type ServerOp,
  type TestSnapshot,
  type Welcome,
} from '@draftroom/canvas-schema/protocol'
import '../../../../src/room/index.ts' // registers O1's ElementRoom (engine-switch.ts registerElementRoom)
import { loadConfig } from '../../../../src/config.ts'
import { type ElementRoomService, registeredElementRoom } from '../../../../src/engine-switch.ts'
import { testHooks } from '../../../../src/test-hooks.ts'
import { TEST_INTERNAL_SECRET, TEST_TICKET_SECRET } from '../../../harness/tickets.ts'
import { clone, type El, type Scene } from './excalidraw.ts'

export interface Room {
  readonly service: ElementRoomService
  readonly boardId: string
  /** a signed-in editor session on this board (`name` becomes the uid and the tab) */
  client(name: string): Promise<TestClient>
  /** the test snapshot (live elements and tombstones) as a map */
  stored(): Promise<Scene>
  snapshot(): Promise<TestSnapshot>
}

export interface RoomService {
  /** a room for one board of this service (each scenario uses its own board) */
  board(boardId: string): Room
  close(): Promise<void>
  /** the service's log lines (ids only) */
  readonly logs: string[]
}

/** O1's service on a fresh temp data dir, with DRAFTROOM_ENGINE=excalidraw and DRAFTROOM_TEST_HOOKS=1. */
export async function openRoomService(): Promise<RoomService> {
  const factory = registeredElementRoom()
  if (!factory) throw new Error('apps/sync/src/room/index.ts did not register an ElementRoom')
  const dir = mkdtempSync(join(tmpdir(), 'dr-arrows-'))
  const config = loadConfig({
    DRAFTROOM_TICKET_SECRET: TEST_TICKET_SECRET,
    DRAFTROOM_INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    DRAFTROOM_DATA_DIR: dir,
    DRAFTROOM_ENGINE: 'excalidraw',
    DRAFTROOM_TEST_HOOKS: '1',
    DRAFTROOM_REACTIONS: 'on',
    DRAFTROOM_PLANNING: 'on',
    IDLE_EVICT_MS: '600000',
  })
  const logs: string[] = []
  let service: ElementRoomService
  try {
    service = factory({
      dataDir: join(dir, 'rooms'),
      config,
      log: (...a) => logs.push(a.map(String).join(' ')),
      fileRefs: async (_b, ids) => ({ ok: [], foreign: [], missing: [...ids] }),
      workshopState: async () => ({ voteOpen: false, anonymous: false }),
      onSessionRemoved: () => {},
      onDocumentChange: () => {},
    })
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
  const clients: TestClient[] = []
  return {
    logs,
    board(boardId) {
      const snapshot = async () => {
        const hooks = testHooks()
        if (!hooks)
          throw new Error('the ElementRoom did not register its test hooks (DRAFTROOM_TEST_HOOKS=1)')
        const snap = await hooks.snapshot(boardId)
        if (!snap) throw new Error(`no test snapshot for ${boardId}`)
        return snap
      }
      return {
        service,
        boardId,
        async client(name) {
          const c = new TestClient(service, boardId, name)
          clients.push(c)
          await c.connect()
          return c
        },
        snapshot,
        async stored() {
          return new Map((await snapshot()).elements.map((e) => [e.id, clone(e) as El]))
        },
      }
    },
    async close() {
      for (const c of clients) c.close()
      await service.closeAll()
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    },
  }
}

/** A minimal protocol client: welcome/snapshot/changes/ack, pushes of ops it is given, the text lease. */
export class TestClient {
  readonly name: string
  readonly uid: string
  /** the server's copy of every element (tombstones included), as `changes` and the snapshot say */
  readonly confirmed: Scene = new Map()
  clock = 0
  epoch: string | null = null
  welcome: Welcome | null = null
  private readonly handle: ReturnType<ElementRoomService['connect']>
  private seq = 0
  private req = 0
  private inbound: Promise<void> = Promise.resolve()
  private readonly acks = new Map<number, (a: Ack) => void>()
  private readonly leaseWaiters = new Map<number, (m: LeaseGrant | LeaseDeny) => void>()
  private readonly clockWaiters: { clock: number; resolve: () => void }[] = []
  private welcomed!: () => void
  private readonly welcomedP = new Promise<void>((r) => {
    this.welcomed = r
  })
  private error: Error | null = null
  closed = false

  constructor(service: ElementRoomService, boardId: string, name: string) {
    this.name = name
    this.uid = `usr_${name.padEnd(10, '0')}`.slice(0, 40)
    const sid = `${this.uid}:${name}`
    this.handle = service.connect(
      {
        boardId,
        sid,
        uid: this.uid,
        name,
        color: '#1971c2',
        role: 'editor',
        guest: false,
        readonly: false,
        ticketIssuedAt: Date.now(),
      },
      {
        send: (data) => {
          this.inbound = this.inbound
            .then(() => this.receive(data))
            .catch((e: Error) => {
              this.error = e
            })
        },
        close: () => {
          this.closed = true
        },
        readyState: 1,
        bufferedAmount: 0,
      },
    )
  }

  async connect(): Promise<Welcome> {
    this.send({
      type: 'hello',
      proto: PROTO,
      schema: ELEMENT_SCHEMA_VERSION,
      since: 0,
      epoch: null,
      tab: this.name,
    })
    await this.within(this.welcomedP, 'welcome')
    return this.welcome as Welcome
  }

  send(msg: ClientMessage | Record<string, unknown>): void {
    this.handle.message(JSON.stringify(msg))
  }

  /** A clone of the confirmed scene: the client's local copy to edit with Excalidraw's helpers. */
  copy(): Scene {
    const m: Scene = new Map()
    for (const [k, v] of this.confirmed) m.set(k, clone(v))
    return m
  }

  /** Sends a push now (base = `base`, default this client's clock) and returns a promise of its ack. */
  pushNow(
    ops: readonly (Op | Record<string, unknown>)[],
    base = this.clock,
  ): { seq: number; ack: Promise<Ack> } {
    const seq = ++this.seq
    const ack = new Promise<Ack>((r) => this.acks.set(seq, r))
    this.send({ type: 'push', seq, base, ops })
    return { seq, ack: this.within(ack, `ack ${seq}`) }
  }
  /** Sends a push and waits for its ack and for this client's clock to reach the ack's clock. */
  async push(ops: readonly (Op | Record<string, unknown>)[], base = this.clock): Promise<Ack> {
    const ack = await this.pushNow(ops, base).ack
    await this.untilClock(ack.clock)
    return ack
  }
  /** Creates elements (one push, `c` ops). */
  create(elements: readonly El[]): Promise<Ack> {
    return this.push(elements.map((el) => ({ k: 'c', el: JSON.parse(JSON.stringify(el)) })))
  }

  async acquire(id: string): Promise<LeaseGrant | LeaseDeny> {
    const req = ++this.req
    const p = new Promise<LeaseGrant | LeaseDeny>((r) => this.leaseWaiters.set(req, r))
    this.send({ type: 'lease.acquire', req, id })
    return this.within(p, `lease ${id}`)
  }

  untilClock(clock: number): Promise<void> {
    if (this.clock >= clock) return Promise.resolve()
    return this.within(
      new Promise<void>((resolve) => this.clockWaiters.push({ clock, resolve })),
      `clock ${clock}`,
    )
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.handle.closed()
  }

  private async within<T>(p: Promise<T>, what: string, ms = 30_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(this.error ?? new Error(`${this.name}: no ${what} within ${ms} ms`)),
        ms,
      )
    })
    try {
      return await Promise.race([p, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  private setClock(clock: number) {
    this.clock = Math.max(this.clock, clock)
    for (const w of [...this.clockWaiters])
      if (this.clock >= w.clock) {
        this.clockWaiters.splice(this.clockWaiters.indexOf(w), 1)
        w.resolve()
      }
  }

  private applyOp(op: ServerOp) {
    if (op.k === 'c') {
      this.confirmed.set(op.el.id, clone(op.el) as El)
      return
    }
    const cur = this.confirmed.get(op.id)
    if (!cur) throw new Error(`${this.name}: a patch for unknown ${op.id}`)
    if (cur.version !== op.pv)
      throw new Error(`${this.name}: patch for ${op.id} at pv ${op.pv}, held ${cur.version}`)
    const next = overlayPatch(cur, { g: op.g, c: op.c, b: op.b, lobbyServer: op.lobbyServer })
    this.confirmed.set(op.id, { ...next, version: op.v, versionNonce: op.vn, updated: op.updated })
  }

  private async receive(data: string | Uint8Array) {
    if (typeof data !== 'string') {
      const frame = await decodeSnapshotFrame(data)
      this.confirmed.clear()
      for (const el of frame.elements) this.confirmed.set(el.id, clone(el) as El)
      this.epoch = frame.epoch
      this.setClock(frame.clock)
      this.welcomed()
      return
    }
    const msg: ServerMessage = ServerMessageSchema.parse(JSON.parse(data))
    switch (msg.type) {
      case 'welcome':
        this.welcome = msg
        this.epoch = msg.epoch
        if (!msg.reset) {
          for (const op of msg.catchUp ?? []) this.applyOp(op)
          this.setClock(msg.clock)
          this.welcomed()
        }
        return
      case 'changes':
        for (const op of msg.ops) this.applyOp(op)
        this.setClock(msg.clock)
        return
      case 'ack': {
        const resolve = this.acks.get(msg.seq)
        this.acks.delete(msg.seq)
        resolve?.(msg)
        return
      }
      case 'lease.grant':
      case 'lease.deny': {
        const resolve = this.leaseWaiters.get(msg.req)
        this.leaseWaiters.delete(msg.req)
        resolve?.(msg)
        return
      }
      default:
        return
    }
  }
}

// ---- ops the way a client builds them from its local copy -------------------------------------------------

/**
 * The patch a client pushes for one element whose local copy differs from `confirmed`: the changed
 * groups with their changed fields, and, when any geometry field of an arrow or a line changed, its WHOLE
 * `path` unit from the same copy (§2.4.2). `extra` adds fields or a fit.
 */
export function patchOf(
  local: El,
  confirmed: El,
  extra: Partial<Pick<Op & { k: 'p' }, 'fit' | 'off'>> = {},
): Op {
  const g: Record<string, Record<string, unknown>> = {}
  for (const f of new Set([...Object.keys(local), ...Object.keys(confirmed)])) {
    const group = fieldGroupOf(local, f)
    if (!group || group === 'bound') continue
    if (JSON.stringify(local[f]) === JSON.stringify(confirmed[f])) continue
    const fields = g[group] ?? {}
    fields[f] = clone(local[f])
    g[group] = fields
  }
  if (g.path) g.path = pathUnitOf(local)
  return {
    k: 'p',
    id: local.id,
    pv: confirmed.version,
    ...(Object.keys(g).length ? { g } : {}),
    ...extra,
  } as Op
}

/** The whole `path` unit of `local`, as its own patch (a user's point, segment or rotation edit). */
export const pathOp = (local: El, confirmed: El, extra: { off?: number } = {}): Op =>
  ({ k: 'p', id: local.id, pv: confirmed.version, g: { path: pathUnitOf(local) }, ...extra }) as Op
