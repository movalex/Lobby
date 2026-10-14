// K2-3 (wave K, UXD-12): new rectangles, ellipses and diamonds get a solid light fill, so a drag from the middle
// moves the shape (with Fill: None it started a selection box). Connectors and lines keep no fill, and
// Fill: None is one click away in the style panel. Also K2-2's engine half: a shape tool picked after a
// Lobby tool (note, comment) goes back to Select after one shape, as the engine's own default does.
import type { Page } from '@playwright/test'
import {
  editingId,
  expect,
  expectSaved,
  item,
  items,
  test,
  tool,
  typeText,
  waitForTextEditor,
} from '../tests/support/canvas.ts'
import { focusBoard } from './board-kit.ts'
import { showStylePanel } from './canvas-ux-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const LIGHT_FILL = '#fcfffe'

async function canvasPoint(page: Page, fx: number, fy: number) {
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no canvas')
  return { x: box.x + box.width * fx, y: box.y + box.height * fy }
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 10 })
  await page.mouse.up()
}

/** The ids of the elements of `type` that are new since `known`. */
async function newOf(page: Page, type: string, known: Set<string>) {
  return (await items(page)).filter((e) => e.type === type && !known.has(e.id)).map((e) => e.id)
}

test('K2-3: a new rectangle is filled light and moves when dragged from its centre; Fill: None is one click away', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  // P-021: the style panel opens on request; this person has it open
  await showStylePanel(a.page)
  await focusBoard(a.page)
  const known = new Set((await items(a.page)).map((e) => e.id))

  await test.step('a note first (a Lobby tool, which the engine keeps locked)', async () => {
    await a.page.keyboard.press('n')
    const p = await canvasPoint(a.page, 0.3, 0.3)
    await a.page.mouse.click(p.x, p.y)
    await waitForTextEditor(a.page)
    await typeText(a.page, 'First')
    await a.page.keyboard.press('Escape')
    await expect.poll(() => editingId(a.page)).toBeNull()
    for (const e of await items(a.page)) known.add(e.id)
  })

  const rect =
    await test.step('R, drag: the rectangle has the light fill and the tool is Select again', async () => {
      await a.page.keyboard.press('r')
      await expect.poll(() => tool(a.page)).toBe('rectangle')
      await drag(a.page, await canvasPoint(a.page, 0.5, 0.35), await canvasPoint(a.page, 0.62, 0.55))
      await expect.poll(async () => (await newOf(a.page, 'rectangle', known)).length).toBe(1)
      const id = (await newOf(a.page, 'rectangle', known))[0] as string
      known.add(id)
      const r = await item(a.page, id)
      expect(r?.backgroundColor).toBe(LIGHT_FILL)
      expect(r?.fillStyle).toBe('solid')
      // one shape, then back to Select (the engine reverts an unlocked drawing tool)
      await expect.poll(() => tool(a.page)).toBe('select')
      await expectSaved(a.page)
      return id
    })

  await test.step('a drag from its middle moves it (no selection box)', async () => {
    const before = await item(a.page, rect)
    if (!before) throw new Error('no rectangle')
    await a.page.keyboard.press('Escape')
    const mid = await canvasPoint(a.page, 0.56, 0.45)
    await drag(a.page, mid, { x: mid.x + 120, y: mid.y + 80 })
    await expect.poll(async () => (await item(a.page, rect))?.x).not.toBe(before.x)
    const after = await item(a.page, rect)
    expect((after?.x ?? 0) - before.x).toBeGreaterThan(50)
    expect((after?.y ?? 0) - before.y).toBeGreaterThan(30)
    await expectSaved(a.page)
    await a.page.screenshot({ path: testInfo.outputPath('k2-3-filled-rectangle.png') })
  })

  await test.step('Fill: None in the style panel takes the fill off (one click)', async () => {
    await expect(a.page.getByTestId('style.fill.semi')).toHaveAttribute('aria-pressed', 'true')
    await a.page.getByTestId('style.fill.none').click()
    await expect.poll(async () => (await item(a.page, rect))?.backgroundColor).toBe('transparent')
    await expectSaved(a.page)
  })

  await test.step('the next rectangle keeps that choice: Fill: None', async () => {
    await focusBoard(a.page)
    await a.page.keyboard.press('r')
    await drag(a.page, await canvasPoint(a.page, 0.2, 0.62), await canvasPoint(a.page, 0.3, 0.78))
    await expect.poll(async () => (await newOf(a.page, 'rectangle', known)).length).toBe(1)
    const id = (await newOf(a.page, 'rectangle', known))[0] as string
    known.add(id)
    expect((await item(a.page, id))?.backgroundColor).toBe('transparent')
  })
})

test('K2-3: ellipses and diamonds are filled too; a connector drawn after them has no fill', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await focusBoard(a.page)
  const known = new Set((await items(a.page)).map((e) => e.id))
  const pick = async (id: string) => {
    await a.page.getByTestId('tools.more-button').click()
    await a.page.getByTestId(`tools.more.${id}`).click()
    await expect.poll(() => tool(a.page)).toBe(id)
  }
  await pick('ellipse')
  await drag(a.page, await canvasPoint(a.page, 0.3, 0.3), await canvasPoint(a.page, 0.4, 0.45))
  await pick('diamond')
  await drag(a.page, await canvasPoint(a.page, 0.5, 0.3), await canvasPoint(a.page, 0.6, 0.45))
  await expect.poll(async () => (await newOf(a.page, 'diamond', known)).length).toBe(1)
  for (const type of ['ellipse', 'diamond']) {
    const [id] = await newOf(a.page, type, known)
    expect((await item(a.page, id as string))?.backgroundColor, type).toBe(LIGHT_FILL)
  }
  await focusBoard(a.page)
  await a.page.keyboard.press('l')
  await expect.poll(() => tool(a.page)).toBe('arrow')
  await drag(a.page, await canvasPoint(a.page, 0.3, 0.7), await canvasPoint(a.page, 0.6, 0.75))
  await expect.poll(async () => (await newOf(a.page, 'arrow', known)).length).toBe(1)
  const [arrow] = await newOf(a.page, 'arrow', known)
  expect((await item(a.page, arrow as string))?.backgroundColor).toBe('transparent')
  await expectSaved(a.page)
})
