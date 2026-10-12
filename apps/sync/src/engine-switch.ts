// The seam between the sync server's shell (app.ts: sockets, tickets, access, backups, maintenance) and
// the ElementRoom (apps/sync/src/room/**), frozen at spike B's contracts step C0
// (docs/research/excalidraw/spike-b/CONTRACTS.md). Since wave 4 part 2 the ElementRoom is the only engine
// (the TLSocketRoom path and R0's born-after check left with it; DRAFTROOM_ENGINE=tldraw is refused by
// config.ts, and a rollback is a deploy of bridge release R0: docs/EXCALIDRAW-CUTOVER.md §7).
//
//  - registerElementRoom(factory): `apps/sync/src/room/index.ts` calls it when it is imported;
//    `loadEngine()` imports it (server.ts does, before createSyncServer).
//  - InternalRoute: how the room's internal routes (and /internal/metrics, the test hooks) are mounted by
//    the HTTP router, behind the internal secret.
//
// Nothing here imports engine code statically: loadEngine() does.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WireElement } from '@draftroom/canvas-schema/elements'
import type { FileRefsResponse, WorkshopStateBody } from '@draftroom/contracts'
import type { SyncConfig } from './config.ts'
import type { DiskProbe } from './disk.ts'
import type { BoardRole } from './permissions.ts'
import type { BoardStore } from './room/store.ts'

/**
 * Loads the engine's own modules, which register themselves here: the ElementRoom (`registerElementRoom`)
 * and the internal routes built outside it (`registerRoomExtension`, CR 2F-1). Idempotent (modules load once).
 */
export async function loadEngine(): Promise<void> {
  await import('./room/index.ts')
  await import('./room-internal/index.ts')
}

// ---- internal routes ------------------------------------------------------------------------------

/**
 * An internal route the router mounts under `/internal/…`, after its shared-secret check (401
 * `UNAUTHORIZED` without the secret, as for every internal route). `path` matches the raw path (no query);
 * its capture groups are passed as `params` (still percent-encoded: check ids with BOARD_ID_RE). Throw an
 * `HttpError` (http/respond.ts) for a failure; a wrong method gets 405 from the router.
 */
export interface InternalRoute {
  readonly method: 'GET' | 'POST'
  readonly path: RegExp
  handle(req: IncomingMessage, res: ServerResponse, params: string[]): unknown
}

// ---- the ElementRoom (O1) ---------------------------------------------------------------------------

/** Who a socket is, from the verified ticket and the connect URL (never from the client's messages). */
export interface ElementSessionInfo {
  readonly boardId: string
  /** `<uid>:<clientSessionId>` (the replaced-socket guard in app.ts is keyed by it) */
  readonly sid: string
  readonly uid: string
  readonly name: string
  /** the colour everyone is shown (presenceIdentity: a plain hex colour or the fallback) */
  readonly color: string
  readonly role: BoardRole
  /** the ticket's A3 `guest` claim */
  readonly guest: boolean
  /** viewers and commenters: every write is refused (READ_ONLY) */
  readonly readonly: boolean
  /** the ticket's `iat` (the access monitor re-checks sessions admitted before an access change) */
  readonly ticketIssuedAt: number
  /**
   * The contracts revision the connect URL names (`rev`, canvas-schema protocol.ts CONNECT_REV_PARAM; CONTRACTS_REV
   * 12 on), or null/absent for a client that names none (every web before rev 12): the room serves the socket
   * every frame in that revision's form and writes its pushes as that revision's (room/reader-frames.ts).
   */
  readonly contractsRev?: number | null
}

/** The socket as the room sees it: app.ts wraps the `ws` socket (never binds the room's listeners to it). */
export interface ElementSocket {
  /**
   * a text frame (JSON) or the binary gzip snapshot frame (protocol.ts SnapshotFrame). `compress: false` (M7-2):
   * never deflate this frame on the wire, whatever the socket negotiated (the snapshot is gzip already). `done`
   * (ws's send callback) runs once the frame has left the socket's buffer, or with an error once it never will: the
   * process-wide outbound budget counts the one cached snapshot once while any socket holds it (room/outbound.ts)
   */
  send(data: string | Uint8Array, opts?: { readonly compress?: boolean }, done?: (err?: Error) => void): void
  close(code: number, reason: string): void
  /** `ws` readyState: 1 = OPEN */
  readonly readyState: number
  /** bytes queued but not yet sent (backpressure, §2.4.5) */
  readonly bufferedAmount: number
}

