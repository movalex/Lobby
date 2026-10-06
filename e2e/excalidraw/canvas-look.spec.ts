// Wave C, workstream C1 (the canvas look) on the Excalidraw board page:
//  - CR-3A-7: with the note or text tool picked, the style panel sets the next note's or text's style, and a
//    note's label size and a free text's are two sizes (a note's L is not the next text's size);
//  - W5-38: one accent (the engine's selection colour is Lobby's), a hover outline, a selected frame's box clear
//    of its name;
//  - W5-55: a note being typed into is outlined;
//  - W5-51: zoomed out to 14 %, no frame name runs into a neighbouring frame; at 100 % a frame inside another
//    keeps its name (and can be renamed by a double-click on it);
//  - W5-53 (wave J, J6a): a connector drawn between two shapes ends 1 to 2 px off the shape it joins (the engine
//    patch: it stopped 5 px short) and its arrowhead is about 12 px at the default stroke (it was 25), measured on
//    the canvas's pixels; the sync room's re-snap agrees with the page;
//  - R13: on a phone, other people's cursors show without their name tags;
//  - PLAN-wave4 mermaid stub: a pasted chart definition stays plain text.
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
  updateItem,
} from '../tests/support/canvas.ts'
import { focusBoard, settled } from './board-kit.ts'
import { waitForCanvasUx } from './canvas-ux-kit.ts'
import { grantClipboard, writeClipboard } from './navigation-kit.ts'

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
  /** No size button is pressed: the tool's own next size (the engine's 20, before a pick) is on neither scale. */
  const noSizePressed = async () => {
    for (const s of ['s', 'm', 'l', 'xl'])
      await expect(a.page.getByTestId(`style.size.${s}`)).toHaveAttribute('aria-pressed', 'false')
  }

  await test.step('nothing picked yet: the engine’s next size (20) is on neither scale, so no size is pressed', async () => {
    await setTool(a.page, 'text')
    await expect(a.page.getByTestId('style.size.s')).toBeVisible()
    await noSizePressed()
    await setTool(a.page, 'note')
    await expect(palette).toBeVisible()
    await noSizePressed()
  })

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

  await test.step('the text tool starts from its own size: the note’s L (26) is not the next text’s', async () => {
    await selectNone(a.page)
    await setTool(a.page, 'text')
    await expect(a.page.getByTestId('style.size.xl')).toBeVisible()
    await noSizePressed()
    // a text made before any pick is the engine's 20, not the note's 26 (it was 26: one next size for both)
    const made = await makeByHand(a.page, await canvasPoint(a.page, 0.15, 0.3), 'Plain')
    expect(made.find((e) => e.type === 'text')?.fontSize).toBe(20)
  })

  await test.step('the text tool', async () => {
    await selectNone(a.page)
    await setTool(a.page, 'text')
    await expect(a.page.getByTestId('style.size.xl')).toBeVisible()
    await noSizePressed()
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

  await test.step('each tool keeps its own size: back on the note tool its L is still pressed, and the next note’s label is 26, not the text’s 44', async () => {
    await selectNone(a.page)
    await setTool(a.page, 'note')
    await expect(palette).toBeVisible()
    await expect(a.page.getByTestId('style.size.l')).toHaveAttribute('aria-pressed', 'true')
    await expect(a.page.getByTestId('style.size.xl')).toHaveAttribute('aria-pressed', 'false')
    const made = await makeByHand(a.page, await canvasPoint(a.page, 0.75, 0.3), 'Again')
    const label = made.find((e) => e.type === 'text')
    expect(label?.baseFontSize ?? label?.fontSize).toBe(26)
    // and the text tool still has its XL (44)
    await selectNone(a.page)
    await setTool(a.page, 'text')
    await expect(a.page.getByTestId('style.size.xl')).toHaveAttribute('aria-pressed', 'true')
    await expect(a.page.getByTestId('style.size.l')).toHaveAttribute('aria-pressed', 'false')
    const again = await makeByHand(a.page, await canvasPoint(a.page, 0.3, 0.8), 'Heading')
    expect(again.find((e) => e.type === 'text')?.fontSize).toBe(44)
  })

  await test.step('a size picked on a selected text is the next text’s only: the note tool keeps its L', async () => {
    const heading = (await items(a.page)).find((e) => e.type === 'text' && e.fontSize === 44)
    expect(heading).toBeTruthy()
    await select(a.page, [heading?.id as string])
    await a.page.getByTestId('style.size.m').click()
    await expect.poll(async () => (await item(a.page, heading?.id as string))?.fontSize).toBe(24)
    await selectNone(a.page)
    await setTool(a.page, 'note')
    await expect(a.page.getByTestId('style.size.l')).toHaveAttribute('aria-pressed', 'true')
    await selectNone(a.page)
    await setTool(a.page, 'text')
    await expect(a.page.getByTestId('style.size.m')).toHaveAttribute('aria-pressed', 'true')
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

/**
 * The engine's static canvas (the elements, no selection) in a screen box, as rows of "ink" flags: an opaque pixel
 * that is dark (the strokes are Lobby's near-black ink on a light canvas; the boxes here are not filled).
 */
const inkRows = (page: Page, box: { x: number; y: number; width: number; height: number }) =>
  page.evaluate((box) => {
    const c = document.querySelector<HTMLCanvasElement>(
      '.lobby-board-canvas canvas.excalidraw__canvas.static',
    )
    if (!c) throw new Error('no static canvas')
    const r = c.getBoundingClientRect()
    const sx = c.width / r.width
    const sy = c.height / r.height
    if (sx !== 1 || sy !== 1) throw new Error(`device pixel ratio ${sx} x ${sy}: this probe reads 1:1`)
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    const x = Math.round(box.x - r.left)
    const y = Math.round(box.y - r.top)
    const w = Math.round(box.width)
    const h = Math.round(box.height)
    const data = ctx.getImageData(x, y, w, h).data
    const rows: boolean[][] = []
    for (let j = 0; j < h; j++) {
      const row: boolean[] = []
      for (let i = 0; i < w; i++) {
        const k = (j * w + i) * 4
        const lum = 0.2126 * (data[k] ?? 255) + 0.7152 * (data[k + 1] ?? 255) + 0.0722 * (data[k + 2] ?? 255)
        row.push((data[k + 3] ?? 0) > 128 && lum < 150)
      }
      rows.push(row)
    }
    return { rows, x: x + r.left, y: y + r.top }
  }, box)

test('W5-53: a connector drawn between two shapes ends 1 to 2 px off the second one, with an arrowhead of about 12 px, on the canvas and in the room', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForCanvasUx(a.page)
  // two outlined boxes (a 2 px stroke, no fill), so nothing but strokes is on the row the connector crosses
  const hollow = { backgroundColor: 'transparent', strokeWidth: 2 }
  const r1 = await settled(
    a.page,
    createItem(a.page, 'rectangle', { x: 100, y: 100, width: 200, height: 120, ...hollow }),
  )
  const r2 = await settled(
    a.page,
    createItem(a.page, 'rectangle', { x: 600, y: 100, width: 200, height: 120, ...hollow }),
  )
  expect(r1).not.toBe(r2)
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  await focusBoard(a.page)
  await a.page.keyboard.press('l')
  await expect.poll(() => tool(a.page)).toBe('arrow')
  const s = await sceneToScreen(a.page, { x: 180, y: 160 })
  const e = await sceneToScreen(a.page, { x: 720, y: 160 })
  await a.page.mouse.move(s.x, s.y)
  await a.page.mouse.down()
  await a.page.mouse.move(e.x, e.y, { steps: 12 })
  // held still inside the second box: the engine's precise ("inside") binding, then the outline write on release
  await expect
    .poll(
      async () =>
        (
          (await items(a.page)).find((x) => x.type === 'arrow') as
            | { endBinding?: { mode?: string } }
            | undefined
        )?.endBinding?.mode,
      { timeout: 5_000 },
    )
    .toBe('inside')
  await a.page.mouse.up()
  const arrowId = ((await items(a.page)).find((x) => x.type === 'arrow') as { id: string }).id
  type Linear = { x: number; y: number; points: [number, number][] }
  const endsOf = async (page: Page) => {
    const el = (await item(page, arrowId)) as unknown as Linear | null
    if (!el) return null
    const p0 = el.points[0] as [number, number]
    const p1 = el.points[el.points.length - 1] as [number, number]
    return { startX: el.x + p0[0], endX: el.x + p1[0] }
  }
  // the orbit gap of the patched engine: 1 + stroke / 2 = 2 (it was 5 + stroke / 2 = 6)
  const GAP = 2
  const atGap = async (page: Page) => {
    const t = await endsOf(page)
    return t
      ? { start: Math.abs(t.startX - (300 + GAP)) < 0.3, end: Math.abs(t.endX - (600 - GAP)) < 0.3 }
      : null
  }

  await test.step('both ends sit the orbit gap off the outlines (alice, then bob: the room re-snapped with the same rule)', async () => {
    // held: the state is not monotonic on the way (the start is left where the press was until the outline write)
    let since: number | null = null
    await expect
      .poll(
        async () => {
          const ok = JSON.stringify(await atGap(a.page)) === JSON.stringify({ start: true, end: true })
          if (!ok) {
            since = null
            return 'not there yet'
          }
          since ??= Date.now()
          return Date.now() - since >= 600 ? 'holds' : 'settling'
        },
        { timeout: 20_000, intervals: [100, 150, 200, 250] },
      )
      .toBe('holds')
    await expectSaved(a.page)
    expect(await atGap(a.page)).toEqual({ start: true, end: true })
    await expect.poll(() => atGap(b.page), { timeout: 20_000 }).toEqual({ start: true, end: true })
  })

  await test.step('on the canvas: at most 2 clear pixels between the arrowhead and the box, and a head about 12 px across (was 5 and 19)', async () => {
    await selectNone(a.page)
    await a.page.mouse.move(10, 10) // no hover outline over the row
    const row = await sceneToScreen(a.page, { x: 0, y: 160 })
    const left = await sceneToScreen(a.page, { x: 540, y: 0 })
    const stroke = (await sceneToScreen(a.page, { x: 600, y: 0 })).x // the box's stroke covers [stroke - 1, stroke + 1)
    const { rows } = await inkRows(a.page, { x: left.x, y: row.y - 14, width: 90, height: 29 })
    const mid = 14
    const col = (x: number) => Math.round(x - left.x)
    // the box's stroke is ink on the connector's row, and the arrowhead's tip is the last ink before it
    const strokeStart = col(stroke - 1)
    expect(rows[mid]?.[strokeStart], 'the box’s own stroke is where it should be').toBe(true)
    let tip = strokeStart - 1
    while (tip >= 0 && !rows[mid]?.[tip]) tip--
    expect(tip, 'ink left of the box on the connector’s row').toBeGreaterThan(0)
    const clear = strokeStart - 1 - tip
    expect(
      clear,
      `clear pixels between the tip and the box (tip column ${tip}, box column ${strokeStart})`,
    ).toBeGreaterThanOrEqual(0)
    expect(clear).toBeLessThanOrEqual(2)
    test.info().annotations.push({ type: 'W5-53 clear pixels (tip to box)', description: String(clear) })
    // the head: the tallest run of ink in the 16 columns behind the tip (the shaft alone is 2 rows)
    let tallest = 0
    for (let c = Math.max(0, tip - 16); c <= tip; c++) {
      const ys = rows.map((r, j) => (r[c] ? j : -1)).filter((j) => j >= 0)
      if (ys.length) tallest = Math.max(tallest, (ys[ys.length - 1] as number) - (ys[0] as number) + 1)
    }
    expect(
      tallest,
      'the arrowhead is about 12 px across (barbs of 4.3 px each way plus the stroke)',
    ).toBeGreaterThanOrEqual(8)
    expect(tallest).toBeLessThanOrEqual(13)
    test.info().annotations.push({ type: 'W5-53 head height px', description: String(tallest) })
  })

  await test.step('moving the second box keeps the gap (the follow, here and in the room)', async () => {
    await updateItem(a.page, r2, { x: 640 })
    await expectSaved(a.page)
    const follow = async (page: Page) => {
      const t = await endsOf(page)
      return t ? Math.abs(t.endX - (640 - GAP)) < 0.3 : null
    }
    await expect.poll(() => follow(a.page), { timeout: 20_000 }).toBe(true)
    await expect.poll(() => follow(b.page), { timeout: 20_000 }).toBe(true)
  })
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

test('W5-51: at 100 %, a frame inside another frame (a converted board’s lifted nested frame) keeps its name, and a double-click on it renames it', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  const outer = await settled(
    a.page,
    createItem(a.page, 'frame', { x: 0, y: 0, width: 1000, height: 700, name: 'Outer' }),
  )
  const inner = await settled(
    a.page,
    createItem(a.page, 'frame', { x: 100, y: 200, width: 300, height: 200, name: 'Inner' }),
  )
  await setViewport(a.page, { x: -100, y: -100, zoom: 1 })
  await setTool(a.page, 'select')
  await expect
    .poll(async () => (await shownNames(a.page)).map((n) => n.text).sort())
    .toEqual(['Inner', 'Outer'])
  // still shown after the next measure (a pan, the window resized): nothing hides it a frame later
  await setViewport(a.page, { x: -60, y: -80, zoom: 1 })
  await a.page.setViewportSize({ width: 1400, height: 880 })
  await a.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  expect((await shownNames(a.page)).map((n) => n.text).sort()).toEqual(['Inner', 'Outer'])

  const label = a.page.locator(`[id$="-frame-name-${inner}"]`)
  await expect(label).toBeVisible()
  const nb = await label.boundingBox()
  if (!nb) throw new Error('no inner frame name')
  await a.page.mouse.dblclick(nb.x + Math.min(20, nb.width / 2), nb.y + nb.height / 2)
  await expect(a.page.getByTestId('frame-rename')).toBeFocused()
  await a.page.keyboard.type('Inner renamed')
  await a.page.keyboard.press('Enter')
  await expect.poll(async () => (await item(a.page, inner))?.name).toBe('Inner renamed')
  expect((await item(a.page, outer))?.name).toBe('Outer')
  await expectSaved(a.page)
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

test('PLAN-wave4 mermaid stub: a pasted chart definition stays plain text (no diagram is made)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  await waitForCanvasUx(a.page)
  await focusBoard(a.page)
  const definition = 'graph LR; A-->B'
  const before = new Set((await items(a.page)).map((e) => e.id))
  await writeClipboard(a.page, { 'text/plain': definition })
  const at = await canvasPoint(a.page, 0.4, 0.4)
  await a.page.mouse.move(at.x, at.y)
  await a.page.keyboard.press('ControlOrMeta+v')
  await expect
    .poll(async () => ((await items(a.page)) as unknown as El[]).filter((e) => !before.has(e.id)).length)
    .toBeGreaterThan(0)
  await expectSaved(a.page)
  const made = ((await items(a.page)) as unknown as El[]).filter((e) => !before.has(e.id))
  expect(made.map((e) => e.type)).toEqual(['text'])
  expect(made[0]?.originalText).toBe(definition)
})
