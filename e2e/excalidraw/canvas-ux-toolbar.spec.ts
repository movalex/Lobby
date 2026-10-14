// canvas-ux (3a) on the Excalidraw board page: the toolbar and the style panel. Ported from the tldraw
// page's specs (tests/canvas-ux.spec.ts "toolbar layout pin" and "note palette", tests/canvas-ux.fix.spec.ts
// "RETRO-20", tests/canvas-2.fix.spec.ts "R16"): the same behaviour on Lobby's own chrome. The pixel
// snapshot of tldraw's toolbar is not ported (Lobby's toolbar is new chrome): the order is checked by test
// ids instead.
import {
  createItem,
  createNote,
  expect,
  expectConverged,
  item,
  select,
  selectNone,
  setTool,
  test,
  tool,
  waitForItem,
} from '../tests/support/canvas.ts'
import { focusBoard, settled } from './board-kit.ts'
import { showStylePanel, toolbarIds, undoKey, waitForCanvasUx, withCanvas } from './canvas-ux-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const MAIN = [
  'tools.select',
  'tools.hand',
  'tools.note',
  'tools.text',
  'tools.rectangle',
  'tools.freedraw',
  'tools.arrow',
  'tools.frame',
  'tools.asset',
]

test('toolbar: the main tools keep their order, an overflow tool takes the one extra slot, a viewer gets only what their role may use', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)

  await test.step('pinned order: the main tools, then one overflow slot (the eraser), then More', async () => {
    const ids = await toolbarIds(a.page)
    expect(ids.slice(0, MAIN.length)).toEqual(MAIN)
    expect(ids.slice(-2)).toEqual(['tools.eraser', 'tools.more-button'])
    // Templates only where the templates panel exists (navigation's), and never twice
    const templates = await a.page.getByTestId('dock-tab-templates').count()
    expect(ids.filter((i) => i === 'tools.dr-templates')).toHaveLength(templates)
  })

  await test.step('an overflow tool, once used, takes the extra slot; the main tools do not move', async () => {
    await a.page.getByTestId('tools.more-button').click()
    await a.page.getByTestId('tools.more.ellipse').click()
    await expect.poll(() => tool(a.page)).toBe('ellipse')
    await expect(a.page.getByTestId('tools.more-content')).toHaveCount(0)
    let ids = await toolbarIds(a.page)
    expect(ids.slice(0, MAIN.length)).toEqual(MAIN)
    expect(ids.slice(-2)).toEqual(['tools.ellipse', 'tools.more-button'])
    await expect(a.page.getByTestId('tools.ellipse')).toHaveAttribute('aria-pressed', 'true')
    // the keyboard stayed on the board: V picks the select tool
    await a.page.keyboard.press('v')
    await expect.poll(() => tool(a.page)).toBe('select')
    ids = await toolbarIds(a.page)
    expect(ids.slice(-2)).toEqual(['tools.ellipse', 'tools.more-button'])
  })

  await test.step('a viewer has no creation tools, no Templates and no More', async () => {
    const b = await canvasSession('bob', { role: 'viewer' })
    await waitForCanvasUx(b.page)
    const ids = await toolbarIds(b.page)
    expect(ids[0]).toBe('tools.select')
    for (const id of [
      'tools.note',
      'tools.rectangle',
      'tools.asset',
      'tools.dr-templates',
      'tools.more-button',
    ])
      expect(ids).not.toContain(id)
    await expect(b.page.getByTestId('dock-tab-templates')).toHaveCount(0)
    await expect(b.page.getByTestId('style.panel')).toHaveCount(0)
  })
})

