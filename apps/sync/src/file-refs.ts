// A1 file-refs (docs/EXCALIDRAW-MIGRATION.md §2.10.2, packages/contracts sync-internal.ts): sync asks the
// api which image versions belong to a board's workspace before it stores a `fileId` or a
// `customData.lobby.file`. The call runs in stage 0 of the accept algorithm (§2.4.3), never inside the
// drain; the answers are cached per room (LRU of 10,000; positive answers 10 minutes, negative 30 s).
// Any status but 200, a malformed body or the 3 s timeout is a failure: the caller FAILS CLOSED (the ops
// that need an unresolved id get UNAVAILABLE).

import {
  FILE_REFS_CACHE,
  FILE_REFS_MAX_IDS,
  type FileRef,
  FileRefsResponse,
  fileRefsPath,
  SYNC_INTERNAL_SECRET_HEADER,
  SYNC_INTERNAL_TIMEOUT_MS,
} from '@draftroom/contracts'
import type { FileRefsLookup } from './engine-switch.ts'

export interface FileRefsClientOpts {
  /** the api's internal base URL, without a trailing slash (config.apiInternalUrl) */
  readonly baseUrl: string
  readonly internalSecret: string
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}

/** The HTTP client of `GET <api>/internal/boards/:bid/file-refs?ids=` (1–100 BARE version ids per call). */
export function createFileRefsClient(opts: FileRefsClientOpts): FileRefsLookup {
  const f = opts.fetchImpl ?? fetch
  return async (boardId, versionIds) => {
    const ids = [...new Set(versionIds)]
    const out: FileRefsResponse = { ok: [], foreign: [], missing: [] }
    for (let i = 0; i < ids.length; i += FILE_REFS_MAX_IDS) {
      const chunk = ids.slice(i, i + FILE_REFS_MAX_IDS)
      const res = await f(`${opts.baseUrl}${fileRefsPath(boardId, chunk)}`, {
        headers: { [SYNC_INTERNAL_SECRET_HEADER]: opts.internalSecret },
        signal: AbortSignal.timeout(opts.timeoutMs ?? SYNC_INTERNAL_TIMEOUT_MS),
      })
      if (res.status !== 200) throw new Error(`file-refs answered ${res.status}`)
      const body = FileRefsResponse.parse(await res.json())
      out.ok.push(...body.ok)
      out.foreign.push(...body.foreign)
      out.missing.push(...body.missing)
    }
    return out
  }
}

export type FileRefAnswer =
  | { readonly status: 'ok'; readonly ref: FileRef }
  | { readonly status: 'foreign' }
  | { readonly status: 'missing' }

interface CacheEntry {
  readonly answer: FileRefAnswer
  readonly until: number
}

/** The per-room answer cache: an LRU (Map insertion order) with the contract's lifetimes. */
export class FileRefsCache {
  private readonly map = new Map<string, CacheEntry>()
  hits = 0
  misses = 0
  private readonly now: () => number
  private readonly limits: typeof FILE_REFS_CACHE
  constructor(now: () => number, limits = FILE_REFS_CACHE) {
    this.now = now
    this.limits = limits
  }

  /** The cached answer for a bare version id, or undefined (unknown or expired). */
  get(versionId: string): FileRefAnswer | undefined {
    const e = this.map.get(versionId)
    if (!e) return undefined
    if (e.until <= this.now()) {
      this.map.delete(versionId)
      return undefined
    }
    this.map.delete(versionId)
    this.map.set(versionId, e)
    return e.answer
  }

  /** Counts a stage-0 look-up as a hit or a miss (metrics). */
  note(hit: boolean): void {
    if (hit) this.hits++
    else this.misses++
  }

  put(response: FileRefsResponse): void {
    const now = this.now()
    const set = (id: string, answer: FileRefAnswer, ttl: number) => {
      this.map.delete(id)
      this.map.set(id, { answer, until: now + ttl })
      while (this.map.size > this.limits.entries) {
        const oldest = this.map.keys().next().value
        if (oldest === undefined) break
        this.map.delete(oldest)
      }
    }
    for (const ref of response.ok) set(ref.versionId, { status: 'ok', ref }, this.limits.positiveMs)
    for (const id of response.foreign) set(id, { status: 'foreign' }, this.limits.negativeMs)
    for (const id of response.missing) set(id, { status: 'missing' }, this.limits.negativeMs)
  }
}
