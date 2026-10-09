// Phone flows on the Excalidraw board page (docs/EXCALIDRAW-MIGRATION.md §4.8 "phone and tablet"; owner 3i),
// under Playwright touch emulation at 390 × 844 as spike B's B12 ran them: nothing scrolls sideways; the dock
// rail folds behind one button and a panel opens as a full-width sheet (R13 / A11Y-06, the dock both pages
// share); the phone sheet ("Board actions", the `phoneSheet` slot) offers the role's tools, Undo / Redo and
// Zoom to fit with touch-size targets and gives the keyboard back; a name-only guest joins from a workshop
// link on a phone and adds a note by tap.
// K5-1 (wave K): double-tapping a note at a whole-board fit opens its editor at a readable size (the local
// camera moves to 100 %, the note in the upper third, above where the keyboard opens), pushes nothing for the
// move, and the camera goes back when the editor closes unless the person moved it meanwhile.
import type { Page } from '@playwright/test'
import {
  editingId,
  expect,
  expectSaved,
  itemCenterOnScreen,
  items,
  pushedOps,
  setViewport,
  TEXT_EDITOR,
  test,
  tool,
  viewport,
  zoomToFit,
} from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import {
  boardHasFocus,
  note,
  openPhoneSession,
  PHONE,
  scrollsSideways,
  waitForA11y,
  withCanvas,
} from './a11y-kit.ts'

const box = async (page: Page, testId: string) => {
  const b = await page.getByTestId(testId).first().boundingBox()
  if (!b) throw new Error(`${testId} has no box`)
  return b
}
const within = (b: { x: number; width: number }, w: number) => b.x >= 0 && b.x + b.width <= w + 0.5

