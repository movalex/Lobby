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
//
// Push receipts (CONTRACTS_REV 11, W5-ENG-2): a push with a receipt id (`rid`) that wrote, with no op
// refused for a retryable reason, gets a row in lb_receipts (schema.ts) in the batch's transaction, so it
// commits with the push; a `receipts` query is a queue entry too (ordered after everything queued before
// it, every socket's), answered after the batch's COMMIT from the file: which of the named receipts this
// user's pushes left, and from which clock its receipts are complete.

import { randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { gzip } from 'node:zlib'
import { redactTombstone, type WireElement } from '@draftroom/canvas-schema/elements'
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
import { CatchUpCache, catchUpChangesJson, catchUpWelcomeJson } from './catch-up.ts'
import { closeTerminal } from './closing.ts'
import { IndexCache } from './index-keys.ts'
import { type LeaseHolderInfo, LeaseTable } from './lease.ts'
import { type El, type MergeEnv, PushApplier } from './merge.ts'
import type { RoomMetrics } from './metrics.ts'
import { Outbound } from './outbound.ts'
import { CommitPacer } from './pacing.ts'
import { CONTRACTS_FRAME, PresenceHub, rosterEntry } from './presence.ts'
import { type SessionBudgets, sessionBudgets } from './rates.ts'
import { RosterBatch } from './roster-batch.ts'
import { RECEIPTS } from './schema.ts'
import { runServerWrite, type ServerWriteEntry } from './server-write.ts'
import { BoardStore, LB_DELETED_LIMITS } from './store.ts'
import type { PreOp, PreparedPush, PushOutcome, SessionIdentity } from './types.ts'

/**
 * What a batch wrote of its receipt gaps (RCPT-1, element-room.ts writeReceiptGaps), applied after its COMMIT:
 * the batch's own gaps (`fresh`, null when it only wrote older ones), where they went, what lb_meta holds
 * now and what is still only in memory.
 */
interface ReceiptGapWrite {
  readonly fresh: Map<string, number> | null
  readonly where: 'file' | 'meta' | 'memory'
  readonly meta: Map<string, number>
  readonly unwritten: Map<string, number> | null
}

/** The drain's limits (§2.4.3 stage 1); a busy room's hold is pacing.ts DRAIN_PACING. */
export const DRAIN = { maxPushes: 64, maxWorkMs: 8, minCommitIntervalMs: 25 } as const
/** A catch-up larger than this is a reset instead. */
const CATCH_UP_MAX_ROWS = 5_000
/**
 * A cached reset snapshot (gzip, built once) serves every joiner while the board moved on from its clock
 * by at most `maxRowsBehind` rows and it is at most `maxAgeMs` old; each joiner gets the rows since its
 * clock as a catch-up `changes` frame right after it (§2.4.5), so what a joiner holds is the same. Before,
 * the cache lived 5 s whatever the board did: a join ramp of 200 sessions in 60 s on a board edited 20
 * times a second rebuilt and re-gzipped the 3 MB snapshot 12 times (B9, the join storm's event-loop tail).
 * A snapshot whose clock is the board's clock is reused as long as it lives: the bytes would be the same.
 * A delete still drops the cache at once (W5-02: a joiner must not get a deleted element's words).
 */
export const SNAPSHOT_REUSE = { maxAgeMs: 60_000, maxRowsBehind: 500 } as const
/** The old name of the cache's life, kept for callers that read it: the longest a snapshot may be reused. */
export const SNAPSHOT_CACHE_MS = SNAPSHOT_REUSE.maxAgeMs
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
      rid?: string
    }
  | { kind: 'acquire'; req: number; id: string }
  | { kind: 'release'; id: string }
  | { kind: 'receipts'; req: number; ids: string[] }

type QueueEntry =
  | { kind: 'push'; session: Session; push: PreparedPush; rejectAll?: RejectCode }
  | { kind: 'acquire'; session: Session; req: number; id: string }
  | { kind: 'release'; session: Session; id: string }
  | { kind: 'receipts'; session: Session; req: number; ids: string[] }
  | { kind: 'relayout'; id: string }
  | ServerWriteEntry

let handleSeq = 0

/**
 * `hello` frames a session may send: at most `burst` within `windowMs`, more close it 4099 RATE_LIMITED
 * before any work (V2: a viewer sending 400 hellos made the room build and serialize 400 catch-ups of up
 * to 5,000 rows, and stalled every board of the process for 8-9 s). A client sends one per connection and
 * one per resync.
 */
