// OWNER: 3f. Helpers for the PORTED workshops specs (e2e/excalidraw/workshops-*.spec.ts) on the Excalidraw
// board page: the tldraw suite's instrumented sessions (support/workshops.ts: the network recording, the
// vote-marker and chime recorders, an API client per person) opened on the new page, and canvas drivers
// over the frozen facade helpers (support/canvas.ts) instead of `window.editor`.
//
// The engine-neutral parts of support/workshops.ts and support/workshops-2.ts (the timer pill, the
// popover, the network log, the reaction bar, the hands queue, the API readers) are reused as they are.
// Canvas seeding goes through the board page's dev handle `window.__lobbyBoard.canvas.transact` (dev-auth
// builds only, as 2C's board-*.spec.ts use it): one transact, so one push, then Saved (the O2 race of
// board-kit.ts `settled` never meets two seeding writes).
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { type Api, type BoardRole, signInContext } from '../tests/support/api.ts'
import {
  type CanvasElement,
  test as canvasTest,
  expectSaved,
  item,
  itemBounds,
  itemCenterOnScreen,
  viewport,
  waitForCanvas,
  zoomToFit,
} from '../tests/support/canvas.ts'
import { expect } from '../tests/support/fixtures.ts'
import type { TestUser } from '../tests/support/users.ts'
import { NetworkLog } from '../tests/support/workshops.ts'

export { expect }

// ---- page instrumentation (installed before any app script runs; support/workshops.ts's, unchanged) ----

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

/** A slow device: the main thread is busy for `busyMs` right after the board event stream opens. */
function busyAfterEventStreamOpens(busyMs: number) {
  const busy = () =>
    setTimeout(() => {
      const until = Date.now() + busyMs
      while (Date.now() < until) {
        // busy
      }
    }, 0)
  const Original = window.EventSource
  window.EventSource = class extends Original {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init)
      if (String(url).includes('/events')) busy()
    }
  }
  // Wave H1: on the direct transport the stream is a fetch on the api origin.
  const originalFetch = window.fetch
  window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const p = originalFetch.call(this, input, init)
    if (/\/api\/boards\/[^/?]+\/events$/.test(new URL(url, location.href).pathname)) busy()
    return p
  } as typeof window.fetch
}

/** The network log, plus what the Excalidraw canvas socket says about other people's selections. */
export class CanvasNetworkLog extends NetworkLog {
  /**
   * Every element id that appeared in a peer's `sel` in any `presence` frame received (other people's
   * selections: canvas-schema protocol.ts PresenceOut), as `shape:` refs, sorted.
   */
  override presenceSelections(): string[] {
    const out = new Set<string>()
    for (const f of this.wsFrames) {
      if (!f.includes('"presence"')) continue
      try {
        const msg = JSON.parse(f) as { type?: string; peers?: { sel?: unknown }[] }
        if (msg.type !== 'presence') continue
        for (const p of msg.peers ?? [])
          if (Array.isArray(p.sel)) for (const id of p.sel) if (typeof id === 'string') out.add(`shape:${id}`)
      } catch {
        // not JSON (a snapshot frame)
      }
    }
    return [...out].sort()
  }
}

// ---- sessions ------------------------------------------------------------------------------------------------

export interface WorkshopCanvasSession {
  readonly user: string
  readonly name: string
  readonly id: string
  readonly context: BrowserContext
  readonly page: Page
  readonly net: CanvasNetworkLog
  /** Node-side API client signed in as the same person (server-side checks and forged requests) */
  readonly api: Api
  readonly role: BoardRole
}

export interface JoinOptions {
  /** Simulate a slow device (see busyAfterEventStreamOpens). */
  busyAfterEventStreamMs?: number
  /** Browser context options (a phone: viewport, touch, mobile). */
  context?: Parameters<Browser['newContext']>[0]
}

/** Waits for the Excalidraw board page and the workshop state (the pill shows a state). */
export async function waitForWorkshopBoard(page: Page) {
  await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-engine', 'excalidraw')
  await waitForCanvas(page)
  // K3-3: the one Facilitate button (there for everyone, guests included; on phones inside the closed "⋯"
  // menu) is what says the workshop bar is up
  await expect(page.getByTestId('facilitate-button')).toBeAttached()
}

