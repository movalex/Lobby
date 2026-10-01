// One simulated session of a load run (docs/EXCALIDRAW-MIGRATION.md §2.13, §8.3 B9): a headless client
// on O2's real engine core (apps/web/src/canvas/sync/headless, through the injected factory) over a real
// WebSocket with a signed test ticket, driven by one behaviour of profiles.ts. Local edits go through the
// client's scene and `edit()`, exactly as the browser adapter feeds the core, with Excalidraw's version
// bump (version + 1, a new versionNonce), so the core finds them as it finds a browser's edits.
//
// Measured here, per session: push → ack latency (the core's push log against its acks), rejects by code,
// notices, closes, joins and the way back after the sync kill, bytes by channel (meter.ts), drag starts
// and ids per start, and, for the sessions that measure it, which (id, version) arrived when (A→B
// visibility is joined across sessions by run.ts). Editors keep an acked ledger of their own notes (each
// editor owns disjoint notes) for the acked-but-missing check.

import type {
  HeadlessClient,
  HeadlessClientOptions,
  LeaseTransport,
  SceneElement,
} from '../../apps/web/src/canvas/sync/types.ts'
import type { Ack, ServerMessage } from '../../packages/canvas-schema/src/protocol.ts'
import type { GeneratedBoard } from './boards.ts'
import { Meter, meteredWebSocket, PROBE_VIEW, probePointer } from './meter.ts'
import type { SessionGroup } from './profiles.ts'
import { Recorder } from './stats.ts'
import type { LoadUser } from './tickets.ts'

export type ClientFactory = (opts: HeadlessClientOptions & { meter: Meter }) => HeadlessClient

/**
 * How long a session may stay without a welcome after a close before the harness replaces its client (a
 * client that does not reconnect by itself). Above the transport's longest jittered backoff (5 s × 1.3,
 * socket.ts RECONNECT_JITTER) plus a slow welcome, so the harness never races a client that is coming
 * back on its own; B9 ran with 5 s and saw 9 such replacements in one run whose restart took 7.6 s.
 */
export const HARNESS_RECONNECT_AFTER_MS = 12_000

/** The real factory: O2's headless client with a metered WebSocket. */
export function realClientFactory(create: (opts: HeadlessClientOptions) => HeadlessClient): ClientFactory {
  return ({ meter, ...opts }) => create({ ...opts, WebSocketImpl: meteredWebSocket(meter) })
}

export interface SessionPlan {
  readonly key: string
  readonly boardId: string
  readonly group: SessionGroup
  /** index within its group (editors own notes by this index) */
  readonly index: number
  readonly user: LoadUser
  readonly ticket: string
  /** ms after the run start this session joins */
  readonly joinAtMs: number
  /** the notes this session edits (editors), disjoint across editors */
  readonly ownNotes: readonly string[]
  /** a receive-only session on the thin client (thin.ts) instead of O2's full core */
  readonly thin?: boolean
}

export interface EditRecord {
  readonly id: string
  readonly v: number
  readonly sentAt: number
  readonly ackAt: number
}

export interface SessionReport {
  readonly key: string
  readonly boardId: string
  readonly kind: SessionGroup['kind']
  /** ran the thin client (thin.ts) */
  readonly thin?: boolean
  readonly role: string
  readonly joinedAt: number | null
  readonly joinMs: number | null
  readonly welcomes: number
  readonly closes: { at: number; code: number }[]
  /** after the first close following `killAt`: when a new welcome arrived */
  readonly backAt: number | null
  readonly pushes: number
  readonly ops: number
  readonly ackMs: ReturnType<Recorder['summary']>
  readonly ackSamples: readonly number[]
  readonly rejects: Record<string, number>
  readonly denied: Record<string, number>
  readonly fitDropped: number
  readonly notices: Record<string, number>
  readonly edits: readonly EditRecord[]
  /** (id:v) → arrival time, for visibility (measuring sessions only) */
  readonly arrivals: Record<string, number>
  readonly dragStarts: number
  readonly dragIds: number[]
  readonly leaseGrants: number
  readonly leaseDenies: number
  readonly bytes: ReturnType<Meter['snapshot']>
  readonly welcomeBytes: { jsonBytes: number; snapshotBytes: number }[]
  /** last acked values of this editor's own notes: id → fields */
  readonly acked: Record<string, Record<string, unknown>>
  readonly reconnectsByHarness: number
  readonly errors: string[]
  /** the probe cursor's delay to this session (measuring sessions), ms */
  readonly presenceDelayMs: ReturnType<Recorder['summary']>
  readonly presenceDelaySamples: readonly number[]
  /** every welcome this session received (the meter's socket-event times), for the restart numbers */
  readonly welcomeTimes?: readonly number[]
  /** acks received per 10 s window since the run start (window index → count): "every room keeps serving" */
  readonly ackWindows?: Readonly<Record<number, number>>
  /**
   * ids with a push sent but not acked when the session stopped (after waiting up to 10 s for Saved): the
   * readback may hold a NEWER value than the last acked one for them, which is not a loss (report.ts)
   */
  readonly pendingAtEnd?: readonly string[]
}