test('at 390 px: no sideways scroll; the rail folds and a panel is a full-width sheet; Board actions offers the tools with touch-size targets', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const a = await openPhoneSession(browser, board, users, 'alice')
  try {
    const page = a.page
    expect(await scrollsSideways(page)).toBe(false)
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector('.dr-board__canvas')?.getBoundingClientRect().width ?? 0),
      )
      .toBe(PHONE.width)

    await test.step('R13 / A11Y-06: the rail folds behind one button; a panel opens as a full-width sheet', async () => {
      const toggle = page.getByTestId('dock-rail-toggle')
      await expect(toggle).toBeVisible()
      await expect(page.getByTestId('dock-tab-contents')).toBeHidden()
      // nothing else sits on the fold button
      const t = await box(page, 'dock-rail-toggle')
      const top = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid]')?.getAttribute('data-testid'),
        { x: t.x + t.width / 2, y: t.y + t.height / 2 },
      )
      expect(top).toBe('dock-rail-toggle')
      await toggle.tap()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByTestId('dock-tab-contents')).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath('phone-rail-open.png') })
      await page.getByTestId('dock-tab-contents').tap()
      const panel = page.getByTestId('dock-panel-contents')
      await expect(panel).toBeVisible()
      const p = await box(page, 'dock-panel-contents')
      expect(Math.round(p.x)).toBe(0)
      expect(Math.round(p.width)).toBe(PHONE.width)
      await expect(toggle).toBeHidden()
      expect(await scrollsSideways(page)).toBe(false)
      await page.screenshot({ path: testInfo.outputPath('phone-panel-sheet.png') })
      await page.getByTestId('dock-panel-close').tap()
      await expect(panel).toHaveCount(0)
    })

    await test.step('Board actions: a 48 px button that opens a full-width sheet with the tools', async () => {
      const open = page.getByTestId('phone-sheet-open')
      await expect(open).toBeVisible()
      // K5-3: "All tools", with its own icon (the board menu at the top left is the ≡)
      await expect(open).toHaveAccessibleName('All tools')
      const o = await box(page, 'phone-sheet-open')
      expect(o.width).toBeGreaterThanOrEqual(44)
      expect(o.height).toBeGreaterThanOrEqual(44)
      expect(within(o, PHONE.width)).toBe(true)
      await open.tap()
      await expect(open).toHaveAttribute('aria-expanded', 'true')
      const sheet = page.getByTestId('phone-sheet')
      await expect(sheet).toBeVisible()
      await expect(page.getByRole('dialog', { name: 'All tools' })).toBeVisible()
      const s = await box(page, 'phone-sheet')
      expect(Math.round(s.x)).toBe(0)
      expect(Math.round(s.width)).toBe(PHONE.width)
      const tools = await sheet
        .getByTestId('phone-sheet-tool')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-tool')))
      expect(tools.slice(0, 8)).toEqual([
        'select',
        'hand',
        'note',
        'text',
        'rectangle',
        'freedraw',
        'arrow',
        'frame',
      ])
      const small = await sheet.locator('button').evaluateAll((els) =>
        els
          .map((e) => ({
            t: e.textContent,
            h: e.getBoundingClientRect().height,
            w: e.getBoundingClientRect().width,
          }))
          .filter((r) => r.h < 44 || r.w < 44),
      )
      expect(small).toEqual([])
      await expect(sheet.getByTestId('phone-sheet-tool').first()).toBeFocused()
      expect(await scrollsSideways(page)).toBe(false)
      await page.screenshot({ path: testInfo.outputPath('phone-sheet-open.png') })
    })

    await test.step('a tool tapped in the sheet is picked, the sheet shuts and the board has the keyboard', async () => {
      await page.locator('[data-testid="phone-sheet-tool"][data-tool="note"]').tap()
      await expect(page.getByTestId('phone-sheet')).toHaveCount(0)
      await expect.poll(() => tool(page)).toBe('note')
      await expect.poll(() => boardHasFocus(page)).toBe(true)
      // the sheet marks the tool in use
      await page.getByTestId('phone-sheet-open').tap()
      await expect(page.locator('[data-testid="phone-sheet-tool"][data-tool="note"]')).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await page.locator('[data-testid="phone-sheet-tool"][data-tool="select"]').tap()
      await expect.poll(() => tool(page)).toBe('select')
    })

    await test.step('Escape and Close give the keyboard back to the button; a press outside shuts it', async () => {
      const open = page.getByTestId('phone-sheet-open')
      await open.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('phone-sheet')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('phone-sheet')).toHaveCount(0)
      await expect(open).toBeFocused()
      await open.tap()
      await page.getByTestId('phone-sheet-close').tap()
      await expect(page.getByTestId('phone-sheet')).toHaveCount(0)
      await expect(open).toBeFocused()
      await open.tap()
      await expect(page.getByTestId('phone-sheet')).toBeVisible()
      await page.mouse.click(200, 150)
      await expect(page.getByTestId('phone-sheet')).toHaveCount(0)
    })

    await test.step('Undo in the sheet takes back the last change', async () => {
      const id = await note(page, 0, 0, 'Phone note')
      await page.getByTestId('phone-sheet-open').tap()
      const undo = page.getByTestId('phone-sheet-undo')
      await expect(undo).toBeEnabled()
      await undo.tap()
      await expect.poll(async () => (await items(page)).some((e) => e.id === id)).toBe(false)
      await expect(page.getByTestId('phone-sheet-redo')).toBeEnabled()
      await page.getByTestId('phone-sheet-redo').tap()
      await expect.poll(async () => (await items(page)).some((e) => e.id === id)).toBe(true)
      await page.getByTestId('phone-sheet-fit').tap()
      await expect(page.getByTestId('phone-sheet')).toHaveCount(0)
    })

    await test.step('on a desktop width there is no Board actions button', async () => {
      await page.setViewportSize({ width: 1280, height: 720 })
      await expect(page.getByTestId('phone-sheet-open')).toHaveCount(0)
      await expect(page.getByTestId('dock-rail-toggle')).toBeHidden()
      await expect(page.getByTestId('dock-tab-contents')).toBeVisible()
    })
  } finally {
    await a.context.close()
  }
})

// ---- K5-1 (wave K): editing a note on a phone zooms the local camera to a readable size -------------------

/** A one-finger double tap at a screen point through the browser's own touch input (CDP). */
async function doubleTap(page: Page, at: { x: number; y: number }): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  try {
    for (let i = 0; i < 2; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: at.x, y: at.y, id: 1 }],
      })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(60)
    }
  } finally {
    await cdp.detach()
  }
}

