// The Miro REST API v2 client of an import (wave R, WS1; docs/WAVE-R-CONTRACTS.md §3; AGENTS.md "Server egress
// exception: Miro import"). Every request goes through the egress module (../../../egress: the Miro policy's exact
// host, https:443, the read paths of MIRO_API_PATH_PATTERNS, GET only, the address vetted and pinned, redirects
// refused, one deadline and a byte cap), with the person's token as a RedactedSecret in the Authorization header,
// only toward Miro's API host. Nothing here logs, and no error it throws carries a URL, a header or a body: only a
// MIRO_CODES code (MiroError).
//
// Pacing (MIRO_RATE): at most `maxRequestsPerSecond` requests a second per client (one client per job, or per
// route call), slower (one a second) once X-RateLimit-Remaining falls under `slowBelowRemaining` of the limit; a
// 429 waits until X-RateLimit-Reset (epoch seconds) or Retry-After, at most `maxWaitMs`, at most `retries` times,
// then MIRO_RATE_LIMITED. Statuses: 400/401 MIRO_TOKEN_INVALID, 403 MIRO_SCOPE_MISSING, 404 MIRO_BOARD_NOT_VISIBLE,
// anything else (5xx, a refused, broken, oversized or unreadable answer, a timeout) MIRO_UNAVAILABLE.
//
// Files: `resourceUrl` asks Miro for a resource as `?format=original&redirect=false` and returns the signed URL of
// its answer (the egress file rule decides whether it may be fetched: MIRO_DOWNLOAD_HOSTS, no Bearer, its Expires).
import {
  MIRO_API_ORIGIN,
  MIRO_BOARD_ID_PATTERN,
  MIRO_CODES,
  MIRO_IMPORT_LIMITS,
  MIRO_RATE,
  MIRO_RESOURCE_PATH_PATTERN,
} from '@draftroom/contracts'
import { isRecord, type MiroPage, readPage } from '@draftroom/miro-import/sources'
import { type EgressDeps, EgressError, egressFetch, type RedactedSecret } from '../../../egress/index.ts'

export type MiroCode = (typeof MIRO_CODES)[keyof typeof MIRO_CODES]

/** A Miro request that did not give what was asked: a code only (never a URL, a header or Miro's words). */
export class MiroError extends Error {
  readonly code: MiroCode
  constructor(code: MiroCode) {
    super(`miro: ${code}`)
    this.name = 'MiroError'
    this.code = code
  }
  toJSON() {
    return { name: this.name, code: this.code }
  }
}

export interface MiroClientOptions {
  /** the origin standing for https://api.miro.com (the fake Miro's, behind the local-dev guard), else Miro's */
  readonly apiOrigin?: string
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  /** asked before every request and every wait (an import's checkpoint: it throws to stop) */
  readonly checkpoint?: () => Promise<void>
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms)
    t.unref?.()
  })

const header = (h: Readonly<Record<string, string | undefined>>, name: string): number | null => {
  const v = h[name]
  if (v === undefined || !/^\s*\d{1,12}(\.\d+)?\s*$/.test(v)) return null
  return Number(v)
}

export interface MiroTokenContext {
  readonly team: string
  readonly scopes: readonly string[]
}

export class MiroClient {
  readonly #deps: EgressDeps
  readonly #token: RedactedSecret
  readonly #origin: string
  readonly #now: () => number
  readonly #sleep: (ms: number) => Promise<void>
  readonly #checkpoint: () => Promise<void>
  #next = 0
  /** requests made (tests, the report's counts) */
  requests = 0

  constructor(deps: EgressDeps, token: RedactedSecret, opts: MiroClientOptions = {}) {
    this.#deps = deps
    this.#token = token
    this.#origin = (opts.apiOrigin ?? MIRO_API_ORIGIN).replace(/\/$/, '')
    this.#now = opts.now ?? Date.now
    this.#sleep = opts.sleep ?? defaultSleep
    this.#checkpoint = opts.checkpoint ?? (async () => {})
  }

