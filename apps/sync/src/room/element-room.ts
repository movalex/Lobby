// One board's ElementRoom (docs/EXCALIDRAW-MIGRATION.md §2.4): its sessions, the stage-0 FIFO per
// session, the room queue and the drain (group commit), the fan-out, presence, the lease table and the
// COMMIT-failure path. One room per board per process, one board file (store.ts).
//
// Stage 0 (per session, outside the drain): every ordered message (`push`, `lease.acquire`,
// `lease.release`) enters the session's FIFO; a push is parsed op by op (a bad op is INVALID in its place,
// a bad envelope closes 4099 INVALID_MESSAGE), its unknown file ids are resolved with one file-refs call,
// and its op and byte cost is paid from the session's budgets (rates.ts). A message leaves the FIFO only
// when everything before it has, so a session's order is kept; other sessions are never blocked.
//
// The drain (on setImmediate, at least 25 ms after this room's previous commit): up to 64 pushes, or
// about 8 ms of work, in one BEGIN IMMEDIATE with a SAVEPOINT per push; each push that writes gets its
// own clock. After COMMIT, and only then: one `changes` frame for the batch, serialized once and queued
// for every session (the writer included), then the acks and lease events in queue order. If COMMIT
// fails: ROLLBACK, every push of the batch is answered UNAVAILABLE, the room reopens its board file from
// disk and every session gets 4000 RECONNECT.
//
// Server writes (CR 2F-2, server-write.ts: place-notes, the "Recently deleted" restore) are queue entries
// too: run in the drain at the batch's next clock, broadcast in the batch's `changes`, acked to nobody;
// their callers' promises settle after the COMMIT (a failed COMMIT rejects them 503).

import { randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { gzip } from 'node:zlib'
import type { WireElement } from '@draftroom/canvas-schema/elements'
import { fieldGroupOf, kindOf, overlayPatch, pathUnitOf } from '@draftroom/canvas-schema/groups'
import { canonicalElement, canonicalJson } from '@draftroom/canvas-schema/hash'
import {
  ABUSE_REJECTS_PER_MINUTE,
  COORD_LIMIT,
  MAX_PUSH_BYTES,
  TOMBSTONE_MAX,
  TOMBSTONE_TTL_MS,
  WIRE_LIMITS,
} from '@draftroom/canvas-schema/limits'
import {
  type AckResult,
  CLOSE_RECONNECT,
  CLOSE_TERMINAL,
  ClientEnvelope,
  ELEMENT_SCHEMA_VERSION,
  type LeaseHookRequest,
  Op,
  PROTO,
  REJECT_CODE_INFO,
  type RejectCode,
  type ServerOp,
  type TerminalCloseReason,
} from '@draftroom/canvas-schema/protocol'
import { SYNC_INTERNAL_TIMEOUT_MS } from '@draftroom/contracts'
import type {
  ElementSessionInfo,
  ElementSocket,
  FileRefsLookup,
  ServerWriteApply,
  WorkshopStateLookup,
} from '../engine-switch.ts'
import { type FileRefAnswer, FileRefsCache } from '../file-refs.ts'
import { HttpError } from '../http/respond.ts'
import { GroupMap, type LiveCounts, WriterLedger } from './caches.ts'
import { IndexCache } from './index-keys.ts'
import { type LeaseHolderInfo, LeaseTable } from './lease.ts'
import { type El, type MergeEnv, PushApplier } from './merge.ts'
import type { RoomMetrics } from './metrics.ts'
import { Outbound } from './outbound.ts'
import { PresenceHub, rosterEntry } from './presence.ts'
import { type SessionBudgets, sessionBudgets } from './rates.ts'
import { runServerWrite, type ServerWriteEntry } from './server-write.ts'
import { BoardStore, LB_DELETED_LIMITS } from './store.ts'
import type { PreOp, PreparedPush, PushOutcome, SessionIdentity } from './types.ts'

/** The drain's limits (§2.4.3 stage 1). */
export const DRAIN = { maxPushes: 64, maxWorkMs: 8, minCommitIntervalMs: 25 } as const
/** A catch-up larger than this is a reset instead. */
const CATCH_UP_MAX_ROWS = 5_000
/** A cached reset snapshot serves joiners for this long (plus a catch-up since its clock). */
export const SNAPSHOT_CACHE_MS = 5_000
const PRESENCE_TICK_MS = 100
const LEASE_TICK_MS = 250
const DISK_LOW_FRACTION = 0.05

export interface RoomDeps {
  readonly boardId: string
  readonly path: string
  readonly log: (...a: unknown[]) => void
  readonly now: () => number
  readonly leaseTtlMs: number
  readonly fileRefs: FileRefsLookup
  readonly workshopState: WorkshopStateLookup
  readonly metrics: RoomMetrics
  readonly onSessionRemoved: (
    boardId: string,
    sid: string,
    meta: { userId: string; role: SessionIdentity['role']; name: string; color: string },
  ) => void
  readonly onDocumentChange: (boardId: string) => void
  /** the room has no session and no work left (the service may evict it) */
  readonly onIdle: (room: ElementRoom) => void
  /** the global snapshot cache budget (index.ts): register an entry's size, evict others */
  readonly snapshotBudget: (room: ElementRoom, bytes: number) => void
}

type FifoItem =
  | {
      kind: 'push'
      seq: number
      base: number
      ops: PreOp[]
      doc?: { set: Record<string, unknown> }
      cost: { ops: number; bytes: number }
      rateRejected: boolean
      paid: boolean
      files: Map<string, FileRefAnswer>
      lookup: Promise<void> | null
      receivedAt: number
    }
  | { kind: 'acquire'; req: number; id: string }
  | { kind: 'release'; id: string }

type QueueEntry =
  | { kind: 'push'; session: Session; push: PreparedPush; rejectAll?: RejectCode }
  | { kind: 'acquire'; session: Session; req: number; id: string }
  | { kind: 'release'; session: Session; id: string }
  | { kind: 'relayout'; id: string }
  | ServerWriteEntry

let handleSeq = 0

/** Rejects when `p` takes longer than `ms` (the api's 3 s timeout, enforced here too: fail closed). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

/** 503 for a server write the room could not commit or run (closing, a failed COMMIT). */
const unavailable = (message: string) => new HttpError(503, 'unavailable', message)

/**
 * The server's own writes (the lease-expiry re-fit, CR 2F-2's server writes): attributed to nobody (an
 * `lb_deleted` row names "Lobby"), never read-only.
 */
const SERVER_IDENTITY: SessionIdentity = {
  sid: 'lobby:server',
  uid: 'lobby-server',
  name: 'Lobby',
  color: '#000000',
  role: 'owner',
  guest: false,
  readonly: false,
}

export class Session {
  readonly key = ++handleSeq
  readonly identity: SessionIdentity
  readonly out: Outbound
  readonly fifo: FifoItem[] = []
  readonly budgets: SessionBudgets
  welcomed = false
  closed = false
  pumpTimer: ReturnType<typeof setTimeout> | null = null
  private readonly abuse: number[] = []

  readonly info: ElementSessionInfo
  readonly socket: ElementSocket

  constructor(
    info: ElementSessionInfo,
    socket: ElementSocket,
    now: number,
    onOverflow: () => void,
    onSent: (n: number) => void,
  ) {
    this.info = info
    this.socket = socket
    this.identity = {
      sid: info.sid,
      uid: info.uid,
      name: info.name,
      color: info.color,
      role: info.role,
      guest: info.guest,
      readonly: info.readonly,
    }
    this.budgets = sessionBudgets(info.guest, now)
    this.out = new Outbound(socket, onOverflow, onSent)
  }

  /** Counts abuse rejects; true when more than 50 fell within the last minute. */
  abused(n: number, now: number): boolean {
    for (let i = 0; i < n; i++) this.abuse.push(now)
    while (this.abuse.length && (this.abuse[0] as number) < now - 60_000) this.abuse.shift()
    return this.abuse.length > ABUSE_REJECTS_PER_MINUTE
  }

  closeWith(code: number, reason: string): void {
    if (this.closed) return
    try {
      this.socket.close(code, reason)
    } catch {
      // already closed
    }
  }
}

const opIdOf = (raw: unknown): string => {
  if (!raw || typeof raw !== 'object') return ''
  const r = raw as { id?: unknown; el?: { id?: unknown } }
  const id = typeof r.id === 'string' ? r.id : typeof r.el?.id === 'string' ? r.el.id : ''
  return id.slice(0, 200)
}

/** The version ids a parsed op needs resolved (bare, deduped by the caller). */
function fileIdsOf(op: Op): string[] {
  const out: string[] = []
  const bare = (f: string) => f.replace(/\.p[1-9][0-9]{0,3}$/, '')
  if (op.k === 'c') {
    if (op.el.type === 'image') out.push(bare(op.el.fileId))
    const file = op.el.customData?.lobby?.file as { versionId?: unknown } | undefined
    if (typeof file?.versionId === 'string') out.push(file.versionId)
  } else {
    const fid = op.g?.file?.fileId
    if (typeof fid === 'string') out.push(bare(fid))
    const file = op.c?.file as { versionId?: unknown } | null | undefined
    if (file && typeof file.versionId === 'string') out.push(file.versionId)
  }
  return out
}

export class ElementRoom {
  readonly boardId: string
  store: BoardStore
  readonly sessions = new Set<Session>()
  readonly leases: LeaseTable
  readonly presence: PresenceHub
  readonly fileCache: FileRefsCache
  private readonly index = new IndexCache()
  private readonly groups = new GroupMap()
  private readonly counts: LiveCounts = { elements: 0, items: 0 }
  private readonly ledger = new WriterLedger()
  private readonly guestCreated = new Map<string, number>()
  private readonly queue: QueueEntry[] = []
  private drainTimer: ReturnType<typeof setTimeout> | ReturnType<typeof setImmediate> | null = null
  private draining = false
  private lastCommitAt = 0
  private readonly timers: ReturnType<typeof setInterval>[] = []
  private closed = false
  /** the dot-vote state: null until the api pull answers */
  workshop: { voteOpen: boolean; anonymous: boolean } | null = null
  private workshopPull: Promise<void> | null = null
  failCommits = 0
  private heldGrants: (() => void)[] = []
  snapshotCache: {
    clock: number
    epoch: string
    elements: number
    bytes: Promise<Uint8Array>
    size: number
    at: number
  } | null = null
  private lastDiskCheck = 0
  private deletedSinceTrim = 0
  /** this room open's session id, named by its `lb_deleted` rows (the per-session retention, store.ts) */
  readonly deletedSession = randomUUID()

  private readonly deps: RoomDeps

  constructor(deps: RoomDeps) {
    this.deps = deps
    this.boardId = deps.boardId
    this.store = new BoardStore(deps.path)
    this.leases = new LeaseTable(deps.leaseTtlMs)
    this.presence = new PresenceHub(deps.now)
    this.fileCache = new FileRefsCache(deps.now)
    try {
      this.store.compact(deps.now(), { maxTombstones: TOMBSTONE_MAX, ttlMs: TOMBSTONE_TTL_MS })
    } catch (e) {
      deps.log('[room] compaction failed', this.boardId, (e as Error)?.name ?? 'error')
    }
    this.rebuildCaches()
    this.timers.push(setInterval(() => this.presenceTick(), PRESENCE_TICK_MS))
    this.timers.push(setInterval(() => this.leaseTick(), LEASE_TICK_MS))
    for (const t of this.timers) t.unref?.()
    this.pullWorkshop()
  }

  // ---- caches -------------------------------------------------------------------------------------

  private rebuildCaches(): void {
    const rows = this.store.liveIndexRows()
    this.index.reset(rows)
    this.groups.reset()
    this.counts.elements = rows.length
    this.counts.items = 0
    for (const r of rows) {
      const el = JSON.parse(r.data) as El
      this.groups.add(el.groupIds)
      if (!(el.type === 'text' && el.containerId)) this.counts.items++
    }
  }

  private pullWorkshop(): void {
    if (this.workshopPull) return
    this.workshopPull = this.deps
      .workshopState(this.boardId)
      .then((s) => {
        if (this.workshop === null) this.setWorkshop(s)
      })
      .catch(() => {
        this.deps.log('[room] workshop-state pull failed', this.boardId)
      })
      .finally(() => {
        this.workshopPull = null
      })
  }

  /** The api pushed (or the pull answered) the workshop state: stored and broadcast. */
  setWorkshop(s: { voteOpen: boolean; anonymous: boolean }): void {
    const changed =
      !this.workshop || this.workshop.voteOpen !== s.voteOpen || this.workshop.anonymous !== s.anonymous
    this.workshop = { voteOpen: s.voteOpen, anonymous: s.anonymous }
    if (changed) this.broadcast(JSON.stringify({ type: 'workshop', ...this.workshop }))
  }

  // ---- sessions -----------------------------------------------------------------------------------

  connect(info: ElementSessionInfo, socket: ElementSocket): Session {
    const s: Session = new Session(
      info,
      socket,
      this.deps.now(),
      () => this.metricsClose(CLOSE_RECONNECT, 'backpressure'),
      (n) => this.deps.metrics.inc('lobby_outbound_bytes_total', {}, n),
    )
    this.sessions.add(s)
    return s
  }

  message(s: Session, text: string) {
    if (s.closed || this.closed) return
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      if (/^\d+_/.test(text)) return this.terminal(s, 'CLIENT_TOO_OLD')
      return this.terminal(s, 'INVALID_MESSAGE')
    }
    const type = (raw as { type?: unknown } | null)?.type
    if (type === 'connect') return this.terminal(s, 'CLIENT_TOO_OLD')
    if (type === 'hello') {
      const h = raw as { proto?: unknown; schema?: unknown }
      if (typeof h.proto === 'number' && h.proto !== PROTO)
        return this.terminal(s, h.proto > PROTO ? 'SERVER_TOO_OLD' : 'CLIENT_TOO_OLD')
      if (typeof h.schema === 'number' && h.schema > ELEMENT_SCHEMA_VERSION)
        return this.terminal(s, 'SERVER_TOO_OLD')
      if (typeof h.schema === 'number' && h.schema < ELEMENT_SCHEMA_VERSION - 1)
        return this.terminal(s, 'CLIENT_TOO_OLD')
    }
    const parsed = ClientEnvelope.safeParse(raw)
    if (!parsed.success) return this.terminal(s, 'INVALID_MESSAGE')
    const msg = parsed.data
    if (msg.type === 'hello') return this.hello(s, msg.since, msg.epoch)
    if (msg.type === 'ping')
      return s.out.send(JSON.stringify({ type: 'pong', ...(msg.n !== undefined ? { n: msg.n } : {}) }))
    if (!s.welcomed) {
      // presence before hello is dropped (a client may start its pointer stream early); a push or a lease
      // message before hello is malformed: the session has no clock yet
      if (msg.type === 'presence') return
      return this.terminal(s, 'INVALID_MESSAGE')
    }
    if (msg.type === 'presence') {
      const ok = this.presence.input(
        s.identity.sid,
        s.identity.readonly,
        msg,
        this.workshop?.voteOpen === true,
      )
      if (ok) {
        this.deps.metrics.inc('lobby_presence_in_total')
        if (msg.editing) this.leases.renew(msg.editing, s.identity.sid, this.deps.now())
      }
      return
    }
    if (msg.type === 'lease.acquire') {
      s.fifo.push({ kind: 'acquire', req: msg.req, id: msg.id })
      return this.pump(s)
    }
    if (msg.type === 'lease.release') {
      s.fifo.push({ kind: 'release', id: msg.id })
      return this.pump(s)
    }
    // push: stage 0
    this.deps.metrics.inc('lobby_pushes_received_total')
    const ops: PreOp[] = msg.ops.map((rawOp) => {
      const r = Op.safeParse(rawOp)
      return r.success ? { op: r.data, id: opIdOf(rawOp) } : { reject: 'INVALID' as const, id: opIdOf(rawOp) }
    })
    const bytes = Buffer.byteLength(text, 'utf8')
    const tooLarge = bytes > MAX_PUSH_BYTES
    const item: FifoItem = {
      kind: 'push',
      seq: msg.seq,
      base: msg.base,
      ops: tooLarge ? ops.map((o) => ({ reject: 'TOO_LARGE' as const, id: o.id })) : ops,
      ...(msg.doc !== undefined ? { doc: msg.doc as { set: Record<string, unknown> } } : {}),
      cost: { ops: Math.max(1, ops.length), bytes },
      rateRejected: false,
      paid: false,
      files: new Map(),
      lookup: null,
      receivedAt: this.deps.now(),
    }
    // over budget with a backlog of more than one burst waiting: refused (RATE, SLOW_DOWN), in order
    const now = this.deps.now()
    let backlogOps = item.cost.ops
    let backlogBytes = item.cost.bytes
    for (const f of s.fifo)
      if (f.kind === 'push' && !f.paid && !f.rateRejected) {
        backlogOps += f.cost.ops
        backlogBytes += f.cost.bytes
      }
    if (
      (backlogOps > s.budgets.ops.burst && s.budgets.ops.waitMs(backlogOps, now) > 0) ||
      (backlogBytes > s.budgets.bytes.burst && s.budgets.bytes.waitMs(backlogBytes, now) > 0)
    ) {
      item.rateRejected = true
      s.out.send(JSON.stringify({ type: 'notice', code: 'SLOW_DOWN' }))
    } else if (!tooLarge) {
      // stage 0 step 2: the file ids the room has not seen, resolved with one call
      const needed = new Set<string>()
      for (const o of item.ops) if (o.op) for (const v of fileIdsOf(o.op)) needed.add(v)
      const unknown: string[] = []
      for (const v of needed) {
        const hit = this.fileCache.get(v)
        this.fileCache.note(!!hit)
        this.deps.metrics.inc('lobby_file_refs_total', { result: hit ? 'hit' : 'miss' })
        if (hit) item.files.set(v, hit)
        else unknown.push(v)
      }
      if (unknown.length)
        item.lookup = withTimeout(this.deps.fileRefs(this.boardId, unknown), SYNC_INTERNAL_TIMEOUT_MS).then(
          (res) => {
            this.fileCache.put(res)
            for (const v of unknown) {
              const a = this.fileCache.get(v)
              if (a) item.files.set(v, a)
            }
            item.lookup = null
          },
          () => {
            this.deps.log('[room] file-refs lookup failed', this.boardId, unknown.length)
            this.deps.metrics.inc('lobby_file_refs_failures_total')
            item.lookup = null
          },
        )
    }
    s.fifo.push(item)
    this.pump(s)
  }

  /** Moves the session's ready FIFO head(s) into the room queue, in order. */
  private pump(s: Session): void {
    if (s.closed || s.pumpTimer) return
    while (s.fifo.length) {
      const item = s.fifo[0] as FifoItem
      if (item.kind === 'push') {
        if (item.lookup) {
          item.lookup.then(() => this.pump(s))
          return
        }
        if (!item.rateRejected && !item.paid) {
          const now = this.deps.now()
          const wait = Math.max(
            s.budgets.ops.waitMs(item.cost.ops, now),
            s.budgets.bytes.waitMs(item.cost.bytes, now),
          )
          if (wait > 0) {
            s.pumpTimer = setTimeout(() => {
              s.pumpTimer = null
              this.pump(s)
            }, wait)
            return
          }
          s.budgets.ops.take(item.cost.ops, now)
          s.budgets.bytes.take(item.cost.bytes, now)
          item.paid = true
        }
        s.fifo.shift()
        const push: PreparedPush = {
          seq: item.seq,
          base: item.base,
          ops: item.ops,
          ...(item.doc ? { doc: item.doc } : {}),
          files: item.files,
          receivedAt: item.receivedAt,
        }
        this.enqueue({
          kind: 'push',
          session: s,
          push,
          ...(item.rateRejected ? { rejectAll: 'RATE' as const } : {}),
        })
        continue
      }
      s.fifo.shift()
      this.enqueue(
        item.kind === 'acquire'
          ? { kind: 'acquire', session: s, req: item.req, id: item.id }
          : { kind: 'release', session: s, id: item.id },
      )
    }
  }

  closed_(s: Session): void {
    if (s.closed) return
    s.closed = true
    s.out.close()
    if (s.pumpTimer) clearTimeout(s.pumpTimer)
    s.fifo.length = 0
    this.sessions.delete(s)
    this.presence.forgetRecipient(s.key)
    if (s.welcomed) {
      const sid = s.identity.sid
      const stillThere = [...this.sessions].some((o) => o.welcomed && o.identity.sid === sid)
      if (!stillThere) {
        this.presence.remove(sid)
        this.broadcast(JSON.stringify({ type: 'roster', events: [{ k: 'leave', sid }] }))
      }
    }
    this.deps.onSessionRemoved(this.boardId, s.identity.sid, {
      userId: s.identity.uid,
      role: s.identity.role,
      name: s.identity.name,
      color: s.identity.color,
    })
    this.maybeIdle()
  }

  /** Ends a session: 4099 with a terminal reason, or 4000 RECONNECT without one. */
  closeSession(sid: string, reason?: string): void {
    for (const s of [...this.sessions])
      if (s.identity.sid === sid) {
        if (reason) s.closeWith(CLOSE_TERMINAL, reason)
        else s.closeWith(CLOSE_RECONNECT, 'RECONNECT')
        this.metricsClose(reason ? CLOSE_TERMINAL : CLOSE_RECONNECT, reason ?? 'RECONNECT')
        this.closed_(s)
      }
  }

  private terminal(s: Session, reason: TerminalCloseReason): void {
    this.metricsClose(CLOSE_TERMINAL, reason)
    s.closeWith(CLOSE_TERMINAL, reason)
    this.closed_(s)
  }

  private metricsClose(code: number, reason: string): void {
    this.deps.metrics.inc('lobby_closes_total', { code: String(code), reason })
  }

  private maybeIdle(): void {
    if (this.sessions.size === 0 && this.queue.length === 0 && !this.draining) this.deps.onIdle(this)
  }

  get sessionCount(): number {
    return this.sessions.size
  }

  // ---- hello / welcome ----------------------------------------------------------------------------

  private roster() {
    const seen = new Set<string>()
    const out = []
    for (const s of this.sessions)
      if (s.welcomed && !seen.has(s.identity.sid)) {
        seen.add(s.identity.sid)
        out.push(rosterEntry(s.identity))
      }
    return out
  }

  private hello(s: Session, since: number, epoch: string | null): void {
    const first = !s.welcomed
    const now = this.deps.now()
    if (first) {
      const already = [...this.sessions].some(
        (o) => o !== s && o.welcomed && o.identity.sid === s.identity.sid,
      )
      s.welcomed = true
      this.deps.metrics.inc('lobby_joins_total')
      if (!already)
        this.broadcast(
          JSON.stringify({ type: 'roster', events: [{ k: 'join', p: rosterEntry(s.identity) }] }),
          s,
        )
    }
    const meta = this.store.meta
    const base = {
      type: 'welcome' as const,
      proto: PROTO,
      schema: ELEMENT_SCHEMA_VERSION,
      sid: s.identity.sid,
      you: {
        uid: s.identity.uid,
        name: s.identity.name,
        color: s.identity.color,
        role: s.identity.role,
        guest: s.identity.guest,
      },
      readonly: s.identity.readonly,
      epoch: meta.epoch,
      horizon: meta.horizon,
      doc: this.store.docAll(),
      leases: this.leases.live(now),
      roster: this.roster(),
      workshop: this.workshop ?? { voteOpen: false, anonymous: false },
      drags: this.presence.activeDrags(),
      limits: { ...WIRE_LIMITS, leaseTtlMs: this.leases.ttlMs },
    }
    const catchUp =
      epoch === meta.epoch &&
      since >= meta.horizon &&
      since <= meta.clock &&
      this.store.countSince(since) <= CATCH_UP_MAX_ROWS
    if (catchUp) {
      const ops: ServerOp[] = this.store.since(since).map((r) => ({ k: 'c', el: r.el }))
      s.out.send(JSON.stringify({ ...base, clock: meta.clock, reset: false, catchUp: ops, snapshot: null }))
    } else {
      this.deps.metrics.inc('lobby_resets_total')
      const snap = this.snapshotFor(now)
      const welcome = snap.bytes.then((b) =>
        JSON.stringify({
          ...base,
          clock: snap.clock,
          reset: true,
          catchUp: null,
          snapshot: { elements: snap.elements, bytes: b.byteLength },
        }),
      )
      s.out.send(welcome)
      s.out.send(snap.bytes)
      if (snap.clock < meta.clock) {
        const ops: ServerOp[] = this.store.since(snap.clock).map((r) => ({ k: 'c', el: r.el }))
        s.out.send(JSON.stringify({ type: 'changes', clock: meta.clock, ops }))
      }
    }
    // everyone's current cursors, so a late joiner does not wait for the next move
    const peers = this.presence.current().filter((p) => p.sid !== s.identity.sid)
    if (peers.length) s.out.send(JSON.stringify({ type: 'presence', peers }))
  }

  /** The reset snapshot (tombstones included), compressed once and cached for 5 s. */
  private snapshotFor(now: number): { clock: number; elements: number; bytes: Promise<Uint8Array> } {
    const meta = this.store.meta
    const c = this.snapshotCache
    if (c && c.epoch === meta.epoch && now - c.at <= SNAPSHOT_CACHE_MS) return c
    const rows = this.store.snapshotJson()
    const doc = this.store.docAll()
    const json = `{"type":"snapshot","epoch":${JSON.stringify(meta.epoch)},"clock":${meta.clock},"horizon":${meta.horizon},"elements":[${rows.join(',')}],"doc":${JSON.stringify(doc)}}`
    const bytes = new Promise<Uint8Array>((resolve, reject) =>
      gzip(json, (err, out) =>
        err ? reject(err) : resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength)),
      ),
    )
    const entry = {
      clock: meta.clock,
      epoch: meta.epoch,
      elements: rows.length,
      bytes,
      size: json.length,
      at: now,
    }
    this.snapshotCache = entry
    bytes.then((b) => this.deps.snapshotBudget(this, b.byteLength)).catch(() => {})
    return entry
  }

  dropSnapshotCache(): void {
    this.snapshotCache = null
  }

  /** Sends `frame` to every welcomed session (except `except`). */
  private broadcast(frame: string, except?: Session): void {
    for (const s of this.sessions) if (s.welcomed && s !== except) s.out.send(frame)
  }

  // ---- presence and lease ticks -------------------------------------------------------------------

  private presenceTick(): void {
    const recipients = [...this.sessions]
      .filter((s) => s.welcomed && !s.closed)
      .map((s) => ({
        sid: s.identity.sid,
        key: s.key,
        congested: s.out.congested,
        send: (f: string) => {
          s.out.send(f)
          this.deps.metrics.inc('lobby_presence_out_total')
        },
      }))
    this.presence.tick(recipients)
  }

  private leaseTick(): void {
    this.checkDisk() // at most once a minute: DISK when free space is below 5%
    const expired = this.leases.expire(this.deps.now())
    for (const l of expired) {
      this.broadcast(JSON.stringify({ type: 'lease', id: l.id, holder: null }))
      // rule 6: the holder vanished; the server re-fits the container if its geometry changed since
      this.enqueue({ kind: 'relayout', id: l.id })
    }
  }

  // ---- the room queue and the drain ---------------------------------------------------------------

  private enqueue(e: QueueEntry): void {
    this.queue.push(e)
    this.schedule()
  }

  private schedule(): void {
    if (this.drainTimer || this.draining || this.closed || !this.queue.length) return
    const wait = this.lastCommitAt + DRAIN.minCommitIntervalMs - this.deps.now()
    if (wait > 0)
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null
        this.drain()
      }, wait)
    else
      this.drainTimer = setImmediate(() => {
        this.drainTimer = null
        this.drain()
      })
  }

  private env(now: number): MergeEnv {
    return {
      store: this.store,
      leases: this.leases,
      index: this.index,
      groups: this.groups,
      counts: this.counts,
      voteOpen: this.workshop ? this.workshop.voteOpen : null,
      fileCache: this.fileCache,
      ledger: this.ledger,
      guestCreated: this.guestCreated,
      now,
      epoch: this.store.meta.epoch,
      deletedSession: this.deletedSession,
      nonce: () => Math.floor(Math.random() * 2 ** 31),
    }
  }

  /**
   * CR 2F-2: a server write (server-write.ts), queued with the sessions' pushes. Resolves with the write's
   * result after its batch COMMITs; rejects with the write's own error (its SAVEPOINT rolled back), or 503
   * `unavailable` when the COMMIT fails or the room closes first.
   */
  serverWrite<T>(apply: ServerWriteApply<T>): Promise<T> {
    if (this.closed) return Promise.reject(unavailable('This board is closing. Try again in a moment.'))
    return new Promise<T>((resolve, reject) =>
      this.enqueue({
        kind: 'server',
        apply: apply as ServerWriteApply<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      }),
    )
  }

  /** Runs one batch. Synchronous from BEGIN to the fan-out. */
  drain(): void {
    if (this.draining || this.closed || !this.queue.length) return
    this.draining = true
    try {
      this.drainBatch()
    } finally {
      this.draining = false
    }
    if (this.queue.length) this.schedule()
    else this.maybeIdle()
  }

  private drainBatch(): void {
    const t0 = performance.now()
    const now = this.deps.now()
    const store = this.store
    const startClock = store.meta.clock
    let clock = startClock
    const deliveries: (() => void)[] = []
    /** the lease replies alone: they are sent even when the COMMIT fails (leases live in memory) */
    const leaseDeliveries: (() => void)[] = []
    const pushEntries: { session: Session; push: PreparedPush }[] = []
    /** the batch's server writes, in queue order, with their answers (settled after the COMMIT) */
    const serverWrites: { entry: ServerWriteEntry; ok: boolean; value: unknown }[] = []
    const before = new Map<string, WireElement | null>()
    const after = new Map<string, WireElement>()
    const doc: Record<string, unknown> = {}
    let pushes = 0
    store.begin()
    if (this.workshop === null) this.pullWorkshop()
    while (this.queue.length && pushes < DRAIN.maxPushes && performance.now() - t0 < DRAIN.maxWorkMs) {
      const e = this.queue.shift() as QueueEntry
      if (e.kind === 'acquire') {
        const d = this.acquire(e.session, e.req, e.id, now)
        deliveries.push(d)
        leaseDeliveries.push(d)
        continue
      }
      if (e.kind === 'release') {
        const d = this.release(e.session, e.id, now)
        deliveries.push(d)
        leaseDeliveries.push(d)
        continue
      }
      if (e.kind === 'server') {
        pushes++
        const touched = { caches: false }
        store.savepoint('push')
        try {
          const done = runServerWrite(
            {
              store,
              clock: clock + 1,
              now,
              identity: SERVER_IDENTITY,
              deletedSession: this.deletedSession,
              index: this.index,
              groups: this.groups,
              counts: this.counts,
              ledger: this.ledger,
              env: () => this.env(now),
            },
            e.apply,
            touched,
          )
          store.release('push')
          if (done.wrote) {
            clock++
            for (const [id, ch] of done.changed) {
              if (!before.has(id)) before.set(id, ch.before)
              after.set(id, ch.after)
            }
            Object.assign(doc, done.doc)
            this.deletedSinceTrim += done.deletions
            this.snapshotCache = null
          }
          serverWrites.push({ entry: e, ok: true, value: done.result })
        } catch (err) {
          store.rollbackTo('push')
          if (touched.caches) this.rebuildCaches()
          const code = err instanceof HttpError ? err.code : ((err as Error)?.name ?? 'error')
          this.deps.log('[room] server write refused', this.boardId, code)
          serverWrites.push({ entry: e, ok: false, value: err })
        }
        continue
      }
      if (e.kind === 'relayout') {
        store.savepoint('push')
        try {
          const push: PreparedPush = {
            seq: 0,
            base: clock,
            ops: [],
            files: new Map(),
            receivedAt: now,
            relayout: e.id,
          }
          const outcome = new PushApplier(this.env(now), SERVER_IDENTITY, push, clock + 1).run()
          store.release('push')
          if (outcome.clock !== null) {
            clock = outcome.clock
            for (const [id, ch] of outcome.changed) {
              if (!before.has(id)) before.set(id, ch.before)
              after.set(id, ch.after)
            }
          }
        } catch (err) {
          store.rollbackTo('push')
          this.deps.log('[room] lease-expiry re-fit failed', this.boardId, (err as Error)?.name)
          this.rebuildCaches()
        }
        continue
      }
      pushes++
      pushEntries.push(e)
      let outcome: PushOutcome
      if (e.rejectAll) {
        outcome = this.rejectedOutcome(e.push, e.rejectAll)
      } else {
        store.savepoint('push')
        try {
          outcome = new PushApplier(this.env(now), e.session.identity, e.push, clock + 1).run()
          store.release('push')
        } catch (err) {
          store.rollbackTo('push')
          this.deps.log(
            '[room] push failed; answered INVALID',
            this.boardId,
            e.session.identity.sid,
            (err as Error)?.name,
          )
          this.rebuildCaches()
          outcome = this.rejectedOutcome(e.push, 'INVALID')
        }
      }
      if (outcome.clock !== null) {
        clock = outcome.clock
        for (const [id, ch] of outcome.changed) {
          if (!before.has(id)) before.set(id, ch.before)
          after.set(id, ch.after)
          if (ch.after.isDeleted && !ch.before?.isDeleted) this.deletedSinceTrim++
        }
        Object.assign(doc, outcome.doc)
      }
      const ackClock = outcome.clock ?? clock
      deliveries.push(this.ackDelivery(e.session, e.push, outcome, ackClock))
    }
    if (clock !== startClock) store.setClock(clock)
    const tc = performance.now()
    try {
      if (this.failCommits > 0) {
        this.failCommits--
        throw new Error('injected COMMIT failure')
      }
      store.commit()
    } catch (err) {
      store.rollback()
      this.commitFailed(pushEntries, leaseDeliveries, err as Error)
      for (const w of serverWrites)
        w.entry.reject(w.ok ? unavailable('The board could not save this change. Try again.') : w.value)
      return
    }
    const t1 = performance.now()
    this.deps.metrics.fsyncMs.observe(t1 - tc)
    this.deps.metrics.commitMs.observe(t1 - t0)
    if (pushes) this.deps.metrics.pushesPerCommit.observe(pushes)
    this.lastCommitAt = this.deps.now()
    store.meta.clock = clock
    // the cached reset snapshot stays valid for its 5 s: a joiner gets it plus a catch-up since its clock
    // (§2.4.5), so a join storm on a busy board compresses one snapshot, not one per write
    // after COMMIT: the batch's changes (once, for everyone), then acks and lease events in order
    if (after.size || Object.keys(doc).length) {
      const ops: ServerOp[] = []
      for (const [id, el] of after) ops.push(serverOp(before.get(id) ?? null, el))
      const frame = JSON.stringify({
        type: 'changes',
        clock,
        ops,
        ...(Object.keys(doc).length ? { doc: { set: doc } } : {}),
      })
      this.broadcast(frame)
      this.deps.onDocumentChange(this.boardId)
    }
    for (const d of deliveries) d()
    for (const w of serverWrites) (w.ok ? w.entry.resolve : w.entry.reject)(w.value)
    if (this.deletedSinceTrim >= LB_DELETED_LIMITS.trimEvery) {
      this.deletedSinceTrim = 0
      try {
        store.trimDeleted(LB_DELETED_LIMITS, this.deletedSession)
      } catch {
        this.deps.log('[room] lb_deleted trim failed', this.boardId)
      }
    }
  }

  private rejectedOutcome(push: PreparedPush, code: RejectCode): PushOutcome {
    return {
      clock: null,
      results: push.ops.map((o) => ({ id: o.id, ok: false as const, code, el: null })),
      derived: [],
      changed: new Map(),
      doc: {},
      codes: push.ops.map(() => code),
    }
  }

  private ackDelivery(s: Session, push: PreparedPush, outcome: PushOutcome, clock: number): () => void {
    return () => {
      const now = this.deps.now()
      for (const c of outcome.codes) this.deps.metrics.inc('lobby_ops_total', { result: c })
      this.deps.metrics.ackMs.observe(now - push.receivedAt)
      if (s.closed) return
      s.out.send(
        JSON.stringify({
          type: 'ack',
          seq: push.seq,
          clock,
          r: outcome.results,
          ...(outcome.derived.length ? { derived: outcome.derived } : {}),
          ...(outcome.docDenied ? { docDenied: outcome.docDenied } : {}),
        }),
      )
      const abuse = outcome.codes.filter((c) => c !== 'ok' && REJECT_CODE_INFO[c as RejectCode]?.abuse).length
      if (abuse && s.abused(abuse, now)) this.terminal(s, 'INVALID_MESSAGE')
    }
  }

  private commitFailed(
    pushes: { session: Session; push: PreparedPush }[],
    leaseDeliveries: (() => void)[],
    err: Error,
  ): void {
    this.deps.log('[room] COMMIT failed; batch answered UNAVAILABLE, reopening', this.boardId, err.name)
    this.deps.metrics.inc('lobby_commit_failures_total')
    for (const { session, push } of pushes) {
      const outcome = this.rejectedOutcome(push, 'UNAVAILABLE')
      this.ackDelivery(session, push, outcome, this.store.meta.clock)()
    }
    for (const d of leaseDeliveries) d()
    this.checkDisk(true)
    // nothing in memory changed: reopen the board file from disk and resync every session
    try {
      this.store.close()
    } catch {
      // closing a failed handle
    }
    this.store = new BoardStore(this.deps.path)
    this.rebuildCaches()
    this.snapshotCache = null
    for (const s of [...this.sessions]) {
      s.closeWith(CLOSE_RECONNECT, 'RECONNECT')
      this.metricsClose(CLOSE_RECONNECT, 'RECONNECT')
      this.closed_(s)
    }
  }

  private checkDisk(force = false): void {
    const now = this.deps.now()
    if (!force && now - this.lastDiskCheck < 60_000) return
    this.lastDiskCheck = now
    try {
      const st = statfsSync(dirname(this.deps.path))
      if (st.blocks > 0 && st.bavail / st.blocks < DISK_LOW_FRACTION) {
        this.broadcast(JSON.stringify({ type: 'notice', code: 'DISK' }))
      }
    } catch {
      // statfs unavailable: no notice
    }
  }

  // ---- lease messages (ordered with pushes) -------------------------------------------------------

  private holderOf(s: Session): LeaseHolderInfo {
    return { sid: s.identity.sid, uid: s.identity.uid, name: s.identity.name }
  }

  private acquire(s: Session, req: number, id: string, now: number): () => void {
    if (s.identity.readonly) {
      this.deps.metrics.inc('lobby_lease_total', { result: 'deny' })
      return () =>
        s.out.send(
          JSON.stringify({
            type: 'lease.deny',
            req,
            id,
            holder: this.leases.holderOf(id, now) ?? {
              sid: 'read-only',
              uid: 'read-only',
              name: 'read-only',
            },
          }),
        )
    }
    const r = this.leases.acquire(id, this.holderOf(s), now)
    if (!r.granted) {
      this.deps.metrics.inc('lobby_lease_total', { result: 'deny' })
      return () => s.out.send(JSON.stringify({ type: 'lease.deny', req, id, holder: r.holder }))
    }
    this.deps.metrics.inc('lobby_lease_total', { result: 'grant' })
    const holder = this.holderOf(s)
    const grant = () => {
      if (s.closed || !this.leases.stillGranted(id, s.identity.sid, r.seq, this.deps.now())) return
      s.out.send(JSON.stringify({ type: 'lease.grant', req, id, ttlMs: this.leases.ttlMs }))
      if (r.fresh) this.broadcast(JSON.stringify({ type: 'lease', id, holder }))
    }
    const hook = this.leases.hook
    if (hook.mode === 'delay' && hook.ms > 0) return () => void setTimeout(grant, hook.ms).unref?.()
    if (hook.mode === 'hold') return () => void this.heldGrants.push(grant)
    return grant
  }

  private release(s: Session, id: string, now: number): () => void {
    const released = this.leases.release(id, s.identity.sid, now)
    return () => {
      if (released) this.broadcast(JSON.stringify({ type: 'lease', id, holder: null }))
    }
  }

  /** The test hook of §2.4.6 (lease-hook). */
  leaseHook(req: LeaseHookRequest): void {
    if (req.mode === 'release') {
      const held = this.heldGrants
      this.heldGrants = []
      for (const g of held) g()
      this.leases.hook = { mode: 'off' }
      return
    }
    if (req.mode === 'off') {
      const held = this.heldGrants
      this.heldGrants = []
      for (const g of held) g()
    }
    this.leases.hook = req
  }

  // ---- reads for routes and hooks -----------------------------------------------------------------

  /** The test snapshot: every element, tombstones included, in (id) order. */
  testSnapshot() {
    const m = this.store.meta
    return {
      clock: m.clock,
      epoch: m.epoch,
      horizon: m.horizon,
      elements: this.store.allJsonById().map((d) => JSON.parse(d) as WireElement),
    }
  }

  /** The internal snapshot (live elements and the doc). */
  liveSnapshot() {
    return {
      format: 'lobby-elements' as const,
      schema: ELEMENT_SCHEMA_VERSION,
      clock: this.store.meta.clock,
      elements: this.store.liveJson().map((d) => JSON.parse(d) as Record<string, unknown>),
      doc: this.store.docAll(),
    }
  }

  gauges() {
    const c = this.store.counts()
    return {
      boardId: this.boardId,
      sessions: this.sessions.size,
      elements: c.live,
      tombstones: c.dead,
      dbBytes: this.store.sizeBytes(),
    }
  }

  get queueLength(): number {
    return this.queue.length
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const t of this.timers) clearInterval(t)
    if (this.drainTimer) {
      clearTimeout(this.drainTimer as ReturnType<typeof setTimeout>)
      clearImmediate(this.drainTimer as ReturnType<typeof setImmediate>)
      this.drainTimer = null
    }
    for (const s of [...this.sessions]) {
      s.closeWith(CLOSE_RECONNECT, 'RECONNECT')
      s.closed = true
      s.out.close()
      if (s.pumpTimer) clearTimeout(s.pumpTimer)
    }
    this.sessions.clear()
    for (const e of this.queue.splice(0))
      if (e.kind === 'server') e.reject(unavailable('This board is closing. Try again in a moment.'))
    this.store.close()
  }

  /** Whether the room has work in flight (queued pushes, a batch, a lookup). */
  get busy(): boolean {
    return this.queue.length > 0 || this.draining || [...this.sessions].some((s) => s.fifo.length > 0)
  }
}

