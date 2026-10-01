// O1's ElementRoom service (docs/EXCALIDRAW-MIGRATION.md §2.4, §8.6.3): every open board's room in this
// sync process, behind the frozen seam of engine-switch.ts. Importing this module registers the factory
// (`registerElementRoom`); `loadEngine('excalidraw')` imports it before the server is built, and the C0
// arrow acceptance tests (apps/sync/test/room/arrows/) import it to get the real room.
//
// The service: opens a board's room synchronously on the first socket (race-free, like
// RoomRegistry.getOrCreate), evicts it after IDLE_EVICT_MS without sessions, serves the room's internal
// routes and /internal/metrics, enforces the global outbound budget (64 MiB) and the snapshot cache
// budget (64 MiB, one entry per board), and with DRAFTROOM_TEST_HOOKS=1 registers the test hooks
// (snapshot with tombstones, lease-hook, fail-commit; test-hooks.ts).
//
// Conversion on room open (§5.3 "Lazy", §5.9 step 3, §2.13): a board file with tldraw tables and no
// `lb_meta` (or a converted board whose tldraw side moved during a rollback) is prepared by O4's
// MigrationService (room/migrate/**) before its room opens: one job at a time process-wide, in a capped
// worker, behind the RSS gate. Its joiners are held (notice PREPARING, their messages buffered) and admitted
// in order when the board is ready. A failed job leaves the board on its tldraw tables: the joiners get
// 4099 CONVERSION_FAILED, and the board is not re-queued by later joiners (only a maintenance run converts
// it; transient failures are retried after FAILED_RETRY_MS). The service's routes (convert-all, status)
// are mounted with the room's; closeAll closes it (the running worker is terminated). The internal routes
// that open a board (the snapshot, the test snapshot) wait for the same preparation.
//
// CR 2F-2 (engine-switch.ts): `prepareBoard(boardId)` is that preparation for any in-process caller (the
// api's internal routes built outside the room, room-internal/** on engine/excalidraw): the board's room
// opened, after its conversion or roll-forward. `serverWrite(boardId, apply)` opens the board the same way
// and queues a server write in its room (element-room.ts, server-write.ts): place-notes and the "Recently
// deleted" restore on a board people have open. With DRAFTROOM_TEST_HOOKS=1 both are also reachable
// through test-only routes (test-routes.ts), for the protocol tests.
//
// Engine code on the server: pure helpers only, through @draftroom/canvas-schema/engine (§2.4.1). The
// text metrics provider is installed once, before any layout.

