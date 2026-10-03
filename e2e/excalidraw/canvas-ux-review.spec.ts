// canvas-ux (3a) on the Excalidraw board page: the wave-5 review's findings for the canvas tools
// (docs/research/excalidraw/REVIEW-W5-EARLY.md): W5-11 connectors end on the shapes' outlines, W5-20 Esc
// after a keyboard placement gives Select back, W5-22 the toolbar's More from the keyboard, D4 the polygon
// tools, W5-33 the board menu (View, Paste, Theme) and Undo / Redo on a desktop canvas, W5-40 to W5-42 the
// style panel (faces, icon pickers, the opacity label, dark-mode legend, one Tab stop per control), W5-46
// the panel folding on a low canvas, W5-50 the tools' keys, W5-59 the text editor's name, W5-31 / W5-06
// the phone toolbar's touch targets, and W5-05's client half (a frame's move carries its locked heading).
import type { Page } from '@playwright/test'
import {
  createItem,
  createNote,
  editingId,
  expect,
  expectSaved,
  item,
  items,
  itemText,
  pushedOps,
  sceneToScreen,
  screenToScene,
  select,
  selection,
  setTool,
  setViewport,
  test,
  tool,
  viewport,
  waitForItem,
  waitForTextEditor,
} from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { openPhoneSession } from './a11y-kit.ts'
import { emptyCanvasPoint, focusBoard, settled } from './board-kit.ts'
import { boardHasFocus, notes, undoKey, waitForCanvasUx, withCanvas } from './canvas-ux-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

/** The tool as the canvas API reports it (the polygon tools and the highlighter are canvas-level tools). */
const lobbyTool = (page: Page) => withCanvas(page, (c) => c.tool(), null)

type Pt = readonly [number, number]
interface Linear {
  x: number
  y: number
  points: Pt[]
  startBinding?: { elementId: string; mode: string; fixedPoint: Pt } | null
  endBinding?: { elementId: string; mode: string; fixedPoint: Pt } | null
  isDeleted?: boolean
  polygon?: boolean
  groupIds: string[]
}
const ends = (el: Linear) => {
  const a = el.points[0] as Pt
  const b = el.points[el.points.length - 1] as Pt
  return { start: [el.x + a[0], el.y + a[1]] as const, end: [el.x + b[0], el.y + b[1]] as const }
}
/**
 * Waits until `read()` has returned `want` on every poll for `holdMs` (a value that is right once and wrong
 * again a moment later does not count).
 */
async function holds(read: () => Promise<unknown>, want: unknown, holdMs = 600): Promise<void> {
  let since: number | null = null
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await read())
        if (now !== JSON.stringify(want)) {
          since = null
          return `not there yet: ${now}`
        }
        since ??= Date.now()
        return Date.now() - since >= holdMs ? 'holds' : 'settling'
      },
      { timeout: 20_000, intervals: [100, 150, 200, 250] },
    )
    .toBe('holds')
}
const live = async (page: Page) =>
  (await items(page)).filter((e) => !(e as { isDeleted?: boolean }).isDeleted)

