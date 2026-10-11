/**
 * A protocol fake of the ElementRoom (docs/EXCALIDRAW-MIGRATION.md §2.4, §8.6.4 "tested against a protocol
 * fake generated from protocol.ts"), for the engine core's and the headless client's Node tests. It is NOT
 * O1's room: it validates every client frame with the frozen zod schemas, answers with frames that pass
 * the frozen `ServerMessage` schema, and implements the parts of the accept algorithm the client depends
 * on (per-group last writer wins through `overlayPatch`, versions, per-op rejects, partial accept under a
 * lease, the conditional fit, the lease table, welcome with a reset snapshot or a catch-up, `changes` to
 * every session including the writer, then the ack). Bound arrows are not re-snapped: tests script
 * the server's re-snaps as ops (`serverWrite`).
 *
 * Every frame goes through the manual clock with a per-session latency, so a test controls the order.
 *
 * NODE-SAFE (CONTRACTS.md).
 */
import { redactTombstone } from '@draftroom/canvas-schema/elements'
import { overlayPatch, pathUnitOf, stripEngineArtifacts } from '@draftroom/canvas-schema/groups'
import { WIRE_LIMITS } from '@draftroom/canvas-schema/limits'
import {
  type AckResult,
  CLOSE_TERMINAL,
  type ClientMessage,
  ClientMessage as ClientMessageSchema,
  type DerivedRow,
  type LeaseHolder,
  lobbyKeyNewerThan,
  Op as OpSchema,
  PushEnvelope,
  type RejectCode,
  type ServerMessage,
  ServerMessage as ServerMessageSchema,
  type ServerOp,
  type SnapshotFrame,
  SnapshotFrame as SnapshotFrameSchema,
} from '@draftroom/canvas-schema/protocol'
import type { SceneElement, ServerInbound, Transport, TransportClose, TransportState } from '../types.ts'
import type { ManualClock } from './manualClock.ts'

type El = Record<string, unknown> & {
  id: string
  type: string
  version: number
  versionNonce: number
  isDeleted: boolean
}

interface Session {
  readonly sid: string
  readonly uid: string
  readonly name: string
  readonly readonly: boolean
  latencyMs: number
  /**
   * The client → room half alone, when set (a slow uplink: the V1 verifier's proxy `delayUpMs`, so a second
   * push can still be on its way up while the first one's ack is already back); null: `latencyMs / 2`
   */
  upLatencyMs: number | null
  deliver: ((m: ServerInbound) => void) | null
  open: boolean
  /** frames this session sent, parsed */
  readonly received: ClientMessage[]
  /** frames sent to this session */
  readonly sent: ServerInbound[]
}

export interface FakeRoomOptions {
  readonly clock: ManualClock
  readonly epoch?: string
  /** validate every outbound frame with the frozen schemas (default true) */
  readonly strict?: boolean
}

let nonce = 0x51ed27
const nextNonce = () => {
  nonce = (Math.imul(nonce, 1664525) + 1013904223) >>> 0
  return nonce & 0x7fffffff
}

