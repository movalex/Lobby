// api -> sync internal canvas calls (docs/M1-CONTRACTS.md §8): read a board's snapshot, seed a NEW
// board. Other services never open the sync server's disk; they ask it over this authenticated API.

import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import {
  LobbyElementsSnapshot,
  SYNC_INTERNAL_TIMEOUT_MS,
  type WorkshopStateBody,
  workshopStatePath,
} from '@draftroom/contracts'
import type { CanvasEngine } from './canvas-engine.ts'

/** A tldraw RoomSnapshot as JSON (documents + schema + clocks). Treated as opaque data here. */
export type RoomSnapshotJson = {
  documents: { state: Record<string, unknown>; lastChangedClock?: number }[]
  schema?: unknown
  [k: string]: unknown
}

/**
 * What `GET …/snapshot` answers: a tldraw RoomSnapshot, or (sync on the Excalidraw engine, wave 2F) the
 * `lobby-elements` envelope. Readers tell them apart with canvas/lobby-elements.ts `lobbySnapshotOf`.
 */
export type BoardSnapshotJson = RoomSnapshotJson | LobbyElementsSnapshot

/**
 * A seed of the Excalidraw engine (apps/sync/src/room-internal/seed.ts): elements and the board document.
 * A tldraw sync refuses it (400), so it is sent only for content that is already elements.
 */
export interface LobbySeed {
  format: 'lobby-elements'
  elements: unknown[]
  doc: Record<string, unknown>
  /**
   * Wave T: the content's `card:who` uids that are accounts with a role on the NEW board (its row does not exist
   * when the seed runs, so the sync cannot ask assignee-refs for it): the sync keeps only these. An older sync
   * ignores the field (and holds no planning key).
   */
  assignees?: string[]
}

export const isLobbySeed = (v: RoomSnapshotJson | LobbySeed): v is LobbySeed =>
  (v as { format?: unknown }).format === 'lobby-elements'

export interface SyncInternalClient {
  snapshot(boardId: string): Promise<BoardSnapshotJson>
  /**
   * Initializes a board that has no canvas data yet. Throws SyncSeedConflict if it already has some.
   * tldraw records go as today's `{ snapshot }` (a sync on the Excalidraw engine converts them); elements
   * as a LobbySeed.
   */
  seed(boardId: string, snapshot: RoomSnapshotJson | LobbySeed): Promise<{ records: number }>
  /**
   * Wave R (WS1, import from Miro): seeds a NEW board from what an import read from Miro (`format: 'miro-v2'`,
   * packages/miro-import sources.ts MiroSeedBody). Sync converts it in a worker thread and answers with the board's
   * report (unchecked JSON: the caller validates it). Throws SyncSeedConflict on 409, SyncUnavailable (with sync's
   * status: 413 too large, 422 too complex, 503 busy) otherwise. Waits up to MIRO_SEED_TIMEOUT_MS (a conversion of
   * a big board takes seconds). Optional like placeNotes.
   */
  seedMiro?(boardId: string, body: unknown): Promise<{ records: number; report: unknown }>
  /**
   * Private brainstorming (workshops private-notes): writes revealed drafts into the board as note
   * shapes, in one storage transaction (POST /internal/boards/:bid/place-notes). Idempotent per draft
   * id. Optional so that test fakes without it keep compiling; the HTTP client always has it. The
   * answer is unchecked JSON: the caller validates it.
   */
  placeNotes?(boardId: string, body: unknown): Promise<unknown>
  /**
   * The asset collector (files/gc.ts): the file versions a board's canvas and its "Recently deleted"
   * still reference (GET /internal/boards/:bid/asset-refs). Optional like placeNotes; unchecked JSON
   * (the collector validates it, and treats anything else as an unreadable board).
   */
  assetRefs?(boardId: string): Promise<unknown>
  /**
   * Search (GET /internal/boards/:bid/text): the board's searchable text, or `{ unchanged: true }`
   * when its document clock is still `since`. Optional like placeNotes; the answer is unchecked JSON
   * (features/search validates it). `links` (wave N, N7-3): ask for the board links too (`?links=1`; an older
   * sync ignores it and answers without them).
   */
  boardText?(boardId: string, opts?: { since?: number; maxBytes?: number; links?: boolean }): Promise<unknown>
  /**
   * Excalidraw engine, A2 (docs/EXCALIDRAW-MIGRATION.md §1, §2.4.6; @draftroom/contracts
   * sync-internal.ts): tells sync whether a dot vote is open (POST /internal/boards/:bid/workshop-state,
   * 204), so it refuses new +1s and drops selection presence meanwhile. Optional like placeNotes. Throws
   * SyncUnavailable on anything but 2xx; a tldraw sync answers 404 (it has no such route).
   */
  workshopState?(boardId: string, body: WorkshopStateBody): Promise<void>
  /**
   * The canvas the sync server runs (GET /internal/canvas; canvas-engine.ts): `excalidraw` on the new
   * canvas, else `tldraw` (R0's sync has no such route: 404). Throws SyncUnavailable when sync cannot be
   * asked. Optional like placeNotes; a client without it is a tldraw sync.
   */
  engine?(): Promise<CanvasEngine>
  /**
   * Wave N.1: the sync server's clock, ms since the epoch (GET /internal/clock; ./sync-clock.ts measures the offset).
   * Throws SyncUnavailable when sync cannot be asked or has no such route (an older sync: 404). Optional like
   * placeNotes; a client without it leaves the api on its own clock.
   */
  clock?(): Promise<number>
}