test('tools: the Miro letters pick their tool on the board (L connector, P pen), and a click on a tool leaves the keyboard on the board', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  await focusBoard(a.page)
  const keys: [string, string][] = [
    ['n', 'note'],
    ['t', 'text'],
    ['r', 'rectangle'],
    ['o', 'ellipse'],
    ['p', 'freedraw'],
    ['l', 'arrow'],
    ['f', 'frame'],
    ['e', 'eraser'],
    ['k', 'laser'],
    ['h', 'hand'],
    ['v', 'select'],
  ]
  for (const [key, name] of keys) {
    await a.page.keyboard.press(key)
    await expect.poll(() => tool(a.page), { message: key }).toBe(name)
  }
  // a click on a tool button keeps the keyboard on the canvas (T or V right after work)
  await a.page.getByTestId('tools.rectangle').click()
  await expect.poll(() => tool(a.page)).toBe('rectangle')
  await expect(a.page.getByTestId('tools.rectangle')).toHaveAttribute('data-state', 'selected')
  await a.page.keyboard.press('v')
  await expect.poll(() => tool(a.page)).toBe('select')
  // the toolbar is one Tab stop with arrow keys along it (ARIA toolbar)
  await a.page.getByTestId('tools.select').focus()
  await a.page.keyboard.press('ArrowRight')
  await expect(a.page.getByTestId('tools.hand')).toBeFocused()
  await a.page.keyboard.press('End')
  await expect(a.page.getByTestId('tools.more-button')).toBeFocused()
})

test('RETRO-20 / R16: the style panel shows for a selection or a creation tool, never for frames only', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  // P-021: the style panel opens on request; this person has it open
  await showStylePanel(a.page)
  await waitForCanvasUx(a.page)
  const panel = a.page.getByTestId('style.panel')
  const rect = await settled(
    a.page,
    createItem(a.page, 'rectangle', { x: 100, y: 100, width: 200, height: 120 }),
  )
  const frame = await settled(
    a.page,
    createItem(a.page, 'frame', { x: 500, y: 100, width: 300, height: 200, name: 'F' }),
  )
  await expect(panel).toHaveCount(0)
  await select(a.page, [rect])
  await expect(panel).toBeVisible()
  for (const id of ['style.color', 'style.opacity', 'style.fill', 'style.dash', 'style.size'])
    await expect(a.page.getByTestId(id)).toBeVisible()
  await expect(a.page.getByTestId('note-palette')).toHaveCount(0)
  await select(a.page, [frame])
  await expect(panel).toHaveCount(0)
  await selectNone(a.page)
  await setTool(a.page, 'rectangle')
  await expect(panel).toBeVisible()
  await expect(a.page.getByTestId('style.geo')).toBeVisible()
  // CR-3A-7: the note tool's next note takes the note colour, size and font; the text tool's next text its
  // colour, size, font and alignment (neither takes an opacity)
  await setTool(a.page, 'note')
  await expect(panel).toBeVisible()
  for (const id of ['note-palette', 'style.size', 'style.font'])
    await expect(a.page.getByTestId(id)).toBeVisible()
  for (const id of ['style.color', 'style.opacity', 'style.align', 'style.vertical-align'])
    await expect(a.page.getByTestId(id)).toHaveCount(0)
  await setTool(a.page, 'text')
  for (const id of ['style.color', 'style.size', 'style.font', 'style.align'])
    await expect(a.page.getByTestId(id)).toBeVisible()
  await expect(a.page.getByTestId('style.opacity')).toHaveCount(0)
  await expect(a.page.getByTestId('note-palette')).toHaveCount(0)
  await setTool(a.page, 'select')
  await expect(panel).toHaveCount(0)
})

test('COL-06 note palette: two selected notes show the 13 Lobby colours, one pick recolours both (bob sees it), one undo restores each', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  // P-021: the style panel opens on request; this person has it open
  await showStylePanel(a.page)
  const b = await canvasSession('bob')
  await waitForCanvasUx(a.page)
  const n1 = await settled(a.page, createNote(a.page, { x: 100, y: 100, text: 'one', color: '#f8e48f' }))
  const n2 = await settled(a.page, createNote(a.page, { x: 360, y: 100, text: 'two', color: '#f4a874' }))
  await select(a.page, [n1, n2])
  const palette = a.page.getByTestId('note-palette')
  await expect(palette).toBeVisible()
  await expect(palette.getByTestId('note-color')).toHaveCount(13)
  await expect(palette.locator('legend')).toHaveText('Note color (mixed)')
  await expect(palette.locator('[data-color="white"]')).toHaveAttribute('aria-label', 'White')
  await palette.locator('[data-color="light-blue"]').click()
  const sky = '#a6d8f3'
  await expect.poll(async () => (await item(a.page, n1))?.backgroundColor).toBe(sky)
  await expect.poll(async () => (await item(a.page, n2))?.backgroundColor).toBe(sky)
  await expect(palette.locator('[data-color="light-blue"]')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await item(b.page, n2))?.backgroundColor).toBe(sky)
  // one undo step for the pick
  await undoKey(a.page)
  await expect.poll(async () => (await item(a.page, n1))?.backgroundColor).toBe('#f8e48f')
  await expect.poll(async () => (await item(a.page, n2))?.backgroundColor).toBe('#f4a874')
  await expectConverged(a.page, [b.page])
})

