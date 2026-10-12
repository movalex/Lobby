// Helpers for the workshops suite (timer, dot voting, gather everyone): sessions whose NETWORK is
// recorded from before the first request (API response bodies, every server-sent event as the
// browser's network stack delivered it, WebSocket frames), a DOM recorder for vote markers, a
// WebAudio probe for the time's-up chime, and small UI/API drivers.
//
// Owned by the workshops e2e engineer (the shared support files stay untouched).
import type { Browser, BrowserContext, CDPSession, Page } from '@playwright/test'
import { type Api, type BoardRole, signInContext } from './api.ts'
import { edit, read, type Session, shapeCenterOnScreen, waitForBoard } from './board.ts'
import type { BoxLike, VecLike } from './editor.ts'
import { test as base, expect } from './fixtures.ts'
import { readBody } from './network-bodies.ts'
import type { TestUser } from './users.ts'

// ---- network recording ---------------------------------------------------------------------------

export interface RecordedResponse {
  url: string
  path: string
  status: number
  body: string
}
export interface RecordedEvent {
  type: string
  data: unknown
  /** The event exactly as it arrived (the `data:` payload of the SSE message). */
  raw: string
}

/**
 * Bytes of an event stream in, the data of each message out (the api ends lines with LF; comments and other
 * fields skipped; a blank line dispatches). Independent of the web client's own parser on purpose.
 */
function sseFeed(message: (data: string) => void): (bytes: Buffer) => void {
  const decoder = new TextDecoder()
  let buf = ''
  let data: string[] = []
  return (bytes) => {
    buf += decoder.decode(bytes, { stream: true })
    const lines = buf.split('\n')
    // The last piece is a line still being received.
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (line === '') {
        if (data.length) message(data.join('\n'))
        data = []
      } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
  }
}

/**
 * Everything the server sent one page: every /api response body (the SSE stream itself excluded:
 * its body never ends) and every server-sent event, captured through the DevTools protocol's
 * Network domain (what the browser received, not what the app chose to handle).
 */
export class NetworkLog {
  readonly responses: RecordedResponse[] = []
  readonly events: RecordedEvent[] = []
  readonly wsFrames: string[] = []
  /**
   * Wave N.1: the responses whose body was not read (recorded in `responses` with an empty body): a thumbnail upload
   * the api refused, or a body still pending after BODY_READ_TIMEOUT_MS (./network-bodies.ts). A spec that must see
   * every body asserts this is empty.
   */
  readonly unread: { path: string; status: number; why: 'refused-upload' | 'timeout' }[] = []
  private readonly pending = new Set<Promise<void>>()
  private cdp: CDPSession | null = null