export const HELLO_LIMIT = { burst: 5, windowMs: 10_000 } as const
/**
 * `receipts` queries a session may send (CONTRACTS_REV 11): at most `burst` within `windowMs`, more close it
 * 4099 RATE_LIMITED. A client asks once per welcome (after a reconnect, a reload) and once per adopted queue.
 */
export const RECEIPTS_QUERY_LIMIT = { burst: 10, windowMs: 10_000 } as const
/**
 * The welcome work one USER (uid) may cause across all its sockets and boards of the process, in rows (a
 * catch-up's rows, a reset's elements; at least `minCost` a welcome): a token bucket of `burst` rows that
 * refills `perSecond`. A hello past it closes its socket 4099 RATE_LIMITED before any work (V2's
 * re-check: HELLO_LIMIT counted per socket, so one viewer with 40 sockets had 200 catch-ups of 5,000 rows
 * built, 4-5 s of every join on the process). A person opening a few of the largest boards at once stays
 * well inside it; the fair queue below bounds what one user's welcomes cost everyone else.
 */
export const WELCOME_BUDGET_PER_USER = { burst: 200_000, perSecond: 20_000, minCost: 50 } as const
const userBudgets = new Map<string, { tokens: number; at: number }>()
/** Takes the cost of one welcome of `rows` rows from `uid`'s budget; false when it has not enough left. */
export function userWelcomeAllowed(uid: string, rows: number, now: number): boolean {
  const { burst, perSecond, minCost } = WELCOME_BUDGET_PER_USER
  const cost = Math.max(minCost, rows)
  const b = userBudgets.get(uid) ?? { tokens: burst, at: now }
  b.tokens = Math.min(burst, b.tokens + (Math.max(0, now - b.at) / 1000) * perSecond)
  b.at = now
  userBudgets.set(uid, b)
  if (userBudgets.size > 10_000)
    for (const [k, v] of userBudgets)
      if (v.tokens + ((now - v.at) / 1000) * perSecond >= burst) userBudgets.delete(k)
  if (b.tokens < cost) return false
  b.tokens -= cost
  return true
}

/**
 * The welcomes of every room of the process are built a slice at a time (at most `sliceMs` of work, then
 * the event loop runs other boards' pushes and frames): a join storm, or one board's large catch-ups, no
 * longer block every other board (PERF-05's join queue, for the new engine). Fair by user (V2's re-check):
 * each user (uid) has its own queue and the slices take one hello per user in turn, so a user with many
 * sockets and large catch-ups delays another user's join by at most one of its welcomes, not all of them.
 */
export const HELLO_SLICE_MS = 20
const helloQueues = new Map<string, (() => void)[]>()
let helloTimer: ReturnType<typeof setImmediate> | null = null
function queueHello(user: string, run: () => void): void {
  const q = helloQueues.get(user)
  if (q) q.push(run)
  else helloQueues.set(user, [run])
  if (!helloTimer) helloTimer = setImmediate(drainHellos)
}
function drainHellos(): void {
  helloTimer = null
  const t0 = performance.now()
  while (helloQueues.size) {
    // the user first in line runs one hello and goes to the back of the line
    const [user, q] = helloQueues.entries().next().value as [string, (() => void)[]]
    const run = q.shift()
    helloQueues.delete(user)
    if (q.length) helloQueues.set(user, q)
    try {
      run?.()
    } catch {
      // a failed welcome closes nothing else; the session's socket error path handles it
    }
    if (performance.now() - t0 >= HELLO_SLICE_MS) break
  }
  if (helloQueues.size) helloTimer = setImmediate(drainHellos)
}

/** Live leases one session may hold at once; a further new one is denied (V2: lease squatting). */
export const MAX_LEASES_PER_SESSION = 4
/**
 * Live leases one USER may hold in a room across its tabs (V2's re-check: the per-session cap let one
 * editor with 13 tabs hold 52 leases). Two tabs' worth: a person types in one text at a time per tab.
 */