  /** Waits for this client's next request slot. */
  async #pace(): Promise<void> {
    const wait = this.#next - this.#now()
    if (wait > 0) await this.#sleep(wait)
    this.#next = Math.max(this.#now(), this.#next) + Math.ceil(1000 / MIRO_RATE.maxRequestsPerSecond)
  }

  /** GET `path` (a read path) with `query`, as JSON. */
  async get(path: string, query: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') qs.set(k, String(v))
    const url = `${this.#origin}${path}${qs.size ? `?${qs.toString()}` : ''}`
    for (let attempt = 0; ; attempt++) {
      await this.#checkpoint()
      await this.#pace()
      this.requests++
      let answer: Awaited<ReturnType<typeof egressFetch>>
      try {
        answer = await egressFetch(this.#deps, {
          method: 'GET',
          url,
          accept: 'application/json',
          bearer: this.#token,
          timeoutMs: MIRO_IMPORT_LIMITS.requestTimeoutMs,
          maxBytes: MIRO_IMPORT_LIMITS.answerBytes,
        })
      } catch (e) {
        if (e instanceof EgressError) throw new MiroError(MIRO_CODES.unavailable)
        throw e
      }
      const { status, headers } = answer
      const limit = header(headers, 'x-ratelimit-limit')
      const remaining = header(headers, 'x-ratelimit-remaining')
      if (limit && remaining !== null && remaining < limit * MIRO_RATE.slowBelowRemaining)
        this.#next = Math.max(this.#next, this.#now() + 1000)
      if (status === 429) {
        if (attempt >= MIRO_RATE.retries) throw new MiroError(MIRO_CODES.rateLimited)
        const reset = header(headers, 'x-ratelimit-reset')
        const retryAfter = header(headers, 'retry-after')
        const until = reset !== null && reset > 1e9 ? reset * 1000 - this.#now() : null
        const ms = Math.min(MIRO_RATE.maxWaitMs, Math.max(1000, until ?? (retryAfter ?? 5) * 1000))
        await this.#checkpoint()
        await this.#sleep(ms)
        continue
      }
      if (status === 400 || status === 401) throw new MiroError(MIRO_CODES.tokenInvalid)
      if (status === 403) throw new MiroError(MIRO_CODES.scopeMissing)
      if (status === 404) throw new MiroError(MIRO_CODES.boardNotVisible)
      if (status < 200 || status >= 300) throw new MiroError(MIRO_CODES.unavailable)
      try {
        return JSON.parse(answer.body.toString('utf8')) as unknown
      } catch {
        throw new MiroError(MIRO_CODES.unavailable)
      }
    }
  }

  /** The token's team and scopes (`GET /v1/oauth-token`); a token without boards:read is MIRO_SCOPE_MISSING. */
  async tokenContext(): Promise<MiroTokenContext> {
    const body = await this.get('/v1/oauth-token')
    const team =
      isRecord(body) && isRecord(body.team) && typeof body.team.name === 'string' ? body.team.name : ''
    const scopes =
      isRecord(body) && Array.isArray(body.scopes) ? body.scopes.filter((s) => typeof s === 'string') : []
    if (!scopes.includes('boards:read')) throw new MiroError(MIRO_CODES.scopeMissing)
    return { team, scopes }
  }

  /** One page of the boards the token can see (`GET /v2/boards`, newest change first). */
  async boards(input: { query?: string; offset?: number }): Promise<MiroPage> {
    const page = readPage(
      await this.get('/v2/boards', {
        limit: MIRO_IMPORT_LIMITS.boardsPageSize,
        offset: input.offset ?? 0,
        sort: 'last_modified',
        query: input.query,
      }),
    )
    if (!page) throw new MiroError(MIRO_CODES.unavailable)
    return page
  }

  /** A board (`GET /v2/boards/{id}`): its name, or MIRO_BOARD_NOT_VISIBLE. */
  async board(boardId: string): Promise<{ id: string; name: string }> {
    if (!MIRO_BOARD_ID_PATTERN.test(boardId)) throw new MiroError(MIRO_CODES.boardNotVisible)
    const body = await this.get(`/v2/boards/${boardId}`)
    if (!isRecord(body)) throw new MiroError(MIRO_CODES.unavailable)
    return { id: boardId, name: typeof body.name === 'string' ? body.name : '' }
  }

  /**
   * Every element of a cursor-paged list (items, connectors, groups), page after page, until `max` were read
   * (then `over` is true). `onPage` gets the count so far (progress), and the checkpoint runs between pages.
   */
  async cursorList(
    path: string,
    opts: {
      max: number
      query?: Record<string, string>
      onPage?: (read: number, total: number | null) => void
    },
  ): Promise<{ data: unknown[]; over: boolean }> {
    const data: unknown[] = []
    let cursor: string | undefined
    for (let pages = 0; pages < 100_000; pages++) {
      const page = readPage(
        await this.get(path, { ...opts.query, limit: MIRO_IMPORT_LIMITS.itemsPageSize, cursor }),
      )
      if (!page) throw new MiroError(MIRO_CODES.unavailable)
      data.push(...page.data)
      opts.onPage?.(data.length, page.total)
      if (data.length > opts.max) return { data: data.slice(0, opts.max), over: true }
      if (!page.cursor || page.cursor === cursor || page.data.length === 0) break
      cursor = page.cursor
    }
    return { data, over: false }
  }

  /** Every element of an offset-paged list (tags, an item list by tag, members), up to `max`. */
  async offsetList(
    path: string,
    opts: { max: number; query?: Record<string, string> },
  ): Promise<{ data: unknown[]; over: boolean }> {
    const data: unknown[] = []
    const limit = MIRO_IMPORT_LIMITS.itemsPageSize
    for (let offset = 0; offset <= 100_000; offset += limit) {
      const page = readPage(await this.get(path, { ...opts.query, limit, offset }))
      if (!page) throw new MiroError(MIRO_CODES.unavailable)
      data.push(...page.data)
      if (data.length > opts.max) return { data: data.slice(0, opts.max), over: true }
      const total = page.total ?? 0
      if (page.data.length < limit || data.length >= total) break
    }
    return { data, over: false }
  }

  /**
   * The signed URL a resource answer names (`GET <path>?format=original&redirect=false` → `{ type, url }`), or null
   * when the answer has none. `path` must be a resource path (MIRO_RESOURCE_PATH_PATTERN).
   */
  async resourceUrl(path: string): Promise<string | null> {
    if (!MIRO_RESOURCE_PATH_PATTERN.test(path)) return null
    // images come in their original format; a document has only the one
    const images = path.includes('/resources/images/')
    const body = await this.get(
      path,
      images ? { format: 'original', redirect: 'false' } : { redirect: 'false' },
    )
    return isRecord(body) && typeof body.url === 'string' && body.url.length <= 8192 ? body.url : null
  }
}
