// Wave C, workstream C1 (the canvas look) on the Excalidraw board page:
//  - CR-3A-7: with the note or text tool picked, the style panel sets the next note's or text's style;
//  - W5-38: one accent (the engine's selection colour is Lobby's), a hover outline, a selected frame's box clear
//    of its name;
//  - W5-55: a note being typed into is outlined;
//  - W5-51: zoomed out to 14 %, no frame name runs into a neighbouring frame;
//  - R13: on a phone, other people's cursors show without their name tags;
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e exec playwright test excalidraw/canvas-look.spec.ts
import type { Page } from '@playwright/test'
import {
  createItem,
  createNote,
  expect,
  expectSaved,
  item,
  itemCenterOnScreen,
  items,
  sceneToScreen,
  select,
  selectNone,
  setTool,
  setViewport,
  startTextEditing,
  stopTextEditing,
  TEXT_EDITOR,
  test,
  tool,
} from '../tests/support/canvas.ts'
import { focusBoard, settled } from './board-kit.ts'
import { waitForCanvasUx } from './canvas-ux-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

type El = { id: string; type: string; x: number; y: number; width: number; height: number } & Record<
  string,
  unknown
>

/** A point on the canvas at (fx, fy) of its box. */
async function canvasPoint(page: Page, fx: number, fy: number) {
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no board canvas')
  return { x: box.x + box.width * fx, y: box.y + box.height * fy }
}

/** Makes an element by hand with the picked tool (a click, the editor, words, Escape); returns what it made. */
async function makeByHand(page: Page, at: { x: number; y: number }, words: string): Promise<El[]> {
  const before = new Set((await items(page)).map((e) => e.id))
  await page.mouse.click(at.x, at.y)
  const editor = page.locator(TEXT_EDITOR)
  await expect(editor).toBeFocused({ timeout: 15_000 })
  await expect(editor).toHaveJSProperty('readOnly', false, { timeout: 15_000 })
  await expectSaved(page)
  await page.keyboard.type(words, { delay: 15 })
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  await expectSaved(page)
  return ((await items(page)) as unknown as El[]).filter((e) => !before.has(e.id))
}