test('W5-11: a connector drawn from inside one shape to inside another ends on both outlines, anchors kept; one undo removes it; bob sees the same ends', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForCanvasUx(a.page)
  const fill = { backgroundColor: '#ffc9c9', fillStyle: 'solid' }
  const r1 = await settled(
    a.page,
    createItem(a.page, 'rectangle', { x: 100, y: 100, width: 200, height: 120, ...fill }),
  )
  const r2 = await settled(
    a.page,
    createItem(a.page, 'rectangle', { x: 600, y: 100, width: 200, height: 120, ...fill }),
  )
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  await focusBoard(a.page)
  await a.page.keyboard.press('l')
  await expect.poll(() => tool(a.page)).toBe('arrow')
  const s = await sceneToScreen(a.page, { x: 180, y: 150 })
  const e = await sceneToScreen(a.page, { x: 720, y: 170 })
  await a.page.mouse.move(s.x, s.y)
  await a.page.mouse.down()
  await a.page.mouse.move(e.x, e.y, { steps: 12 })
  // held still inside B: the engine's precise ("inside") binding takes the end into the shape
  await expect
    .poll(
      async () =>
        ((await live(a.page)).find((x) => x.type === 'arrow') as unknown as Linear | undefined)?.endBinding
          ?.mode,
      { timeout: 5_000 },
    )
    .toBe('inside')
  await a.page.mouse.up()
  const arrowId = (await live(a.page)).find((x) => x.type === 'arrow')?.id as string

  await test.step('both ends sit on the outlines, a binding gap out, with orbit bindings to the same anchors', async () => {
    // the engine's own ends first (the start left where the press was), then the outline write: the room
    // re-snaps the ends when the hold is released. The state is not monotonic on the way (under CPU load a
    // read after "orbit and past the outline" found the start back at the press, x = 180, 2 runs in 20), so
    // the wait is for the whole final state to HOLD for 600 ms, and it is read once more afterwards.
    const onOutlines = async () => {
      const el = (await item(a.page, arrowId)) as unknown as Linear | null
      if (!el) return null
      const { start, end } = ends(el)
      return {
        modes: [el.startBinding?.mode, el.endBinding?.mode],
        bound: [el.startBinding?.elementId, el.endBinding?.elementId],
        // r1's right edge is x = 300 and r2's left edge x = 600, a binding gap (< 12 px) out from each
        startX: start[0] > 300 && start[0] < 312,
        endX: end[0] < 600 && end[0] > 588,
        // both inside the rectangles' height (100..220)
        ys: [start[1], end[1]].every((y) => y > 100 && y < 220),
      }
    }
    const final = {
      modes: ['orbit', 'orbit'],
      bound: [r1, r2],
      startX: true,
      endX: true,
      ys: true,
    }
    await holds(onOutlines, final)
    await expectSaved(a.page)
    expect(await onOutlines(), 'still on the outlines once Saved').toEqual(final)
  })

  await test.step('bob has the same ends (the server re-snapped them with the same rule)', async () => {
    const mine = ends((await item(a.page, arrowId)) as unknown as Linear)
    // bob first has the arrow with its binding modes and the re-snapped ends arrive with the room's change a
    // moment later (waiting for the modes alone and reading once raced it): the ends themselves, held
    await holds(async () => {
      const el = (await item(b.page, arrowId)) as unknown as Linear | null
      if (!el) return null
      const t = ends(el)
      return [
        el.endBinding?.mode,
        Math.abs(t.start[0] - mine.start[0]) < 1,
        Math.abs(t.end[0] - mine.end[0]) < 1,
      ]
    }, ['orbit', true, true])
  })

  await test.step('one undo removes the connector whole', async () => {
    await undoKey(a.page)
    await expect.poll(async () => (await live(a.page)).some((x) => x.id === arrowId)).toBe(false)
    expect((await live(a.page)).filter((x) => x.type === 'rectangle').length).toBe(2)
  })
})

test('W5-20: after placing with the keyboard, Esc gives Select back and Enter edits the placed note again; a note left empty is taken away and announced', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  await focusBoard(a.page)
  await a.page.keyboard.press('n')
  await expect.poll(() => tool(a.page)).toBe('note')
  await a.page.keyboard.press('Enter')
  const id = await waitForTextEditor(a.page)
  await expectSaved(a.page) // spike B's O2 race (see RETRO-02)
  await a.page.keyboard.type('Idea')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()
  await expect.poll(() => tool(a.page)).toBe('select')
  expect(await selection(a.page)).toEqual([id])

  await test.step('Enter edits the same note; no blank one is made', async () => {
    await a.page.keyboard.press('Enter')
    await waitForTextEditor(a.page, id)
    expect((await notes(a.page)).map((n) => n.id)).toEqual([id])
    await a.page.keyboard.press('Escape')
    await expect.poll(() => itemText(a.page, id)).toBe('Idea')
  })

  await test.step('N, Enter, Esc with nothing typed: the blank note goes, and the live region says so', async () => {
    await a.page.keyboard.press('n')
    await a.page.keyboard.press('Enter')
    await expect.poll(async () => ((await editingId(a.page)) ?? id) !== id).toBe(true)
    const blank = (await editingId(a.page)) as string
    await expectSaved(a.page)
    await a.page.keyboard.press('Escape')
    await expect.poll(async () => (await notes(a.page)).map((n) => n.id)).toEqual([id])
    expect((await live(a.page)).some((x) => x.id === blank)).toBe(false)
    await expect(a.page.getByTestId('canvas-announcer')).toContainText('Empty sticky note removed')
    await expect.poll(() => tool(a.page)).toBe('select')
    await expectSaved(a.page)
  })
})