export interface SessionContext {
  readonly syncWsUrl: string
  readonly createClient: ClientFactory
  readonly board: GeneratedBoard
  readonly presenceHz: number
  /** wall clock of the run start */
  readonly t0: number
  readonly stopping: () => boolean
  readonly log?: (event: string, detail: Record<string, unknown>) => void
  /** the presence probe's session id on a board (null: none) */
  readonly probeSid?: (boardId: string) => string | null
  /** harness-side reconnect when the client stays without a welcome this long after a close (ms) */
  readonly reconnectAfterMs?: number
  /** the thin client for plans marked thin (a real sync only; absent: every session gets createClient) */
  readonly createThinClient?: ClientFactory
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)))
const jitter = (ms: number, f = 0.3) => ms * (1 - f + Math.random() * 2 * f)
const nonce = () => Math.floor(Math.random() * 2 ** 31)

/** Excalidraw's `mutateElement` on a copy: the patch, version + 1, a new versionNonce, `updated` now. */
export function mutated(el: SceneElement, patch: Record<string, unknown>): SceneElement {
  return {
    ...el,
    ...patch,
    version: el.version + 1,
    versionNonce: nonce(),
    updated: Date.now(),
  } as SceneElement
}

const TRACKED_FIELDS = ['x', 'y', 'backgroundColor', 'text'] as const

export class LoadSession {
  readonly plan: SessionPlan
  private readonly ctx: SessionContext
  private client: HeadlessClient | null = null
  private readonly meter: Meter
  private lease: LeaseTransport | null = null
  private leaseReq = 0
  private readonly leaseWaiters = new Map<number, (granted: boolean) => void>()
  private dragSeq = 0
  private stopped = false
  private readonly ackRec = new Recorder(20_000)
  private readonly pushSentAt = new Map<number, { at: number; ids: string[] }>()
  private readonly r = {
    joinedAt: null as number | null,
    joinMs: null as number | null,
    welcomes: 0,
    closes: [] as { at: number; code: number }[],
    backAt: null as number | null,
    pushes: 0,
    ops: 0,
    rejects: {} as Record<string, number>,
    denied: {} as Record<string, number>,
    fitDropped: 0,
    notices: {} as Record<string, number>,
    edits: [] as EditRecord[],
    arrivals: {} as Record<string, number>,
    dragStarts: 0,
    dragIds: [] as number[],
    leaseGrants: 0,
    leaseDenies: 0,
    acked: {} as Record<string, Record<string, unknown>>,
    reconnectsByHarness: 0,
    errors: [] as string[],
    ackWindows: {} as Record<number, number>,
    pendingAtEnd: [] as string[],
  }
  private lastPushLogLen = 0
  private killSeenAt: number | null = null

  constructor(plan: SessionPlan, ctx: SessionContext) {
    this.plan = plan
    this.ctx = ctx
    this.meter = new Meter({ parsePresence: plan.index === 0 || plan.group.measureVisibility === true })
    this.meter.probeSid = ctx.probeSid?.(plan.boardId) ?? null
    if (plan.group.measureVisibility)
      this.meter.onChanges = (ops, at) => {
        for (const op of ops) {
          const k = `${op.id}:${op.v}`
          if (this.r.arrivals[k] === undefined) this.r.arrivals[k] = at
        }
      }
  }