  async attach(context: BrowserContext, page: Page) {
    page.on('response', (res) => {
      const url = new URL(res.url())
      if (!url.pathname.startsWith('/api/') || /\/events$/.test(url.pathname)) return
      const p: Promise<void> = readBody(res, url.pathname)
        .then((read) => {
          if (!read) return // the browser could not give it (a failed request): not recorded, as before
          const status = res.status()
          this.responses.push({ url: res.url(), path: url.pathname, status, body: read.body })
          if (read.unread) this.unread.push({ path: url.pathname, status, why: read.unread })
        })
        .finally(() => this.pending.delete(p))
      this.pending.add(p)
    })
    page.on('websocket', (ws) => {
      ws.on('framereceived', (f) => {
        this.wsFrames.push(typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8'))
      })
    })
    const cdp = await context.newCDPSession(page)
    this.cdp = cdp
    const record = (raw: string) => {
      let type = '?'
      let data: unknown = null
      try {
        const msg = JSON.parse(raw) as { type?: string; data?: unknown }
        type = msg.type ?? '?'
        data = msg.data ?? null
      } catch {
        // not JSON: kept raw
      }
      this.events.push({ type, data, raw })
    }
    // The same-origin stream (an EventSource): the Network domain reports each message.
    cdp.on('Network.eventSourceMessageReceived', (e: { data: string }) => record(e.data))
    // Wave H1: the direct stream on the api origin is a fetch (an EventSource cannot send its ticket
    // header), which the Network domain reports as body chunks: stream its body and split it into messages
    // as an EventSource would. Chunks that arrive before the buffered part is in are queued, in order.
    const fetchStreams = new Map<string, { ready: boolean; queued: Buffer[]; feed(bytes: Buffer): void }>()
    cdp.on(
      'Network.responseReceived',
      (e: { requestId: string; type?: string; response: { url: string; mimeType?: string } }) => {
        if (e.type !== 'Fetch' || !(e.response.mimeType ?? '').startsWith('text/event-stream')) return
        if (!/\/api\/boards\/[^/]+\/events$/.test(new URL(e.response.url).pathname)) return
        const s = { ready: false, queued: [] as Buffer[], feed: sseFeed(record) }
        fetchStreams.set(e.requestId, s)
        cdp.send('Network.streamResourceContent', { requestId: e.requestId }).then(
          (r: { bufferedData: string }) => {
            s.feed(Buffer.from(r.bufferedData, 'base64'))
            s.ready = true
            for (const q of s.queued.splice(0)) s.feed(q)
          },
          () => fetchStreams.delete(e.requestId),
        )
      },
    )
    cdp.on('Network.dataReceived', (e: { requestId: string; data?: string }) => {
      const s = fetchStreams.get(e.requestId)
      if (!s || !e.data) return
      const bytes = Buffer.from(e.data, 'base64')
      if (s.ready) s.feed(bytes)
      else s.queued.push(bytes)
    })
    for (const done of ['Network.loadingFinished', 'Network.loadingFailed'] as const)
      cdp.on(done, (e: { requestId: string }) => void fetchStreams.delete(e.requestId))
    await cdp.send('Network.enable')
  }

  /** Waits for response bodies still being read (each at most BODY_READ_TIMEOUT_MS: it always ends). */
  async settle() {
    while (this.pending.size > 0) await Promise.all([...this.pending])
  }

  /** Every response body and SSE payload received so far, as one list of (source, text). */
  async received(): Promise<{ source: string; text: string }[]> {
    await this.settle()
    return [
      ...this.responses.map((r) => ({ source: `${r.status} ${r.path}`, text: r.body })),
      ...this.events.map((e) => ({ source: `sse ${e.type}`, text: e.raw })),
    ]
  }

  /** Sources (responses or events) whose text contains any of `needles`. */
  async containing(needles: readonly string[]): Promise<string[]> {
    const all = await this.received()
    return all.filter((r) => needles.some((n) => r.text.includes(n))).map((r) => r.source)
  }

  eventsOf(type: string) {
    return this.events.filter((e) => e.type === type)
  }

  /**
   * Every shape id that appeared in a `selectedShapeIds` field of any canvas-socket frame received
   * (other people's presence: what they have selected). Handles whole records and diff ops
   * (['put', value] / ['patch', {...}]).
   */
  presenceSelections(): string[] {
    const out = new Set<string>()
    const collect = (v: unknown) => {
      if (typeof v === 'string' && v.startsWith('shape:')) out.add(v)
      else if (Array.isArray(v)) for (const x of v) collect(x)
      else if (v && typeof v === 'object') for (const x of Object.values(v)) collect(x)
    }
    const walk = (node: unknown, depth: number) => {
      if (!node || typeof node !== 'object' || depth > 30) return
      if (Array.isArray(node)) {
        for (const x of node) walk(x, depth + 1)
        return
      }
      for (const [k, v] of Object.entries(node)) {
        if (k === 'selectedShapeIds') collect(v)
        else walk(v, depth + 1)
      }
    }
    for (const f of this.wsFrames) {
      if (!f.includes('selectedShapeIds')) continue
      try {
        walk(JSON.parse(f), 0)
      } catch {
        // not JSON
      }
    }
    return [...out].sort()
  }

  async detach() {
    await this.cdp?.detach().catch(() => {})
  }
}

// ---- page instrumentation (installed before any app script runs) -----------------------------------

/**
 * Records every vote marker ([data-testid^="vote-"][data-shape-id]) the page ever renders, so "bob
 * never saw alice's dot" is checked over the whole session, not at one instant. Also counts
 * WebAudio oscillator starts (the chime is three notes with an overtone each: 6 starts).
 */
function instrumentPage() {
  const w = window as unknown as {
    __voteMarks: { testId: string; shapeId: string; at: number }[]
    __oscillatorStarts: number
  }
  w.__voteMarks = []
  w.__oscillatorStarts = 0
  const seen = new Set<string>()
  const scan = () => {
    for (const el of document.querySelectorAll('[data-testid^="vote-"][data-shape-id]')) {
      const testId = el.getAttribute('data-testid') ?? ''
      const shapeId = el.getAttribute('data-shape-id') ?? ''
      const key = `${testId}|${shapeId}`
      if (seen.has(key)) continue
      seen.add(key)
      w.__voteMarks.push({ testId, shapeId, at: Date.now() })
    }
  }
  new MutationObserver(scan).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-testid', 'data-shape-id'],
  })
  if (typeof OscillatorNode !== 'undefined') {
    const start = OscillatorNode.prototype.start
    OscillatorNode.prototype.start = function (this: OscillatorNode, ...args: [number?]) {
      w.__oscillatorStarts++
      return start.apply(this, args)
    }
  }
}