// ---- the batch's server ops ---------------------------------------------------------------------------

const eqJson = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null)
type Ref = { id: string; type: 'arrow' | 'text' }

/**
 * The server op for one element changed in a batch: a patch of the groups that changed (the whole unit
 * for `path`), the customData.lobby keys, boundElements by id and lobbyServer, with the new `v`, `vn`,
 * the previous `pv` and `updated`; or the full element (`c`) for a create, or whenever a patch could not
 * reproduce the stored element exactly (checked by overlaying it).
 */
export function serverOp(before: WireElement | null, after: WireElement): ServerOp {
  const full: ServerOp = { k: 'c', el: after }
  if (!before) return full
  const b = before as El
  const a = after as El
  if (kindOf(b) !== kindOf(a) || b.type !== a.type) return full
  const g: Record<string, Record<string, unknown>> = {}
  for (const f of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (f === 'customData' || f === 'boundElements') continue
    if (eqJson(b[f], a[f])) continue
    const grp = fieldGroupOf(a, f)
    if (!grp) {
      if (['version', 'versionNonce', 'updated'].includes(f)) continue
      return full
    }
    const fields = g[grp] ?? {}
    fields[f] = a[f]
    g[grp] = fields
  }
  if (g.path) g.path = pathUnitOf(a)
  const op: Record<string, unknown> = {
    k: 'p',
    id: a.id,
    v: a.version,
    vn: a.versionNonce,
    pv: b.version,
    updated: a.updated,
  }
  if (Object.keys(g).length) op.g = g
  const la = (b.customData?.lobby ?? {}) as Record<string, unknown>
  const lb = (a.customData?.lobby ?? {}) as Record<string, unknown>
  const c: Record<string, unknown> = {}
  for (const k of new Set([...Object.keys(la), ...Object.keys(lb)]))
    if (!eqJson(la[k], lb[k])) c[k] = lb[k] ?? null
  if (Object.keys(c).length) op.c = c
  const bb = (b.boundElements ?? []) as Ref[]
  const ab = (a.boundElements ?? []) as Ref[]
  if (!eqJson(bb, ab)) {
    const add = ab.filter((r) => !bb.some((x) => x.id === r.id && x.type === r.type))
    const rm = bb.filter((r) => !ab.some((x) => x.id === r.id)).map((r) => r.id)
    op.b = { add, rm }
  }
  if (!eqJson(b.customData?.lobbyServer, a.customData?.lobbyServer)) {
    if (a.customData?.lobbyServer === undefined) return full
    op.lobbyServer = a.customData.lobbyServer
  }
  // the patch must reproduce the stored element exactly
  const rebuilt = {
    ...overlayPatch(b, op as never),
    version: a.version,
    versionNonce: a.versionNonce,
    updated: a.updated,
  }
  if (canonicalJson(canonicalElement(rebuilt)) !== canonicalJson(canonicalElement(a))) return full
  if (
    Object.values(g).some((fields) =>
      Object.values(fields).some((v) => typeof v === 'number' && Math.abs(v) > COORD_LIMIT * 10),
    )
  )
    return full
  return op as ServerOp
}

/** The ack result of an op the room could not even parse (stage 0). */
export const invalidResult = (id: string): AckResult => ({ id, ok: false, code: 'INVALID', el: null })