/** What app.ts calls on a connected session. Messages arrive in order, already past the rate limiter and the join queue. */
export interface ElementSessionHandle {
  /** one whole text frame from the client */
  message(text: string): void
  /** the socket closed or errored (once) */
  closed(): void
}

/** A live session, as the access monitor and the session-end reporter read it. */
export interface LiveElementSession {
  readonly sessionId: string
  readonly meta: {
    readonly userId: string
    readonly role: BoardRole
    readonly name: string
    readonly color: string
  }
}

/**
 * The session directory the access monitor, the session-end reporter and app.ts use in either engine.
 * `closeSession(sid, 'FORBIDDEN')` ends a session for good (4099 FORBIDDEN); `closeSession(sid)` with no
 * reason makes it reconnect (4000 RECONNECT; a role change).
 */
export interface SessionDirectory {
  roomIfOpen(boardId: string): { closeSession(sessionId: string, reason?: string): void } | null
  sessionsOf(boardId: string): LiveElementSession[]
  openBoards(): string[]
}

/** The api's answer for A1 file-refs (packages/contracts sync-internal.ts), injectable for tests. */
export type FileRefsLookup = (boardId: string, versionIds: readonly string[]) => Promise<FileRefsResponse>
/** The api's answer for A2 workshop-state (the pull on room open), injectable for tests. */
export type WorkshopStateLookup = (boardId: string) => Promise<WorkshopStateBody>

export interface ElementRoomDeps {
  /** the rooms folder (`dataLayout(config.dataDir).rooms`); board files are `boardDbPath(dataDir, boardId)` as today */
  readonly dataDir: string
  /** the whole validated config (secrets included: keep them in memory, never log them) */
  readonly config: Readonly<SyncConfig>
  readonly log: (...a: unknown[]) => void
  readonly now?: () => number
  /** replaces the HTTP client of GET <api>/internal/boards/:bid/file-refs (tests) */
  readonly fileRefs?: FileRefsLookup
  /** replaces the HTTP client of GET <api>/internal/boards/:bid/workshop-state (tests) */
  readonly workshopState?: WorkshopStateLookup
  /** after a session has left its room (any reason) */
  readonly onSessionRemoved: (boardId: string, sessionId: string, meta: LiveElementSession['meta']) => void
  /** after a committed document write (never presence); cheap and must not throw (touch.ts, session-end.ts) */
  readonly onDocumentChange: (boardId: string) => void
  /**
   * OPEN16 (CR-W5-FIX-1): whether maintenance is on (app.ts's switch; absent: never). The router refuses a
   * board-writing internal POST on entry; the room's write paths (`serverWrite`, the room-internal seed,
   * place-notes and restore) ask again once the request body is read and parsed, synchronously before the
   * write, so a POST already in flight when maintenance went on cannot commit inside the window.
   */
  readonly maintenance?: () => boolean
  /** M7-4: the disk's free share (disk.ts; app.ts passes statfs or the test hook's answer). Absent: statfs. */
  readonly disk?: DiskProbe
}

/**
 * The ElementRoom service: every open board's room in this process. One per sync server. Created by the
 * registered factory (app.ts); with DRAFTROOM_TEST_HOOKS=1 it also calls `registerTestHooks`
 * (test-hooks.ts) and unregisters on `closeAll`.
 */
export interface ElementRoomService extends SessionDirectory {
  /**
   * Admits a session whose ticket app.ts verified: opens the board's room if needed (synchronously, like
   * RoomRegistry.getOrCreate, so creation is race-free) and returns the handle app.ts feeds. The session
   * must send `hello` first; everything else is the protocol (packages/canvas-schema protocol.ts).
   */
  connect(session: ElementSessionInfo, socket: ElementSocket): ElementSessionHandle
  /** the room's internal routes (snapshot, seed, workshop-state POST, …), mounted instead of the tldraw board routes */
  routes(): InternalRoute[]
  /** Prometheus text for GET /internal/metrics (§2.4.6) */
  metrics(): string
  /** closes every room, session and board file */
  closeAll(): Promise<void>
  /**
   * CR 2F-2 (optional; O1 implements it): the board's room opened for an internal route, after the
   * board's conversion or roll-forward when its file needs one (what the room's snapshot route waits for,
   * `existing` in room/index.ts). Resolves true when the room is open, false when the board has no file;
   * throws HttpError 503 `unavailable` when the board could not be prepared.
   */
  prepareBoard?(boardId: string): Promise<boolean>
  /**
   * CR 2F-2 (optional; O1 implements it): a server-originated write into the board's room (place-notes,
   * "Recently deleted" restore), queued with the sessions' pushes. The room opens the board if needed
   * (as `prepareBoard`), and in its drain runs `apply` inside the batch's transaction (its own SAVEPOINT)
   * with `clock` = the batch's next clock. Rows `apply` upserts carry that clock; after it, the room
   * rebuilds its caches from the store (index, groups, counts), drops its snapshot cache, broadcasts
   * `changed` as server ops and `doc` as a doc set with the batch's `changes`, calls `onDocumentChange`,
   * and resolves with `result`. A throw rolls the SAVEPOINT back and rejects. Nothing else writes an open
   * room's board file.
   */
  serverWrite?<T>(boardId: string, apply: ServerWriteApply<T>): Promise<T>
}