export class SyncSeedConflict extends Error {
  constructor() {
    super('board already has canvas data')
  }
}

export class SyncUnavailable extends Error {
  /** The HTTP status sync answered with, when it answered at all. */
  readonly status: number | null
  constructor(message?: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

/**
 * Bridge release R0 (docs/EXCALIDRAW-MIGRATION.md §5.9 step 4): the sync server refused the board
 * because it was made on the new canvas (409 `new-canvas`). A SyncUnavailable, so every existing
 * caller keeps treating the board as unreadable (retry later, keep its files); the history routes say
 * why (new-board.ts viaSync).
 */
export class SyncNewCanvasBoard extends SyncUnavailable {
  constructor() {
    super('the board was made on the new canvas', 409)
  }
}

/**
 * A snapshot answer as this build reads it: a tldraw RoomSnapshot, which always has a `documents` array
 * (a board without storage answers an empty board's records), or (sync on the Excalidraw engine) the
 * `lobby-elements` envelope (docs/EXCALIDRAW-MIGRATION.md §3.7). Anything else would read as an EMPTY
 * board: an empty checkpoint that lists and restores as a real one, an empty duplicate or export. So it
 * is refused as SyncUnavailable (the callers retry later or answer 503). Bridge release R0 (the tldraw
 * build, on main) refuses the `lobby-elements` envelope too; this branch reads it.
 */
export function boardSnapshotOf(value: unknown): BoardSnapshotJson {
  const v = value as { documents?: unknown } | null
  if (v && typeof v === 'object' && Array.isArray(v.documents)) return value as RoomSnapshotJson
  if (LobbyElementsSnapshot.safeParse(value).success) return value as LobbyElementsSnapshot
  throw new SyncUnavailable('the sync server answered with a snapshot of neither canvas format')
}

/**
 * The client with every snapshot answer checked (boardSnapshotOf), whichever client it is (the HTTP
 * one, or a test's): what app.ts hands to the features. Every other member is the client's own.
 */
export function checkedSnapshots(client: SyncInternalClient): SyncInternalClient {
  const snapshot = async (boardId: string) => boardSnapshotOf(await client.snapshot(boardId))
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'snapshot') return snapshot
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** A failed answer: SyncNewCanvasBoard for sync's 409 `new-canvas`, else SyncUnavailable. */
async function failure(res: Response, what: string): Promise<SyncUnavailable> {
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null
    if (body?.error?.code === 'new-canvas') return new SyncNewCanvasBoard()
  } else await res.body?.cancel().catch(() => {})
  return new SyncUnavailable(`${what} failed with ${res.status}`, res.status)
}

/** How long the api waits for a Miro seed (sync's own budget is shorter: convert-miro.ts miroSeedLimits). */
export const MIRO_SEED_TIMEOUT_MS = 60_000

export function createHttpSyncInternalClient(opts: {
  baseUrl: string
  secret: string
  timeoutMs?: number
}): SyncInternalClient {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const timeout = opts.timeoutMs ?? 15_000
  async function call(path: string, init: RequestInit = {}, waitMs = timeout) {
    let res: Response
    try {
      res = await fetch(`${base}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), [INTERNAL_SECRET_HEADER]: opts.secret },
        signal: AbortSignal.timeout(waitMs),
      })
    } catch (e) {
      throw new SyncUnavailable(`sync unreachable: ${(e as Error).name}`)
    }
    return res
  }
  return {
    async snapshot(boardId) {
      const res = await call(`/internal/boards/${encodeURIComponent(boardId)}/snapshot`)
      if (!res.ok) throw await failure(res, 'snapshot')
      return boardSnapshotOf(await res.json())
    },
    async seed(boardId, snapshot) {
      const res = await call(`/internal/boards/${encodeURIComponent(boardId)}/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(isLobbySeed(snapshot) ? snapshot : { snapshot }),
      })
      if (res.status === 409) throw new SyncSeedConflict()
      if (!res.ok) throw new SyncUnavailable(`seed failed with ${res.status}`)
      const body = (await res.json()) as { records?: number }
      return { records: body.records ?? 0 }
    },
    async seedMiro(boardId, body) {
      const res = await call(
        `/internal/boards/${encodeURIComponent(boardId)}/seed`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
        MIRO_SEED_TIMEOUT_MS,
      )
      if (res.status === 409) {
        await res.body?.cancel().catch(() => {})
        throw new SyncSeedConflict()
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        throw new SyncUnavailable(`seed failed with ${res.status}`, res.status)
      }
      const answer = (await res.json()) as { records?: number; report?: unknown }
      return { records: answer.records ?? 0, report: answer.report ?? null }
    },
    async placeNotes(boardId, body) {
      const res = await call(`/internal/boards/${encodeURIComponent(boardId)}/place-notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw await failure(res, 'place-notes')
      return (await res.json()) as unknown
    },
    async assetRefs(boardId) {
      const res = await call(`/internal/boards/${encodeURIComponent(boardId)}/asset-refs`)
      if (!res.ok) throw await failure(res, 'asset-refs')
      return (await res.json()) as unknown
    },
    async boardText(boardId, opts = {}) {
      const params = new URLSearchParams()
      if (opts.since !== undefined) params.set('since', String(opts.since))
      if (opts.maxBytes !== undefined) params.set('maxBytes', String(opts.maxBytes))
      if (opts.links) params.set('links', '1')
      const qs = params.size ? `?${params}` : ''
      const res = await call(`/internal/boards/${encodeURIComponent(boardId)}/text${qs}`)
      if (!res.ok) throw await failure(res, 'board text')
      return (await res.json()) as unknown
    },
    async engine() {
      let res: Response
      try {
        res = await fetch(`${base}/internal/canvas`, {
          headers: { [INTERNAL_SECRET_HEADER]: opts.secret },
          signal: AbortSignal.timeout(Math.min(timeout, 2_000)),
          redirect: 'error', // never forward the secret anywhere else
        })
      } catch (e) {
        throw new SyncUnavailable(`sync unreachable: ${(e as Error).name}`)
      }
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {})
        return 'tldraw'
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        throw new SyncUnavailable(`canvas failed with ${res.status}`, res.status)
      }
      const body = (await res.json().catch(() => null)) as { engine?: unknown } | null
      return body?.engine === 'excalidraw' ? 'excalidraw' : 'tldraw'
    },
    async clock() {
      let res: Response
      try {
        res = await fetch(`${base}/internal/clock`, {
          headers: { [INTERNAL_SECRET_HEADER]: opts.secret },
          signal: AbortSignal.timeout(Math.min(timeout, 2_000)),
          redirect: 'error', // never forward the secret anywhere else
        })
      } catch (e) {
        throw new SyncUnavailable(`sync unreachable: ${(e as Error).name}`)
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        throw new SyncUnavailable(`clock failed with ${res.status}`, res.status)
      }
      const body = (await res.json().catch(() => null)) as { now?: unknown } | null
      const now = body?.now
      if (typeof now !== 'number' || !Number.isSafeInteger(now) || now <= 0)
        throw new SyncUnavailable('clock answered something else')
      return now
    },
    async workshopState(boardId, body) {
      let res: Response
      try {
        res = await fetch(`${base}${workshopStatePath(boardId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [INTERNAL_SECRET_HEADER]: opts.secret },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.min(timeout, SYNC_INTERNAL_TIMEOUT_MS)),
          redirect: 'error', // never forward the secret anywhere else
        })
      } catch (e) {
        throw new SyncUnavailable(`sync unreachable: ${(e as Error).name}`)
      }
      await res.body?.cancel()
      if (!res.ok) throw new SyncUnavailable(`workshop-state failed with ${res.status}`, res.status)
    },
  }
}