test('W5-22: More from the keyboard: Enter opens it on its first tool, arrows move, Enter picks, Esc closes it back on More; it follows the tools in the DOM; a canvas click or a tool key closes it', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const page = a.page
  await waitForCanvasUx(page)
  const more = page.getByTestId('tools.more-button')
  const menu = page.getByTestId('tools.more-content')
  await expect(more).toHaveAttribute('aria-haspopup', 'menu')
  await expect(more).toHaveAttribute('aria-expanded', 'false')

  await test.step('Enter opens it with the keyboard on its first tool; aria-controls names it', async () => {
    await page.getByTestId('tools.select').focus()
    await page.keyboard.press('End')
    await expect(more).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await expect(more).toHaveAttribute('aria-controls', (await menu.getAttribute('id')) as string)
    await expect(menu).toHaveAttribute('role', 'menu')
    await expect(menu.getByRole('menuitemradio').first()).toBeFocused()
    // right after the tools in the DOM (the next Tab stop after More)
    expect(
      await page.evaluate(
        () =>
          document
            .querySelector('[data-testid="main-toolbar"]')
            ?.nextElementSibling?.getAttribute('data-testid') ?? null,
      ),
    ).toBe('tools.more-content')
  })

  await test.step('arrows move inside it, Enter picks: More closes and the board has the keyboard', async () => {
    await page.keyboard.press('ArrowRight')
    const second = menu.getByRole('menuitemradio').nth(1)
    await expect(second).toBeFocused()
    const picked = await second.getAttribute('data-tool')
    await page.keyboard.press('Enter')
    await expect(menu).toHaveCount(0)
    await expect.poll(() => lobbyTool(page)).toBe(picked)
    await expect.poll(() => boardHasFocus(page)).toBe(true)
    await setTool(page, 'select')
  })

  await test.step('Esc closes it and gives More the keyboard back', async () => {
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(more).toBeFocused()
  })

  await test.step('a click on the canvas closes it, and so does a tool key', async () => {
    await more.click()
    await expect(menu).toBeVisible()
    const p = await emptyCanvasPoint(page)
    await page.mouse.click(p.x, p.y)
    await expect(menu).toHaveCount(0)
    await more.click()
    await expect(menu).toBeVisible()
    await page.keyboard.press('r')
    await expect.poll(() => tool(page)).toBe('rectangle')
    await expect(menu).toHaveCount(0)
  })
})

