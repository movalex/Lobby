// An in-memory stand-in for sync's ElementRoom and O2's headless client, for the load generator's own
// tests and plumbing dry runs before M2 (O3's instructions: build against the frozen contracts and fakes).
// It speaks the frozen protocol's message SHAPES (welcome with a catch-up, changes, ack, lease, presence)
// through a meter, so the sessions, the meter, the joins and the reports run end to end. It is NOT a model
// of the room's rules: no groups, invariants, fit or re-snaps; every patch's fields are overlaid and the
// version bumped. Nothing here is used by a measured run.

import type {
  EngineCore,
  GestureState,
  HeadlessClient,
  HeadlessClientOptions,
  PushRecord,
  SaveStatus,
  SceneElement,
} from '../../../apps/web/src/canvas/sync/types.ts'
import type {
  Ack,
  ClientMessage,
  LeaseServerMessage,
  Op,
  ServerMessage,
} from '../../../packages/canvas-schema/src/protocol.ts'
import type { Meter } from '../meter.ts'

interface Conn {
  readonly sid: string
  deliver(m: ServerMessage): void
  drop(code: number): void
}

export class FakeRoom {
  readonly elements = new Map<string, SceneElement>()
  clock = 0
  down = false
  readonly conns = new Set<Conn>()
  readonly leases = new Map<string, string>()
  pushes = 0
  /** ms added before each delivery (a slow server) */
  latencyMs = 0

  constructor(elements: readonly SceneElement[]) {
    for (const e of elements) this.elements.set(e.id, e)
  }

  private send(c: Conn, m: ServerMessage) {
    if (this.latencyMs) setTimeout(() => c.deliver(m), this.latencyMs)
    else queueMicrotask(() => c.deliver(m))
  }

  join(c: Conn): void {
    if (this.down) throw new Error('fake room is down')
    this.conns.add(c)
    const welcome = {
      type: 'welcome',
      proto: 1,
      schema: 1,
      sid: c.sid,
      you: { uid: c.sid.split(':')[0] ?? 'u', name: 'Load', color: '#000', role: 'editor', guest: false },
      readonly: false,
      epoch: 'fake',
      clock: this.clock,
      horizon: 0,
      reset: false,
      catchUp: [...this.elements.values()].map((el) => ({ k: 'c', el })),
      snapshot: null,
      doc: {},
      leases: [],
      roster: [],
      workshop: { voteOpen: false, anonymous: false },
      drags: [],
      limits: {},
    } as unknown as ServerMessage
    this.send(c, welcome)
  }

  leave(c: Conn): void {
    this.conns.delete(c)
    for (const [id, sid] of this.leases) if (sid === c.sid) this.leases.delete(id)
  }

  /** SIGKILL: every socket drops, the room refuses joins for `ms`. */
  kill(ms: number): void {
    this.down = true
    for (const c of [...this.conns]) {
      this.conns.delete(c)
      c.drop(1006)
    }
    this.leases.clear()
    setTimeout(() => {
      this.down = false
    }, ms)
  }