  private note(e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (this.r.errors.length < 20) this.r.errors.push(msg.slice(0, 200))
  }

  private newClient(): HeadlessClient {
    const create =
      this.plan.thin && this.ctx.createThinClient ? this.ctx.createThinClient : this.ctx.createClient
    const c = create({
      syncUrl: this.ctx.syncWsUrl,
      boardId: this.plan.boardId,
      tab: this.plan.key,
      ticket: this.plan.ticket,
      meter: this.meter,
    })
    c.core.onAck((ack) => this.onAck(ack))
    this.lease = c.core.leaseConnect((m) => {
      if (m.type === 'lease.grant') {
        this.r.leaseGrants++
        this.leaseWaiters.get(m.req)?.(true)
      } else if (m.type === 'lease.deny') {
        this.r.leaseDenies++
        this.leaseWaiters.get(m.req)?.(false)
      }
    })
    return c
  }

  /** Joins at its planned time and runs its behaviour until the run stops. */
  async run(): Promise<void> {
    await sleep(this.ctx.t0 + this.plan.joinAtMs - Date.now())
    if (this.ctx.stopping()) return
    const t = Date.now()
    try {
      this.client = this.newClient()
      await this.client.connect()
      this.r.joinedAt = Date.now()
      this.r.joinMs = this.r.joinedAt - t
    } catch (e) {
      this.note(e)
      return
    }
    const watch = this.watchConnection()
    try {
      await this.behave()
    } catch (e) {
      this.note(e)
    }
    this.stopped = true
    await watch
  }

  /**
   * Follows the connection: counts welcomes and notices from the client's raw log, takes closes and the
   * welcome times from the meter (stamped on the socket's own events), and, when the client stays without
   * a welcome for `reconnectAfterMs` after a close (a client that does not reconnect by itself), replaces
   * it with a new client on the same tab, with a 1 s backoff while sync is still down.
   */
  private async watchConnection(): Promise<void> {
    let seen = 0
    let nextTry = 0
    while (!this.stopped && !this.ctx.stopping()) {
      const c = this.client
      if (c) {
        const got = c.received()
        for (; seen < got.length; seen++) this.onServer(got[seen] as ServerMessage)
        // O2's headless client keeps EVERY decoded server frame in this array (its reset snapshot, every
        // `changes` and `presence` frame) for protocol tests. A 10-minute run of 260 sessions would hold
        // gigabytes (the local L1 rehearsal passed 3.3 GB in 2 minutes; the load container has 2 GB), so the
        // load generator empties it once read. The array is the client's own (received() returns it), and
        // nothing else in the client reads it.
        if (seen > 0) {
          ;(got as unknown[]).length = 0
          seen = 0
        }
        this.collectPushes()
      }
      const closes = this.meter.closes
      if (closes.length > this.r.closes.length) {
        const fresh = closes.slice(this.r.closes.length)
        this.r.closes.push(...fresh)
        if (this.killSeenAt === null) this.killSeenAt = fresh[0]?.at ?? Date.now()
      }
      const lastClose = this.r.closes.at(-1)?.at ?? null
      const lastWelcome = this.meter.welcomes.at(-1)?.at ?? 0
      if (this.killSeenAt !== null && this.r.backAt === null) {
        const back = this.meter.welcomes.find((w) => w.at > (this.killSeenAt as number))
        if (back) this.r.backAt = back.at
      }
      const down = lastClose !== null && lastWelcome < lastClose
      if (
        down &&
        Date.now() - (lastClose as number) > (this.ctx.reconnectAfterMs ?? 5_000) &&
        Date.now() >= nextTry
      ) {
        try {
          await c?.close()
        } catch {}
        this.r.reconnectsByHarness++
        try {
          this.client = this.newClient()
          seen = 0
          await this.client.connect()
        } catch (e) {
          this.note(e)
          nextTry = Date.now() + 1_000
        }
      }
      await sleep(100)
    }
  }

  private onServer(m: ServerMessage): void {
    if (m.type === 'welcome') this.r.welcomes++
    else if (m.type === 'notice') this.r.notices[m.code] = (this.r.notices[m.code] ?? 0) + 1
  }