test('D4: the polygon tools: in More in tldraw’s order; a drag draws the shape in the box (a closed line and its see-through holder, grouped), a click a 200 px one; Select after; one undo; bob sees it; Enter places one ready to type in', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const page = a.page
  await waitForCanvasUx(page)
  await setViewport(page, { x: 0, y: 0, zoom: 1 })
  const kinds = [
    'triangle',
    'hexagon',
    'rhombus',
    'star',
    'cloud',
    'heart',
    'arrow-left',
    'arrow-up',
    'arrow-down',
    'arrow-right',
  ]

  await test.step('More lists them between the ellipse and the line', async () => {
    await page.getByTestId('tools.more-button').click()
    const order = await page
      .getByTestId('tools.more-content')
      .locator('button')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-tool')))
    const at = (id: string) => order.indexOf(id)
    for (const k of kinds) expect(at(k), k).toBeGreaterThan(at('ellipse'))
    for (const k of kinds) expect(at(k), k).toBeLessThan(at('line'))
    await page.getByTestId('tools.more.star').click()
    await expect.poll(() => lobbyTool(page)).toBe('star')
  })

  let line = ''
  let holder = ''
  await test.step('a drag draws a star in the dragged box, previewed while dragging', async () => {
    const from = await sceneToScreen(page, { x: 100, y: 100 })
    const to = await sceneToScreen(page, { x: 300, y: 260 })
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 8 })
    await expect(page.getByTestId('polygon-preview')).toBeVisible()
    await page.mouse.up()
    await expect(page.getByTestId('polygon-preview')).toHaveCount(0)
    await expect.poll(async () => (await live(page)).filter((e) => e.type === 'line').length).toBe(1)
    const els = await live(page)
    const l = els.find((e) => e.type === 'line') as unknown as Linear & { id: string }
    const h = els.find((e) => e.type === 'rectangle') as unknown as {
      id: string
      x: number
      y: number
      width: number
      height: number
      strokeColor: string
      backgroundColor: string
      groupIds: string[]
    }
    line = l.id
    holder = h.id
    expect(l.polygon).toBe(true)
    expect(l.points.length).toBe(11)
    expect(l.points[0]).toEqual(l.points[l.points.length - 1])
    expect([h.x, h.y, h.width, h.height]).toEqual([100, 100, 200, 160])
    expect([h.strokeColor, h.backgroundColor]).toEqual(['transparent', 'transparent'])
    expect(h.groupIds[0]).toBeTruthy()
    expect(l.groupIds[0]).toBe(h.groupIds[0])
    // the star's outline inside the dragged box, its top point at the box's top
    const bounds = await withCanvas(page, (c, id) => c.bounds(id), line)
    expect(bounds?.x ?? 0).toBeGreaterThanOrEqual(99.5)
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(300.5)
    expect(Math.abs((bounds?.y ?? 0) - 100)).toBeLessThan(1.5)
    expect((bounds?.width ?? 0) > 180).toBe(true)
    await expect.poll(() => tool(page)).toBe('select')
    expect([...(await selection(page))].sort()).toEqual([line, holder].sort())
    await expectSaved(page)
    await waitForItem(b.page, line, (e) => (e as unknown as Linear).polygon === true)
    await waitForItem(b.page, holder)
  })

  await test.step('the style panel styles the outline, not the holder', async () => {
    await page.getByTestId('style.color.blue').click()
    await expect.poll(async () => (await item(page, line))?.strokeColor).toBe('#4465e9')
    expect((await item(page, holder))?.strokeColor).toBe('transparent')
    await page.getByTestId('style.fill.solid').click()
    await expect.poll(async () => (await item(page, line))?.backgroundColor).not.toBe('transparent')
    expect((await item(page, holder))?.backgroundColor).toBe('transparent')
    await expectSaved(page)
  })

  await test.step('one undo per step; the drawing step takes both away', async () => {
    await undoKey(page)
    await undoKey(page)
    await undoKey(page)
    await expect.poll(async () => (await live(page)).length).toBe(0)
  })

  await test.step('a click puts a 200 px hexagon centred on the click', async () => {
    await setTool(page, 'hexagon')
    await expect.poll(() => lobbyTool(page)).toBe('hexagon')
    const at = await sceneToScreen(page, { x: 600, y: 300 })
    await page.mouse.click(at.x, at.y)
    await expect.poll(async () => (await live(page)).filter((e) => e.type === 'rectangle').length).toBe(1)
    const h = (await live(page)).find((e) => e.type === 'rectangle') as unknown as {
      x: number
      y: number
      width: number
    }
    expect([h.x, h.y, h.width]).toEqual([500, 200, 200])
    await expect.poll(() => tool(page)).toBe('select')
  })

  await test.step('with the keyboard: the tool, then Enter, places a triangle ready to type its label', async () => {
    await focusBoard(page)
    await setTool(page, 'triangle')
    // the engine applies a tool a render later
    await expect.poll(() => lobbyTool(page)).toBe('triangle')
    await page.keyboard.press('Enter')
    const label = await waitForTextEditor(page)
    await expectSaved(page)
    await page.keyboard.type('Peak')
    await page.keyboard.press('Escape')
    await expect.poll(() => itemText(page, label)).toBe('Peak')
    expect((await item(page, label))?.type).toBe('rectangle')
    await expect.poll(() => tool(page)).toBe('select')
  })

  await test.step('a double-click inside a polygon edits its label', async () => {
    const hex = (await live(page)).find(
      (e) => e.type === 'rectangle' && (e as unknown as { x: number }).x === 500,
    ) as unknown as { id: string }
    const at = await sceneToScreen(page, { x: 600, y: 300 })
    await page.mouse.dblclick(at.x, at.y)
    await waitForTextEditor(page, hex.id)
    await page.keyboard.type('Six')
    await page.keyboard.press('Escape')
    await expect.poll(() => itemText(page, hex.id)).toBe('Six')
  })
})

