// api -> sync internal canvas calls (docs/M1-CONTRACTS.md §8): read a board's snapshot, seed a NEW
// board. Other services never open the sync server's disk; they ask it over this authenticated API.

import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import {
  type LobbyElementsSnapshot,
  SYNC_INTERNAL_TIMEOUT_MS,
  type WorkshopStateBody,
  workshopStatePath,
} from '@draftroom/contracts'

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
   * (features/search validates it).
   */
  boardText?(boardId: string, opts?: { since?: number; maxBytes?: number }): Promise<unknown>
  /**
   * Excalidraw engine, A2 (docs/EXCALIDRAW-MIGRATION.md §1, §2.4.6; @draftroom/contracts
   * sync-internal.ts): tells sync whether a dot vote is open (POST /internal/boards/:bid/workshop-state,
   * 204), so it refuses new +1s and drops selection presence meanwhile. Optional like placeNotes. Throws
   * SyncUnavailable on anything but 2xx; a tldraw sync answers 404 (it has no such route).
   */
  workshopState?(boardId: string, body: WorkshopStateBody): Promise<void>
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

export function createHttpSyncInternalClient(opts: {
  baseUrl: string
  secret: string
  timeoutMs?: number
}): SyncInternalClient {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const timeout = opts.timeoutMs ?? 15_000
  async function call(path: string, init: RequestInit = {}) {
    let res: Response
    try {
      res = await fetch(`${base}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), [INTERNAL_SECRET_HEADER]: opts.secret },
        signal: AbortSignal.timeout(timeout),
      })
    } catch (e) {
      throw new SyncUnavailable(`sync unreachable: ${(e as Error).name}`)
    }
    return res
  }
  return {
    async snapshot(boardId) {
      const res = await call(`/internal/boards/${encodeURIComponent(boardId)}/snapshot`)
      if (!res.ok) throw new SyncUnavailable(`snapshot failed with ${res.status}`)
      return (await res.json()) as BoardSnapshotJson
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
    async placeNotes(boardId, body) {
      const res = await call(`/internal/boards/${encodeURIComponent(boardId)}/place-notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new SyncUnavailable(`place-notes failed with ${res.status}`)
      return (await res.json()) as unknown
    },
    async assetRefs(boardId) {
      const res = await call(`/internal/boards/${encodeURIComponent(boardId)}/asset-refs`)
      if (!res.ok) throw new SyncUnavailable(`asset-refs failed with ${res.status}`)
      return (await res.json()) as unknown
    },
    async boardText(boardId, opts = {}) {
      const params = new URLSearchParams()
      if (opts.since !== undefined) params.set('since', String(opts.since))
      if (opts.maxBytes !== undefined) params.set('maxBytes', String(opts.maxBytes))
      const qs = params.size ? `?${params}` : ''
      const res = await call(`/internal/boards/${encodeURIComponent(boardId)}/text${qs}`)
      if (!res.ok) throw new SyncUnavailable(`board text failed with ${res.status}`)
      return (await res.json()) as unknown
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