/** CR 2F-2: what a server write sees inside the transaction it commits in. */
export interface ServerWriteTx {
  /** the board file (room/store.ts), inside the transaction (and SAVEPOINT) the write commits in */
  readonly store: BoardStore
  /** the clock every row the write upserts carries */
  readonly clock: number
  readonly now: number
}
/** CR 2F-2: one element a server write changed (`before` null for a create). */
export interface ServerWriteChange {
  readonly before: WireElement | null
  readonly after: WireElement
}
/** CR 2F-2: a server write's changes, for the broadcast, and its answer. */
export interface ServerWriteOutcome<T> {
  readonly changed: readonly ServerWriteChange[]
  /** lb_doc keys written (null = removed) */
  readonly doc: Readonly<Record<string, unknown>>
  readonly result: T
}
/** CR 2F-2: synchronous from the first read to the last upsert (it runs inside the room's drain). */
export type ServerWriteApply<T> = (tx: ServerWriteTx) => ServerWriteOutcome<T>

export type ElementRoomFactory = (deps: ElementRoomDeps) => ElementRoomService

let elementRoomFactory: ElementRoomFactory | null = null

/** Called once by O1's `apps/sync/src/room/index.ts` at import. A second registration replaces the first. */
export function registerElementRoom(factory: ElementRoomFactory): void {
  elementRoomFactory = factory
}

/** The registered factory, or null when `./room/index.ts` was not loaded (loadEngine()). */
export function registeredElementRoom(): ElementRoomFactory | null {
  return elementRoomFactory
}

// ---- room extensions (CR 2F-1) --------------------------------------------------------------------------

/**
 * What a room extension builds its routes from: the service it extends (its public surface: the session
 * directory, `routes()`, and the optional CR 2F-2 members when the room has them) and the deps the service
 * was built with (the rooms folder, config, log, clock and the document-change reporter).
 */
export interface RoomExtensionContext {
  readonly service: ElementRoomService
  readonly deps: ElementRoomDeps
}
/**
 * Internal routes built outside the room (apps/sync/src/room-internal/**: seed, place-notes, text,
 * asset-refs, deleted), mounted after the room's own routes, behind the same secret check.
 */
export type RoomExtension = (ctx: RoomExtensionContext) => readonly InternalRoute[]

const roomExtensions: RoomExtension[] = []

/** Called by `./room-internal/index.ts` at import (loadEngine()). Returns the unregister function. */
export function registerRoomExtension(ext: RoomExtension): () => void {
  roomExtensions.push(ext)
  return () => {
    const i = roomExtensions.indexOf(ext)
    if (i >= 0) roomExtensions.splice(i, 1)
  }
}

/**
 * The service with the registered extensions' routes appended to its own (app.ts calls it on the
 * factory's service). With no extension registered it is the service itself.
 */
export function extendElementRoom(service: ElementRoomService, deps: ElementRoomDeps): ElementRoomService {
  if (roomExtensions.length === 0) return service
  const exts = [...roomExtensions]
  let extra: InternalRoute[] | null = null
  const extended: ElementRoomService = {
    connect: (session, socket) => service.connect(session, socket),
    routes: () => {
      extra ??= exts.flatMap((ext) => [...ext({ service, deps })])
      return [...service.routes(), ...extra]
    },
    metrics: () => service.metrics(),
    closeAll: () => service.closeAll(),
    roomIfOpen: (boardId) => service.roomIfOpen(boardId),
    sessionsOf: (boardId) => service.sessionsOf(boardId),
    openBoards: () => service.openBoards(),
  }
  if (service.prepareBoard) {
    const prepare = service.prepareBoard.bind(service)
    Object.assign(extended, { prepareBoard: prepare })
  }
  if (service.serverWrite) {
    const write = service.serverWrite.bind(service)
    Object.assign(extended, { serverWrite: write })
  }
  return extended
}