test('W5-33: Board ▸ View has the zoom entries and the minimap, Edit ▸ and the context menu have Paste, Preferences ▸ Theme switches the theme; Undo and Redo sit beside the tools on a desktop canvas', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const page = a.page
  await a.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })
  await waitForCanvasUx(page)
  const n = await settled(page, createNote(page, { x: 100, y: 100, text: 'Copy me' }))
  const openSub = async (sub: string) => {
    await page.getByTestId('main-menu.button').click()
    await page.getByTestId(`main-menu-sub.${sub}-button`).click()
  }

  await test.step('View ▸ the camera entries; Zoom to 100% zooms to 100%', async () => {
    await setViewport(page, { zoom: 0.5 })
    await openSub('view')
    // the View rows are the navigation feature's, each once (the wave-5 integration found them twice)
    for (const id of ['zoom-in', 'zoom-out', 'zoom-to-100', 'zoom-to-fit', 'minimap'])
      await expect(page.getByTestId(`main-menu.navigation.view.${id}`)).toBeVisible()
    await expect(
      page.getByTestId('main-menu-sub.view-content').locator('[data-testid^="main-menu."]'),
    ).toHaveCount(6)
    await page.getByTestId('main-menu.navigation.view.zoom-to-100').click()
    await expect.poll(async () => (await viewport(page)).zoom).toBeCloseTo(1, 2)
  })

  await test.step('the context menu’s Paste pastes what was copied, where the menu opened', async () => {
    await select(page, [n])
    await page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
    await page.keyboard.press('ControlOrMeta+c')
    const at = await emptyCanvasPoint(page)
    const scene = await screenToScene(page, at)
    await page.mouse.click(at.x, at.y, { button: 'right' })
    await page.getByTestId('context-menu.paste').click()
    await expect.poll(async () => (await notes(page)).length).toBe(2)
    const copy = (await notes(page)).find((x) => x.id !== n)
    expect(copy?.text).toBe('Copy me')
    expect(Math.abs((copy?.x ?? 0) + 100 - scene.x)).toBeLessThan(150)
  })

  await test.step('Edit ▸ Paste pastes too', async () => {
    await openSub('edit')
    await page.getByTestId('main-menu.paste').click()
    await expect.poll(async () => (await notes(page)).length).toBe(3)
    await expectSaved(page)
  })

  await test.step('Preferences ▸ Theme ▸ Dark, then System', async () => {
    await openSub('preferences')
    await page.getByTestId('main-menu-sub.theme-button').click()
    await page.getByTestId('main-menu.theme-dark').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect.poll(() => withCanvas(page, (c) => c.theme(), null)).toBe('dark')
    await openSub('preferences')
    await page.getByTestId('main-menu-sub.theme-button').click()
    await expect(page.getByTestId('main-menu.theme-dark')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('main-menu.theme-system').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme-pref', 'system')
  })

  await test.step('Undo and Redo beside the tools (no quick actions on a desktop canvas)', async () => {
    await expect(page.getByTestId('quick-actions')).toHaveCount(0)
    const bar = page.getByTestId('history-bar')
    await expect(bar).toBeVisible()
    const tools = await page.getByTestId('main-toolbar').boundingBox()
    const hb = await bar.boundingBox()
    expect((hb?.x ?? 0) + (hb?.width ?? 0)).toBeLessThanOrEqual((tools?.x ?? 0) + 1)
    await page.getByTestId('history-bar.undo').click()
    await expect.poll(async () => (await notes(page)).length).toBe(2)
    await page.getByTestId('history-bar.redo').click()
    await expect.poll(async () => (await notes(page)).length).toBe(3)
    await expect.poll(() => boardHasFocus(page)).toBe(true)
  })
})