  message(c: Conn, m: ClientMessage): void {
    if (this.down) return
    if (m.type === 'push') {
      this.pushes++
      const clock = ++this.clock
      const out: unknown[] = []
      const r: Ack['r'] = []
      for (const op of m.ops as Op[]) {
        if (op.k === 'c') {
          const el = {
            ...(op.el as unknown as SceneElement),
            version: (op.el as { version: number }).version + 1,
          }
          this.elements.set(el.id, el)
          out.push({ k: 'c', el })
          r.push({ id: el.id, ok: true, v: el.version })
          continue
        }
        const prev = this.elements.get(op.id)
        if (!prev) {
          r.push({ id: op.id, ok: false, code: 'GONE', el: null })
          continue
        }
        const fields: Record<string, unknown> = {}
        for (const g of Object.values(op.g ?? {})) Object.assign(fields, g)
        const next = {
          ...prev,
          ...fields,
          version: prev.version + 1,
          versionNonce: (prev.versionNonce + 1) | 0,
        } as SceneElement
        this.elements.set(op.id, next)
        out.push({
          k: 'p',
          id: op.id,
          v: next.version,
          vn: next.versionNonce,
          pv: prev.version,
          updated: Date.now(),
          g: op.g,
        })
        r.push({ id: op.id, ok: true, v: next.version })
      }
      const changes = { type: 'changes', clock, ops: out } as unknown as ServerMessage
      for (const k of this.conns) this.send(k, changes)
      this.send(c, { type: 'ack', seq: m.seq, clock, r } as ServerMessage)
    } else if (m.type === 'lease.acquire') {
      const holder = this.leases.get(m.id)
      if (!holder || holder === c.sid) {
        this.leases.set(m.id, c.sid)
        this.send(c, { type: 'lease.grant', req: m.req, id: m.id, ttlMs: 30_000 })
      } else
        this.send(c, {
          type: 'lease.deny',
          req: m.req,
          id: m.id,
          holder: { sid: holder, uid: 'u', name: 'x' },
        })
    } else if (m.type === 'lease.release') {
      if (this.leases.get(m.id) === c.sid) this.leases.delete(m.id)
    } else if (m.type === 'presence') {
      const frame = {
        type: 'presence',
        peers: [
          {
            sid: c.sid,
            pointer: m.pointer,
            button: m.button,
            sel: m.sel,
            view: m.view,
            idle: m.idle,
            editing: m.editing,
          },
        ],
        ...(m.drag ? { drags: [{ sid: c.sid, ...m.drag }] } : {}),
      } as unknown as ServerMessage
      for (const k of this.conns) if (k !== c) this.send(k, frame)
    }
  }
}

/** Diff of one element against its confirmed copy: the changed top-level fields, as one pseudo-group. */
function diff(prev: SceneElement | undefined, next: SceneElement): Record<string, unknown> | null {
  if (!prev) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(next)) {
    if (k === 'version' || k === 'versionNonce' || k === 'updated') continue
    if (JSON.stringify(v) !== JSON.stringify((prev as Record<string, unknown>)[k])) out[k] = v
  }
  return Object.keys(out).length ? out : null
}

