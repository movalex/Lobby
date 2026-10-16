// Wave T assignee-refs (docs/WAVE-T-CONTRACTS.md §3.2, §5; packages/contracts sync-internal.ts): before the room
// stores a `card:who` (canvas-schema planning-keys.ts), it asks the api which of the uids a push names are ACCOUNTS
// with a role on the board now. The call runs in stage 0 of the accept algorithm (element-room.ts, beside file-refs),
// never inside the drain: once per push batch for the uids the room's cache does not hold, chunked by
// ASSIGNEE_REFS_MAX_UIDS. Any status but 200 (a 404 for a trashed or unknown board, or an api without the route; a
// 503), a malformed body or the 3 s timeout is a failure, and the caller FAILS CLOSED: the ops naming an unresolved
// uid get UNAVAILABLE (retryable). A uid the answer leaves out is no account with access: INVALID.
// Removing an assignee needs no lookup; a uid is never logged.

import {
  ASSIGNEE_REFS_CACHE_MS,
  ASSIGNEE_REFS_MAX_UIDS,
  AssigneeRefsAnswer,
  assigneeRefsPath,
  SYNC_INTERNAL_SECRET_HEADER,
  SYNC_INTERNAL_TIMEOUT_MS,
} from '@draftroom/contracts'

/** The api's answer for a set of uids: the ones that are accounts with a role on the board. */
export type AssigneeRefsLookup = (boardId: string, uids: readonly string[]) => Promise<readonly string[]>

export interface AssigneeRefsClientOpts {
  /** the api's internal base URL, without a trailing slash (config.apiInternalUrl) */
  readonly baseUrl: string
  readonly internalSecret: string
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}

/** The HTTP client of `POST <api>/internal/boards/:bid/assignee-refs` (1-50 uids per call). */
export function createAssigneeRefsClient(opts: AssigneeRefsClientOpts): AssigneeRefsLookup {
  const f = opts.fetchImpl ?? fetch
  return async (boardId, uids) => {
    const asked = [...new Set(uids)]
    const out: string[] = []
    for (let i = 0; i < asked.length; i += ASSIGNEE_REFS_MAX_UIDS) {
      const chunk = asked.slice(i, i + ASSIGNEE_REFS_MAX_UIDS)
      const res = await f(`${opts.baseUrl}${assigneeRefsPath(boardId)}`, {
        method: 'POST',
        headers: { [SYNC_INTERNAL_SECRET_HEADER]: opts.internalSecret, 'content-type': 'application/json' },
        body: JSON.stringify({ uids: chunk }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? SYNC_INTERNAL_TIMEOUT_MS),
      })
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {})
        throw new Error(`assignee-refs answered ${res.status}`)
      }
      const body = AssigneeRefsAnswer.parse(await res.json())
      // only what was asked counts (a confused answer names nothing more)
      const inChunk = new Set(chunk)
      for (const uid of body.accounts) if (inChunk.has(uid)) out.push(uid)
    }
    return out
  }
}

/**
 * How long "not an account with access" is kept: shorter than a yes (ASSIGNEE_REFS_CACHE_MS, 60 s), so a person
 * invited a moment ago can be assigned within seconds, and a forged uid repeated push after push still costs at most
 * one call per 10 s.
 */
export const ASSIGNEE_REFS_NEGATIVE_MS = 10_000
/**
 * Flooding (wave T review): a push naming random uids skips the negative cache, so at most this many uids the cache
 * lacks are asked per push (one call: the route's own cap); a write naming any other is INVALID before any lookup.
 */
export const ASSIGNEE_NEW_UIDS_PER_PUSH = 50
/** A room's assignee-refs calls in a minute, all its sockets together: past it new uids are UNAVAILABLE, unasked. */
export const ASSIGNEE_LOOKUPS_PER_MINUTE = 20

/** A sliding-window count: `take()` is true (and counts) while fewer than `limit` were taken in the last `windowMs`. */
export class LookupRate {
  private readonly at: number[] = []
  private readonly now: () => number
  private readonly limit: number
  private readonly windowMs: number
  constructor(now: () => number, limit: number, windowMs: number) {
    this.now = now
    this.limit = limit
    this.windowMs = windowMs
  }

  take(): boolean {
    const now = this.now()
    while (this.at.length && (this.at[0] as number) <= now - this.windowMs) this.at.shift()
    if (this.at.length >= this.limit) return false
    this.at.push(now)
    return true
  }
}

/** Entries a room keeps (an LRU): far more people than a board has. */
export const ASSIGNEE_REFS_CACHE_ENTRIES = 2_000

interface CacheEntry {
  readonly account: boolean
  readonly until: number
}

/** The per-room answer cache (Map insertion order: least recently used first). */
export class AssigneeRefsCache {
  private readonly map = new Map<string, CacheEntry>()
  private readonly now: () => number
  constructor(now: () => number) {
    this.now = now
  }

  /** true: an account with access; false: not one; undefined: unknown or expired. */
  get(uid: string): boolean | undefined {
    const e = this.map.get(uid)
    if (!e) return undefined
    if (e.until <= this.now()) {
      this.map.delete(uid)
      return undefined
    }
    this.map.delete(uid)
    this.map.set(uid, e)
    return e.account
  }

  /** Records the answer for `asked`: the ones in `accounts` are accounts with access, the others are not. */
  put(asked: readonly string[], accounts: readonly string[]): void {
    const yes = new Set(accounts)
    const now = this.now()
    for (const uid of asked) {
      const account = yes.has(uid)
      this.map.delete(uid)
      this.map.set(uid, {
        account,
        until: now + (account ? ASSIGNEE_REFS_CACHE_MS : ASSIGNEE_REFS_NEGATIVE_MS),
      })
      while (this.map.size > ASSIGNEE_REFS_CACHE_ENTRIES) {
        const oldest = this.map.keys().next().value
        if (oldest === undefined) break
        this.map.delete(oldest)
      }
    }
  }
}