/** The relative luminance contrast of two CSS colours (rgb() strings). */
const contrastIn = (page: Page, fg: string, bg: string) =>
  page.evaluate(
    ([f, b]: readonly [string, string]) => {
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
      const lum = (c: string) => {
        const [r, g, bl] = rgb(c).map((v) => {
          const s = v / 255
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        }) as [number, number, number]
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl
      }
      const [hi, lo] = [lum(f), lum(b)].sort((x, y) => y - x) as [number, number]
      return (hi + 0.05) / (lo + 0.05)
    },
    [fg, bg] as const,
  )

test('W5-40 to W5-42: font buttons in their own faces, icon arrowheads, a labelled opacity slider, a readable note-colour legend in dark mode, and one Tab stop per control', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const page = a.page
  await waitForCanvasUx(page)
  const rect = await settled(
    page,
    createItem(page, 'rectangle', { x: 100, y: 100, width: 200, height: 120, backgroundColor: '#ffc9c9' }),
  )
  await select(page, [rect])
  await expect(page.getByTestId('style.panel')).toBeVisible()

  await test.step('the font buttons are drawn in their faces; the opacity slider has a visible label', async () => {
    for (const [id, face] of [
      ['draw', 'Excalifont'],
      ['sans', 'Nunito'],
      ['mono', 'Comic Shanns'],
    ] as const)
      await expect(page.getByTestId(`style.font.${id}`)).toHaveCSS('font-family', new RegExp(face))
    await expect(page.getByTestId('style-opacity-label')).toBeVisible()
    await expect(page.getByTestId('style-opacity-label')).toContainText('Opacity')
    await expect(page.getByTestId('style-opacity-label')).toContainText('100%')
  })

  await test.step('one Tab stop per control; arrows move inside one', async () => {
    const color = page.getByTestId('style.color')
    const stops = await color.locator('button[tabindex="0"]').count()
    expect(stops).toBe(1)
    for (const id of ['style.fill', 'style.dash', 'style.size', 'style.font', 'style.align'])
      expect(await page.getByTestId(id).locator('button[tabindex="0"]').count(), id).toBe(1)
    await color.locator('button[tabindex="0"]').focus()
    const before = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.testid)
    await page.keyboard.press('ArrowRight')
    const after = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.testid)
    expect(after).not.toBe(before)
    expect(after?.startsWith('style.color.')).toBe(true)
    // the whole toolbar is one stop too
    expect(await page.getByTestId('main-toolbar').locator('button[tabindex="0"]').count()).toBe(1)
  })

  await test.step('a connector gets icon arrowheads, not native selects', async () => {
    const arrow = await settled(page, createItem(page, 'arrow', { x: 400, y: 400 }))
    await select(page, [arrow])
    await expect(page.locator('[data-testid="style.panel"] select')).toHaveCount(0)
    const end = page.getByTestId('style.arrowhead-end.triangle')
    await expect(end).toHaveAttribute('aria-label', 'Triangle')
    await end.click()
    await expect.poll(async () => (await item(page, arrow))?.endArrowhead).toBe('triangle')
    await expect(end).toHaveAttribute('aria-pressed', 'true')
  })

  await test.step('dark mode: the note palette legend reads at 4.5:1 or more', async () => {
    await page.evaluate(() => {
      localStorage.setItem('draftroom:theme', 'dark')
    })
    await page.reload()
    await waitForCanvasUx(page)
    const n1 = await settled(page, createNote(page, { x: 600, y: 100, text: 'n' }))
    await select(page, [n1])
    const legend = page.getByTestId('note-palette').locator('legend')
    await expect(legend).toBeVisible()
    const fg = await legend.evaluate((e) => getComputedStyle(e).color)
    const bg = await page.getByTestId('style.panel').evaluate((e) => getComputedStyle(e).backgroundColor)
    expect(await contrastIn(page, fg, bg)).toBeGreaterThanOrEqual(4.5)
  })
})

