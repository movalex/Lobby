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

export async function textItem(
  page: Page,
  x: number,
  y: number,
  text: string,
  props: Record<string, unknown> = {},
) {
  const id = await createItem(page, 'text', { x, y, text, ...props })
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
  viewport: { width: number; height: number } = PHONE,
): Promise<CanvasSession> {
  const who = handle === 'alice' ? await users.get(handle) : await users.grant(board, handle, role)
  const context = await browser.newContext({
    viewport,
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

/** A Pixel 7's CSS viewport (the reviewers' second phone, W5-06). */
export const PIXEL_7 = { width: 412, height: 915 }

/**
 * Where a tap on a control would land somewhere else (W5-06 / W5-07: "elementFromPoint at each control's
 * centre returns that control"). Every visible button, menu item and text box under `roots` is probed at
 * its centre and at four points inside its edges (20 % in, so a corner under a floating button counts);
 * a point is fine when the element on top there is the control or inside it. A control scrolled out of
 * its own clipping box (the phone toolbar scrolls sideways) or wholly off screen is not probed. Returns one
 * line per covered point: "<control> (u, v) under <what is on top>".
 */
export async function coveredControls(page: Page, roots: readonly string[]): Promise<string[]> {
  return page.evaluate((selectors) => {
    const POINTS: readonly (readonly [number, number])[] = [
      [0.5, 0.5],
      [0.2, 0.5],
      [0.8, 0.5],
      [0.5, 0.2],
      [0.5, 0.8],
    ]
    const name = (el: Element) =>
      el.getAttribute('data-testid') ??
      el.getAttribute('aria-label') ??
      (el.textContent ?? '').trim().slice(0, 24) ??
      el.tagName.toLowerCase()
    const what = (el: Element | null) => {
      if (!el) return 'nothing'
      const tagged = el.closest('[data-testid]')
      return tagged ? `[${tagged.getAttribute('data-testid')}]` : el.tagName.toLowerCase()
    }
    const out: string[] = []
    const seen = new Set<Element>()
    for (const sel of selectors) {
      for (const root of document.querySelectorAll(sel)) {
        const controls = [
          ...(root.matches('button, textarea, [role="menuitem"]') ? [root] : []),
          ...root.querySelectorAll('button, textarea, [role="menuitem"]'),
        ]
        for (const c of controls) {
          if (seen.has(c)) continue
          seen.add(c)
          const r = c.getBoundingClientRect()
          if (r.width === 0 || r.height === 0 || getComputedStyle(c).visibility === 'hidden') continue
          if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue
          const cx = r.x + r.width / 2
          const cy = r.y + r.height / 2
          let clipped = false
          for (let p = c.parentElement; p && p !== document.body; p = p.parentElement) {
            const s = getComputedStyle(p)
            if (s.overflowX === 'visible' && s.overflowY === 'visible') continue
            const b = p.getBoundingClientRect()
            if (cx < b.left || cx > b.right || cy < b.top || cy > b.bottom) clipped = true
          }
          if (clipped) continue
          for (const [u, v] of POINTS) {
            const x = r.left + u * r.width
            const y = r.top + v * r.height
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue
            const top = document.elementFromPoint(x, y)
            if (top && (top === c || c.contains(top))) continue
            out.push(`${name(c)} (${u}, ${v}) under ${what(top)}`)
          }
        }
      }
    }
    return out
  }, roots)
}

/**
 * Points across a card (a grid over its whole box, every ~1/12 of its width and 1/4 of its height, 4 px in
 * from its edges: a round button over a corner is found) where something else is on top, as
 * "(i/12, j/4) under <what>" (W5-07: the phone's floating buttons must never sit on a card).
 */
export async function coveredAcross(page: Page, testId: string): Promise<string[]> {
  return page.getByTestId(testId).evaluate((card) => {
    const r = card.getBoundingClientRect()
    const out: string[] = []
    const inset = 4
    for (let i = 0; i <= 12; i++) {
      for (let j = 0; j <= 4; j++) {
        const x = r.left + inset + ((r.width - 2 * inset) * i) / 12
        const y = r.top + inset + ((r.height - 2 * inset) * j) / 4
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue
        const top = document.elementFromPoint(x, y)
        if (top && (top === card || card.contains(top))) continue
        const tagged = top?.closest('[data-testid]')
        out.push(
          `(${i}/12, ${j}/4) under ${tagged ? `[${tagged.getAttribute('data-testid')}]` : (top?.tagName ?? 'nothing')}`,
        )
      }
    }
    return out
  })
}

/** The tool the board page reports (LobbyCanvas.tool(): `hand` under a viewer's Hand, CR-3A-9). */
export const lobbyTool = (page: Page) => withCanvas(page, (c) => c.tool(), null)