  private collectPushes(): void {
    const c = this.client
    if (!c) return
    const log = c.core.pushLog()
    for (; this.lastPushLogLen < log.length; this.lastPushLogLen++) {
      const p = log[this.lastPushLogLen]
      if (!p) continue
      this.r.pushes++
      this.r.ops += p.ops.length
      this.pushSentAt.set(p.seq, { at: p.at, ids: p.ops.map((o) => (o.k === 'c' ? o.el.id : o.id)) })
    }
  }

  private onAck(ack: Ack): void {
    const now = Date.now()
    const w = Math.floor((now - this.ctx.t0) / 10_000)
    this.r.ackWindows[w] = (this.r.ackWindows[w] ?? 0) + 1
    this.collectPushes()
    const sent = this.pushSentAt.get(ack.seq)
    if (sent) {
      this.ackRec.add(now - sent.at)
      this.pushSentAt.delete(ack.seq)
    }
    for (const res of ack.r) {
      if (!res.ok) {
        this.r.rejects[res.code] = (this.r.rejects[res.code] ?? 0) + 1
        continue
      }
      if (res.denied) this.r.denied[res.denied.code] = (this.r.denied[res.denied.code] ?? 0) + 1
      if (res.fitDropped) this.r.fitDropped++
      if (sent && this.r.edits.length < 50_000)
        this.r.edits.push({ id: res.id, v: res.v, sentAt: sent.at, ackAt: now })
      if (this.plan.ownNotes.includes(res.id) || this.plan.ownNotes.includes(res.id.replace(/\.t$/, ''))) {
        const el = this.client?.core.confirmed(res.id) as Record<string, unknown> | undefined
        if (el)
          this.r.acked[res.id] = Object.fromEntries(
            TRACKED_FIELDS.filter((f) => f in el).map((f) => [f, el[f]]),
          )
      }
    }
  }

  // ---- behaviours ----

  private async behave(): Promise<void> {
    const g = this.plan.group
    switch (g.kind) {
      case 'watcher':
        return this.watcher()
      case 'gesture':
        return this.gestures()
      case 'frame-dragger':
        return this.frameDrags()
      case 'typist':
        return this.typist()
      case 'oneshot':
      case 'light':
        return this.oneShots()
    }
  }

  private running() {
    return !this.stopped && !this.ctx.stopping()
  }

  private presence(
    extra: {
      pointer?: { x: number; y: number } | null
      drag?: unknown
      editing?: string | null
      idle?: boolean
      sel?: unknown
    } = {},
  ) {
    try {
      this.client?.core.sendPresence({
        pointer: extra.pointer ?? null,
        button: 'up',
        sel: (extra.sel as never) ?? [],
        // measuring sessions look at the probe's private region (meter.ts), everyone else at the board
        view: this.plan.group.measureVisibility ? { ...PROBE_VIEW } : { x: 0, y: 0, w: 1920, h: 1080 },
        idle: extra.idle ?? false,
        editing: extra.editing ?? null,
        ...(extra.drag !== undefined ? { drag: extra.drag as never } : {}),
      })
    } catch (e) {
      this.note(e)
    }
  }

  /** Is this the board's presence probe (the first measuring watcher)? */
  private isProbe(): boolean {
    return (
      this.plan.group.kind === 'watcher' &&
      this.plan.group.measureVisibility === true &&
      this.plan.index === 0
    )
  }

  private async watcher(): Promise<void> {
    const g = this.plan.group
    const period = 1_000 / this.ctx.presenceHz
    if (this.isProbe()) {
      // the probe moves all the time, its send time in its position
      while (this.running()) {
        this.presence({ pointer: probePointer(Date.now()) })
        await sleep(period)
      }
      return
    }
    // random phase
    await sleep(Math.random() * ((g.moveMs ?? 5_000) + (g.stillMs ?? 5_000)))
    let a = Math.random() * Math.PI * 2
    const cx = 400 + Math.random() * 1_200
    const cy = 300 + Math.random() * 600
    while (this.running()) {
      const until = Date.now() + (g.moveMs ?? 5_000)
      while (this.running() && Date.now() < until) {
        a += 0.05
        this.presence({
          pointer: { x: Math.round(cx + 200 * Math.cos(a)), y: Math.round(cy + 120 * Math.sin(a)) },
        })
        await sleep(period)
      }
      this.presence({ pointer: null, idle: true })
      await sleep(g.stillMs ?? 5_000)
    }
  }