test('CR-3A-7: the note tool’s panel sets the next note’s colour, size and font; the text tool’s the next text’s colour, size, font and alignment', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  await focusBoard(a.page)
  const palette = a.page.getByTestId('note-palette')

  await test.step('the note tool', async () => {
    await setTool(a.page, 'note')
    await expect(palette).toBeVisible()
    // Lobby's default note colour is the one pressed until another is picked
    await expect(palette.locator('[data-color="black"]')).toHaveAttribute('aria-pressed', 'true')
    await palette.locator('[data-color="light-blue"]').click()
    await a.page.getByTestId('style.size.l').click()
    await a.page.getByTestId('style.font.mono').click()
    await expect(palette.locator('[data-color="light-blue"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(a.page.getByTestId('style.size.l')).toHaveAttribute('aria-pressed', 'true')
    await expect(a.page.getByTestId('style.font.mono')).toHaveAttribute('aria-pressed', 'true')
    expect(await tool(a.page)).toBe('note')
    const made = await makeByHand(a.page, await canvasPoint(a.page, 0.75, 0.6), 'Sky')
    const note = made.find((e) => e.type === 'stickynote')
    const label = made.find((e) => e.type === 'text')
    expect(note?.backgroundColor).toBe('#a6d8f3')
    // the label: Large (tldraw's label size 26) in Mono (Comic Shanns, 8)
    expect(label?.fontFamily).toBe(8)
    expect(label?.baseFontSize ?? label?.fontSize).toBe(26)
  })

  await test.step('the text tool', async () => {
    await setTool(a.page, 'text')
    await a.page.getByTestId('style.color.blue').click()
    await a.page.getByTestId('style.size.xl').click()
    await a.page.getByTestId('style.font.draw').click()
    await a.page.getByTestId('style.align.center').click()
    await expect(a.page.getByTestId('style.size.xl')).toHaveAttribute('aria-pressed', 'true')
    const made = await makeByHand(a.page, await canvasPoint(a.page, 0.3, 0.6), 'Title')
    const text = made.find((e) => e.type === 'text')
    expect(text).toMatchObject({
      strokeColor: '#4465e9',
      fontSize: 44,
      fontFamily: 5,
      textAlign: 'center',
    })
  })

  await test.step('a note named with a colour of its own keeps it (a feature’s note)', async () => {
    const id = await settled(a.page, createNote(a.page, { x: -600, y: -600, text: 'own', color: '#f4a874' }))
    expect((await item(a.page, id))?.backgroundColor).toBe('#f4a874')
  })
})

/** The colour a CSS colour value resolves to on the page (rgb()). */
const resolved = (page: Page, value: string, inside?: string) =>
  page.evaluate(
    ({ value, inside }) => {
      const host = inside ? (document.querySelector(inside) ?? document.body) : document.body
      const probe = document.createElement('i')
      probe.style.color = value
      host.append(probe)
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    },
    { value, inside },
  )

/** The opaque pixels of the engine's interactive canvas (selection, handles) in a screen box, as [r, g, b]. */
const interactivePixels = (page: Page, box: { x: number; y: number; width: number; height: number }) =>
  page.evaluate((box) => {
    const c = document.querySelector<HTMLCanvasElement>(
      '.lobby-board-canvas canvas.excalidraw__canvas.interactive',
    )
    if (!c) throw new Error('no interactive canvas')
    const r = c.getBoundingClientRect()
    const sx = c.width / r.width
    const sy = c.height / r.height
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    const x = Math.round((box.x - r.left) * sx)
    const y = Math.round((box.y - r.top) * sy)
    const w = Math.max(1, Math.round(box.width * sx))
    const h = Math.max(1, Math.round(box.height * sy))
    const data = ctx.getImageData(x, y, w, h).data
    const out: [number, number, number][] = []
    for (let i = 0; i < data.length; i += 4)
      if ((data[i + 3] ?? 0) > 96) out.push([data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0])
    return out
  }, box)

const rgbOf = (css: string) => (css.match(/\d+/g) ?? []).slice(0, 3).map(Number) as [number, number, number]
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(...a.map((v, i) => v - (b[i] ?? 0)))

test('W5-38: the engine’s selection is drawn in Lobby’s accent, the element under the pointer is outlined until it is selected, and a selected frame’s box clears its name', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  const note = await settled(a.page, createNote(a.page, { x: 100, y: 100, text: 'Hover me' }))
  const frame = await settled(
    a.page,
    createItem(a.page, 'frame', { x: 600, y: 160, width: 480, height: 300, name: 'Plan the week ahead' }),
  )
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  await setTool(a.page, 'select')

  await test.step('one accent: the selection colour the engine reads is the focus token', async () => {
    const focus = await resolved(a.page, 'var(--dr-focus)')
    expect(await resolved(a.page, 'var(--color-selection)', '.lobby-board-canvas .excalidraw')).toBe(focus)
    // and the engine draws a selected note's box in it, not its own violet (#6965db)
    await select(a.page, [note])
    const tl = await sceneToScreen(a.page, { x: 100, y: 100 })
    await expect
      .poll(
        async () =>
          (await interactivePixels(a.page, { x: tl.x + 30, y: tl.y - 8, width: 40, height: 8 })).length,
      )
      .toBeGreaterThan(0)
    const px = await interactivePixels(a.page, { x: tl.x + 30, y: tl.y - 8, width: 40, height: 8 })
    for (const p of px) expect(dist(p, rgbOf(focus)), `pixel ${p}`).toBeLessThan(dist(p, [105, 101, 219]))
    await selectNone(a.page)
  })

  await test.step('hover: an outline around the note under the pointer; selecting it, or moving off, drops it', async () => {
    const outline = a.page.locator(`[data-testid="hover-outline"][data-id="${note}"]`)
    const c = await itemCenterOnScreen(a.page, note)
    await a.page.mouse.move(c.x - 20, c.y - 20)
    await a.page.mouse.move(c.x, c.y, { steps: 3 })
    await expect(outline).toBeVisible()
    const box = await outline.boundingBox()
    if (!box) throw new Error('no outline box')
    expect(c.x).toBeGreaterThan(box.x)
    expect(c.x).toBeLessThan(box.x + box.width)
    expect(box.width).toBeGreaterThan(200)
    await a.page.mouse.click(c.x, c.y)
    await expect(a.page.getByTestId('hover-outline')).toHaveCount(0)
    await selectNone(a.page)
    const empty = await canvasPoint(a.page, 0.4, 0.8)
    await a.page.mouse.move(empty.x, empty.y, { steps: 3 })
    await expect(a.page.getByTestId('hover-outline')).toHaveCount(0)
  })

  await test.step('a selected frame: its box (4 px out, 1 px wide) runs below its name, not through it', async () => {
    await select(a.page, [frame])
    const name = a.page.locator(`[id$="-frame-name-${frame}"]`)
    await expect(name).toBeVisible()
    const nb = await name.boundingBox()
    if (!nb) throw new Error('no frame name')
    const top = (await sceneToScreen(a.page, { x: 600, y: 160 })).y
    expect(nb.y + nb.height).toBeLessThanOrEqual(top - 5)
  })
})

