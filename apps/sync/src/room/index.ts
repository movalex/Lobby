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
// Engine code on the server: pure helpers only, through @draftroom/canvas-schema/engine (§2.4.1). The
// text metrics provider is installed once, before any layout.

import { existsSync, mkdirSync } from 'node:fs'
import { installedServerTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { LEASE_TTL_MS } from '@draftroom/canvas-schema/limits'
import { CLOSE_RECONNECT, type LeaseHookRequest } from '@draftroom/canvas-schema/protocol'
import {
  type ElementRoomDeps,
  type ElementRoomService,
  type LiveElementSession,
  registerElementRoom,
} from '../engine-switch.ts'
import { createFileRefsClient } from '../file-refs.ts'
import { BOARD_ID_RE, boardDbPath } from '../rooms.ts'
import { registerTestHooks } from '../test-hooks.ts'
import { createWorkshopStateClient } from '../workshop-state.ts'
import { ElementRoom } from './element-room.ts'
import { roomRoutes } from './http.ts'
import { RoomMetrics } from './metrics.ts'
import { OUTBOUND } from './outbound.ts'

/** The global snapshot cache budget (§2.4.5): one entry per board, least recently built dropped first. */
const SNAPSHOT_BUDGET_BYTES = 64 * 1024 * 1024
/** today's tldraw default of TEXT_LEASE_MS: when it is unchanged the new lease uses §2.9.2's 10 s */
const TLDRAW_DEFAULT_TEXT_LEASE_MS = 5_000

export function createElementRoomService(deps: ElementRoomDeps): ElementRoomService {
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
  let closed = false

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

  const existing = (boardId: string): ElementRoom | null => {
    const cur = rooms.get(boardId)
    if (cur) return cur
    if (!BOARD_ID_RE.test(boardId) || !existsSync(boardDbPath(deps.dataDir, boardId))) return null
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
        snapshot: (boardId) => existing(boardId)?.testSnapshot() ?? null,
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

  return {
    connect(session, socket) {
      const room = open(session.boardId)
      const s = room.connect(session, socket)
      return {
        message(text: string) {
          try {
            room.message(s, text)
          } catch (e) {
            deps.log('[room] message failed', session.boardId, (e as Error)?.name ?? 'error')
            s.closeWith(4099, 'UNKNOWN_ERROR')
            room.closed_(s)
          }
        },
        closed() {
          room.closed_(s)
        },
      }
    },
    routes: () =>
      roomRoutes({
        existing,
        ifOpen: (boardId) => rooms.get(boardId) ?? null,
      }),
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
      for (const room of rooms.values()) room.close()
      rooms.clear()
      offHooks()
      metrics.stop()
    },
    roomIfOpen(boardId) {
      const room = rooms.get(boardId)
      return room ? { closeSession: (sid: string, reason?: string) => room.closeSession(sid, reason) } : null
    },
    sessionsOf(boardId): LiveElementSession[] {
      const room = rooms.get(boardId)
      if (!room) return []
      return [...room.sessions].map((s) => ({
        sessionId: s.identity.sid,
        meta: {
          userId: s.identity.uid,
          role: s.identity.role,
          name: s.identity.name,
          color: s.identity.color,
        },
      }))
    },
    openBoards: () => [...rooms.keys()],
  }
}

registerElementRoom(createElementRoomService)