/** The text editor's line of text on screen: its font size times the scale it is drawn at, and its box. */
const editorFontBox = (page: Page) =>
  page.locator(TEXT_EDITOR).evaluate((el) => {
    const cs = getComputedStyle(el)
    const m = cs.transform.match(/^matrix\(([^,]+),\s*([^,]+)/)
    const scale = m ? Math.hypot(Number(m[1]), Number(m[2])) : 1
    const r = el.getBoundingClientRect()
    return {
      font: Number.parseFloat(cs.fontSize) * scale,
      line: Number.parseFloat(cs.lineHeight) * scale,
      height: r.height,
    }
  })

/**
 * Opens `id`'s editor by a double tap, runs `check` while it is open, closes it with Escape (no typing) and
 * waits for the camera to settle; returns what was pushed meanwhile.
 */
async function editWithoutTyping(page: Page, id: string, check?: () => Promise<void>) {
  await expectSaved(page)
  const before = (await pushedOps(page)).length
  await doubleTap(page, await itemCenterOnScreen(page, id))
  await expect.poll(() => editingId(page)).toBe(id)
  await expect(page.locator(TEXT_EDITOR)).toBeVisible()
  if (check) await check()
  await page.waitForTimeout(500)
  await page.keyboard.press('Escape')
  await expect.poll(() => editingId(page)).toBeNull()
  await page.waitForTimeout(500)
  await expectSaved(page)
  return (await pushedOps(page)).slice(before)
}

/** The camera is animating (LobbyCanvas.viewport.moving). */
const cameraMoving = (page: Page) => withCanvas(page, (c) => c.viewport.moving(), null)

/** The note high on a phone screen at 100 %: an edit there moves no camera. */
const readableView = (n: { x: number; y: number }) => ({ x: n.x - 87, y: n.y - 40, zoom: 1 })

test('K5-1: double-tapping a note at fit zoom on a phone zooms the camera so its words are at least 14 px; the zoom pushes nothing and goes back on close', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const a = await openPhoneSession(browser, board, users, 'alice', 'owner', { width: 375, height: 812 })
  try {
    const page = a.page
    // a board wider and taller than the screen: its whole-board fit is well under 1
    const at = { x: 300, y: 700 }
    const middle = await note(page, at.x, at.y, 'Middle')
    await note(page, -400, -300, 'Top left')
    await note(page, 1100, 1700, 'Far')

    await test.step('control: an edit at 100 % with the note high moves no camera', async () => {
      // the first edit of a note may write its label's measured layout (the lease holder's fit): out of the
      // way here, where nothing moves, so the counter below sees only what the zoom could add
      await setViewport(page, readableView(at))
      const still = await viewport(page)
      await editWithoutTyping(page, middle, async () => {
        const v = await viewport(page)
        expect(v.zoom).toBe(1)
        expect(Math.abs(v.x - still.x)).toBeLessThan(0.01)
        expect(Math.abs(v.y - still.y)).toBeLessThan(0.01)
      })
      expect(await editWithoutTyping(page, middle)).toEqual([])
    })

    await zoomToFit(page)
    await expect.poll(async () => (await viewport(page)).zoom).toBeLessThan(0.6)
    const fit = await viewport(page)

    await test.step('at fit zoom the editor opens at a readable size, the note centred in the upper third; nothing is pushed', async () => {
      const pushed = await editWithoutTyping(page, middle, async () => {
        // the move animates: wait for where it ends
        await expect.poll(async () => (await viewport(page)).zoom).toBeGreaterThanOrEqual(1)
        await expect.poll(() => cameraMoving(page)).toBe(false)
        const box = await editorFontBox(page)
        expect(box.font).toBeGreaterThanOrEqual(14)
        expect(box.height).toBeGreaterThanOrEqual(14)
        const c = await itemCenterOnScreen(page, middle)
        const canvas = await page.locator('[data-lobby-board-canvas]').boundingBox()
        if (!canvas) throw new Error('no canvas')
        expect(Math.abs(c.x - (canvas.x + canvas.width / 2))).toBeLessThan(2)
        expect(c.y - canvas.y).toBeLessThan(canvas.height / 3)
        await page.screenshot({ path: testInfo.outputPath('k5-1-editing-readable.png') })
      })
      // the camera went to 100 % and back: a local move, no push
      expect(pushed).toEqual([])
    })

    await test.step('closing it put the camera back where it was', async () => {
      const v = await viewport(page)
      expect(v.zoom).toBeCloseTo(fit.zoom, 4)
      expect(Math.abs(v.x - fit.x) * v.zoom).toBeLessThan(2)
      expect(Math.abs(v.y - fit.y) * v.zoom).toBeLessThan(2)
    })

    await test.step('a pan while editing: the camera stays where the person put it', async () => {
      await expectSaved(page)
      await doubleTap(page, await itemCenterOnScreen(page, middle))
      await expect.poll(() => editingId(page)).toBe(middle)
      await expect.poll(async () => (await viewport(page)).zoom).toBeGreaterThanOrEqual(1)
      await expect.poll(() => cameraMoving(page)).toBe(false)
      const zoomed = await viewport(page)
      await setViewport(page, { x: zoomed.x + 60, y: zoomed.y, zoom: zoomed.zoom })
      await page.keyboard.press('Escape')
      await expect.poll(() => editingId(page)).toBeNull()
      await page.waitForTimeout(500)
      const v = await viewport(page)
      expect(v.zoom).toBeCloseTo(zoomed.zoom, 4)
      expect(Math.abs(v.x - (zoomed.x + 60))).toBeLessThan(0.5)
    })
  } finally {
    await a.context.close()
  }
})