/**
 * A slow device: right after the page opens its board event stream, the main thread is busy for
 * `busyMs` (as while a heavy page is still starting up), so the stream's first message ('hello',
 * which carries the server time) is handled that much later than it arrived.
 */
function busyAfterEventStreamOpens(busyMs: number) {
  const Original = window.EventSource
  window.EventSource = class extends Original {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init)
      if (String(url).includes('/events'))
        setTimeout(() => {
          const until = Date.now() + busyMs
          while (Date.now() < until) {
            // busy
          }
        }, 0)
    }
  }
}

/** Every (testId, shapeId) vote marker this page has rendered since it loaded. */
export const voteMarks = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __voteMarks: { testId: string; shapeId: string }[] }).__voteMarks,
  )

/** Shape ids of vote markers this page ever rendered. */
export async function markedShapeIds(page: Page): Promise<string[]> {
  return [...new Set((await voteMarks(page)).map((m) => m.shapeId))].sort()
}

export const oscillatorStarts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __oscillatorStarts: number }).__oscillatorStarts)

// ---- sessions ----------------------------------------------------------------------------------------

export interface WorkshopSession extends Session {
  readonly net: NetworkLog
  /** Node-side API client signed in as the same person (server-side checks and forged requests). */
  readonly api: Api
  readonly role: BoardRole
}

async function openInstrumented(
  browser: Browser,
  board: string,
  user: TestUser,
  api: Api,
  role: BoardRole,
  opts: JoinOptions = {},
): Promise<WorkshopSession> {
  const context = await browser.newContext()
  await context.addInitScript(instrumentPage)
  if (opts.busyAfterEventStreamMs)
    await context.addInitScript(busyAfterEventStreamOpens, opts.busyAfterEventStreamMs)
  const page = await context.newPage()
  const net = new NetworkLog()
  await net.attach(context, page)
  await signInContext(context, user.handle, user.name)
  await page.goto(`/b/${board}`)
  await waitForBoard(page)
  await expect(page.getByTestId('dev-identity-badge')).toHaveAttribute('data-user-id', user.id)
  // The workshop state has loaded once the pill shows a state.
  await expect(page.getByTestId('facilitate-button')).toHaveAttribute('data-timer-state', /.+/)
  return { user: user.handle, name: user.name, id: user.id, context, page, net, api, role }
}