test('W5-46: on a low canvas (a laptop at 200% zoom) the style panel folds behind the Styles button, which opens it above the tools', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const page = a.page
  await page.setViewportSize({ width: 720, height: 450 })
  await waitForCanvasUx(page)
  const rect = await settled(page, createItem(page, 'rectangle', { x: 0, y: 0, width: 200, height: 120 }))
  await select(page, [rect])
  await expect(page.getByTestId('mobile-styles.button')).toBeVisible()
  await expect(page.getByTestId('style.panel')).toHaveCount(0)
  await page.getByTestId('mobile-styles.button').click()
  await expect(page.getByTestId('mobile-styles.content').getByTestId('style.panel')).toBeVisible()
  const panel = await page.getByTestId('mobile-styles.content').boundingBox()
  const tools = await page.getByTestId('main-toolbar').boundingBox()
  expect((panel?.y ?? 0) + (panel?.height ?? 0)).toBeLessThanOrEqual((tools?.y ?? 0) + 1)
})

test('W5-50 and W5-59: the tools say their keys (aria-keyshortcuts and the tooltip); the open text editor is named for what it edits', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const page = a.page
  await waitForCanvasUx(page)
  await expect(page.getByTestId('tools.select')).toHaveAttribute('aria-keyshortcuts', 'V')
  await expect(page.getByTestId('tools.note')).toHaveAttribute('aria-keyshortcuts', 'N')
  await expect(page.getByTestId('tools.note')).toHaveAttribute('title', /Note — N/)
  await expect(page.getByTestId('tools.asset')).toHaveAttribute('aria-keyshortcuts', 'Control+U')
  const n = await settled(page, createNote(page, { x: 100, y: 100, text: 'x' }))
  const r = await settled(
    page,
    createItem(page, 'rectangle', { x: 500, y: 100, width: 200, height: 120, backgroundColor: '#ffc9c9' }),
  )
  // every name the editor is given while it opens: one writer, one name (the wave-5 integration found
  // canvas-ux and a11y both naming it, "Rectangle text" then "Shape label")
  await page.evaluate(() => {
    const w = window as unknown as { __editorNames: string[] }
    w.__editorNames = []
    new MutationObserver((records) => {
      for (const m of records) {
        const t = m.target as HTMLElement
        if (t.tagName === 'TEXTAREA') w.__editorNames.push(t.getAttribute('aria-label') ?? '')
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['aria-label'], subtree: true })
  })
  const names = () => page.evaluate(() => (window as unknown as { __editorNames: string[] }).__editorNames)
  for (const [id, name] of [
    [n, 'Sticky note text'],
    [r, 'Shape label'],
  ] as const) {
    await focusBoard(page)
    await select(page, [id])
    await page.evaluate(() => {
      ;(window as unknown as { __editorNames: string[] }).__editorNames = []
    })
    await page.keyboard.press('Enter')
    await waitForTextEditor(page, id)
    await expect(page.locator('textarea.excalidraw-wysiwyg')).toHaveAttribute('aria-label', name)
    await page.waitForTimeout(300)
    expect(new Set(await names())).toEqual(new Set([name]))
    await page.keyboard.press('Escape')
  }
})