// K5 review: Android Chrome (interactive-widget=resizes-content) shrinks the canvas when the soft keyboard
// opens, often while the 320 ms move is still running; the camera tween keeps the centre fixed through it,
// so the move ends about 150 px from where it was aimed. The camera must still go back on close, and go back
// exactly when the keyboard closes during the move back. A viewport resize stands in for the keyboard.
test('K5-1 (review refix): the keyboard resizing the canvas during the zoom (or during the move back) still puts the camera back where it was', async ({
  browser,
  board,
  users,
}) => {
  const a = await openPhoneSession(browser, board, users, 'alice', 'owner', { width: 375, height: 812 })
  try {
    const page = a.page
    const at = { x: 300, y: 700 }
    const middle = await note(page, at.x, at.y, 'Middle')
    await note(page, -400, -300, 'Top left')
    await note(page, 1100, 1700, 'Far')
    // the first edit may write the label's measured layout (the lease holder's fit): out of the way first
    await setViewport(page, readableView(at))
    await editWithoutTyping(page, middle)

    const backAtFit = async (fit: { x: number; y: number; zoom: number }) => {
      await expect.poll(() => cameraMoving(page)).toBe(false)
      const v = await viewport(page)
      expect(v.zoom).toBeCloseTo(fit.zoom, 4)
      expect(Math.abs(v.x - fit.x) * v.zoom).toBeLessThan(2)
      expect(Math.abs(v.y - fit.y) * v.zoom).toBeLessThan(2)
    }

    await test.step('the keyboard opens while the zoom is still moving, then Escape: back at the fit', async () => {
      await zoomToFit(page)
      await expect.poll(() => cameraMoving(page)).toBe(false)
      const fit = await viewport(page)
      expect(fit.zoom).toBeLessThan(0.6)
      await expectSaved(page)
      const pushedBefore = (await pushedOps(page)).length
      await doubleTap(page, await itemCenterOnScreen(page, middle))
      await expect.poll(() => editingId(page)).toBe(middle)
      // 80 ms into the 320 ms move
      await page.waitForTimeout(80)
      await page.setViewportSize({ width: 375, height: 512 })
      await page.waitForTimeout(800)
      expect((await viewport(page)).zoom).toBeGreaterThanOrEqual(1)
      await page.keyboard.press('Escape')
      await expect.poll(() => editingId(page)).toBeNull()
      await page.waitForTimeout(600)
      // the keyboard closes once the editor is gone (after the move back)
      await page.setViewportSize({ width: 375, height: 812 })
      await page.waitForTimeout(300)
      await backAtFit(fit)
      await expectSaved(page)
      expect((await pushedOps(page)).slice(pushedBefore)).toEqual([])
    })

    await test.step('the keyboard closes while the move back is running: back exactly at the fit', async () => {
      await zoomToFit(page)
      await expect.poll(() => cameraMoving(page)).toBe(false)
      const fit = await viewport(page)
      await expectSaved(page)
      await doubleTap(page, await itemCenterOnScreen(page, middle))
      await expect.poll(() => editingId(page)).toBe(middle)
      await expect.poll(() => cameraMoving(page)).toBe(false)
      await page.setViewportSize({ width: 375, height: 512 })
      await page.waitForTimeout(400)
      await page.keyboard.press('Escape')
      await expect.poll(() => editingId(page)).toBeNull()
      // 150 ms delay, then a 320 ms move back: the keyboard closes 250 ms after Escape, mid-move
      await page.waitForTimeout(250)
      await page.setViewportSize({ width: 375, height: 812 })
      await page.waitForTimeout(800)
      await backAtFit(fit)
    })
  } finally {
    await a.context.close()
  }
})