export class FakeRoom {
  readonly elements = new Map<string, El>()
  readonly rowClock = new Map<string, number>()
  /** per element, per group: the clock of the last ordinary write (fit writes do not advance it) */
  readonly gclock = new Map<string, Record<string, number>>()
  readonly leases = new Map<string, LeaseHolder>()
  readonly sessions = new Map<string, Session>()
  readonly doc: Record<string, unknown> = {}
  clock = 0
  epoch: string
  horizon = 0
  /** next pushes answered UNAVAILABLE (a COMMIT failure) */
  failNext = 0
  /**
   * The room's cached reset snapshot (element-room.ts `snapshotFor`, 5 s there): while set, a reset
   * welcome serves the snapshot taken up to this many ms ago, then the rows since it as one `changes`
   * frame. 0 (the default): a fresh snapshot every time.
   */
  snapshotCacheMs = 0
  /**
   * Send every tombstone redacted (CONTRACTS_REV 7, W5-02: elements.ts `redactTombstone`), as the room
   * does since wave 5: in snapshots, catch-ups, `c` ops and a reject's stored element.
   */
  redactTombstones = false
  /**
   * Send the welcome and the snapshot frame with `docClocks` (per board-document key, the clock of the
   * write that last set or removed it: `lb_doc.clock`), as the room does since CONTRACTS_REV 9 (W4B-1, the
   * doc-key ABA). The strict check parses the frames without the field, so the fake builds with a
   * `protocol.ts` before or after rev 9.
   */
  sendDocClocks = false
  /** per board-document key, the clock of its last write (what `docClocks` carries) */
  readonly docClocks = new Map<string, number>()
  /**
   * Server-derived writes (room/fit.ts, §2.9.4 rule 7), scripted per target: when a push moves `target`
   * (a `pos` write), each arrow listed follows by the same delta as a derived `path` write in the same
   * batch, with a `derived` row in the push's ack (its version bumps with no op of the client's).
   */
  readonly derive = new Map<string, string[]>()
  /**
   * CONTRACTS_REV 10/11: when set, the room's `contracts` frame follows every welcome (and its snapshot and
   * catch-up) with this revision, as the room does; null (the default): a room before rev 10, no frame.
   */
  contractsRev: number | null = null
  /**
   * Wave N (N1-7): refuse, INVALID and whole, any write that leaves an element with a `customData.lobby` key whose
   * class `contractsRev` does not know (LOBBY_KEY_ADDITIONS), as a room below that revision does (the 104c6e0 sync's
   * checkElement on every written element, merge.ts:771): a rev-12 room after a rollback, met by a rev-13 page.
   */
  refuseUnknownKeys = false
  /**
   * Push receipts (CONTRACTS_REV 11, W5-ENG-2; the room's lb_receipts): `<uid> <rid>` → the clock the push
   * committed at, for each push with a receipt id that wrote and had no op refused for a retryable reason
   */
  readonly receipts = new Map<string, number>()
  /** the answers' `from` (a test raises it to model receipts the room trimmed) */
  receiptsFrom = 0
  /** a receipts query is left unanswered (a room that never answers: the client's fallback) */
  dropReceiptQueries = false
  private snapCache: { at: number; clock: number; elements: El[]; doc: Record<string, unknown> } | null = null
  private readonly c: ManualClock
  private readonly strict: boolean

  constructor(opts: FakeRoomOptions) {
    this.c = opts.clock
    this.epoch = opts.epoch ?? 'epoch1'
    this.strict = opts.strict ?? true
  }

  /** Seeds stored elements (clock 0), as a board opened with content. */
  seed(elements: readonly Record<string, unknown>[]): void {
    for (const e of elements) {
      const el = { ...(e as El) }
      this.elements.set(el.id, el)
      this.rowClock.set(el.id, 0)
    }
  }

