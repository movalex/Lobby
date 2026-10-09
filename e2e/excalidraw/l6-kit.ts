// Wave L (W6) helpers for the l6-*.spec.ts suites: the board clock and the push counter (a receive-only tab
// must push nothing), the laser drag and a watcher of the other tab's laser layer, the workshop setting that
// hides cursors, a session opened in a context of our own (touch, a routed socket), the follow through the
// page's debug handle.
import type { Browser, BrowserContextOptions, Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import { type CanvasSession, expect, setDoc, waitForCanvas } from '../tests/support/canvas.ts'
import type { Users } from '../tests/support/users.ts'
import { emptyCanvasPoint, focusBoard, pushCount } from './board-kit.ts'

export { emptyCanvasPoint, focusBoard, pushCount }

interface BoardWindow {
  __lobbyBoard?: {
    core: { clock: number; sid: string | null }
    canvas: {
      tool(): string | null
      follow: {
        current(): string | null
        state(): { sid: string; status: 'following' | 'paused' } | null
        start(sid: string): void
        stop(): void
        resume(): void
      }
      presence: {
        peers(): { sid: string; uid: string; color: string; point: { x: number; y: number } | null }[]
        lasers(): { sid: string; uid: string; color: string; active: boolean; points: unknown[] }[]
      }
      collaborators(): { sid: string; uid: string; color: string }[]
    }
  }
}

/** The board clock this tab's engine core has applied. */
export const boardClock = (page: Page) =>
  page.evaluate(() => (window as unknown as BoardWindow).__lobbyBoard?.core.clock ?? -1)

/** This tab's session id (the core's). */
export const sidOf = (page: Page) =>
  page.evaluate(() => (window as unknown as BoardWindow).__lobbyBoard?.core.sid ?? null)

/** `uid`'s presence colour as `page`'s roster has it. */
export const colorOf = (page: Page, uid: string) =>
  page.evaluate(
    (u) =>
      (window as unknown as BoardWindow).__lobbyBoard?.canvas.collaborators().find((r) => r.uid === u)?.color,
    uid,
  )

export const toolOf = (page: Page) =>
  page.evaluate(() => (window as unknown as BoardWindow).__lobbyBoard?.canvas.tool() ?? null)

export const followState = (page: Page) =>
  page.evaluate(() => (window as unknown as BoardWindow).__lobbyBoard?.canvas.follow.state() ?? null)

export const follow = (page: Page, sid: string) =>
  page.evaluate((s) => (window as unknown as BoardWindow).__lobbyBoard?.canvas.follow.start(s), sid)

/** Pushes and the clock of each tab, to compare before and after something that must write nothing. */
export async function writes(pages: readonly Page[]) {
  return Promise.all(pages.map(async (p) => ({ pushes: await pushCount(p), clock: await boardClock(p) })))
}

/** "Hide everyone's cursors" (a facilitator's workshop setting: the board document's `workshop` key). */
export const setHideCursors = (page: Page, on: boolean) =>
  setDoc(page, { workshop: { hideNoteAuthors: false, hideCursors: on } })

/** Picks the laser with K (the board takes the keyboard first) and waits for the tool. */
export async function pickLaser(page: Page) {
  await focusBoard(page)
  await page.keyboard.press('k')
  await expect.poll(() => toolOf(page)).toBe('laser')
}

/**
 * A read-only role picks the laser as a viewer does (wave L integration, L6-1): the read-only toolbar offers it
 * (canvas-ux READONLY_TOOLS) and K picks it (keymap.ts's read-only branch); the engine lets them point (CR-3A-8).
 */
export async function pickLaserReadOnly(page: Page) {
  await expect(page.getByTestId('tools.laser')).toBeVisible()
  await focusBoard(page)
  await page.keyboard.press('k')
  await expect.poll(() => toolOf(page)).toBe('laser')
}

/**
 * A laser stroke across empty canvas: down, `steps` moves of `dx` px (`stepMs` apart), up. Returns when the
 * press started and when it ended (this machine's clock, as the other page's Date.now()).
 */
export async function laserStroke(page: Page, opts: { dx?: number; steps?: number; stepMs?: number } = {}) {
  const { dx = 5, steps = 60, stepMs = 4 } = opts
  const p = await emptyCanvasPoint(page)
  const x0 = p.x - dx * steps
  await page.mouse.move(x0, p.y)
  const startedAt = Date.now()
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + i * dx, p.y + Math.round(Math.sin(i / 4) * 12))
    await page.waitForTimeout(stepMs)
  }
  await page.mouse.up()
  return { startedAt, endedAt: Date.now() }
}

