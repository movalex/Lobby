// Phone flows on the Excalidraw board page (docs/EXCALIDRAW-MIGRATION.md §4.8 "phone and tablet"; owner 3i),
// under Playwright touch emulation at 390 × 844 as spike B's B12 ran them: nothing scrolls sideways; the dock
// rail folds behind one button and a panel opens as a full-width sheet (R13 / A11Y-06, the dock both pages
// share); the phone sheet ("Board actions", the `phoneSheet` slot) offers the role's tools, Undo / Redo and
// Zoom to fit with touch-size targets and gives the keyboard back; a name-only guest joins from a workshop
// link on a phone and adds a note by tap.
import type { Page } from '@playwright/test'
import { expect, items, test, tool } from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { boardHasFocus, note, openPhoneSession, PHONE, scrollsSideways, waitForA11y } from './a11y-kit.ts'

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
      await expect(open).toHaveAccessibleName('Board actions')
      const o = await box(page, 'phone-sheet-open')
      expect(o.width).toBeGreaterThanOrEqual(44)
      expect(o.height).toBeGreaterThanOrEqual(44)
      expect(within(o, PHONE.width)).toBe(true)
      await open.tap()
      await expect(open).toHaveAttribute('aria-expanded', 'true')
      const sheet = page.getByTestId('phone-sheet')
      await expect(sheet).toBeVisible()
      await expect(page.getByRole('dialog', { name: 'Board actions' })).toBeVisible()
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
