// Wave S, WS4: helpers for the s4-* specs (the client review page and its summary PDF). WS1's routes are not in this
// branch, so the review routes are DOUBLES at the network layer (Playwright route handlers): `GET …/review`,
// `POST …/review/items/:rvi/status` and `GET …/review/items/:rvi/events` answer from a small state with the contract's
// shapes (packages/contracts review.ts), record every call, and can be told to fail the next write (409 STATUS_CHANGED,
// 409 NEWER_VERSION…). Everything else is the real stack: the board, its frames, the comments, the invitation, the guest
// join and the PDF made in the browser.
import type { Browser, BrowserContext, Page, Route } from '@playwright/test'
import { expect } from '@playwright/test'
import { waitForCanvas } from '../tests/support/canvas.ts'
import { signedInContext } from '../tests/support/dashboard-share.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { ORIGIN, waitForLobbyBoard } from './guests-kit.ts'

/** The dev-auth override of the review page switch (apps/web features/review/flags.ts REVIEW_FLAG_KEYS.reviewPage). */
export const REVIEW_PAGE_FLAG_KEY = 'lobby.reviewPage'

export interface Actor {
  id: string | null
  name: string
  kind: 'account' | 'guest'
  external: boolean
}
export const SAM_GUEST: Actor = { id: null, name: 'Sam Rivera', kind: 'guest', external: false }
export const ANA_GUEST: Actor = { id: null, name: 'Ana', kind: 'guest', external: false }

type Status = 'pending' | 'changes_requested' | 'approved'

export interface DoubleItem {
  elementId: string
  label: string
  kind?: 'frame' | 'file'
  assetId?: string | null
  status?: Status
  statusBy?: Actor | null
  statusAt?: string | null
  statusSeq?: number
  statusVersionId?: string | null
  position?: number | null
  roundId?: string | null
}

export interface Call {
  method: string
  path: string
  body: unknown
}

interface Failure {
  status: number
  body: unknown
}

const pad = (n: number, width = 10) => String(n).padStart(width, '0')

/** The review routes of one board, answered from memory. */
export class ReviewDouble {
  readonly boardId: string
  readonly items: Record<string, unknown>[]
  readonly calls: Call[] = []
  readonly events = new Map<string, Record<string, unknown>[]>()
  can: { setStatus: boolean; manage: boolean }
  /** who the "server" says did a write (the session's user) */
  actor: Actor
  private readonly failures: Failure[] = []
  private seq = 1000
  openRound: Record<string, unknown> | null = null

  constructor(
    boardId: string,
    items: readonly DoubleItem[],
    opts: { can?: { setStatus: boolean; manage: boolean }; actor?: Actor } = {},
  ) {
    this.boardId = boardId
    this.can = opts.can ?? { setStatus: true, manage: false }
    this.actor = opts.actor ?? SAM_GUEST
    this.items = items.map((it, i) => ({
      id: `rvi_s4item${pad(i + 1)}`,
      boardId,
      elementId: it.elementId,
      kind: it.kind ?? 'frame',
      assetId: it.assetId ?? null,
      label: it.label,
      position: it.position ?? null,
      roundId: it.roundId ?? null,
      status: it.status ?? 'pending',
      statusSeq: it.statusSeq ?? 0,
      statusBy: it.statusBy ?? null,
      statusAt: it.statusAt ?? null,
      statusVersionId: it.statusVersionId ?? null,
      createdAt: '2026-10-10T10:00:00.000Z',
      removedAt: null,
    }))
  }

  /** The item row of the n-th item (1-based). */
  item(n: number): Record<string, unknown> {
    const it = this.items[n - 1]
    if (!it) throw new Error(`no item ${n}`)
    return it
  }
  itemId(n: number): string {
    return String(this.item(n).id)
  }

  /** The status writes the page made, in order. */
  statusCalls(): Call[] {
    return this.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/status'))
  }

  /** The next status write answers `status` with `body` (once). */
  failNext(status: number, body: unknown) {
    this.failures.push({ status, body })
  }

  /** Someone else answered an item meanwhile: the row changes, the next write sees a different statusSeq. */
  changeBehindTheBack(n: number, status: Status, by: Actor) {
    const it = this.item(n)
    it.status = status
    it.statusBy = by
    it.statusAt = new Date().toISOString()
    it.statusSeq = Number(it.statusSeq) + 1
  }

  private json(route: Route, status: number, body: unknown) {
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  }

