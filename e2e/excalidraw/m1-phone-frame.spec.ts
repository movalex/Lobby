// Hotfix H1 (wave M, M1-1; the first-time scout's FTU-1): on a phone, selecting two items inside a frame blanked
// the whole board ("Maximum update depth exceeded" in SelectionBar: its layout effect measured the bar, moved it,
// and the move changed what it measured). The board must stay alive, with the selection bar on screen, whichever
// way the selection is made:
//  - at 390 x 844 (touch, isMobile), light and dark: a frame with two notes selected through the palette's
//    "select all notes", the same notes selected through the facade, and two shapes over a frame;
//  - at 768 x 1024 and 1440 x 900: a frame with rectangles and notes, all selected: no hang (10 s) and no page
//    error.
// Each case checks: no pageerror, `window.lobbyCanvas` still installed, the canvas still drawn, the bar visible.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m1-phone-frame.spec.ts --project=chromium --workers=1
import type { Browser, Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import {
  type CanvasSession,
  createItem,
  expect,
  expectSaved,
  select,
  selection,
  setViewport,
  test,
} from '../tests/support/canvas.ts'
import type { Users } from '../tests/support/users.ts'
import { frame, intoFrame, note, PHONE, waitForA11y } from './a11y-kit.ts'
import { focusCanvas } from './navigation-kit.ts'

type Scheme = 'light' | 'dark'

async function openSession(
  browser: Browser,
  board: string,
  users: Users,
  viewport: { width: number; height: number },
  colorScheme: Scheme,
  touch: boolean,
): Promise<CanvasSession & { errors: string[] }> {
  const who = await users.get('alice')
  const context = await browser.newContext({
    viewport,
    colorScheme,
    ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
  })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`.slice(0, 300)))
  await signInContext(context, who.handle, who.name)
  await page.goto(`/b/${board}`)
  await waitForA11y(page)
  return { user: who.handle, name: who.name, id: who.id, context, page, errors }
}

/** The board is alive: the facade is still installed, the canvas still drawn, the selection bar on screen. */
async function expectAlive(page: Page, errors: string[], ids: readonly string[]) {
  // a loop (React's update-depth guard) fires within a few frames of the selection; give it time to
  await page.waitForTimeout(1_000)
  expect(errors).toEqual([])
  expect(await page.evaluate(() => typeof (window as { lobbyCanvas?: unknown }).lobbyCanvas)).toBe('object')
  await expect(page.locator('.excalidraw canvas').first()).toBeVisible()
  await expect(page.getByTestId('lobby-overlay')).toBeAttached()
  expect([...(await selection(page))].sort()).toEqual([...ids].sort())
  await expect(page.getByTestId('selection-bar')).toBeVisible()
  // the bar settled: its side and box are the same a moment later (nothing still moving it)
  const where = () =>
    page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="selection-bar"]')
      const r = el?.getBoundingClientRect()
      return r ? `${el?.dataset.side} ${Math.round(r.x)} ${Math.round(r.y)} ${Math.round(r.width)}` : null
    })
  const first = await where()
  await page.waitForTimeout(300)
  expect(await where()).toBe(first)
  // one row of buttons inside the canvas, not a column folded against an edge
  const bar = await page.getByTestId('selection-bar').boundingBox()
  const canvas = await page.locator('.dr-board__canvas').boundingBox()
  if (!bar || !canvas) throw new Error('no selection bar or canvas box')
  expect(bar.height).toBeLessThan(60)
  expect(bar.x).toBeGreaterThanOrEqual(canvas.x - 0.5)
  expect(bar.x + bar.width).toBeLessThanOrEqual(canvas.x + canvas.width + 0.5)
  expect(errors).toEqual([])
}

/**
 * Camera positions to select at. FTU-1's loop needs the selection off the middle: at the second one the notes sit
 * at the canvas's left edge, the bar's centre is clamped there, and its width depended on that left (an
 * absolutely placed box shrinks to the room right of its left edge), so every measure moved it again.
 */
const CAMERAS = [
  { x: 0, y: 0, zoom: 1 },
  { x: 300, y: -100, zoom: 0.5 },
  { x: 200, y: 0, zoom: 0.4 },
] as const

async function cameraAt(page: Page, v: { x: number; y: number; zoom: number }) {
  await select(page, [])
  await setViewport(page, v)
  await page.waitForTimeout(150)
}

/** A frame holding two notes, the frame in view. */
async function frameWithTwoNotes(page: Page) {
  const f = await frame(page, 0, 0, 700, 420, 'Ideas')
  const n1 = await note(page, 60, 100, 'First')
  const n2 = await note(page, 400, 100, 'Second')
  await intoFrame(page, [n1, n2], f)
  return { f, notes: [n1, n2] }
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`at 390 x 844, ${scheme}`, () => {
    test(`a frame with two notes, selected through the palette's "select all notes": the board stays alive (${scheme})`, async ({
      browser,
      board,
      users,
    }) => {
      const a = await openSession(browser, board, users, PHONE, scheme, true)
      try {
        const { notes } = await frameWithTwoNotes(a.page)
        await cameraAt(a.page, CAMERAS[1])
        await focusCanvas(a.page)
        await a.page.keyboard.press('ControlOrMeta+k')
        const input = a.page.getByTestId('command-palette-input')
        await expect(input).toBeFocused()
        await a.page.keyboard.type('select all notes')
        await expect(
          a.page.locator('[data-testid="command-palette-option"][data-active="true"]'),
        ).toBeVisible()
        await a.page.keyboard.press('Enter')
        await expect(a.page.getByTestId('command-palette')).toHaveCount(0)
        await expectAlive(a.page, a.errors, notes)
      } finally {
        await a.context.close()
      }
    })

    test(`a frame with two notes, selected through the facade: the board stays alive (${scheme})`, async ({
      browser,
      board,
      users,
    }) => {
      const a = await openSession(browser, board, users, PHONE, scheme, true)
      try {
        const { notes } = await frameWithTwoNotes(a.page)
        for (const v of CAMERAS) {
          await cameraAt(a.page, v)
          await select(a.page, notes)
          await expectAlive(a.page, a.errors, notes)
        }
        // and again from nothing, then one of them, then both (each a new selection key)
        await select(a.page, [])
        await select(a.page, [notes[0] as string])
        await select(a.page, notes)
        await expectAlive(a.page, a.errors, notes)
      } finally {
        await a.context.close()
      }
    })

    test(`two shapes over a frame, selected: the board stays alive (${scheme})`, async ({
      browser,
      board,
      users,
    }) => {
      const a = await openSession(browser, board, users, PHONE, scheme, true)
      try {
        await frame(a.page, 0, 0, 700, 420, 'Shapes')
        const r1 = await createItem(a.page, 'rectangle', { x: 60, y: 100, width: 200, height: 140 })
        await expectSaved(a.page)
        const r2 = await createItem(a.page, 'rectangle', { x: 400, y: 100, width: 200, height: 140 })
        await expectSaved(a.page)
        for (const v of CAMERAS) {
          await cameraAt(a.page, v)
          await select(a.page, [r1, r2])
          await expectAlive(a.page, a.errors, [r1, r2])
        }
      } finally {
        await a.context.close()
      }
    })
  })
}