test('a viewer on a phone gets Select, Hand, Laser and Comment in the sheet, and no Undo', async ({
  browser,
  board,
  users,
}) => {
  const v = await openPhoneSession(browser, board, users, 'carol', 'viewer')
  try {
    await v.page.getByTestId('phone-sheet-open').tap()
    const sheet = v.page.getByTestId('phone-sheet')
    await expect(sheet).toBeVisible()
    expect(
      await sheet
        .getByTestId('phone-sheet-tool')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-tool'))),
      // Comment is the comments feature's tool (3c), offered to every role as on the tldraw toolbar
    ).toEqual(['select', 'hand', 'laser', 'comment'])
    await expect(sheet.getByTestId('phone-sheet-undo')).toHaveCount(0)
    await expect(v.page.getByTestId('dock-add-note')).toHaveCount(0)
    expect(await scrollsSideways(v.page)).toBe(false)
  } finally {
    await v.context.close()
  }
})

test('a name-only guest joins a workshop link on a phone and adds a note by tap; alice sees it', async ({
  browser,
  board,
  users,
  canvasSession,
}, testInfo) => {
  const alice = await users.api('alice')
  const res = await alice.request.post(`/api/boards/${board}/review-links`, {
    headers: { origin: WEB_URL },
    data: { role: 'editor', allowGuests: true },
  })
  expect(res.status()).toBe(201)
  const { url } = (await res.json()) as { url: string }
  const a = await canvasSession('alice')
  await waitForA11y(a.page)

  const context = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true })
  try {
    const page = await context.newPage()
    await page.goto(url)
    await page.getByTestId('invite-guest-name').fill('Sam')
    await page.getByTestId('invite-guest-join').tap()
    await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
    await waitForA11y(page)
    await expect(page.getByTestId('user-menu')).toHaveAttribute('data-kind', 'guest')
    expect(await scrollsSideways(page)).toBe(false)

    const before = (await items(page)).filter((e) => e.type === 'stickynote').length
    await page.getByTestId('phone-sheet-open').tap()
    await page.locator('[data-testid="phone-sheet-tool"][data-tool="note"]').tap()
    await expect.poll(() => tool(page)).toBe('note')
    const c = await page.locator('[data-lobby-board-canvas]').boundingBox()
    if (!c) throw new Error('no canvas')
    await page.touchscreen.tap(c.x + c.width / 2, c.y + c.height / 2)
    await expect
      .poll(async () => (await items(page)).filter((e) => e.type === 'stickynote').length)
      .toBe(before + 1)
    await expect
      .poll(async () => (await items(a.page)).filter((e) => e.type === 'stickynote').length)
      .toBe(before + 1)
    await page.screenshot({ path: testInfo.outputPath('phone-guest-note.png') })
  } finally {
    await context.close()
  }
})