export interface JoinOptions {
  /** Simulate a slow device (see busyAfterEventStreamOpens). */
  busyAfterEventStreamMs?: number
}

interface WorkshopFixtures {
  /**
   * Opens `board` as `handle` with `role` (alice = owner) in a new, instrumented browser context.
   * Contexts are closed after the test.
   */
  join(handle: string, role?: BoardRole, opts?: JoinOptions): Promise<WorkshopSession>
}

export const test = base.extend<WorkshopFixtures>({
  join: async ({ browser, board, users }, use) => {
    const opened: WorkshopSession[] = []
    await use(async (handle, role = 'editor', opts = {}) => {
      const user = await users.grant(board, handle, role)
      const s = await openInstrumented(
        browser,
        board,
        user,
        await users.api(handle),
        handle === 'alice' ? 'owner' : role,
        opts,
      )
      opened.push(s)
      return s
    })
    await Promise.all(
      opened.map(async (s) => {
        await s.net.detach()
        await s.context.close()
      }),
    )
  },
})

export { expect }

/** Reloads the page and waits until the board and the workshop state are back. */
export async function reloadBoard(s: WorkshopSession) {
  await s.page.reload()
  await waitForBoard(s.page)
  await expect(s.page.getByTestId('facilitate-button')).toHaveAttribute('data-timer-state', /.+/)
}

// ---- timer ---------------------------------------------------------------------------------------------