test('W5-55: a note being typed into is outlined in the accent; the outline goes when the editor closes', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  const note = await settled(a.page, createNote(a.page, { x: 100, y: 100, text: 'Edit me' }))
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  await setTool(a.page, 'select')
  const outline = a.page.locator(`[data-testid="editing-outline"][data-id="${note}"]`)
  await expect(outline).toHaveCount(0)
  await startTextEditing(a.page, note)
  await expect(outline).toBeVisible()
  const [box, c] = [await outline.boundingBox(), await itemCenterOnScreen(a.page, note)]
  if (!box) throw new Error('no outline box')
  expect(c.x).toBeGreaterThan(box.x)
  expect(c.x).toBeLessThan(box.x + box.width)
  expect(c.y).toBeGreaterThan(box.y)
  expect(c.y).toBeLessThan(box.y + box.height)
  expect(await outline.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(
    await resolved(a.page, 'var(--dr-focus)'),
  )
  await stopTextEditing(a.page)
  await expect(a.page.getByTestId('editing-outline')).toHaveCount(0)
})

/** The frame names drawn now (visible), each with its frame id and screen box. */
const shownNames = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.lobby-board-canvas .excalidraw .frame-name')]
      .filter((el) => getComputedStyle(el).visibility !== 'hidden')
      .map((el) => {
        const r = el.getBoundingClientRect()
        return {
          id: /-frame-name-(.+)$/.exec(el.id)?.[1] ?? '',
          text: el.textContent ?? '',
          x: r.left,
          y: r.top,
          width: r.width,
          height: r.height,
        }
      }),
  )

const intersects = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

test('W5-51: zoomed out to 14 %, no frame name runs into a neighbouring frame or another name; at fit zoom every name shows', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  // a template's grid: 1000 × 600 frames, 120 px apart (16.8 screen px at 14 %, less than a name's height)
  const names = ['One', 'Two', 'Three', 'Four']
  const frames: { id: string; x: number; y: number }[] = []
  for (const [i, name] of names.entries()) {
    const x = (i % 2) * 1120
    const y = Math.floor(i / 2) * 720
    frames.push({
      id: await settled(a.page, createItem(a.page, 'frame', { x, y, width: 1000, height: 600, name })),
      x,
      y,
    })
  }
  const frameBoxes = async () =>
    Promise.all(
      frames.map(async (f) => {
        const tl = await sceneToScreen(a.page, { x: f.x, y: f.y })
        const br = await sceneToScreen(a.page, { x: f.x + 1000, y: f.y + 600 })
        return { id: f.id, x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y }
      }),
    )

  await setViewport(a.page, { x: -2000, y: -1500, zoom: 0.14 })
  await expect.poll(async () => (await shownNames(a.page)).map((n) => n.text).sort()).toEqual(['One', 'Two'])
  const boxes = await frameBoxes()
  const shown = await shownNames(a.page)
  for (const n of shown) {
    for (const f of boxes) if (f.id !== n.id) expect(intersects(n, f), `${n.text} over a frame`).toBe(false)
    for (const o of shown) if (o !== n) expect(intersects(n, o), `${n.text} over ${o.text}`).toBe(false)
  }

  // zoomed in to where the names fit between the frames, every name is back
  await setViewport(a.page, { x: -200, y: -200, zoom: 0.45 })
  await expect
    .poll(async () => (await shownNames(a.page)).map((n) => n.text).sort())
    .toEqual(names.slice().sort())
})

test('R13: on a phone, other people’s cursors show without their name tags; at desktop width the tags are back', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForCanvasUx(a.page)
  await a.page.setViewportSize({ width: 390, height: 844 })
  const cursor = a.page.locator(`[data-testid="cursor"][data-uid="${b.id}"]`)
  await expect
    .poll(
      async () => {
        const p = await canvasPoint(b.page, 0.5, 0.5)
        await b.page.mouse.move(p.x - 30, p.y - 30)
        await b.page.mouse.move(p.x, p.y, { steps: 4 })
        return cursor.count()
      },
      { timeout: 20_000 },
    )
    .toBe(1)
  await expect(cursor.locator('svg')).toBeVisible()
  await expect(cursor.locator('.lobby-cursor__name')).toBeHidden()
  await a.page.setViewportSize({ width: 1280, height: 800 })
  await expect(cursor.locator('.lobby-cursor__name')).toBeVisible()
  await expect(cursor.locator('.lobby-cursor__name')).toHaveText(b.name)
})