/**
 * The same stroke at a real mouse's rate: pointer events dispatched in the page on a fixed clock (`hz` moves a
 * second for `ms`, 300 px), so the timing a person sees is measured, not how fast Playwright's mouse steps go
 * on a busy machine (each awaited CDP move took 10 to 20 ms when other suites shared the PC). The events go to
 * the element under the start point, as a real pointer's do (Lobby's capture listeners and the engine's).
 * Returns when the press started and ended, on the page's clock (Date.now(), comparable across tabs).
 */
export async function laserStrokeAtMouseRate(
  page: Page,
  opts: { px?: number; ms?: number; hz?: number } = {},
) {
  const { px = 300, ms = 300, hz = 125 } = opts
  const p = await emptyCanvasPoint(page)
  await page.mouse.move(p.x - px, p.y)
  return page.evaluate(
    ({ x1, y, px, ms, hz }) =>
      new Promise<{ startedAt: number; endedAt: number }>((resolve) => {
        const x0 = x1 - px
        const target = document.elementFromPoint(x0, y) ?? document.body
        const fire = (type: string, x: number, buttons: number) =>
          target.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              pointerId: 1,
              pointerType: 'mouse',
              isPrimary: true,
              button: type === 'pointermove' ? -1 : 0,
              buttons,
              clientX: x,
              clientY: y,
            }),
          )
        const startedAt = Date.now()
        fire('pointerdown', x0, 1)
        const n = Math.round((ms / 1000) * hz)
        let i = 0
        const timer = setInterval(() => {
          i++
          fire('pointermove', x0 + (px * i) / n, 1)
          if (i < n) return
          clearInterval(timer)
          fire('pointerup', x0 + px, 0)
          resolve({ startedAt, endedAt: Date.now() })
        }, 1000 / hz)
      }),
    { x1: p.x, y: p.y, px, ms, hz },
  )
}

export interface LaserSeen {
  /** first time the laser of `uid` had at least `minPoints` samples (Date.now()) */
  readonly at: number | null
  readonly points: number
  readonly color: string | null
  readonly path: boolean
  readonly dot: boolean
  /** the most samples it had */
  readonly maxPoints: number
  /** when it went away after being seen */
  readonly goneAt: number | null
}

/** Watches `page`'s laser layer for `uid` on every animation frame (installed before the stroke). */
export async function watchLaser(page: Page, uid: string, minPoints = 8) {
  await page.evaluate(
    ({ uid, minPoints }) => {
      const w = window as unknown as { __laserSeen?: Record<string, unknown>; __laserStop?: boolean }
      w.__laserStop = false
      const seen: Record<string, unknown> = {
        at: null,
        points: 0,
        color: null,
        path: false,
        dot: false,
        maxPoints: 0,
        goneAt: null,
      }
      w.__laserSeen = seen
      let present = false
      const tick = () => {
        if (w.__laserStop) return
        const g = document.querySelector(`[data-testid="laser"][data-uid="${uid}"]`)
        if (g) {
          present = true
          const n = Number(g.getAttribute('data-points') ?? 0)
          seen.maxPoints = Math.max(seen.maxPoints as number, n)
          if (g.querySelector('[data-testid="laser-path"]')) seen.path = true
          if (g.querySelector('[data-testid="laser-dot"]')) seen.dot = true
          if (seen.at === null && n >= minPoints) {
            seen.at = Date.now()
            seen.points = n
            seen.color = g.getAttribute('data-color')
          }
        } else if (present && seen.goneAt === null) seen.goneAt = Date.now()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    { uid, minPoints },
  )
  return {
    read: () =>
      page.evaluate(() => (window as unknown as { __laserSeen?: LaserSeen }).__laserSeen as LaserSeen),
    stop: () =>
      page.evaluate(() => {
        ;(window as unknown as { __laserStop?: boolean }).__laserStop = true
      }),
  }
}

/**
 * `handle` on `board` in a browser context of our own (`options`: a phone's viewport and touch), with
 * `beforeOpen` run on the page before it opens the board (a routed socket). Closed by the caller.
 */
export async function openTab(
  browser: Browser,
  board: string,
  users: Users,
  handle: string,
  o: {
    role?: 'owner' | 'editor' | 'commenter' | 'viewer'
    options?: BrowserContextOptions
    beforeOpen?: (page: Page) => Promise<void>
  } = {},
): Promise<CanvasSession> {
  const who =
    handle === 'alice' ? await users.get(handle) : await users.grant(board, handle, o.role ?? 'editor')
  const context = await browser.newContext(o.options ?? {})
  const page = await context.newPage()
  await signInContext(context, who.handle, who.name)
  if (o.beforeOpen) await o.beforeOpen(page)
  await page.goto(`/b/${board}`)
  await waitForCanvas(page)
  return { user: who.handle, name: who.name, id: who.id, context, page }
}