  private el(id: string): SceneElement | undefined {
    return this.client?.scene.get(id)
  }

  /** Moves a note and its label by (dx, dy) in one local step (one push). */
  private moveNotes(ids: readonly string[], dx: number, dy: number, alsoIds: readonly string[] = []) {
    const c = this.client
    if (!c) return
    c.edit((scene) => {
      for (const id of [...ids, ...alsoIds]) {
        const el = scene.get(id)
        if (!el || el.isDeleted) continue
        scene.set(id, mutated(el, { x: (el.x as number) + dx, y: (el.y as number) + dy }))
        const label = scene.get(`${id}.t`)
        if (label && !label.isDeleted)
          scene.set(label.id, mutated(label, { x: (label.x as number) + dx, y: (label.y as number) + dy }))
      }
    })
    c.core.flush()
  }

  private async drag(ids: readonly string[], dx: number, dy: number, ms: number): Promise<void> {
    const d = ++this.dragSeq
    const period = 1_000 / this.ctx.presenceHz
    const start = Date.now()
    this.r.dragStarts++
    this.r.dragIds.push(ids.length)
    let first = true
    while (Date.now() - start < ms && this.running()) {
      const f = Math.min(1, (Date.now() - start) / ms)
      const ddx = Math.round(dx * f * 10) / 10
      const ddy = Math.round(dy * f * 10) / 10
      this.presence({
        pointer: { x: 500 + ddx, y: 500 + ddy },
        sel: ids.length > 200 ? { count: ids.length } : ids.slice(0, 200),
        drag: first ? { d, ids: ids.slice(0, 500), dx: ddx, dy: ddy } : { d, dx: ddx, dy: ddy },
      })
      first = false
      await sleep(period)
    }
    this.presence({ pointer: { x: 500 + dx, y: 500 + dy }, drag: null })
  }

  private async gestures(): Promise<void> {
    const g = this.plan.group
    const own = this.plan.ownNotes
    let i = 0
    let sign = 1
    while (this.running()) {
      await sleep(jitter(g.periodMs ?? 3_000))
      if (!this.running() || own.length === 0) break
      const id = own[i++ % own.length] as string
      try {
        if (Math.random() < (g.dragShare ?? 0.5)) {
          await this.drag([id], 40 * sign, 20 * sign, g.dragMs ?? 800)
          this.moveNotes([id], 40 * sign, 20 * sign)
          sign = -sign
        } else if (Math.random() < 0.5) {
          const el = this.el(id)
          if (el) {
            this.client?.edit((scene) =>
              scene.set(
                id,
                mutated(el, { backgroundColor: el.backgroundColor === '#ffdf6b' ? '#9fd4ff' : '#ffdf6b' }),
              ),
            )
            this.client?.core.flush()
          }
        } else this.moveNotes([id], 0, 10 * sign)
      } catch (e) {
        this.note(e)
      }
    }
  }

  private async frameDrags(): Promise<void> {
    const g = this.plan.group
    const frameId = this.ctx.board.frameIds[0] as string
    const notes = this.ctx.board.frame0Notes
    const arrows = this.ctx.board.elements
      .filter((e) => e.type === 'arrow' && e.frameId === frameId)
      .map((e) => e.id)
    let sign = 1
    while (this.running()) {
      await sleep(jitter(g.periodMs ?? 30_000, 0.1))
      if (!this.running()) break
      try {
        await this.drag([frameId, ...notes], 60 * sign, 0, g.dragMs ?? 800)
        this.moveNotes([frameId, ...notes], 60 * sign, 0, arrows)
        sign = -sign
      } catch (e) {
        this.note(e)
      }
    }
  }

  private async acquire(id: string, timeoutMs = 5_000): Promise<boolean> {
    const req = ++this.leaseReq
    const got = new Promise<boolean>((resolve) => {
      this.leaseWaiters.set(req, resolve)
      setTimeout(() => resolve(false), timeoutMs)
    })
    this.lease?.send({ type: 'lease.acquire', req, id })
    const ok = await got
    this.leaseWaiters.delete(req)
    return ok
  }