for (const viewport of [
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
]) {
  test(`at ${viewport.width} x ${viewport.height}: a frame with rectangles and notes, all selected: no hang and no page error`, async ({
    browser,
    board,
    users,
  }) => {
    const a = await openSession(browser, board, users, viewport, 'light', viewport.width < 1000)
    try {
      const { f, notes } = await frameWithTwoNotes(a.page)
      const r1 = await createItem(a.page, 'rectangle', { x: 60, y: 320, width: 160, height: 80 })
      await expectSaved(a.page)
      const r2 = await createItem(a.page, 'rectangle', { x: 400, y: 320, width: 160, height: 80 })
      await expectSaved(a.page)
      await intoFrame(a.page, [r1, r2], f)
      const ids = [...notes, r1, r2]
      // the selection against the canvas's left edge (FTU-1's tablet and desktop hangs)
      await cameraAt(a.page, { x: 300, y: -100, zoom: 0.6 })
      const started = Date.now()
      // a hung page never answers this evaluate: the 10 s budget is the test's own, not the suite's 120 s
      await Promise.race([
        select(a.page, ids),
        new Promise((_, reject) => setTimeout(() => reject(new Error('select hung for 10 s')), 10_000)),
      ])
      await expect(a.page.getByTestId('selection-bar')).toBeVisible({ timeout: 10_000 })
      expect(Date.now() - started).toBeLessThan(10_000)
      await expectAlive(a.page, a.errors, ids)
    } finally {
      await a.context.close()
    }
  })
}