/** "4:05" -> 245, "1:02:03" -> 3723. */
export function clockSeconds(text: string): number {
  const parts = text.trim().split(':').map(Number)
  if (parts.length < 2 || parts.some((p) => !Number.isInteger(p))) throw new Error(`not a clock: "${text}"`)
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

/** Seconds the page's timer pill shows. */
export async function pillSeconds(page: Page): Promise<number> {
  return clockSeconds(await page.getByTestId('timer-remaining').innerText())
}

/**
 * What every page's pill shows, read at (nearly) the same instant. The display is whole seconds
 * rounded up, so pages that agree to within a second can differ by one on a boundary.
 */
export async function pillsNow(pages: Page[]): Promise<number[]> {
  return Promise.all(pages.map((p) => pillSeconds(p)))
}

/** Largest difference between what the pages show right now (seconds). */
export async function pillSpread(pages: Page[]): Promise<number> {
  const s = await pillsNow(pages)
  return Math.max(...s) - Math.min(...s)
}

/**
 * The pages' pills agree within 1 s, and keep agreeing: once they first do, `samples` more readings
 * across more than a second (so every rounding boundary is crossed) must all be within 1 s too. A
 * client whose clock is off by more than a second can match on one lucky reading, not on all.
 */
export async function expectPillsAgree(pages: Page[], samples = 6) {
  await expect.poll(() => pillSpread(pages), { message: 'pills agree within 1 s' }).toBeLessThanOrEqual(1)
  const spreads: number[] = []
  for (let i = 0; i < samples; i++) {
    spreads.push(await pillSpread(pages))
    await pages[0]?.waitForTimeout(250) // sampling over time is the point of this check
  }
  expect(
    spreads.every((s) => s <= 1),
    `spreads over 1.5 s: ${spreads.join(', ')}`,
  ).toBe(true)
}

/**
 * K3-3: the top bar's one Facilitate button ("Session" for participants) holds the timer, the reactions and
 * raise hand, the raised hands, voting and the private brainstorm. Opens its menu (if it is not open yet).
 */
export async function openFacilitate(page: Page) {
  const menu = page.getByTestId('facilitate-menu')
  if (!(await menu.isVisible())) {
    // the tools or the reactions bar is open under the button: a click on it would close that instead
    for (const id of ['workshop-popover', 'reaction-bar'])
      if (await page.getByTestId(id).isVisible()) await page.keyboard.press('Escape')
    await page.getByTestId('facilitate-button').click()
  }
  await expect(menu).toBeVisible()
  return menu
}

export async function closeFacilitate(page: Page) {
  const menu = page.getByTestId('facilitate-menu')
  if (await menu.isVisible()) await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
}

/** The Facilitate menu's entry with test id `testId` (timer-pill, reactions-button, hands-chip, vote-chip, pn-chip), menu opened. */
export async function facilitateEntry(page: Page, testId: string) {
  return (await openFacilitate(page)).getByTestId(testId)
}

/** The timer's display state as the Facilitate button carries it (idle, running, paused, finished, ended…). */
export const timerState = (page: Page) => page.getByTestId('facilitate-button')

export async function openWorkshopPopover(page: Page) {
  const pop = page.getByTestId('workshop-popover')
  if (!(await pop.isVisible())) await (await facilitateEntry(page, 'timer-pill')).click()
  await expect(pop).toBeVisible()
  return pop
}

export async function closeWorkshopPopover(page: Page) {
  const pop = page.getByTestId('workshop-popover')
  if (await pop.isVisible()) await page.keyboard.press('Escape')
  await expect(pop).toHaveCount(0)
}

export interface ApiTimer {
  status: 'running' | 'paused' | 'stopped' | 'finished'
  durationMs: number
  remainingMs: number
  endsAt: string | null
}
export interface ApiVoteState {
  session: {
    id: string
    status: 'open' | 'closed' | 'revealed'
    votesPerPerson: number
    onePerObject: boolean
    scope: 'board' | 'frame'
    frameId: string | null
    shapeTypes: string[] | null
  }
  myVotes: Record<string, number>
  myRemaining: number
  done: boolean
  participantsDone: number
  participants: number
  totalVotesCast: number
  results: { shapeId: string; count: number; rank: number }[] | null
}
export interface ApiWorkshop {
  timer: ApiTimer | null
  vote: ApiVoteState | null
  serverNow: string
}

/** GET /api/boards/:bid/workshop as `api`'s user (the server's stored state, as they may see it). */
export async function workshopState(api: Api, board: string): Promise<ApiWorkshop> {
  const res = await api.fetch('GET', `/api/boards/${board}/workshop`)
  expect(res.status()).toBe(200)
  return (await res.json()) as ApiWorkshop
}

// ---- canvas -------------------------------------------------------------------------------------------

export interface NoteSpec {
  id: string
  x: number
  y: number
  text: string
  parentId?: string
}

/** Fits all content in the page's viewport (so every note can be clicked). */
export async function showAll(page: Page) {
  await edit(page, (ed) => ed.zoomToFit())
}

/**
 * Whether a click at the screen point reaches the canvas at shape `id`: `id` when the element on top
 * is that shape or bare canvas (tldraw hit-tests shapes by geometry, so a hollow shape's inside is
 * canvas background in the DOM); otherwise what is in the way ("shape:other", "div.some-panel"), or
 * null when the point is outside the window.
 */
const reachesShapeAt = (page: Page, p: VecLike, id: string) =>
  page.evaluate(
    ({ x, y, id }) => {
      const el = document.elementFromPoint(x, y)
      if (!el) return null
      const shape = el.closest('[data-shape-id]')?.getAttribute('data-shape-id')
      if (shape) return shape
      if (el.closest('.tl-canvas') && !el.classList.contains('tl-hit-test-blocker')) return id
      return `${el.tagName.toLowerCase()}.${el.className}`
    },
    { x: p.x, y: p.y, id },
  )

/**
 * A plain primary click in the middle of a shape, like a person voting. A shape that is not fully in
 * view is brought into view first (as a person would scroll to it; e.g. opening a dock panel narrows
 * the canvas). Fails, instead of clicking a panel, a bar, another shape or outside the window by
 * mistake, when anything else stays on top at that point; tldraw's transparent hit-test blocker,
 * shown while the camera settles, is waited out.
 */
export async function clickShape(page: Page, id: string) {
  const c = await reachableCenter(page, id)
  await page.mouse.click(c.x, c.y)
}

/**
 * The screen point at the center of shape `id`, once a pointer there reaches it (brought into view
 * first if needed; see clickShape). For drags and other gestures that start on a shape.
 */
export async function reachableCenter(page: Page, id: string): Promise<VecLike> {
  const inView = await read(
    page,
    (ed, shapeId) => {
      const b = ed.getShapePageBounds(shapeId)
      const v = (ed as unknown as CameraEditor).getViewportPageBounds()
      return !!b && b.x >= v.x && b.y >= v.y && b.x + b.w <= v.x + v.w && b.y + b.h <= v.y + v.h
    },
    id,
  )
  if (!inView) await showAll(page)
  let c: VecLike = { x: 0, y: 0 }
  await expect
    .poll(
      async () => {
        c = await shapeCenterOnScreen(page, id)
        return reachesShapeAt(page, c, id)
      },
      { message: `a click at the center of ${id} reaches it`, timeout: 5_000 },
    )
    .toBe(id)
  return c
}

/** A plain click on empty canvas in the middle of the window (checked to be canvas, not UI or a shape). */
export async function clickEmptyCanvas(page: Page) {
  const vp = page.viewportSize() ?? { width: 1280, height: 720 }
  const p = { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2) }
  await expect
    .poll(
      () =>
        page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y)
          return !!el?.closest('.tl-canvas') && !el.closest('[data-shape-id]')
        }, p),
      { message: 'empty canvas under the middle of the window', timeout: 5_000 },
    )
    .toBe(true)
  await page.mouse.click(p.x, p.y)
  return p
}

