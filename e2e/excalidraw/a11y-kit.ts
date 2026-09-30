// OWNER: 3i. Helpers for the ported accessibility and phone specs (a11y-*.spec.ts) on the Excalidraw board
// page: where the keyboard is, the live region, seeding notes and frames through the facade, and phone
// sessions (390 px, touch).
import type { Browser, Page } from '@playwright/test'
import type { LobbyCanvas } from '../../apps/web/src/canvas/api/lobby-canvas.ts'
import { AI_API_ENV } from '../tests/support/ai.ts'
import { signInContext } from '../tests/support/api.ts'
import {
  type CanvasSession,
  canvasCall,
  createItem,
  createNote,
  expect,
  expectSaved,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { PORT_BASE } from '../tests/support/ports.ts'
import type { Users } from '../tests/support/users.ts'

export const PHONE = { width: 390, height: 844 }

/**
 * Marks the running test as an expected failure until `owner`'s wave-3 port of `what` lands on the new
 * board page (the ported a11y specs exercise other features' keyboard behaviour: the AI popover, the tag
 * picker, the selection bar...). Playwright reports it as passing while it still fails; at the wave-3
 * integration a mark whose test starts passing fails the run and must be removed.
 */
export function needs(owner: string, what: string): void {
  test.fail(true, `needs ${owner}: ${what} (wave 3, not on this branch yet)`)
}

/** How long a spec waits for another owner's control before its expected failure is recorded. */
export const MISSING_FEATURE_MS = 5_000

/** The fake OpenAI for the ported AI steps, on a port of this run's range (base + 23). */
export const A11Y_FAKE_OPENAI_PORT = (PORT_BASE ?? 5880) + 23
export const A11Y_AI_ENV: Record<string, string> = {
  ...AI_API_ENV,
  OPENAI_BASE_URL: `http://127.0.0.1:${A11Y_FAKE_OPENAI_PORT}/v1`,
}

/** What has the keyboard: 'BODY', a test id, or the element's tag and classes. */
export const focusOf = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    if (!a || a === document.body) return 'BODY'
    return (
      a.getAttribute('data-testid') ??
      `${a.tagName.toLowerCase()}${a.classList.length ? `.${[...a.classList].join('.')}` : ''}`
    )
  })

/** The keyboard is inside the element with this test id. */
export const inside = (page: Page, testId: string) =>
  page.evaluate(
    (id) => document.querySelector(`[data-testid="${id}"]`)?.contains(document.activeElement) === true,
    testId,
  )

/** The board itself has the keyboard (the engine's container or something inside its canvas). */
export const boardHasFocus = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement
    return !!a && !!a.closest('.excalidraw') && a.tagName !== 'TEXTAREA'
  })

/** The live region (the a11y feature's `liveRegion` slot). */
export const announcer = (page: Page) => page.getByTestId('canvas-announcer')

/** The canvas is up and the a11y feature is installed (its live region is on the page). */
export async function waitForA11y(page: Page): Promise<void> {
  await waitForCanvas(page)
  await expect(announcer(page)).toBeAttached()
}

/** The keyboard on the board, as a click on empty canvas would give it (no pointer event). */
export async function focusCanvas(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
  await expect.poll(() => boardHasFocus(page)).toBe(true)
}

/** Runs `fn(canvas, arg)` in the page on the board page's LobbyCanvas (the dev-auth debug handle). */
export async function withCanvas<T, A>(
  page: Page,
  fn: (canvas: LobbyCanvas, arg: A) => T | Promise<T>,
  arg: A,
): Promise<T> {
  return (await page.evaluate(
    async ({ src, arg }) => {
      const b = (window as unknown as { __lobbyBoard?: { canvas: unknown } }).__lobbyBoard
      if (!b) throw new Error('no window.__lobbyBoard')
      const f = new Function(`return (${src})`)() as (c: unknown, a: unknown) => unknown
      return await f(b.canvas, arg)
    },
    { src: fn.toString(), arg },
  )) as T
}

/**
 * A note, then "Saved" before the next write (spike B's open O2 race, board-kit.ts `settled`): returns
 * its id.
 */
export async function note(page: Page, x: number, y: number, text: string): Promise<string> {
  const id = await createNote(page, { x, y, text })
  await expectSaved(page)
  return id
}

/** Puts `ids` (with their labels) inside `frameId`: LobbyTx.setFrame, one step. */
export async function intoFrame(page: Page, ids: string[], frameId: string): Promise<void> {
  await withCanvas(page, (c, a) => c.transact('into frame', (tx) => tx.setFrame(a.ids, a.frameId)), {
    ids,
    frameId,
  })
  await expectSaved(page)
}

export async function frame(page: Page, x: number, y: number, width: number, height: number, name: string) {
  const id = await createItem(page, 'frame', { x, y, width, height, name })
  await expectSaved(page)
  return id
}

export async function textItem(page: Page, x: number, y: number, text: string) {
  const id = await createItem(page, 'text', { x, y, text })
  await expectSaved(page)
  return id
}

/** The selection, as ids (the facade's). */
export const selected = (page: Page) => canvasCall(page, 'selection')

/**
 * Opens `board` as `handle` on a phone: 390 × 844, touch, a mobile user agent (Playwright's touch
 * emulation, as spike B's B12 phone flows ran). Anyone but alice first gets a grant (default: editor).
 */
export async function openPhoneSession(
  browser: Browser,
  board: string,
  users: Users,
  handle: string,
  role: 'owner' | 'editor' | 'commenter' | 'viewer' = 'editor',
): Promise<CanvasSession> {
  const who = handle === 'alice' ? await users.get(handle) : await users.grant(board, handle, role)
  const context = await browser.newContext({
    viewport: PHONE,
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  await signInContext(context, who.handle, who.name)
  await page.goto(`/b/${board}`)
  await waitForA11y(page)
  return { user: who.handle, name: who.name, id: who.id, context, page }
}

/** The page scrolls sideways (a phone layout must not). */
export const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