/** A HeadlessClient on a FakeRoom, metered like the real one. */
export function fakeClient(room: FakeRoom, opts: HeadlessClientOptions & { meter: Meter }): HeadlessClient {
  const scene = new Map<string, SceneElement>()
  const confirmed = new Map<string, SceneElement>()
  const received: ServerMessage[] = []
  const pushes: PushRecord[] = []
  const ackListeners = new Set<(a: Ack) => void>()
  const leaseListeners = new Set<(m: LeaseServerMessage) => void>()
  const inFlight = new Set<number>()
  let seq = 0
  let welcome: ServerMessage | null = null
  let conn: { sid: string; deliver(m: ServerMessage): void; drop(code: number): void } | null = null
  let welcomed: (() => void) | null = null
  let dirty = new Set<string>()

  const out = (m: ClientMessage) => {
    const text = JSON.stringify(m)
    opts.meter.sent(text)
    if (conn) room.message(conn, JSON.parse(text) as ClientMessage)
  }
  const deliver = (m: ServerMessage) => {
    opts.meter.received(JSON.stringify(m))
    received.push(m)
    if (m.type === 'welcome') {
      welcome = m
      for (const op of m.catchUp ?? []) {
        if (op.k !== 'c') continue
        scene.set(op.el.id, op.el as unknown as SceneElement)
        confirmed.set(op.el.id, op.el as unknown as SceneElement)
      }
      welcomed?.()
    } else if (m.type === 'changes') {
      for (const op of m.ops) {
        if (op.k === 'c') {
          scene.set(op.el.id, op.el as unknown as SceneElement)
          confirmed.set(op.el.id, op.el as unknown as SceneElement)
        } else {
          const prev = confirmed.get(op.id)
          if (!prev) continue
          const fields: Record<string, unknown> = {}
          for (const g of Object.values(op.g ?? {})) Object.assign(fields, g)
          const next = { ...prev, ...fields, version: op.v, versionNonce: op.vn } as SceneElement
          confirmed.set(op.id, next)
          if (!dirty.has(op.id)) scene.set(op.id, next)
        }
      }
    } else if (m.type === 'ack') {
      inFlight.delete(m.seq)
      for (const l of ackListeners) l(m)
    } else if (m.type === 'lease.grant' || m.type === 'lease.deny' || m.type === 'lease') {
      for (const l of leaseListeners) l(m)
    }
  }

  const flush = () => {
    if (dirty.size === 0 || !conn) return
    const ops: Op[] = []
    for (const id of dirty) {
      const el = scene.get(id)
      if (!el) continue
      const d = diff(confirmed.get(id), el)
      if (d) ops.push({ k: 'p', id, pv: confirmed.get(id)?.version ?? 0, g: { pos: d } } as unknown as Op)
    }
    dirty = new Set()
    if (!ops.length) return
    const push = {
      type: 'push' as const,
      seq: ++seq,
      base: (welcome as { clock?: number } | null)?.clock ?? 0,
      ops,
    }
    pushes.push({ seq: push.seq, base: push.base, at: Date.now(), ops })
    inFlight.add(push.seq)
    out(push as ClientMessage)
  }

  const status = (): SaveStatus => ({
    state: dirty.size || inFlight.size ? 'saving' : 'saved',
    pending: dirty.size + inFlight.size,
    offlineChanges: 0,
    lastReject: null,
  })

  const core = {
    start() {},
    onSceneChange() {},
    flush,
    stop() {},
    get welcome() {
      return welcome
    },
    get clock() {
      return 0
    },
    get epoch() {
      return 'fake'
    },
    elements: () => scene,
    confirmed: (id: string) => confirmed.get(id),
    isDerivedHeld: () => false,
    get saveStatus() {
      return status()
    },
    onSaveStatus: () => () => undefined,
    onAck: (l: (a: Ack) => void) => {
      ackListeners.add(l)
      return () => ackListeners.delete(l)
    },
    pushLog: () => pushes,
    leaseConnect: (onMessage: (m: LeaseServerMessage) => void) => {
      leaseListeners.add(onMessage)
      return { send: (m: ClientMessage) => out(m) }
    },
    leaseHolders: () => new Map(),
    sendPresence: (p: Record<string, unknown>) => out({ type: 'presence', ...p } as ClientMessage),
  } as unknown as EngineCore

  return {
    core,
    scene,
    async connect() {
      // sync's sid is `<ticket uid>:<tab>`; the fake reads the uid from the ticket's payload (no signature check)
      const uid = (() => {
        try {
          return (
            JSON.parse(Buffer.from(opts.ticket.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
              uid: string
            }
          ).uid
        } catch {
          return 'fake'
        }
      })()
      const sid = `${uid}:${opts.tab}`
      await new Promise<void>((resolve, reject) => {
        welcomed = resolve
        conn = {
          sid,
          deliver,
          drop: (code) => {
            conn = null
            opts.meter.closed(code)
          },
        }
        try {
          room.join(conn)
        } catch (e) {
          conn = null
          reject(e)
        }
      })
      return welcome as never
    },
    edit(fn: (s: Map<string, SceneElement>) => void, gesture?: Partial<GestureState>) {
      const before = new Map([...scene].map(([k, v]) => [k, v.version]))
      fn(scene)
      for (const [id, el] of scene) if (before.get(id) !== el.version) dirty.add(id)
      if (!gesture?.editingTextElementId) setTimeout(flush, 50)
      else setTimeout(flush, 500)
    },
    async saved(timeoutMs = 10_000) {
      const end = Date.now() + timeoutMs
      while (status().state !== 'saved') {
        if (Date.now() > end) throw new Error('fake client: not saved in time')
        await new Promise((r) => setTimeout(r, 20))
      }
    },
    received: () => received,
    sendRaw(frame: ClientMessage | string) {
      out(typeof frame === 'string' ? (JSON.parse(frame) as ClientMessage) : frame)
    },
    async close() {
      if (conn) {
        room.leave(conn)
        conn = null
        opts.meter.closed(1000)
      }
    },
  }
}