export const MAX_LEASES_PER_USER = 8

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
  private readonly hellos: number[] = []
  private readonly receiptQueries: number[] = []

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

  /** Counts a `hello`; false when it is over HELLO_LIMIT. */
  helloAllowed(now: number): boolean {
    this.hellos.push(now)
    while (this.hellos.length && (this.hellos[0] as number) <= now - HELLO_LIMIT.windowMs) this.hellos.shift()
    return this.hellos.length <= HELLO_LIMIT.burst
  }

  /** Counts a `receipts` query; false when it is over RECEIPTS_QUERY_LIMIT. */
  receiptsAllowed(now: number): boolean {
    const q = this.receiptQueries
    q.push(now)
    while (q.length && (q[0] as number) <= now - RECEIPTS_QUERY_LIMIT.windowMs) q.shift()
    return q.length <= RECEIPTS_QUERY_LIMIT.burst
  }

  /** 4099: the CLOSING notice goes first (SMK-2, closing.ts); 4000 RECONNECT closes as is. */
  closeWith(code: number, reason: string): void {
    if (this.closed) return
    if (code === CLOSE_TERMINAL) {
      closeTerminal(this.socket, reason)
      return
    }
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
  /** a busy room holds its first queued push for company (pacing.ts) */
  readonly pacer = new CommitPacer()
  /** the catch-up ops of recent `since` values, valid for one clock (catch-up.ts) */
  readonly catchUps = new CatchUpCache()
  /** join and leave events, one `roster` frame per macrotask (roster-batch.ts) */
  readonly rosterBatch = new RosterBatch(() => this.rosterRecipients())
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
  /** when the receipts' age limit last ran (schema.ts RECEIPTS.ttlEveryMs; the first writing batch runs it) */
  private lastReceiptTtl = Number.NEGATIVE_INFINITY
  /**
   * The receipt gap (wave D, D2): per user, the highest clock of a committed push of theirs whose receipt
   * this room could not record (recordReceipts). Every answer's `from` is past it, so the client never reads
   * such a push's missing receipt as "never landed" (it counts instead, as before rev 11). The file's own
   * marker row says the same across a restart when it could be written; this covers the open room when it
   * could not.
   */
  private readonly receiptGaps = new Map<string, number>()
  /**
   * RCPT-1: the gaps that are only in memory (neither a marker row nor lb_meta could be written). Every later
   * batch that advances the clock tries again, so a restart after it finds them in the file.
   */
  private readonly unwrittenGaps = new Map<string, number>()
  /** RCPT-1: the gaps lb_meta holds (schema.ts LB_META_RECEIPT_GAPS), as of the last COMMIT */
  private metaGaps = new Map<string, number>()
  /** the error name of the last failed receipts write (logged with its gap; no content) */
  private receiptsError = 'error'
  /** how many receipts the last failed receipts write held (the metric counts receipts, as before) */
  private lastUnrecordedRows = 0
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
    this.loadReceiptGaps()
    this.timers.push(setInterval(() => this.presenceTick(), PRESENCE_TICK_MS))
    this.timers.push(setInterval(() => this.leaseTick(), LEASE_TICK_MS))
    for (const t of this.timers) t.unref?.()
    this.pullWorkshop()
  }

  // ---- caches -------------------------------------------------------------------------------------

  private rebuildCaches(): void {
    const rows = this.store.liveIndexRows()
    const dead = this.store.tombstoneIndexRows()
    // the tombstones' keys are taken too: a live element never takes one (V3, index-keys.ts)
    this.index.reset(rows, dead)
    this.groups.reset()
    this.counts.elements = rows.length
    this.counts.items = 0
    this.guestCreated.clear()
    const guestItem = (uid: string) => this.guestCreated.set(uid, (this.guestCreated.get(uid) ?? 0) + 1)
    for (const r of rows) {
      // the columns come from SQL (store.ts liveIndexRows): no row is parsed in JS here
      if (r.groupIds && r.groupIds !== '[]') this.groups.add(JSON.parse(r.groupIds) as string[])
      if (!r.label) {
        this.counts.items++
        // the guest cap survives a room eviction: a guest's live items count against it (V2)
        if (r.byGuest) guestItem(r.byGuest)
      }
    }
    // ... and so do its deleted ones (D5, V2's re-check: tombstones made or revived reset nothing)
    for (const r of dead) if (r.byGuest && !r.label) guestItem(r.byGuest)
  }

  /** RCPT-1: the receipt gaps lb_meta kept (a gap whose marker row could not be written) count from the open. */
  private loadReceiptGaps(): void {
    try {
      this.metaGaps = this.store.receiptGapsMeta()
    } catch (e) {
      this.deps.log('[room] receipt gaps unreadable', this.boardId, (e as Error)?.name ?? 'error')
      this.metaGaps = new Map()
    }
    for (const [uid, clock] of this.metaGaps)
      this.receiptGaps.set(uid, Math.max(this.receiptGaps.get(uid) ?? 0, clock))
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
    if (msg.type === 'hello') {
      if (!s.helloAllowed(this.deps.now())) return this.terminal(s, 'RATE_LIMITED')
      const { since, epoch } = msg
      return queueHello(s.identity.uid, () => {
        if (!s.closed && !this.closed) this.hello(s, since, epoch)
      })
    }
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
        s.key,
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
    if (msg.type === 'receipts') {
      // CONTRACTS_REV 11: ordered with this session's pushes, answered after the next COMMIT
      if (!s.receiptsAllowed(this.deps.now())) return this.terminal(s, 'RATE_LIMITED')
      s.fifo.push({ kind: 'receipts', req: msg.req, ids: [...msg.ids] })
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
      ...(msg.rid !== undefined ? { rid: msg.rid } : {}),
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
          ...(item.rid !== undefined ? { rid: item.rid } : {}),
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
          : item.kind === 'receipts'
            ? { kind: 'receipts', session: s, req: item.req, ids: item.ids }
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
        this.rosterBatch.push({ k: 'leave', sid })
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

  /** Who gets a batched `roster` frame: every welcomed session (roster-batch.ts). */
  private *rosterRecipients() {
    for (const s of this.sessions)
      if (s.welcomed && !s.closed) yield { sid: s.identity.sid, send: (f: string) => s.out.send(f) }
  }

  private hello(s: Session, since: number, epoch: string | null): void {
    const first = !s.welcomed
    const now = this.deps.now()
    const meta0 = this.store.meta
    const catchUpRows =
      epoch === meta0.epoch && since >= meta0.horizon && since <= meta0.clock
        ? this.store.countSince(since)
        : null
    const rows =
      catchUpRows !== null && catchUpRows <= CATCH_UP_MAX_ROWS
        ? catchUpRows
        : (this.snapshotCache?.elements ?? storedRows(this.store.counts()))
    if (!userWelcomeAllowed(s.identity.uid, rows, now)) {
      this.terminal(s, 'RATE_LIMITED')
      return
    }
    if (first) {
      const already = [...this.sessions].some(
        (o) => o !== s && o.welcomed && o.identity.sid === s.identity.sid,
      )
      s.welcomed = true
      this.deps.metrics.inc('lobby_joins_total')
      // one `roster` frame per 100 ms at most for everyone (roster-batch.ts; the joiner's welcome names it already)
      if (!already) this.rosterBatch.push({ k: 'join', p: rosterEntry(s.identity) })
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
      // CONTRACTS_REV 9: the clock each key was last written at, read with `doc` (doc-key ABA)
      docClocks: this.store.docClocks(),
      leases: this.leases.live(now),
      roster: this.roster(),
      workshop: this.workshop ?? { voteOpen: false, anonymous: false },
      drags: this.presence.activeDrags(),
      limits: { ...WIRE_LIMITS, leaseTtlMs: this.leases.ttlMs },
    }
    const catchUp = catchUpRows !== null && catchUpRows <= CATCH_UP_MAX_ROWS
    // the rows since a clock as catch-up ops: the stored strings as they are, cached per `since` for this
    // clock (catch-up.ts: a reconnect storm after a restart asks for the same rows hundreds of times)
    const opsSince = (clock: number) => this.catchUps.get(clock, meta.clock, () => this.store.sinceRaw(clock))
    if (catchUp) {
      s.out.send(
        catchUpWelcomeJson({ ...base, clock: meta.clock, reset: false, snapshot: null }, opsSince(since)),
      )
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
        // DEF-3F-1 (3b F2): the cached snapshot's document is as old as the snapshot, so the frame that brings
        // the rows since it also brings the doc keys written since it (null: removed); a joiner that took
        // the snapshot's document reaches the welcome's from the frames alone
        const doc = this.store.docSince(snap.clock)
        s.out.send(catchUpChangesJson(meta.clock, opsSince(snap.clock), Object.keys(doc).length ? doc : null))
      }
    }
    // CONTRACTS_REV 10: the revision this room speaks, so a rev-10 client may send `f` and `view.z` on this
    // socket (a rev-9 client drops the frame as unknown); then everyone's current cursors (above 41
    // sessions the 40 this joiner starts with), so a late joiner does not wait for the next move
    s.out.send(CONTRACTS_FRAME)
    const peers = this.presence.welcomeFrame(s.key, s.identity.sid)
    if (peers) s.out.send(peers)
  }

  /**
   * The reset snapshot (tombstones included, redacted: W5-02), compressed once and reused by every joiner
   * while SNAPSHOT_REUSE allows (the rows since its clock follow it as a catch-up). One snapshot serves
   * every role: no tombstone in it carries content, so a viewer's is the owner's.
   */
  private snapshotFor(now: number): { clock: number; elements: number; bytes: Promise<Uint8Array> } {
    const meta = this.store.meta
    const c = this.snapshotCache
    if (c && c.epoch === meta.epoch && this.snapshotReusable(c, meta.clock, now)) return c
    const rows = this.store
      .snapshotRows()
      .map((r) => (r.deleted ? JSON.stringify(redactTombstone(JSON.parse(r.data) as El)) : r.data))
    const doc = this.store.docAll()
    const docClocks = this.store.docClocks()
    const json = `{"type":"snapshot","epoch":${JSON.stringify(meta.epoch)},"clock":${meta.clock},"horizon":${meta.horizon},"elements":[${rows.join(',')}],"doc":${JSON.stringify(doc)},"docClocks":${JSON.stringify(docClocks)}}`
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

  /** SNAPSHOT_REUSE: the same clock, or at most maxRowsBehind rows and maxAgeMs behind the board. */
  private snapshotReusable(c: { clock: number; at: number }, clock: number, now: number): boolean {
    if (c.clock === clock) return true
    if (now - c.at > SNAPSHOT_REUSE.maxAgeMs) return false
    return this.store.countSince(c.clock) <= SNAPSHOT_REUSE.maxRowsBehind
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
    // a peer's join reaches everyone before its first cursor does
    this.rosterBatch.flush()
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
    const fresh = this.queue.length === 0
    this.queue.push(e)
    this.schedule(fresh)
  }

  /** `fresh`: the entry just queued opened a new batch (pacing.ts holds it when the room is busy). */
  private schedule(fresh = false): void {
    if (this.drainTimer || this.draining || this.closed || !this.queue.length) return
    const wait = this.pacer.delay(this.deps.now(), this.lastCommitAt, DRAIN.minCommitIntervalMs, fresh)
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
    /**
     * The lease table before this batch: a failed COMMIT puts it back and sends none of the batch's lease
     * replies (V1: a release in a batch whose COMMIT failed still took effect, so another session was
     * granted the lease and the holder's retried final text push got LEASED; §2.4.3 "nothing in memory
     * changed"). The sessions are closed 4000 and resync; the clients re-send what was not answered.
     */
    const leaseSnap = this.leases.snapshot()
    const pushEntries: { session: Session; push: PreparedPush }[] = []
    /** the batch's server writes, in queue order, with their answers (settled after the COMMIT) */
    const serverWrites: { entry: ServerWriteEntry; ok: boolean; value: unknown }[] = []
    const before = new Map<string, WireElement | null>()
    const after = new Map<string, WireElement>()
    const doc: Record<string, unknown> = {}
    /** the receipts of this batch's pushes that carried one and wrote (CONTRACTS_REV 11) */
    const receipts: { uid: string; rid: string; clock: number }[] = []
    let pushes = 0
    store.begin()
    if (this.workshop === null) this.pullWorkshop()
    while (this.queue.length && pushes < DRAIN.maxPushes && performance.now() - t0 < DRAIN.maxWorkMs) {
      const e = this.queue.shift() as QueueEntry
      if (e.kind === 'acquire') {
        deliveries.push(this.acquire(e.session, e.req, e.id, now))
        continue
      }
      if (e.kind === 'release') {
        deliveries.push(this.release(e.session, e.id, now))
        continue
      }
      if (e.kind === 'receipts') {
        deliveries.push(this.receiptsAnswer(e.session, e.req, e.ids))
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
          if (ch.after.isDeleted && !ch.before?.isDeleted) {
            this.deletedSinceTrim++
            // W5-02: the cached reset snapshot holds this element live, with its content; a join in the
            // next 5 s would get the words of an element now deleted (its catch-up redacts the tombstone,
            // but a client keeps what it saw). Dropped on a delete only: a storm of reconnects replaying
            // their queues keeps the cache for every other write (V2 re-check, P-W3c)
            this.snapshotCache = null
          }
        }
        Object.assign(doc, outcome.doc)
      }
      const ackClock = outcome.clock ?? clock
      // its receipt: only when the push wrote and none of its ops waits for a retry (a receipt says "do
      // not send it again"; a push that wrote nothing has none, so a client sends it again)
      if (e.push.rid !== undefined && outcome.clock !== null && !retriesSome(outcome))
        receipts.push({ uid: e.session.identity.uid, rid: e.push.rid, clock: outcome.clock })
      deliveries.push(this.ackDelivery(e.session, e.push, outcome, ackClock))
    }
    // receipts this batch could not record (null: recorded, or none), then the gaps the file must keep
    const unrecorded = receipts.length ? this.recordReceipts(receipts, now) : null
    const receiptGap =
      clock !== startClock ? this.writeReceiptGaps(unrecorded, receipts.length > 0 && !unrecorded, now) : null
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
      this.leases.restore(leaseSnap)
      this.commitFailed(pushEntries, err as Error)
      for (const w of serverWrites)
        w.entry.reject(w.ok ? unavailable('The board could not save this change. Try again.') : w.value)
      return
    }
    const t1 = performance.now()
    this.deps.metrics.fsyncMs.observe(t1 - tc)
    this.deps.metrics.commitMs.observe(t1 - t0)
    if (pushes) this.deps.metrics.pushesPerCommit.observe(pushes)
    this.lastCommitAt = this.deps.now()
    this.pacer.noteCommit(this.lastCommitAt)
    if (clock !== startClock) this.catchUps.clear()
    store.meta.clock = clock
    // receipts this batch could not record: their pushes committed, so every answer to their users from now
    // on (this batch's own queries included, delivered below) says their receipts are complete only past them
    if (receiptGap) this.noteReceiptGap(receiptGap)
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

  /**
   * The batch's receipts (CONTRACTS_REV 11), in its transaction, then the ring's limits, in a SAVEPOINT of
   * their own. A failure there rolls back only the receipts: the batch's pushes still COMMIT, without them.
   * Left at that, the next query found such a push's receipt absent and, its base being past `from`, the
   * client took it for a push that never landed and sent it again over whatever was written after it (the
   * wave C review's receipt gap). So a failure returns the gap, per user the highest clock whose receipt is
   * missing, which writeReceiptGaps keeps in the file, so every answer's `from` is past it, after a restart
   * too. The client then decides those pushes by counting, as before rev 11. Logged and counted without
   * content (noteReceiptGap).
   */
  private recordReceipts(
    rows: { uid: string; rid: string; clock: number }[],
    now: number,
  ): Map<string, number> | null {
    const store = this.store
    store.savepoint('receipts')
    try {
      store.putReceipts(rows, now)
      const ttl = now - this.lastReceiptTtl >= RECEIPTS.ttlEveryMs
      store.trimReceipts(
        rows.map((r) => r.uid),
        now,
        ttl,
      )
      if (ttl) this.lastReceiptTtl = now
      store.release('receipts')
      return null
    } catch (err) {
      store.rollbackTo('receipts')
      store.forgetReceiptsTable()
      this.receiptsError = (err as Error)?.name ?? 'error'
      const gap = new Map<string, number>()
      for (const r of rows) gap.set(r.uid, Math.max(gap.get(r.uid) ?? 0, r.clock))
      this.lastUnrecordedRows = rows.length
      return gap
    }
  }

  /**
   * The receipt gaps the file must keep, in a batch that advances the clock (the receipts table's rule:
   * schema.ts lb_receipts): this batch's (`fresh`) and those still only in memory (RCPT-1). First as marker
   * rows (lb_receipts, `rid` = '', as the ring's trim keeps what it dropped; what lb_meta held goes there
   * too and lb_meta's key is removed), in a savepoint; if those cannot be written either, in lb_meta
   * (`receipt_gaps`, another table: a broken lb_receipts does not stop it), in a second one; if that fails
   * too, in memory only (the open room's answers still use it) and tried again by the next writing batch.
   * lb_meta's gaps are moved into marker rows only after a batch whose receipts were recorded (`receiptsOk`:
   * lb_receipts takes writes again). Null when there is nothing to write.
   */
  private writeReceiptGaps(
    fresh: Map<string, number> | null,
    receiptsOk: boolean,
    now: number,
  ): ReceiptGapWrite | null {
    const pending = new Map(this.unwrittenGaps)
    for (const [uid, clock] of fresh ?? []) pending.set(uid, Math.max(pending.get(uid) ?? 0, clock))
    const fold = receiptsOk && this.metaGaps.size > 0
    if (!pending.size && !fold) return null
    const store = this.store
    const marks = new Map(pending)
    for (const [uid, clock] of this.metaGaps) marks.set(uid, Math.max(marks.get(uid) ?? 0, clock))
    store.savepoint('receipts_gap')
    try {
      store.markReceiptGap(marks, now)
      if (this.metaGaps.size) store.setReceiptGapsMeta(new Map())
      store.release('receipts_gap')
      return { fresh, where: 'file', meta: new Map(), unwritten: null }
    } catch {
      store.rollbackTo('receipts_gap')
      store.forgetReceiptsTable()
    }
    // lb_meta still holds what it held
    if (!pending.size) return null
    const meta = new Map(this.metaGaps)
    for (const [uid, clock] of pending) meta.set(uid, Math.max(meta.get(uid) ?? 0, clock))
    store.savepoint('receipts_gap_meta')
    try {
      store.setReceiptGapsMeta(meta)
      store.release('receipts_gap_meta')
      return { fresh, where: 'meta', meta, unwritten: null }
    } catch {
      store.rollbackTo('receipts_gap_meta')
      return { fresh, where: 'memory', meta: this.metaGaps, unwritten: pending }
    }
  }

  /**
   * After the COMMIT of a batch that wrote receipt gaps (writeReceiptGaps): its new gaps are kept for the
   * answers, the file's state is taken as written, and a batch's unrecorded receipts are counted and logged
   * by where their gap went (`file`: marker rows; `meta`: lb_meta; `memory`: neither could be written).
   */
  private noteReceiptGap(g: ReceiptGapWrite): void {
    for (const [uid, clock] of g.fresh ?? [])
      this.receiptGaps.set(uid, Math.max(this.receiptGaps.get(uid) ?? 0, clock))
    const wasUnwritten = this.unwrittenGaps.size > 0
    this.unwrittenGaps.clear()
    for (const [uid, clock] of g.unwritten ?? []) this.unwrittenGaps.set(uid, clock)
    this.metaGaps = g.meta
    if (g.fresh) {
      this.deps.metrics.inc('lobby_receipts_unrecorded_total', { gap: g.where }, this.lastUnrecordedRows)
      this.deps.log(
        '[room] receipts not recorded',
        this.boardId,
        this.receiptsError,
        g.where === 'file' ? 'gap marked' : g.where === 'meta' ? 'gap kept in lb_meta' : 'gap kept in memory',
      )
    } else if (wasUnwritten && g.where !== 'memory')
      this.deps.log('[room] receipt gap written', this.boardId, g.where === 'file' ? 'marked' : 'in lb_meta')
  }

  /**
   * The answer to a `receipts` query, read after the batch's COMMIT (so the pushes queued before the query,
   * every socket's, are decided): the named receipts of this session's user, and from which clock its
   * receipts are complete, never at or below a clock whose receipt this room could not record (the receipt
   * gap). A failed read answers nothing conclusive (`from` past every clock): the client then counts, as
   * before rev 11.
   */
  private receiptsAnswer(s: Session, req: number, ids: string[]): () => void {
    return () => {
      if (s.closed) return
      let answer: { landed: Record<string, number>; from: number }
      try {
        answer = this.store.receipts(s.identity.uid, ids)
      } catch (err) {
        this.deps.log('[room] receipts read failed', this.boardId, (err as Error)?.name ?? 'error')
        answer = { landed: {}, from: Number.MAX_SAFE_INTEGER }
      }
      const gap = this.receiptGaps.get(s.identity.uid)
      const from = gap === undefined ? answer.from : Math.max(answer.from, gap + 1)
      s.out.send(JSON.stringify({ type: 'receipts', req, landed: answer.landed, from }))
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

  private commitFailed(pushes: { session: Session; push: PreparedPush }[], err: Error): void {
    this.deps.log('[room] COMMIT failed; batch answered UNAVAILABLE, reopening', this.boardId, err.name)
    this.deps.metrics.inc('lobby_commit_failures_total')
    for (const { session, push } of pushes) {
      const outcome = this.rejectedOutcome(push, 'UNAVAILABLE')
      this.ackDelivery(session, push, outcome, this.store.meta.clock)()
    }
    // the batch's lease messages took no effect (drainBatch restored the table): no reply goes out
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
    this.catchUps.clear()
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
    // a label's own id is never a lease id (its container's is, §2.9.2): refused like a read-only request
    const stored = this.store.get(id)
    const el = stored?.el as { type?: string; containerId?: string | null } | undefined
    if (stored && !stored.deleted && el?.type === 'text' && el.containerId) {
      this.deps.metrics.inc('lobby_lease_total', { result: 'deny' })
      return () =>
        s.out.send(
          JSON.stringify({
            type: 'lease.deny',
            req,
            id,
            holder: { sid: 'not-a-lease', uid: 'not-a-lease', name: 'not-a-lease' },
          }),
        )
    }
    // one session holds at most MAX_LEASES_PER_SESSION leases (V2: one editor could hold every note's lease
    // and deny everyone else's text; a tab edits one text at a time): beyond it a NEW lease is denied, the
    // requester named as the holder (every request is answered; a renewal of one it holds is not new)
    // ... and one user at most MAX_LEASES_PER_USER across its tabs (V2's re-check)
    if (
      !this.leases.holds(id, s.identity.sid, now) &&
      (this.leases.heldBy(s.identity.sid, now) >= MAX_LEASES_PER_SESSION ||
        this.leases.heldByUser(s.identity.uid, now) >= MAX_LEASES_PER_USER)
    ) {
      this.deps.metrics.inc('lobby_lease_total', { result: 'deny' })
      const self = this.holderOf(s)
      return () => s.out.send(JSON.stringify({ type: 'lease.deny', req, id, holder: self }))
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
    this.rosterBatch.close()
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
 *
 * Tombstones (W5-02, canvas-schema elements.ts `redactTombstone`): a `c` op of a deleted element is
 * always the redacted tombstone (a create of a deleted element, a write to a tombstone, a delete whose
 * patch could not reproduce the row). A delete is the patch of what the deleting push changed, sent to the
 * sessions that held the element live: their copy must stay the server's exactly (the client diffs its
 * pushes against it; a delete that also nulled an arrow's bindings must say so, or the arrow's undo never
 * sends them back). An undelete is always the full live element: a joiner holds only the redacted form.
 */
export function serverOp(before: WireElement | null, after: WireElement): ServerOp {
  const full: ServerOp = { k: 'c', el: after.isDeleted ? redactTombstone(after as El) : after }
  // a create, a write to a tombstone, or an undelete
  if (!before || before.isDeleted) return full
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
  // the patch must reproduce the stored element exactly, every field (a delete's too: hash.ts compares a
  // tombstone by its TOMBSTONE_KEYS only, so both sides are compared as if live)
  const rebuilt = {
    ...overlayPatch(b, op as never),
    version: a.version,
    versionNonce: a.versionNonce,
    updated: a.updated,
  }
  const whole = (el: Readonly<Record<string, unknown>>) =>
    canonicalJson(canonicalElement({ ...el, isDeleted: false }))
  if (rebuilt.isDeleted !== a.isDeleted || whole(rebuilt) !== whole(a)) return full
  if (
    Object.values(g).some((fields) =>
      Object.values(fields).some((v) => typeof v === 'number' && Math.abs(v) > COORD_LIMIT * 10),
    )
  )
    return full
  return op as ServerOp
}

const storedRows = (c: { live: number; dead: number }) => c.live + c.dead

/** Whether a push's outcome refused an op (or doc keys) for a reason the client retries (RATE, UNAVAILABLE). */
const retriesSome = (o: PushOutcome): boolean =>
  o.results.some((r) => !r.ok && REJECT_CODE_INFO[r.code].retryable) ||
  (!!o.docDenied && REJECT_CODE_INFO[o.docDenied.code].retryable)

/** The ack result of an op the room could not even parse (stage 0). */
export const invalidResult = (id: string): AckResult => ({ id, ok: false, code: 'INVALID', el: null })

/**
 * `liveSnapshot()` of a board that has no file yet, read while maintenance is on (room/http.ts, W4d 2A):
 * the empty board at clock 0, the same answer its room gives once it is made.
 */
export const emptyLiveSnapshot = (): ReturnType<ElementRoom['liveSnapshot']> => ({
  format: 'lobby-elements',
  schema: ELEMENT_SCHEMA_VERSION,
  clock: 0,
  elements: [],
  doc: {},
})