  async install(context: BrowserContext): Promise<void> {
    await context.route(/\/api\/boards\/[^/]+\/review(\/[^?#]*)?(\?.*)?$/, async (route) => {
      const req = route.request()
      const url = new URL(req.url())
      if (!url.pathname.startsWith(`/api/boards/${this.boardId}/review`)) return route.fallback()
      let body: unknown
      try {
        body = req.postDataJSON()
      } catch {
        body = undefined
      }
      this.calls.push({ method: req.method(), path: url.pathname, body })
      const m = /\/review(?:\/items\/([^/]+)(?:\/(status|events))?)?$/.exec(url.pathname)
      if (req.method() === 'GET' && !m?.[1]) {
        return this.json(route, 200, {
          items: this.items,
          rounds: this.openRound ? [this.openRound] : [],
          openRoundId: this.openRound ? this.openRound.id : null,
          can: this.can,
        })
      }
      const id = m?.[1]
      const it = this.items.find((x) => x.id === id)
      if (req.method() === 'GET' && m?.[2] === 'events') {
        return this.json(route, 200, { events: this.events.get(String(id)) ?? [], nextBefore: null })
      }
      if (req.method() === 'POST' && m?.[2] === 'status' && it) {
        const failure = this.failures.shift()
        if (failure) return this.json(route, failure.status, failure.body)
        const input = body as { status: Status; fromSeq?: number; note?: string }
        if (input.fromSeq !== undefined && input.fromSeq !== it.statusSeq) {
          return this.json(route, 409, {
            error: { code: 'STATUS_CHANGED', message: 'Somebody answered this item meanwhile.' },
            item: it,
          })
        }
        const previous = it.status as Status
        it.status = input.status
        it.statusSeq = Number(it.statusSeq) + 1
        it.statusBy = this.actor
        it.statusAt = new Date().toISOString()
        const event = {
          id: `rve_s4event${pad(++this.seq)}`,
          itemId: it.id,
          roundId: null,
          kind: 'status',
          status: input.status,
          previousStatus: previous,
          reason: 'set',
          versionId: null,
          threadId: null,
          actor: this.actor,
          itemCount: null,
          createdAt: it.statusAt,
          seq: this.seq,
        }
        this.events.set(String(it.id), [event, ...(this.events.get(String(it.id)) ?? [])])
        return this.json(route, 200, { item: it, event })
      }
      return this.json(route, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } })
    })
  }
}

/** A review-page-capable context: the switch on for every page of it (a dev-auth build reads it). */
export async function withReviewFlag(context: BrowserContext): Promise<void> {
  await context.addInitScript((key) => {
    try {
      localStorage.setItem(key, '1')
    } catch {
      /* a blocked store keeps the shipped value */
    }
  }, REVIEW_PAGE_FLAG_KEY)
}

/** alice (or another account) on the board, in a context of its own with the review page switch on. */
export async function openAs(
  browser: Browser,
  handle: string,
  boardId: string,
  opts: { viewport?: { width: number; height: number }; path?: string; flag?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const person = await signedInContext(browser, handle, opts.viewport ? { viewport: opts.viewport } : {})
  if (opts.flag !== false) await withReviewFlag(person.context)
  await person.page.goto(opts.path ?? `/b/${boardId}`)
  await waitForCanvas(person.page)
  return { context: person.context, page: person.page }
}

/** A fresh browser (no account) opens the link, types a name and joins. Resolves once the invite page navigated. */
export async function joinThroughInvitePage(
  browser: Browser,
  link: string,
  name: string,
  opts: { viewport: { width: number; height: number }; flag?: boolean; double?: ReviewDouble },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: opts.viewport })
  if (opts.flag !== false) await withReviewFlag(context)
  if (opts.double) await opts.double.install(context)
  const page = await context.newPage()
  await page.goto(link)
  await expect(page.getByTestId('invite-page')).toHaveAttribute('data-allow-guests', 'true')
  await page.getByTestId('invite-guest-name').fill(name)
  await page.getByTestId('invite-guest-join').click()
  return { context, page }
}

/** The review page of a page: its dialog. */
export const reviewPage = (page: Page) => page.getByTestId('review-page')
export const reviewItems = (page: Page) => page.getByTestId('review-item')

/** A board link from the api for `landing` (the Share dialog's option has its own spec). */
export async function createReviewLink(
  api: {
    fetch(
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status(): number; json(): Promise<unknown> }>
  },
  boardId: string,
  body: Record<string, unknown>,
): Promise<{ id: string; url: string; landing?: string }> {
  const res = await api.fetch('POST', `/api/boards/${boardId}/review-links`, body)
  expect(res.status()).toBe(201)
  return (await res.json()) as { id: string; url: string; landing?: string }
}

/** No horizontal scroll at the page's width (a phone's width most of all). */
export const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

export { ORIGIN, WEB_URL, waitForLobbyBoard }