for (const vp of [
  { width: 390, height: 844 },
  { width: 412, height: 915 },
]) {
  test(`W5-31 / W5-06: on a ${vp.width} px phone every tool, More, Styles, the quick actions, the zoom button and the board menu can be tapped where they are drawn; tools are 44 px`, async ({
    browser,
    board,
    users,
  }) => {
    const a = await openPhoneSession(browser, board, users, 'alice')
    try {
      const page = a.page
      await page.setViewportSize(vp)
      await waitForCanvasUx(page)
      await settled(page, createNote(page, { x: 0, y: 0, text: 'One' }))
      const ids = await page
        .locator(
          '[data-testid="main-toolbar"] > button, [data-testid="mobile-styles.button"], [data-testid="quick-actions"] button, [data-testid="main-menu.button"], [data-testid="navigation.zoom-to-fit"]',
        )
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') as string))
      expect(ids).toContain('tools.select')
      expect(ids).toContain('main-menu.button')
      for (const id of ids) {
        const hit = await page.getByTestId(id).evaluate((el) => {
          const b = el.getBoundingClientRect()
          const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
          return top === el || el.contains(top)
        })
        expect(hit, `${id} is on top where it is drawn`).toBe(true)
      }
      const select = await page.getByTestId('tools.select').boundingBox()
      expect(select?.width).toBeGreaterThanOrEqual(44)
      expect(select?.height).toBeGreaterThanOrEqual(44)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
        true,
      )
    } finally {
      await a.context.close()
    }
  })
}

/** A frame with a locked heading inside it (a template's), on alice's board; returns their ids. */
async function frameWithLockedHeading(page: Page) {
  const frame = await settled(
    page,
    createItem(page, 'frame', { x: 100, y: 100, width: 500, height: 320, name: 'Went well' }),
  )
  const heading = await settled(
    page,
    createItem(page, 'text', { x: 130, y: 130, text: 'What went well?', frameId: frame, locked: true }),
  )
  const note = await settled(page, createNote(page, { x: 160, y: 200, text: 'Idea' }))
  await settled(
    page,
    withCanvas(page, (c, ids) => c.transact('into frame', (tx) => tx.setFrame([ids.note], ids.frame)), {
      note,
      frame,
    }),
  )
  return { frame, heading, note }
}

/** Drags the frame by its name (drawn just above its top edge) by `dx` scene units. */
async function dragFrameByName(page: Page, frame: string, dx: number) {
  await setViewport(page, { x: 0, y: 0, zoom: 1 })
  await select(page, [frame])
  const at = await sceneToScreen(page, { x: 120, y: 92 })
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + dx, at.y, { steps: 10 })
  await page.mouse.up()
  await expect.poll(async () => (await item(page, frame))?.x).toBe(100 + dx)
}

test('W5-05 (client half): dragging a template frame takes its locked heading along, in the same push as the frame (what the server needs to keep the move whole)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  const { frame, heading, note } = await frameWithLockedHeading(a.page)
  const before = (await pushedOps(a.page)).length
  await dragFrameByName(a.page, frame, 150)
  await expect.poll(async () => (await item(a.page, note))?.x).toBe(310)
  await expect
    .poll(async () => {
      const pushes = (await pushedOps(a.page)).slice(before)
      const ids = (p: (typeof pushes)[number]) => p.ops.map((o) => (o.k === 'p' ? o.id : o.el.id))
      return pushes.some((p) => ids(p).includes(frame) && ids(p).includes(heading))
    })
    .toBe(true)
})

test('W5-05: the server keeps a frame move that carries its locked heading by the same distance (Saved, bob sees it, a reload keeps it)', async ({
  canvasSession,
}) => {
  // The server's lock rule (apps/sync/src/room/merge.ts step 5, 2A's) refuses every position change of a
  // locked element, a translation that matches its frame's move in the same push included (REVIEW-W5-EARLY
  // W5-05: "Change not saved — that object is locked", and the split is saved). 2A's rule (wave 5, merged at
  // the engine integration) lets a locked element move by exactly its frame's move in the same push.
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForCanvasUx(a.page)
  const { frame, heading } = await frameWithLockedHeading(a.page)
  await dragFrameByName(a.page, frame, 150)
  await expectSaved(a.page, 10_000)
  await expect(a.page.getByTestId('conn-status')).not.toContainText('not saved')
  await waitForItem(b.page, heading, (e) => e.x === 280, 10_000)
  await a.page.reload()
  await waitForCanvasUx(a.page)
  await expect.poll(async () => (await item(a.page, heading))?.x, { timeout: 10_000 }).toBe(280)
})