test('style: colour, fill, dash and size on a shape are one undo step each, map to tldraw’s colours and reach bob', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  // P-021: the style panel opens on request; this person has it open
  await showStylePanel(a.page)
  const b = await canvasSession('bob')
  await waitForCanvasUx(a.page)
  const rect = await settled(
    a.page,
    createItem(a.page, 'rectangle', { x: 100, y: 100, width: 200, height: 120 }),
  )
  await waitForItem(b.page, rect)
  await select(a.page, [rect])
  await a.page.getByTestId('style.color.blue').click()
  await expect.poll(async () => (await item(a.page, rect))?.strokeColor).toBe('#4465e9')
  await a.page.getByTestId('style.fill.solid').click()
  await expect
    .poll(async () => {
      const e = await item(a.page, rect)
      return [e?.backgroundColor, e?.fillStyle]
    })
    .toEqual(['#dce1f8', 'solid'])
  await expect(a.page.getByTestId('style.fill.solid')).toHaveAttribute('aria-pressed', 'true')
  await a.page.getByTestId('style.dash.dashed').click()
  await expect.poll(async () => (await item(a.page, rect))?.strokeStyle).toBe('dashed')
  await a.page.getByTestId('style.size.xl').click()
  await expect.poll(async () => (await item(a.page, rect))?.strokeWidth).toBe(8)
  // a colour change keeps the fill in the new colour
  await a.page.getByTestId('style.color.red').click()
  await expect
    .poll(async () => {
      const e = await item(a.page, rect)
      return [e?.strokeColor, e?.backgroundColor]
    })
    .toEqual(['#e03131', '#f4dadb'])
  await expect.poll(async () => (await item(b.page, rect))?.strokeWidth).toBe(8)
  await expectConverged(a.page, [b.page])
  // each pick is its own undo step
  await undoKey(a.page)
  await expect.poll(async () => (await item(a.page, rect))?.strokeColor).toBe('#4465e9')
  await undoKey(a.page)
  await expect.poll(async () => (await item(a.page, rect))?.strokeWidth).not.toBe(8)
  // the next shapes take the picks too
  const next = await withCanvas(a.page, (c) => c.styles.next(), null)
  expect(next.strokeColor).toBe('#e03131')
})

test('style: a font and a size on a note (P-011: the note’s size) lay its label out again in one undo step', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  // P-021: the style panel opens on request; this person has it open
  await showStylePanel(a.page)
  const b = await canvasSession('bob')
  await waitForCanvasUx(a.page)
  const note = await settled(a.page, createNote(a.page, { x: 100, y: 100, text: 'Grow me please' }))
  await select(a.page, [note])
  const labelOf = async (page: typeof a.page) => {
    const n = await item(page, note)
    const id = ((n as { boundElements?: { id: string; type: string }[] } | null)?.boundElements ?? []).find(
      (e) => e.type === 'text',
    )?.id
    return id ? item(page, id) : null
  }
  await expect(a.page.getByTestId('style.font')).toBeVisible()
  await a.page.getByTestId('style.font.mono').click()
  await expect.poll(async () => (await labelOf(a.page))?.fontFamily).toBe(8)
  // P-011: a note's Size is the note's (Extra large: 400 px), its words with it (44)
  await a.page.getByTestId('style.size.xl').click()
  await expect
    .poll(async () => (await labelOf(a.page)) as { baseFontSize?: number } | null)
    .toMatchObject({ baseFontSize: 44 })
  await expect.poll(async () => (await item(a.page, note))?.width).toBe(400)
  await expect.poll(async () => (await labelOf(b.page))?.fontFamily).toBe(8)
  await expectConverged(a.page, [b.page])
  await undoKey(a.page)
  await expect
    .poll(async () => ((await labelOf(a.page)) as { baseFontSize?: number } | null)?.baseFontSize)
    .not.toBe(44)
  await expect.poll(async () => (await item(a.page, note))?.width).toBe(200)
  await expect.poll(async () => (await labelOf(a.page))?.fontFamily).toBe(8)
})