import { existsSync, mkdirSync } from 'node:fs'
import { installedServerTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { LEASE_TTL_MS } from '@draftroom/canvas-schema/limits'
import {
  CLOSE_RECONNECT,
  CLOSE_TERMINAL,
  type LeaseHookRequest,
  NOTICE_CODES,
  TERMINAL_CLOSE_REASONS,
} from '@draftroom/canvas-schema/protocol'
import {
  type ElementRoomDeps,
  type ElementRoomService,
  type ElementSessionHandle,
  type ElementSessionInfo,
  type ElementSocket,
  type LiveElementSession,
  registerElementRoom,
} from '../engine-switch.ts'
import { createFileRefsClient } from '../file-refs.ts'
import { HttpError } from '../http/respond.ts'
import { BOARD_ID_RE, boardDbPath } from '../rooms.ts'
import { registerTestHooks } from '../test-hooks.ts'
import { createWorkshopStateClient } from '../workshop-state.ts'
import { closeTerminal } from './closing.ts'
import { ElementRoom, type Session } from './element-room.ts'
import { roomRoutes } from './http.ts'
import { RoomMetrics } from './metrics.ts'
import {
  type BoardFileState,
  boardFileState,
  MigrationService,
  type MigrationServiceOptions,
  type PrepareResult,
} from './migrate/index.ts'
import { maintenanceState } from './migrate/maintenance.ts'
import { OUTBOUND } from './outbound.ts'
import { testRoomRoutes } from './test-routes.ts'

/** The global snapshot cache budget (§2.4.5): one entry per board, least recently built dropped first. */
const SNAPSHOT_BUDGET_BYTES = 64 * 1024 * 1024
/** today's tldraw default of TEXT_LEASE_MS: when it is unchanged the new lease uses §2.9.2's 10 s */
const TLDRAW_DEFAULT_TEXT_LEASE_MS = 5_000

/** A joiner held while its board is prepared: at most this many messages (presence is dropped, as before hello). */
export const PENDING_MAX_MESSAGES = 64
export const PENDING_MAX_BYTES = 1024 * 1024
/**
 * Element sockets one user (uid) may have open on one board (V2's re-check: with no cap, one viewer
 * ticket opened 40 or 100 sockets on a board, and one editor held 4 leases per tab in 13 tabs). One more
 * is closed at once, 4099 RATE_LIMITED. A person has a tab or two per board.
 */
export const MAX_SOCKETS_PER_USER_PER_BOARD = 12
/** ... and on the whole process, every board together (a ticket is per board; this bounds the rest). */
export const MAX_SOCKETS_PER_USER = 128
/** A transient conversion failure (time budget, a worker crash) is retried by a joiner after this long (§5.3). */
export const FAILED_RETRY_MS = 5 * 60_000
/** Failures a joiner never retries at runtime: only a maintenance run converts these boards (§5.3, §2.13). */
const TRANSIENT_FAILURES = /^(time-budget|worker-error|worker-exit|error:|closed|already-converted)/

/** The terminal reason for a board that could not be prepared (CR CONVERSION_FAILED; MAINTENANCE before it). */
const CONVERSION_FAILED: string = (TERMINAL_CLOSE_REASONS as readonly string[]).includes('CONVERSION_FAILED')
  ? 'CONVERSION_FAILED'
  : 'MAINTENANCE'
/** The notice a held joiner gets first (CR PREPARING; nothing before it). */
const PREPARING_NOTICE: string | null = (NOTICE_CODES as readonly string[]).includes('PREPARING')
  ? JSON.stringify({ type: 'notice', code: 'PREPARING' })
  : null

/** A joiner held while its board is converted or rolled forward. */
interface Waiter {
  readonly info: ElementSessionInfo
  readonly socket: ElementSocket
  buffer: string[]
  bytes: number
  /** the session once admitted to the opened room */
  target: { room: ElementRoom; s: Session } | null
  /** closed or refused before admission (removed and reported once) */
  gone: boolean
}

interface Preparation {
  readonly promise: Promise<PrepareResult>
  readonly waiters: Set<Waiter>
}

type OpenPlan = { kind: 'open' } | { kind: 'prepare' } | { kind: 'refuse'; reason: string }

/** Test-only knobs (DRAFTROOM_TEST_HOOKS=1 only, never in production): a small heap cap or time budget. */
function testMigrationOptions(testHooks: boolean): Partial<MigrationServiceOptions> {
  if (!testHooks) return {}
  const cap = Number(process.env.DRAFTROOM_TEST_MIGRATE_CAP_MB)
  const budget = Number(process.env.DRAFTROOM_TEST_MIGRATE_TIME_MS)
  return {
    ...(cap > 0 ? { runtimeCapMb: cap } : {}),
    ...(budget > 0 ? { timeBudgetMs: budget } : {}),
  }
}

export function createElementRoomService(deps: ElementRoomDeps): ElementRoomService {
  return createElementRoomServiceWith(deps)
}

/** The factory with the migration service's options (in-process tests). */
export function createElementRoomServiceWith(
  deps: ElementRoomDeps,
  migrationOptions: Partial<MigrationServiceOptions> = {},
): ElementRoomService {
  if (!installedServerTextMetrics()) installServerTextMetrics()
  const now = deps.now ?? (() => Date.now())
  const config = deps.config
  const leaseTtlMs =
    config.textLeaseMs === TLDRAW_DEFAULT_TEXT_LEASE_MS || !config.textLeaseMs
      ? LEASE_TTL_MS
      : config.textLeaseMs
  const fileRefs =
    deps.fileRefs ??
    createFileRefsClient({ baseUrl: config.apiInternalUrl, internalSecret: config.internalSecret })
  const workshopState =
    deps.workshopState ??
    createWorkshopStateClient({ baseUrl: config.apiInternalUrl, internalSecret: config.internalSecret })
  const metrics = new RoomMetrics()
  const rooms = new Map<string, ElementRoom>()
  const evictTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** hooks set before a board's room opened */
  const pendingHooks = new Map<string, { lease?: LeaseHookRequest; failCommits: number }>()
  const snapshotSizes = new Map<ElementRoom, number>()
  /** boards being converted or rolled forward, with their held joiners */
  const preparing = new Map<string, Preparation>()
  /** boards whose preparation failed: refused without a new job (see FAILED_RETRY_MS) */
  const failures = new Map<string, { reason: string; at: number; permanent: boolean }>()
  let closed = false

  // The migration service (O4): one per process; its queue runs one job at a time. Before a runtime job it
  // flushes every room's snapshot cache (§2.13 "after flushing the snapshot cache").
  const migration = new MigrationService({
    roomsDir: deps.dataDir,
    log: deps.log,
    flushCaches: () => {
      for (const r of rooms.values()) r.dropSnapshotCache()
      snapshotSizes.clear()
    },
    ...testMigrationOptions(config.testHooks === true),
    ...migrationOptions,
  })

  const onIdle = (room: ElementRoom) => {
    if (closed || evictTimers.has(room.boardId)) return
    const t = setTimeout(() => {
      evictTimers.delete(room.boardId)
      if (rooms.get(room.boardId) !== room || room.sessionCount > 0 || room.busy) return
      rooms.delete(room.boardId)
      snapshotSizes.delete(room)
      room.close()
    }, config.idleEvictMs)
    t.unref?.()
    evictTimers.set(room.boardId, t)
  }

  const snapshotBudget = (room: ElementRoom, bytes: number) => {
    snapshotSizes.delete(room)
    snapshotSizes.set(room, bytes)
    let total = 0
    for (const n of snapshotSizes.values()) total += n
    for (const [r, n] of snapshotSizes) {
      if (total <= SNAPSHOT_BUDGET_BYTES || r === room) break
      r.dropSnapshotCache()
      snapshotSizes.delete(r)
      total -= n
    }
  }

  /** Opens the board's room from its file (which must not need a conversion). Synchronous. */
  function open(boardId: string): ElementRoom {
    const cur = rooms.get(boardId)
    if (cur) {
      const t = evictTimers.get(boardId)
      if (t) {
        clearTimeout(t)
        evictTimers.delete(boardId)
      }
      return cur
    }
    if (!BOARD_ID_RE.test(boardId)) throw new Error('invalid board id')
    mkdirSync(deps.dataDir, { recursive: true })
    const room = new ElementRoom({
      boardId,
      path: boardDbPath(deps.dataDir, boardId),
      log: deps.log,
      now,
      leaseTtlMs,
      fileRefs,
      workshopState,
      metrics,
      onSessionRemoved: deps.onSessionRemoved,
      onDocumentChange: deps.onDocumentChange,
      onIdle,
      snapshotBudget,
    })
    const hooks = pendingHooks.get(boardId)
    if (hooks) {
      if (hooks.lease) room.leaseHook(hooks.lease)
      room.failCommits += hooks.failCommits
      pendingHooks.delete(boardId)
    }
    rooms.set(boardId, room)
    return room
  }

  // ---- conversion on open ---------------------------------------------------------------------------

  /** What a board's file needs before its room can open (one read-only look at the file). */
  function planOpen(boardId: string): OpenPlan {
    const state: BoardFileState = boardFileState(boardDbPath(deps.dataDir, boardId))
    if (state === 'missing' || state === 'element' || state === 'converted') {
      failures.delete(boardId)
      return { kind: 'open' }
    }
    if (state === 'unknown') return { kind: 'refuse', reason: 'unreadable' }
    const f = failures.get(boardId)
    if (f && (f.permanent || now() - f.at < FAILED_RETRY_MS)) return { kind: 'refuse', reason: f.reason }
    return { kind: 'prepare' }
  }

  const dropWaiter = (w: Waiter) => {
    if (w.gone || w.target) return
    w.gone = true
    w.buffer = []
    preparing.get(w.info.boardId)?.waiters.delete(w)
    deps.onSessionRemoved(w.info.boardId, w.info.sid, {
      userId: w.info.uid,
      role: w.info.role,
      name: w.info.name,
      color: w.info.color,
    })
  }

  const closeWaiter = (w: Waiter, code: number, reason: string) => {
    if (w.gone || w.target) return
    metrics.inc('lobby_closes_total', { code: String(code), reason })
    if (code === CLOSE_TERMINAL) closeTerminal(w.socket, reason)
    else
      try {
        w.socket.close(code, reason)
      } catch {
        // already closed
      }
    dropWaiter(w)
  }

  /** One message into an admitted session (the same guard as a direct connect). */
  const deliver = (room: ElementRoom, s: Session, boardId: string, text: string) => {
    try {
      room.message(s, text)
    } catch (e) {
      deps.log('[room] message failed', boardId, (e as Error)?.name ?? 'error')
      s.closeWith(CLOSE_TERMINAL, 'UNKNOWN_ERROR')
      room.closed_(s)
    }
  }

  const admit = (w: Waiter, room: ElementRoom) => {
    if (w.gone || w.target) return
    const s = room.connect(w.info, w.socket)
    w.target = { room, s }
    const buffered = w.buffer
    w.buffer = []
    w.bytes = 0
    for (const text of buffered) deliver(room, s, w.info.boardId, text)
  }

  /** The board's preparation (one per board; joiners and internal routes share it). */
  function prepare(boardId: string): Preparation {
    const cur = preparing.get(boardId)
    if (cur) return cur
    const t0 = now()
    const promise = migration
      .prepare(boardId)
      .catch((e): PrepareResult => ({ ready: false, reason: `error: ${(e as Error)?.name ?? 'Error'}` }))
    const p: Preparation = { promise, waiters: new Set() }
    preparing.set(boardId, p)
    metrics.inc('lobby_board_prepare_total', { result: 'started' })
    void promise.then((res) => settle(boardId, p, res, now() - t0))
    return p
  }

  function settle(boardId: string, p: Preparation, res: PrepareResult, ms: number): void {
    if (preparing.get(boardId) === p) preparing.delete(boardId)
    const waiters = [...p.waiters].filter((w) => !w.gone && !w.target)
    if (closed) {
      for (const w of waiters) closeWaiter(w, CLOSE_RECONNECT, 'RECONNECT')
      return
    }
    let ready = res.ready
    if (!ready) {
      // another path may have converted it meanwhile (a maintenance run, `already-converted`)
      try {
        const st = boardFileState(boardDbPath(deps.dataDir, boardId))
        ready = st === 'converted' || st === 'element'
      } catch {
        ready = false
      }
    }
    if (!ready) {
      const reason = res.ready ? 'unknown' : res.reason
      const permanent = !TRANSIENT_FAILURES.test(reason)
      failures.set(boardId, { reason, at: now(), permanent })
      metrics.inc('lobby_board_prepare_total', { result: 'failed' })
      deps.log('[room] board not prepared for the new canvas', boardId, reason, `${ms} ms`)
      for (const w of waiters) closeWaiter(w, CLOSE_TERMINAL, CONVERSION_FAILED)
      return
    }
    failures.delete(boardId)
    metrics.inc('lobby_board_prepare_total', {
      result: res.ready ? (res.did === 'none' ? 'none' : res.did) : 'converted-elsewhere',
    })
    if (res.ready && res.did !== 'none')
      deps.log('[room] board prepared for the new canvas', boardId, res.did, `${ms} ms`)
    if (!waiters.length) return
    let room: ElementRoom
    try {
      room = open(boardId)
    } catch (e) {
      deps.log('[room] open after preparation failed', boardId, (e as Error)?.name ?? 'error')
      for (const w of waiters) closeWaiter(w, CLOSE_TERMINAL, 'UNKNOWN_ERROR')
      return
    }
    for (const w of waiters) admit(w, room)
    if (room.sessionCount === 0) onIdle(room)
  }

  /** A joiner of a board being prepared: held, answered with PREPARING, admitted when ready. */
  function hold(info: ElementSessionInfo, socket: ElementSocket, p: Preparation): ElementSessionHandle {
    const w: Waiter = { info, socket, buffer: [], bytes: 0, target: null, gone: false }
    p.waiters.add(w)
    if (PREPARING_NOTICE) {
      try {
        socket.send(PREPARING_NOTICE)
      } catch {
        // the socket closed meanwhile; closed() follows
      }
    }
    return {
      message(text: string) {
        if (w.target) return deliver(w.target.room, w.target.s, info.boardId, text)
        if (w.gone) return
        if (text.length < 4096 && text.includes('"presence"')) {
          try {
            if ((JSON.parse(text) as { type?: unknown } | null)?.type === 'presence') return
          } catch {
            // buffered; the room answers it after admission
          }
        }
        const bytes = Buffer.byteLength(text, 'utf8')
        if (w.buffer.length >= PENDING_MAX_MESSAGES || w.bytes + bytes > PENDING_MAX_BYTES)
          return closeWaiter(w, CLOSE_TERMINAL, 'RATE_LIMITED')
        w.buffer.push(text)
        w.bytes += bytes
      },
      closed() {
        if (w.target) w.target.room.closed_(w.target.s)
        else dropWaiter(w)
      },
    }
  }

  /**
   * A joiner of a board that could not be prepared: closed at once, 4099 CONVERSION_FAILED. Its removal is
   * reported when app.ts sees the socket close (after it admitted the session to the access monitor).
   */
  function refuse(info: ElementSessionInfo, socket: ElementSocket): ElementSessionHandle {
    const w: Waiter = { info, socket, buffer: [], bytes: 0, target: null, gone: false }
    metrics.inc('lobby_closes_total', { code: String(CLOSE_TERMINAL), reason: CONVERSION_FAILED })
    closeTerminal(socket, CONVERSION_FAILED)
    return { message() {}, closed: () => dropWaiter(w) }
  }

  /**
   * The board's room for an internal route: opened (after its preparation), or null when it has no file.
   * `create`: a board without a file is opened as a new, empty board instead (its file made, as a session's
   * first join makes it): what the api's readers expect of a board nobody has opened yet (W4d, 2A: the
   * checkpoint of such a board answered 503 "the board server is not reachable", the tldraw registry
   * made an empty room on demand). The room is evicted like any other when it stays idle.
   */
  const existing = async (boardId: string, opts: { create?: boolean } = {}): Promise<ElementRoom | null> => {
    const cur = rooms.get(boardId)
    if (cur) return cur
    if (!BOARD_ID_RE.test(boardId)) return null
    if (!existsSync(boardDbPath(deps.dataDir, boardId))) {
      // nothing is made while maintenance is on (the cut-over window: no write reaches the rooms folder;
      // the snapshot route answers the empty board itself, room/http.ts)
      if (!opts.create || maintenanceState() === true) return null
      if (closed) throw new HttpError(503, 'unavailable', 'Closing.')
      const room = open(boardId)
      onIdle(room)
      return room
    }
    const plan: OpenPlan = preparing.has(boardId) ? { kind: 'prepare' } : planOpen(boardId)
    if (plan.kind === 'refuse')
      throw new HttpError(503, 'unavailable', 'This board is not ready on the new canvas.')
    if (plan.kind === 'prepare') {
      const res = await prepare(boardId).promise
      const opened = rooms.get(boardId)
      if (opened) return opened
      if (!res.ready || failures.has(boardId))
        throw new HttpError(503, 'unavailable', 'This board is not ready on the new canvas.')
      if (closed) throw new HttpError(503, 'unavailable', 'Closing.')
    }
    const room = open(boardId)
    onIdle(room)
    return room
  }

  // the global outbound budget (§2.4.5): above 64 MiB, the session with the largest buffer reconnects
  const budgetTimer = setInterval(() => {
    let total = 0
    let largest: { room: ElementRoom; sid: string; pending: number } | null = null
    for (const room of rooms.values())
      for (const s of room.sessions) {
        const p = s.out.pending
        total += p
        if (!largest || p > largest.pending) largest = { room, sid: s.identity.sid, pending: p }
      }
    if (total > OUTBOUND.globalBudget && largest) {
      metrics.inc('lobby_closes_total', { code: String(CLOSE_RECONNECT), reason: 'global-budget' })
      largest.room.closeSession(largest.sid)
    }
  }, 250)
  budgetTimer.unref?.()

  const offHooks = config.testHooks
    ? registerTestHooks({
        snapshot: async (boardId) => (await existing(boardId))?.testSnapshot() ?? null,
        leaseHook: (boardId, req) => {
          const room = rooms.get(boardId)
          if (room) room.leaseHook(req)
          else {
            const h = pendingHooks.get(boardId) ?? { failCommits: 0 }
            h.lease = req
            pendingHooks.set(boardId, h)
          }
        },
        failCommit: (boardId, req) => {
          const room = rooms.get(boardId)
          if (room) room.failCommits += req.count
          else {
            const h = pendingHooks.get(boardId) ?? { failCommits: 0 }
            h.failCommits += req.count
            pendingHooks.set(boardId, h)
          }
        },
      })
    : () => {}

  const waitersOf = (boardId: string): Waiter[] =>
    [...(preparing.get(boardId)?.waiters ?? [])].filter((w) => !w.gone && !w.target)

  /** open element sockets per uid and per uid and board (MAX_SOCKETS_PER_USER, …_PER_BOARD) */
  const socketsOf = new Map<string, number>()
  const count = (key: string, by: number) => {
    const n = (socketsOf.get(key) ?? 0) + by
    if (n > 0) socketsOf.set(key, n)
    else socketsOf.delete(key)
  }
  const capped = (
    session: ElementSessionInfo,
    socket: ElementSocket,
    open: () => ElementSessionHandle,
  ): ElementSessionHandle => {
    const uid = session.uid
    const onBoard = `${uid} ${session.boardId}`
    if (
      (socketsOf.get(uid) ?? 0) >= MAX_SOCKETS_PER_USER ||
      (socketsOf.get(onBoard) ?? 0) >= MAX_SOCKETS_PER_USER_PER_BOARD
    ) {
      metrics.inc('lobby_closes_total', { code: String(CLOSE_TERMINAL), reason: 'RATE_LIMITED' })
      closeTerminal(socket, 'RATE_LIMITED')
      const meta = { userId: uid, role: session.role, name: session.name, color: session.color }
      return { message() {}, closed: () => deps.onSessionRemoved(session.boardId, session.sid, meta) }
    }
    count(uid, 1)
    count(onBoard, 1)
    let inner: ElementSessionHandle
    try {
      inner = open()
    } catch (e) {
      count(uid, -1)
      count(onBoard, -1)
      throw e
    }
    let done = false
    return {
      message: (text: string) => inner.message(text),
      closed() {
        if (!done) {
          done = true
          count(uid, -1)
          count(onBoard, -1)
        }
        inner.closed()
      },
    }
  }

  function connectOne(session: ElementSessionInfo, socket: ElementSocket): ElementSessionHandle {
    const boardId = session.boardId
    let room = rooms.get(boardId)
    if (!room) {
      const pending = preparing.get(boardId)
      if (pending) return hold(session, socket, pending)
      const plan = planOpen(boardId)
      if (plan.kind === 'refuse') return refuse(session, socket)
      if (plan.kind === 'prepare') return hold(session, socket, prepare(boardId))
      room = open(boardId)
    } else open(boardId) // clears a pending eviction
    const r = room
    const s = r.connect(session, socket)
    return {
      message(text: string) {
        deliver(r, s, boardId, text)
      },
      closed() {
        r.closed_(s)
      },
    }
  }

  const service: ElementRoomService = {
    connect(session, socket) {
      if (closed) throw new Error('closing')
      return capped(session, socket, () => connectOne(session, socket))
    },
    routes: () => [
      ...roomRoutes({
        existing,
        ifOpen: (boardId) => rooms.get(boardId) ?? null,
      }),
      ...migration.routes(),
      ...(config.testHooks ? testRoomRoutes(() => service) : []),
    ],
    metrics() {
      const sessionsByRole: Record<string, number> = { owner: 0, editor: 0, commenter: 0, viewer: 0 }
      const boards = []
      for (const room of rooms.values()) {
        for (const s of room.sessions)
          sessionsByRole[s.identity.role] = (sessionsByRole[s.identity.role] ?? 0) + 1
        boards.push(room.gauges())
      }
      return metrics.render({ open: rooms.size, sessionsByRole, boards })
    },
    async closeAll() {
      closed = true
      clearInterval(budgetTimer)
      for (const t of evictTimers.values()) clearTimeout(t)
      evictTimers.clear()
      for (const p of preparing.values())
        for (const w of [...p.waiters]) closeWaiter(w, CLOSE_RECONNECT, 'RECONNECT')
      for (const room of rooms.values()) room.close()
      rooms.clear()
      offHooks()
      metrics.stop()
      await migration.close()
    },
    roomIfOpen(boardId) {
      const room = rooms.get(boardId)
      if (room) return { closeSession: (sid: string, reason?: string) => room.closeSession(sid, reason) }
      if (!preparing.has(boardId)) return null
      return {
        closeSession: (sid: string, reason?: string) => {
          for (const w of waitersOf(boardId))
            if (w.info.sid === sid)
              closeWaiter(w, reason ? CLOSE_TERMINAL : CLOSE_RECONNECT, reason ?? 'RECONNECT')
        },
      }
    },
    sessionsOf(boardId): LiveElementSession[] {
      const room = rooms.get(boardId)
      const live = room
        ? [...room.sessions].map((s) => ({
            sessionId: s.identity.sid,
            meta: {
              userId: s.identity.uid,
              role: s.identity.role,
              name: s.identity.name,
              color: s.identity.color,
            },
          }))
        : []
      for (const w of waitersOf(boardId))
        live.push({
          sessionId: w.info.sid,
          meta: { userId: w.info.uid, role: w.info.role, name: w.info.name, color: w.info.color },
        })
      return live
    },
    openBoards: () => [...new Set([...rooms.keys(), ...preparing.keys()])],
    // CR 2F-2
    async prepareBoard(boardId) {
      if (closed) throw new HttpError(503, 'unavailable', 'Closing.')
      return (await existing(boardId)) !== null
    },
    async serverWrite(boardId, apply) {
      if (closed) throw new HttpError(503, 'unavailable', 'Closing.')
      const room = await existing(boardId)
      if (!room) throw new HttpError(404, 'board-not-found', 'No such board.')
      return room.serverWrite(apply)
    },
  }
  return service
}

registerElementRoom(createElementRoomService)