async function openInstrumented(
  browser: Browser,
  board: string,
  user: TestUser,
  api: Api,
  role: BoardRole,
  opts: JoinOptions = {},
): Promise<WorkshopCanvasSession> {
  const context = await browser.newContext(opts.context)
  await context.addInitScript(instrumentPage)
  if (opts.busyAfterEventStreamMs)
    await context.addInitScript(busyAfterEventStreamOpens, opts.busyAfterEventStreamMs)
  const page = await context.newPage()
  const net = new CanvasNetworkLog()
  await net.attach(context, page)
  await signInContext(context, user.handle, user.name)
  await page.goto(`/b/${board}`)
  await expect(page.getByTestId('dev-identity-badge')).toHaveAttribute('data-user-id', user.id)
  await waitForWorkshopBoard(page)
  return { user: user.handle, name: user.name, id: user.id, context, page, net, api, role }
}

interface WorkshopFixtures {
  /**
   * Opens `board` as `handle` with `role` (alice = owner) on the Excalidraw page, in a new, instrumented
   * browser context (closed after the test).
   */
  join(handle: string, role?: BoardRole, opts?: JoinOptions): Promise<WorkshopCanvasSession>
}

export const test = canvasTest.extend<WorkshopFixtures>({
  join: async ({ browser, board, users }, use) => {
    const opened: WorkshopCanvasSession[] = []
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

/** Reloads the page and waits until the board and the workshop state are back. */
export async function reloadBoard(s: WorkshopCanvasSession) {
  await s.page.reload()
  await waitForWorkshopBoard(s.page)
}

export const post = (s: WorkshopCanvasSession, path: string, body?: unknown) =>
  s.api.fetch('POST', path, body ?? {})

// ---- seeding the canvas ------------------------------------------------------------------------------------

export interface NoteSeed {
  /** the element id (the api ref is `shape:<id>`) */
  id: string
  x: number
  y: number
  text?: string
  /** a frame's element id */
  frameId?: string
  /** a backgroundColor */
  color?: string
}

export interface FrameSeed {
  id: string
  x: number
  y: number
  w: number
  h: number
  name: string
}

export interface ShapeSeed {
  id: string
  kind: 'rectangle' | 'ellipse' | 'diamond'
  x: number
  y: number
  w: number
  h: number
  frameId?: string
}

/**
 * Creates frames, shapes and notes in one transact on the page (the dev handle's canvas: every write
 * through `transact` and the sync engine), waits for Saved, then puts the ones that go into a frame there
 * in a second transact (and waits for Saved again). Two steps because `LobbyTx.setFrame` does not see an
 * element `LobbyTx.create` made in the same step (canvas/api/impl.ts txView; a change request to 2C,
 * docs/research/excalidraw/wave3/3F.md).
 */
export async function seed(
  page: Page,
  what: { frames?: FrameSeed[]; shapes?: ShapeSeed[]; notes?: NoteSeed[] },
): Promise<void> {
  await page.evaluate((w) => {
    type Tx = {
      create(kind: string, props: Record<string, unknown>): string
      setFrame(ids: string[], frameId: string | null): void
    }
    const b = (
      window as unknown as {
        __lobbyBoard?: { canvas: { transact<T>(label: string, fn: (tx: Tx) => T): T } }
      }
    ).__lobbyBoard
    if (!b) throw new Error('no window.__lobbyBoard (not the Excalidraw board page, or no dev-auth build)')
    b.canvas.transact('e2e seed', (tx) => {
      for (const f of w.frames ?? [])
        tx.create('frame', { id: f.id, x: f.x, y: f.y, width: f.w, height: f.h, name: f.name })
      for (const s of w.shapes ?? [])
        tx.create(s.kind, {
          id: s.id,
          x: s.x,
          y: s.y,
          width: s.w,
          height: s.h,
          backgroundColor: 'transparent',
        })
      for (const n of w.notes ?? [])
        tx.create('note', {
          id: n.id,
          x: n.x,
          y: n.y,
          ...(n.text !== undefined ? { text: n.text } : {}),
          ...(n.color !== undefined ? { backgroundColor: n.color } : {}),
        })
    })
  }, what)
  await expectSaved(page)
  const inFrames = [...(what.shapes ?? []), ...(what.notes ?? [])].filter((e) => e.frameId)
  if (!inFrames.length) return
  await page.evaluate((list) => {
    type Tx = { setFrame(ids: string[], frameId: string | null): void }
    const b = (
      window as unknown as { __lobbyBoard: { canvas: { transact(l: string, fn: (tx: Tx) => void): void } } }
    ).__lobbyBoard
    b.canvas.transact('e2e seed frames', (tx) => {
      for (const e of list) tx.setFrame([e.id], e.frameId as string)
    })
  }, inFrames)
  await expectSaved(page)
}

/** Waits until every session holds the elements (they arrive over the sync socket). */
export async function expectItemsEverywhere(sessions: { page: Page; user: string }[], ids: string[]) {
  for (const s of sessions)
    await expect
      .poll(async () => (await Promise.all(ids.map((id) => item(s.page, id)))).every((x) => x !== null), {
        message: `${s.user} has the elements`,
      })
      .toBe(true)
}

/** Fits all content in the page's viewport (so every note can be clicked). */
export const showAll = (page: Page) => zoomToFit(page)

/** Whether a pointer at `p` reaches the canvas (not an overlay control, a panel or a bar). */
const reachesCanvasAt = (page: Page, p: { x: number; y: number }) =>
  page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)
    if (!el) return null
    if (el.closest('.excalidraw') && el.tagName === 'CANVAS') return 'canvas'
    return `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`
  }, p)