export const dot = (page: Page, shapeId: string) =>
  page.locator(`[data-testid="vote-dot"][data-shape-id="${shapeId}"]`)
export const badge = (page: Page, shapeId: string) =>
  page.locator(`[data-testid="vote-count"][data-shape-id="${shapeId}"]`)

export interface ViewState {
  bounds: BoxLike
  zoom: number
  following: string | null
}

type CameraEditor = {
  getViewportPageBounds(): BoxLike
  getZoomLevel(): number
  getInstanceState(): { followingUserId: string | null }
  setCamera(point: VecLike & { z?: number }): unknown
  getCamera(): VecLike & { z: number }
}

export const viewState = (page: Page): Promise<ViewState> =>
  read(page, (ed) => {
    const e = ed as unknown as CameraEditor
    const b = e.getViewportPageBounds()
    return {
      bounds: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) },
      zoom: Math.round(e.getZoomLevel() * 1000) / 1000,
      following: e.getInstanceState().followingUserId,
    }
  })

/** The camera of `userId`'s presence as `page` has received it (null until it arrived). */
export const presenceCamera = (page: Page, userId: string) =>
  read(
    page,
    (ed, uid) => {
      const p = (
        ed.getCollaborators() as unknown as {
          userId: string
          camera?: { x: number; y: number; z: number } | null
        }[]
      ).find((c) => c.userId === uid)
      return p?.camera ? { x: Math.round(p.camera.x), y: Math.round(p.camera.y), z: p.camera.z } : null
    },
    `user:${userId}`,
  )

/** The page's own camera, rounded like presenceCamera. */
export const ownCamera = (page: Page) =>
  read(page, (ed) => {
    const c = (ed as unknown as CameraEditor).getCamera()
    return { x: Math.round(c.x), y: Math.round(c.y), z: c.z }
  })

/** Moves the page's own camera (a pan/zoom the person makes). */
export async function moveCamera(page: Page, camera: { x: number; y: number; z: number }) {
  await edit(page, (ed, c) => (ed as unknown as CameraEditor).setCamera(c), camera)
}

export const center = (b: BoxLike) => ({ x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) })