  private async typist(): Promise<void> {
    const g = this.plan.group
    const own = this.plan.ownNotes
    let i = 0
    await sleep(Math.random() * (g.pauseMs ?? 4_000))
    while (this.running() && own.length > 0) {
      const id = own[i++ % own.length] as string
      const labelId = `${id}.t`
      if (!(await this.acquire(id))) {
        await sleep(g.pauseMs ?? 4_000)
        continue
      }
      const until = Date.now() + (g.burstMs ?? 8_000)
      let text = 'typing '
      while (this.running() && Date.now() < until) {
        text = text.length > 100 ? 'typing ' : `${text}abc`
        const label = this.el(labelId)
        if (label)
          this.client?.edit((scene) => scene.set(labelId, mutated(label, { text, originalText: text })), {
            editingTextElementId: labelId,
          })
        this.presence({ pointer: { x: 700, y: 400 }, editing: id })
        await sleep(g.typeEveryMs ?? 500)
      }
      // close the editor: the final push, then the release (the session's FIFO keeps the order)
      this.client?.edit(() => undefined, { editingTextElementId: null })
      this.client?.core.flush()
      try {
        await this.client?.saved(10_000)
      } catch (e) {
        this.note(e)
      }
      this.lease?.send({ type: 'lease.release', id })
      this.presence({ pointer: { x: 700, y: 400 }, editing: null })
      await sleep(g.pauseMs ?? 4_000)
    }
  }

  private async oneShots(): Promise<void> {
    const g = this.plan.group
    const own = this.plan.ownNotes.length > 0 ? this.plan.ownNotes : this.ctx.board.noteIds
    let i = Math.floor(Math.random() * own.length)
    let sign = 1
    await sleep(Math.random() * (g.periodMs ?? 1_000))
    while (this.running()) {
      const id = own[i++ % own.length] as string
      try {
        if (i % 2 === 0) this.moveNotes([id], 10 * sign, 0)
        else {
          const el = this.el(id)
          if (el) {
            this.client?.edit((scene) =>
              scene.set(
                id,
                mutated(el, { backgroundColor: el.backgroundColor === '#ffdf6b' ? '#b8e994' : '#ffdf6b' }),
              ),
            )
            this.client?.core.flush()
          }
        }
        sign = -sign
      } catch (e) {
        this.note(e)
      }
      await sleep(jitter(g.periodMs ?? 1_000, 0.2))
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    // an editor's last pushes are still in flight when the run ends: wait (up to 10 s) until they are
    // acked, so the acked-but-missing readback compares the last acked value with what is stored, not a
    // stored newer value whose ack the session never waited for
    if (this.client && this.r.pushes > 0)
      try {
        await this.client.saved(10_000)
      } catch (e) {
        this.note(e)
      }
    this.collectPushes()
    // what is still out without an ack (the readback compares against the last ACKED value)
    this.r.pendingAtEnd = [...new Set([...this.pushSentAt.values()].flatMap((p) => p.ids))]
    try {
      await this.client?.close()
    } catch {}
  }

  report(): SessionReport {
    this.collectPushes()
    return {
      key: this.plan.key,
      boardId: this.plan.boardId,
      kind: this.plan.group.kind,
      ...(this.plan.thin && this.ctx.createThinClient ? { thin: true } : {}),
      role: this.plan.user.role,
      ...this.r,
      ackMs: this.ackRec.summary(),
      ackSamples: this.ackRec.values(),
      bytes: this.meter.snapshot(),
      presenceDelayMs: this.meter.presenceDelay.summary(),
      presenceDelaySamples: this.meter.presenceDelay.values(),
      welcomeBytes: this.meter.welcomes.map((w) => ({
        jsonBytes: w.jsonBytes,
        snapshotBytes: w.snapshotBytes,
      })),
      welcomeTimes: this.meter.welcomes.map((w) => w.at),
    }
  }

  /** The client (tests and the end-of-run readback). */
  current(): HeadlessClient | null {
    return this.client
  }
}
