// Feature module: link previews (D2, docs/research/excalidraw/REVIEW-W5-EARLY.md §9; owner 3g). A URL
// pasted on the Excalidraw board becomes a link card: the page's title and site icon, opening in a new
// tab. The board never contacts the site: this route fetches the page's <head> (and its icon) on the
// signed-in person's behalf, with the SSRF rules of ./ssrf.ts, a time and size limit per fetch, and
// answers plain text plus a small raster icon as a `data:` URL that the client only displays (it is
// never stored in an element: the card stores the link and its title as words).
//
//   POST /api/boards/:bid/link-preview  {url}  ->  {title, siteName, icon}
//
// Who: anyone with an account who can view the board (its link cards show to every viewer). Name-only
// guests are refused (403 GUEST_ACCOUNT_REQUIRED, security audit L2): a guest identity costs nothing but
// a name, so the per-person budget below would multiply by the guests one person can create, and the
// canvas never asks for them anyway (a guest's links must be Lobby-relative). The guests feature's root
// guard (features/guests/guard.ts GUEST_REFUSED_ROUTES) refuses them first; this route checks again, so a
// renamed route cannot slip past that list. Limits: 30 fresh fetches a minute per person (answers from
// the cache are free), 6 fetches at once for the whole api, results cached for an hour (10 minutes when
// nothing could be read). A refused or unreachable page answers like a page with no title (all null),
// so the answer says nothing about the api's own network. Nothing here logs a URL (a link can be
// private content).
import { lookup as dnsLookup } from 'node:dns/promises'
import {
  LINK_PREVIEW_ICON_MAX_BYTES,
  LINK_PREVIEW_ROUTE,
  type LinkPreview,
  LinkPreviewInput,
} from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { requireBoardAction } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import type { Params } from '../../context.ts'
import { ApiError, parse } from '../../errors.ts'
import { keyedLimit } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'
import { guestRefused, LINK_PREVIEW_GUESTS } from '../guests/guard.ts'
import { type FetchDeps, FetchRefused, guardedFetch } from './fetch.ts'
import { decodeHtml, iconCandidates, iconType, parseHead } from './parse.ts'
import { checkUrl, type Lookup, type Policy } from './ssrf.ts'

export { LINK_PREVIEW_ROUTE }

export const LINK_PREVIEW_LIMITS = {
  pageTimeoutMs: 5_000,
  iconTimeoutMs: 3_000,
  /** of the page, decompressed; the head is all that is read */
  pageMaxBytes: 512 * 1024,
  iconMaxBytes: LINK_PREVIEW_ICON_MAX_BYTES,
  maxRedirects: 4,
  perUserPerMinute: 30,
  concurrent: 6,
  cacheEntries: 1_000,
  cacheMs: 60 * 60_000,
  emptyCacheMs: 10 * 60_000,
} as const

const EMPTY: LinkPreview = { title: null, siteName: null, icon: null }
const invalidLink = () => new ApiError(400, 'INVALID_LINK', 'That link can’t be shown as a card.')

export interface LinkPreviewDeps {
  readonly lookup?: Lookup
  readonly request?: FetchDeps['request']
}

const systemLookup: Lookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family,
  }))

/** A bounded map with time-limited entries (least recently used first out). */
class TtlCache<V> {
  private readonly map = new Map<string, { at: number; ttl: number; value: V }>()
  private readonly max: number
  constructor(max: number) {
    this.max = max
  }
  get(key: string, now: number): V | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    if (now - e.at > e.ttl) {
      this.map.delete(key)
      return undefined
    }
    this.map.delete(key)
    this.map.set(key, e)
    return e.value
  }
  set(key: string, value: V, ttl: number, now: number) {
    this.map.delete(key)
    this.map.set(key, { at: now, ttl, value })
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }
}