/** The element is wholly inside this page's viewport. */
async function inView(page: Page, id: string): Promise<boolean> {
  const [b, v] = await Promise.all([itemBounds(page, id), viewport(page)])
  return !!b && b.x >= v.x && b.y >= v.y && b.x + b.width <= v.x + v.width && b.y + b.height <= v.y + v.height
}

/**
 * The screen point at the centre of element `id`, once a pointer there reaches the canvas (brought into
 * view first if needed). Fails, instead of clicking a panel, a bar or an overlay by mistake, when
 * anything else stays on top at that point.
 */
export async function reachableCenter(page: Page, id: string): Promise<{ x: number; y: number }> {
  if (!(await inView(page, id))) await showAll(page)
  let c = { x: 0, y: 0 }
  await expect
    .poll(
      async () => {
        c = await itemCenterOnScreen(page, id)
        return reachesCanvasAt(page, c)
      },
      { message: `a click at the centre of ${id} reaches the canvas`, timeout: 5_000 },
    )
    .toBe('canvas')
  return c
}

/** A plain primary click in the middle of an element, like a person voting. */
export async function clickElement(page: Page, id: string) {
  const c = await reachableCenter(page, id)
  await page.mouse.click(c.x, c.y)
}

/** A plain click on empty canvas (checked to be canvas, with nothing under it). */
export async function clickEmptyCanvas(page: Page) {
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no board canvas')
  const p = { x: Math.round(box.x + box.width * 0.85), y: Math.round(box.y + box.height * 0.3) }
  await expect.poll(() => reachesCanvasAt(page, p), { message: 'empty canvas there' }).toBe('canvas')
  await page.mouse.click(p.x, p.y)
  return p
}

/** Gives the board the keyboard (Excalidraw's container). */
export const focusCanvas = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())

/** An element as the SERVER stores it, read through the test snapshot (tests/support/excalidraw.ts). */
export type { CanvasElement }

/** The +1 uids a stored or local element carries (sorted). */
export const plusOnesOfElement = (el: CanvasElement | null): string[] =>
  Object.entries(el?.customData?.lobby ?? {})
    .filter(([k, v]) => k.startsWith('plusOne:') && v === true)
    .map(([k]) => k.slice('plusOne:'.length))
    .sort()

/** The +1s a note carries as `page` holds it. */
export const plusOnesIn = async (page: Page, id: string) => plusOnesOfElement(await item(page, id))

/** The +1 control or badge on a note (its api ref, `shape:<id>`). */
export const plusOne = (page: Page, id: string) =>
  page.locator(`[data-testid="plusone"][data-shape-id="shape:${id}"]`)

/** Moves the pointer onto the middle of a note (the select tool marks it hovered). */
export async function hoverNote(page: Page, id: string) {
  const c = await reachableCenter(page, id)
  await page.mouse.move(c.x - 5, c.y - 5)
  await page.mouse.move(c.x, c.y, { steps: 3 })
}

/** Hovers the note and clicks its +1 control, like a person. */
export async function clickPlusOne(page: Page, id: string) {
  await hoverNote(page, id)
  const control = plusOne(page, id)
  await expect(control).toHaveAttribute('data-active', 'true')
  await control.click()
}

/** The vote dot / result badge on an element (`id` is the element id). */
export const dot = (page: Page, id: string) =>
  page.locator(`[data-testid="vote-dot"][data-shape-id="shape:${id}"]`)
export const badge = (page: Page, id: string) =>
  page.locator(`[data-testid="vote-count"][data-shape-id="shape:${id}"]`)

/** Every api ref of a vote marker this page ever rendered. */
export async function markedShapeIds(page: Page): Promise<string[]> {
  const marks = await page.evaluate(
    () => (window as unknown as { __voteMarks: { shapeId: string }[] }).__voteMarks,
  )
  return [...new Set(marks.map((m) => m.shapeId))].sort()
}

export const oscillatorStarts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __oscillatorStarts: number }).__oscillatorStarts)