  snapshot(): El[] {
    return [...this.elements.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  /**
   * A client transport for a new session. `uid`/`name` are the ticket's; `sid` = `uid:tab`.
   */
  connect(o: {
    uid: string
    name?: string
    tab: string
    readonly?: boolean
    latencyMs?: number
  }): Transport & {
    readonly session: Session
    drop(): void
  } {
    const sid = `${o.uid}:${o.tab}`
    const session: Session = {
      sid,
      uid: o.uid,
      name: o.name ?? o.uid,
      readonly: o.readonly ?? false,
      latencyMs: o.latencyMs ?? 0,
      upLatencyMs: null,
      deliver: null,
      open: false,
      received: [],
      sent: [],
    }
    this.sessions.set(sid, session)
    const msgListeners = new Set<(m: ServerInbound) => void>()
    const stateListeners = new Set<(s: TransportState, c?: TransportClose) => void>()
    let state: TransportState = 'connecting'
    const setState = (s: TransportState, c?: TransportClose) => {
      state = s
      for (const l of [...stateListeners]) l(s, c)
    }
    session.deliver = (m) => {
      for (const l of [...msgListeners]) l(m)
    }
    const room = this
    const transport = {
      session,
      get state() {
        return state
      },
      send(message: ClientMessage) {
        // a frame sent while the socket opens (a real server may read it before its open handler ran) waits
        if (state === 'connecting') {
          early.push(message)
          return
        }
        if (state !== 'open') return
        const copy = JSON.parse(JSON.stringify(message))
        room.c.setTimer(() => room.receive(session, copy), session.upLatencyMs ?? session.latencyMs / 2)
      },
      onMessage(l: (m: ServerInbound) => void) {
        msgListeners.add(l)
        return () => msgListeners.delete(l)
      },
      onState(l: (s: TransportState, c?: TransportClose) => void) {
        stateListeners.add(l)
        return () => stateListeners.delete(l)
      },
      close(code = 1000, reason = '') {
        session.open = false
        this.drop()
        setState('closed', { code, reason })
      },
      /** the socket goes away (a cut, a crash) */
      drop() {
        session.open = false
        room.dropSession(session)
      },
      /** reopen (a reconnect of the same session) */
      reopen() {
        session.open = true
        room.sessions.set(sid, session)
        setState('open')
      },
    }
    // open on the next tick, as a socket would
    const early: ClientMessage[] = []
    this.c.setTimer(() => {
      session.open = true
      setState('open')
      for (const m of early.splice(0)) transport.send(m)
    }, 0)
    return transport
  }

  /** Cuts a session's socket: pending frames are lost, the client sees 'closed'. */
  cut(transport: ReturnType<FakeRoom['connect']>): void {
    ;(transport as unknown as { close(code: number, reason: string): void }).close(1006, 'cut')
  }

  private dropSession(s: Session): void {
    this.sessions.delete(s.sid)
    for (const [id, h] of [...this.leases])
      if (h.sid === s.sid) {
        this.leases.delete(id)
        this.broadcast({ type: 'lease', id, holder: null })
      }
  }

  private send(s: Session, m: ServerInbound): void {
    if (this.strict) {
      // `docClocks` (CONTRACTS_REV 9) is parsed out, so the fake builds with a schema before or after rev 9
      const { docClocks: _omit, ...rest } = m as ServerInbound & { docClocks?: unknown }
      if (m.type === 'snapshot') SnapshotFrameSchema.parse(rest)
      else ServerMessageSchema.parse(rest)
    }
    const copy = (this.redactTombstones ? redactFrame(m) : JSON.parse(JSON.stringify(m))) as ServerInbound
    s.sent.push(copy)
    this.c.setTimer(() => {
      if (s.open) s.deliver?.(copy)
    }, s.latencyMs / 2)
  }

  private broadcast(m: ServerMessage): void {
    for (const s of this.sessions.values()) if (s.open) this.send(s, m)
  }

  private receive(s: Session, raw: unknown): void {
    if (!s.open) return
    const env = ClientMessageSchema.safeParse(raw)
    if (!env.success) {
      const push = PushEnvelope.safeParse(raw)
      if (push.success) {
        this.onPush(s, push.data as unknown as { seq: number; base: number; ops: unknown[]; rid?: string })
        return
      }
      throw new Error(`fake room: malformed client message: ${env.error.message}`)
    }
    const m = env.data
    s.received.push(m)
    switch (m.type) {
      case 'hello':
        this.onHello(s, m)
        return
      case 'push':
        this.onPush(s, m as unknown as { seq: number; base: number; ops: unknown[]; rid?: string })
        return
      case 'lease.acquire': {
        const h = this.leases.get(m.id)
        if (h && h.sid !== s.sid) {
          this.send(s, { type: 'lease.deny', req: m.req, id: m.id, holder: h })
          return
        }
        const me: LeaseHolder = { sid: s.sid, uid: s.uid, name: s.name }
        this.leases.set(m.id, me)
        this.send(s, { type: 'lease.grant', req: m.req, id: m.id, ttlMs: 10_000 })
        if (!h) this.broadcast({ type: 'lease', id: m.id, holder: me })
        return
      }
      case 'lease.release': {
        const h = this.leases.get(m.id)
        if (h?.sid === s.sid) {
          this.leases.delete(m.id)
          this.broadcast({ type: 'lease', id: m.id, holder: null })
        }
        return
      }
      case 'ping':
        this.send(s, { type: 'pong', ...(m.n !== undefined ? { n: m.n } : {}) })
        return
      case 'receipts': {
        if (this.dropReceiptQueries) return
        const landed: Record<string, number> = {}
        for (const rid of m.ids) {
          const at = this.receipts.get(`${s.uid} ${rid}`)
          if (at !== undefined) landed[rid] = at
        }
        this.send(s, { type: 'receipts', req: m.req, landed, from: this.receiptsFrom })
        return
      }
      default:
        return
    }
  }

  private onHello(s: Session, m: Extract<ClientMessage, { type: 'hello' }>): void {
    this.welcomeFor(s, m)
    // the room's revision right after the welcome and its snapshot and catch-up frames (element-room.ts)
    if (this.contractsRev !== null) this.send(s, { type: 'contracts', rev: this.contractsRev })
  }

  private welcomeFor(s: Session, m: Extract<ClientMessage, { type: 'hello' }>): void {
    const reset = m.epoch !== this.epoch || m.since < this.horizon || m.since === 0
    const base = {
      type: 'welcome' as const,
      proto: 1 as const,
      schema: 1,
      sid: s.sid,
      you: {
        uid: s.uid,
        name: s.name,
        color: '#444444',
        role: s.readonly ? ('viewer' as const) : ('editor' as const),
        guest: false,
      },
      readonly: s.readonly,
      epoch: this.epoch,
      clock: this.clock,
      horizon: this.horizon,
      doc: { ...this.doc },
      leases: [...this.leases].map(([id, holder]) => ({ id, holder })),
      roster: [...this.sessions.values()].map((x) => ({
        sid: x.sid,
        uid: x.uid,
        name: x.name,
        color: '#444444',
        role: x.readonly ? ('viewer' as const) : ('editor' as const),
        guest: false,
      })),
      workshop: { voteOpen: false, anonymous: false },
      drags: [],
      limits: { ...WIRE_LIMITS },
      ...(this.sendDocClocks ? { docClocks: Object.fromEntries(this.docClocks) } : {}),
    }
    if (reset) {
      let els = [...this.elements.values()]
      let clock = this.clock
      let doc = { ...this.doc }
      if (this.snapshotCacheMs > 0) {
        const now = this.c.now()
        if (!this.snapCache || now - this.snapCache.at >= this.snapshotCacheMs)
          this.snapCache = {
            at: now,
            clock: this.clock,
            elements: structuredClone(els),
            doc: { ...this.doc },
          }
        els = this.snapCache.elements
        clock = this.snapCache.clock
        // the cached frame carries the document as it was then (element-room.ts snapshotFor); the welcome's
        // is read at the hello
        doc = { ...this.snapCache.doc }
      }
      this.send(s, {
        ...base,
        clock,
        reset: true,
        catchUp: null,
        snapshot: { elements: els.length, bytes: 0 },
      })
      const frame: SnapshotFrame = {
        type: 'snapshot',
        epoch: this.epoch,
        clock,
        horizon: this.horizon,
        elements: [...els].sort(byIndex) as never,
        doc,
        ...(this.sendDocClocks ? { docClocks: Object.fromEntries(this.docClocks) } : {}),
      }
      this.send(s, frame)
      // the rows since a cached snapshot, right behind it (element-room.ts hello)
      if (clock < this.clock) {
        const rows = [...this.elements.values()].filter((e) => (this.rowClock.get(e.id) ?? 0) > clock)
        this.send(s, {
          type: 'changes',
          clock: this.clock,
          ops: rows.sort(byIndex).map((el) => ({ k: 'c' as const, el: el as never })),
        })
      }
      return
    }
    const rows = [...this.elements.values()].filter((e) => (this.rowClock.get(e.id) ?? 0) > m.since)
    this.send(s, {
      ...base,
      reset: false,
      snapshot: null,
      catchUp: rows.sort(byIndex).map((el) => ({ k: 'c' as const, el: el as never })),
    })
  }

  private onPush(
    s: Session,
    push: { seq: number; base: number; ops: unknown[]; doc?: unknown; rid?: string },
  ): void {
    const clock = this.clock + 1
    const results: AckResult[] = []
    const out: ServerOp[] = []
    const derivedRows: DerivedRow[] = []
    const reject = (id: string, code: RejectCode, el: El | null = null) =>
      results.push({ id, ok: false, code, el: el as never })
    if (this.failNext > 0) {
      this.failNext--
      for (const raw of push.ops)
        reject(
          ((raw as { id?: string; el?: { id?: string } }).id ??
            (raw as { el?: { id?: string } }).el?.id ??
            '') as string,
          'UNAVAILABLE',
        )
      this.send(s, { type: 'ack', seq: push.seq, clock: this.clock, r: results })
      return
    }
    for (const raw of push.ops) {
      const parsed = OpSchema.safeParse(raw)
      const rawId = ((raw as { id?: string }).id ?? (raw as { el?: { id?: string } }).el?.id ?? '') as string
      if (!parsed.success) {
        reject(rawId, 'INVALID')
        continue
      }
      const op = parsed.data
      if (s.readonly) {
        reject(rawId, 'READ_ONLY')
        continue
      }
      if (op.k === 'c') {
        const el = stripEngineArtifacts({ ...(op.el as unknown as El) }) as El
        const stored = this.elements.get(el.id)
        if (stored && !stored.isDeleted) {
          reject(el.id, 'INVALID', stored)
          continue
        }
        if (el.type === 'text' && this.leasedByOther(s, (el.containerId as string | null) ?? el.id)) {
          reject(el.id, 'LEASED')
          continue
        }
        const next: El = {
          ...el,
          version: Math.max(stored?.version ?? 0, el.version) + 1,
          versionNonce: nextNonce(),
          updated: this.c.now(),
        }
        delete next.status
        if (this.unknownKeyIn(next)) {
          reject(el.id, 'INVALID', stored ?? null)
          continue
        }
        this.elements.set(el.id, next)
        this.rowClock.set(el.id, clock)
        this.gclock.set(el.id, { all: clock })
        results.push({ id: el.id, ok: true, v: next.version })
        out.push({ k: 'c', el: next as never })
        continue
      }
      const stored = this.elements.get(op.id)
      if (!stored) {
        reject(op.id, 'GONE')
        continue
      }
      const lease = stored.type === 'text' ? ((stored.containerId as string | null) ?? stored.id) : stored.id
      const denied: string[] = []
      const g: Record<string, Record<string, unknown>> = {}
      for (const [group, fields] of Object.entries(op.g ?? {})) {
        if (
          stored.type === 'text' &&
          ['text', 'layout', 'life'].includes(group) &&
          this.leasedByOther(s, lease)
        ) {
          denied.push(group)
          continue
        }
        g[group] = fields as Record<string, unknown>
      }
      // the conditional fit (§2.9.4 rule 3): only the holder's, only with no pos/shape write after its base
      let fitDropped = false
      const gc = this.gclock.get(op.id) ?? {}
      if (op.fit) {
        const holder = this.leases.get(stored.type === 'text' ? stored.id : stored.id)
        const mine = holder?.sid === s.sid
        const later = (gc.pos ?? 0) > push.base || (gc.shape ?? 0) > push.base
        if (!mine || later) fitDropped = true
        else {
          const keys = Object.keys(op.fit)
          const posKeys = keys.filter((k) => k === 'x' || k === 'y')
          const shapeKeys = keys.filter((k) => k === 'width' || k === 'height')
          if (posKeys.length)
            g.pos = {
              ...(g.pos ?? {}),
              ...Object.fromEntries(posKeys.map((k) => [k, (op.fit as Record<string, number>)[k]])),
            }
          if (shapeKeys.length)
            g.shape = {
              ...(g.shape ?? {}),
              ...Object.fromEntries(shapeKeys.map((k) => [k, (op.fit as Record<string, number>)[k]])),
            }
        }
      }
      if (!Object.keys(g).length && !op.c && !op.b) {
        if (denied.length)
          results.push({ id: op.id, ok: true, v: stored.version, denied: { groups: denied, code: 'LEASED' } })
        else
          results.push({
            id: op.id,
            ok: true,
            v: stored.version,
            ...(fitDropped ? { fitDropped: true as const } : {}),
          })
        continue
      }
      const merged = overlayPatch(stored, { g, c: op.c, b: op.b }) as El
      if (this.unknownKeyIn(merged)) {
        reject(op.id, 'INVALID', stored)
        continue
      }
      const next: El = {
        ...merged,
        version: stored.version + 1,
        versionNonce: nextNonce(),
        updated: this.c.now(),
      }
      this.elements.set(op.id, next)
      this.rowClock.set(op.id, clock)
      const ngc = { ...gc }
      for (const group of Object.keys(op.g ?? {})) if (!denied.includes(group)) ngc[group] = clock
      this.gclock.set(op.id, ngc)
      const sop: ServerOp = {
        k: 'p',
        id: op.id,
        v: next.version,
        vn: next.versionNonce,
        pv: stored.version,
        updated: next.updated as number,
        ...(Object.keys(g).length ? { g: g as never } : {}),
        ...(op.c ? { c: op.c } : {}),
        ...(op.b ? { b: op.b } : {}),
      }
      out.push(sop)
      results.push({
        id: op.id,
        ok: true,
        v: next.version,
        ...(fitDropped ? { fitDropped: true as const } : {}),
        ...(denied.length ? { denied: { groups: denied, code: 'LEASED' as const } } : {}),
      })
      if (g.pos && this.derive.has(op.id)) this.deriveFollow(op.id, stored, next, clock, out, derivedRows)
    }
    // the board document (doc.ts keys; the fake accepts every key a client may write)
    const docSet = (push.doc as { set?: Record<string, unknown> } | undefined)?.set
    if (docSet && !s.readonly)
      for (const [k, v] of Object.entries(docSet)) {
        if (v === null) delete this.doc[k]
        else this.doc[k] = v
        this.docClocks.set(k, clock)
      }
    const wrote = out.length > 0 || (!!docSet && !s.readonly)
    // its receipt (CONTRACTS_REV 11): it wrote, and nothing of it waits for a retry
    if (
      wrote &&
      push.rid !== undefined &&
      !results.some((r) => !r.ok && (r.code === 'RATE' || r.code === 'UNAVAILABLE'))
    )
      this.receipts.set(`${s.uid} ${push.rid}`, clock)
    if (wrote) {
      this.clock = clock
      this.broadcast({
        type: 'changes',
        clock,
        ops: out,
        ...(docSet && !s.readonly ? { doc: { set: docSet } } : {}),
      })
    }
    this.send(s, {
      type: 'ack',
      seq: push.seq,
      clock: wrote ? clock : this.clock,
      r: results,
      ...(derivedRows.length ? { derived: derivedRows } : {}),
      ...(docSet && s.readonly
        ? { docDenied: { keys: Object.keys(docSet), code: 'READ_ONLY' as const } }
        : {}),
    })
  }

  /** The arrows scripted on `target` (`derive`) follow its move: a derived `path` write each, in the same batch. */
  private deriveFollow(
    target: string,
    before: El,
    after: El,
    clock: number,
    out: ServerOp[],
    rows: DerivedRow[],
  ): void {
    const dx = (after.x as number) - (before.x as number)
    const dy = (after.y as number) - (before.y as number)
    for (const id of this.derive.get(target) ?? []) {
      const st = this.elements.get(id)
      if (!st || st.isDeleted) continue
      // the whole path unit, as a `path` patch carries it
      const fix = pathUnitOf({ ...st, x: (st.x as number) + dx, y: (st.y as number) + dy }) as Record<
        string,
        unknown
      >
      const next: El = {
        ...st,
        ...fix,
        version: st.version + 1,
        versionNonce: nextNonce(),
        updated: this.c.now(),
      }
      this.elements.set(id, next)
      this.rowClock.set(id, clock)
      out.push({
        k: 'p',
        id,
        v: next.version,
        vn: next.versionNonce,
        pv: st.version,
        updated: next.updated as number,
        g: { path: fix } as never,
      })
      rows.push({ id, v: next.version, fix })
    }
  }

  /** N1-7: `el` has a lobby key this room's revision does not know (only with `refuseUnknownKeys`). */
  private unknownKeyIn(el: El): boolean {
    const rev = this.contractsRev
    if (!this.refuseUnknownKeys || rev === null) return false
    const lobby = (el.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}
    return Object.keys(lobby).some((k) => lobbyKeyNewerThan(rev, k))
  }

  private leasedByOther(s: Session, id: string): boolean {
    const h = this.leases.get(id)
    return !!h && h.sid !== s.sid
  }

  /**
   * A write by the server itself (a re-snap, a repair) or by a session outside the test's clients: the
   * stored element becomes `patch` overlaid, broadcast as one `changes` batch.
   */
  serverWrite(id: string, patch: Readonly<Record<string, unknown>>): void {
    const stored = this.elements.get(id)
    if (!stored) throw new Error(`serverWrite: no ${id}`)
    const clock = ++this.clock
    const next: El = {
      ...stored,
      ...patch,
      version: stored.version + 1,
      versionNonce: nextNonce(),
      updated: this.c.now(),
    }
    this.elements.set(id, next)
    this.rowClock.set(id, clock)
    this.broadcast({ type: 'changes', clock, ops: [{ k: 'c', el: next as never }] })
  }

  /** Every session's socket closes with 4099 and a reason (a terminal close). */
  closeTerminal(transport: ReturnType<FakeRoom['connect']>, reason: string): void {
    ;(transport as unknown as { close(code: number, reason: string): void }).close(CLOSE_TERMINAL, reason)
  }
}

const byIndex = (a: El, b: El) => {
  const ai = (a.index as string | null) ?? ''
  const bi = (b.index as string | null) ?? ''
  if (ai !== bi) return ai < bi ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** The stored form of an element as tests seed it: every server-owned field set. */
/** A frame with every tombstone redacted (FakeRoom.redactTombstones). */
function redactFrame(m: ServerInbound): ServerInbound {
  const f = JSON.parse(JSON.stringify(m)) as Record<string, unknown>
  const red = (el: El) => (el?.isDeleted ? (redactTombstone(el) as unknown as El) : el)
  const ops = (list: unknown) =>
    Array.isArray(list)
      ? list.map((op: { k: string; el?: El }) => (op.k === 'c' && op.el ? { ...op, el: red(op.el) } : op))
      : list
  if (f.type === 'snapshot') f.elements = (f.elements as El[]).map(red)
  if (f.type === 'welcome' && f.catchUp) f.catchUp = ops(f.catchUp)
  if (f.type === 'changes') f.ops = ops(f.ops)
  if (f.type === 'ack') f.r = (f.r as { el?: El | null }[]).map((r) => (r.el ? { ...r, el: red(r.el) } : r))
  return f as unknown as ServerInbound
}

export function stored<T extends Record<string, unknown>>(el: T, version = 1): T & SceneElement {
  return { ...el, version, versionNonce: nextNonce(), updated: 1_700_000_000_000 } as unknown as T &
    SceneElement
}