/** Reads a page's title, site name and icon (never throws: nothing readable answers all null). */
export async function readPreview(deps: FetchDeps, url: string): Promise<LinkPreview> {
  const L = LINK_PREVIEW_LIMITS
  let page: Awaited<ReturnType<typeof guardedFetch>>
  try {
    page = await guardedFetch(
      deps,
      url,
      'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
      { timeoutMs: L.pageTimeoutMs, maxBytes: L.pageMaxBytes, maxRedirects: L.maxRedirects },
      // the head is enough
      (sofar) => sofar.length > 2048 && /<\/head\s*>|<body[\s>]/i.test(sofar.toString('latin1')),
    )
  } catch (e) {
    if (e instanceof FetchRefused) return EMPTY
    return EMPTY
  }
  if (page.contentType !== 'text/html' && page.contentType !== 'application/xhtml+xml') return EMPTY
  const meta = parseHead(decodeHtml(page.body, page.charset))
  let icon: string | null = null
  for (const candidate of iconCandidates(meta, page.url)) {
    try {
      const got = await guardedFetch(
        deps,
        candidate,
        'image/png,image/x-icon,image/vnd.microsoft.icon,image/gif,image/jpeg,image/webp;q=0.9',
        { timeoutMs: L.iconTimeoutMs, maxBytes: L.iconMaxBytes + 1, maxRedirects: L.maxRedirects },
      )
      // too large (cut at the limit), or not one of the raster types by its own bytes (no SVG, no HTML)
      if (got.body.length > L.iconMaxBytes || got.truncated) continue
      const type = iconType(got.body)
      if (!type) continue
      icon = `data:${type};base64,${got.body.toString('base64')}`
      break
    } catch {}
  }
  return { title: meta.title, siteName: meta.siteName, icon }
}

export async function registerLinkPreview(
  app: FastifyInstance,
  ctx: FeatureContext,
  deps: LinkPreviewDeps = {},
): Promise<void> {
  const L = LINK_PREVIEW_LIMITS
  // the e2e fixture origins (config.ts DRAFTROOM_LINK_PREVIEW_TEST_ORIGINS, behind the local-dev guard)
  const seam = ctx.config.devAuth && !ctx.config.production ? ctx.config.linkPreviewTestOrigins : []
  const policy: Policy = { allowOrigins: new Set(seam) }
  const fetchDeps: FetchDeps = { policy, lookup: deps.lookup ?? systemLookup, request: deps.request }
  const perUser = keyedLimit(
    { max: L.perUserPerMinute, timeWindow: 60_000 },
    ctx.now,
    'Too many links at once. Wait a moment and try again.',
  )
  const cache = new TtlCache<LinkPreview>(L.cacheEntries)
  const inFlight = new Map<string, Promise<LinkPreview>>()
  let running = 0
  const waiting: (() => void)[] = []
  const slot = async () => {
    if (running < L.concurrent) {
      running++
      return
    }
    await new Promise<void>((resolve) => waiting.push(resolve))
    running++
  }
  const release = () => {
    running--
    waiting.shift()?.()
  }

  app.post(LINK_PREVIEW_ROUTE, { bodyLimit: 4096 }, async (req): Promise<LinkPreview> => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    await requireBoardAction(ctx.db, bid, user.id, 'view')
    // Audit L2: after the board check (an outsider still gets the board's 404, not a guest refusal).
    if ((await userKind(ctx.db, user.id)) === 'guest') throw guestRefused(LINK_PREVIEW_GUESTS)
    const { url } = parse(LinkPreviewInput, req.body)
    const target = checkUrl(url, policy)
    if (target === 'invalid') throw invalidLink()
    if (target === 'blocked') return EMPTY
    const key = target.url.href
    const now = ctx.now().getTime()
    const cached = cache.get(key, now)
    if (cached) return cached
    let pending = inFlight.get(key)
    if (!pending) {
      perUser.take(user.id)
      pending = (async () => {
        await slot()
        try {
          return await readPreview(fetchDeps, key)
        } finally {
          release()
        }
      })()
      inFlight.set(key, pending)
      void pending
        .then((value) => {
          const empty = !value.title && !value.siteName && !value.icon
          cache.set(key, value, empty ? L.emptyCacheMs : L.cacheMs, ctx.now().getTime())
        })
        .catch(() => {})
        .finally(() => inFlight.delete(key))
    }
    return pending
  })
}
