// api -> sync internal canvas calls (docs/M1-CONTRACTS.md §8): read a board's snapshot, seed a NEW
// board. Other services never open the sync server's disk; they ask it over this authenticated API.

import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'

/** A tldraw RoomSnapshot as JSON (documents + schema + clocks). Treated as opaque data here. */
export type RoomSnapshotJson = {
  documents: { state: Record<string, unknown>; lastChangedClock?: number }[]
  schema?: unknown
  [k: string]: unknown
}

export interface SyncInternalClient {
  snapshot(boardId: string): Promise<RoomSnapshotJson>
  /** Initializes a board that has no canvas data yet. Throws SyncSeedConflict if it already has some. */
  seed(boardId: string, snapshot: RoomSnapshotJson): Promise<{ records: number }>
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
}

export class SyncSeedConflict extends Error {
  constructor() {
    super('board already has canvas data')
  }
}

export class SyncUnavailable extends Error {}

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
      return (await res.json()) as RoomSnapshotJson
    },
    async seed(boardId, snapshot) {
      const res = await call(`/internal/boards/${encodeURIComponent(boardId)}/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ snapshot }),
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
  }
}
