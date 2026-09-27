// canvas-ux in real browsers (docs/E2E-PLAN.md [canvas-ux]; meaning of each ID in
// docs/research/miro-ux-checklist.md; test ids in docs/FEATURES-M2-CONTRACTS.md): the pinned toolbar,
// Miro's keys, lock, type-to-edit, bulk paste, the note palette, templates, the frame outline, board
// search, copy link, the start view, alignment guides + selection bar and the 20k shape cap.
// Shapes are SET UP through window.editor (like the other suites); the behaviour under test is driven
// the way a user drives it (keys, clicks, drags, the clipboard), and every collaborative outcome is
// checked in a second browser (or a fresh one, which loads from the server).
import type { Page } from '@playwright/test'
import { arrowBindings, getShape, pageShapes, waitForTextEditor } from './support/board.ts'
import {
  boundsOf,
  camera,
  clickCanvasAt,
  clickShape,
  currentTool,
  drag,
  editEd,
  grantClipboard,
  inView,
  openPath,
  overlaps,
  readClipboardText,
  readEd,
  screenOf,
  selectedIds,
  shapeCount,
  shortcutRows,
  startView,
  storedCamera,
  viewport,
  visibleToolbarIds,
  waitForCanvasUx,
  waitForSaved,
  writeClipboard,
  zOrder,
  zoom,
} from './support/canvas-ux.ts'
import { plainText, richText, type ShapeLike } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'
import { WEB_URL } from './support/ports.ts'
import { capture } from './support/screenshots.ts'

// The layout the toolbar pin (COL-07/PRF-09) is defined at.
test.use({ viewport: { width: 1440, height: 900 } })

const MAIN_TOOLS = [
  'tools.select',
  'tools.hand',
  'tools.note',
  'tools.text',
  'tools.rectangle',
  'tools.draw',
  'tools.arrow',
  'tools.frame',
  'tools.asset',
  'tools.comment',
  'tools.dr-templates',
]

const note = (id: string, x: number, y: number, text = '', color = 'yellow') => ({
  id,
  type: 'note',
  x,
  y,
  props: { color, richText: richText(text) },
})
const rect = (id: string, x: number, y: number, w = 200, h = 120) => ({
  id,
  type: 'geo',
  x,
  y,
  props: { geo: 'rectangle', w, h },
})
const frame = (id: string, x: number, y: number, name: string, w = 480, h = 320) => ({
  id,
  type: 'frame',
  x,
  y,
  props: { w, h, name },
})

async function create(page: Page, shapes: Record<string, unknown>[]) {
  await editEd(page, (ed, list) => ed.createShapes(list), shapes)
}

const isLocked = (page: Page, id: string) => getShape(page, id).then((s) => s?.isLocked ?? null)
const colorOf = (page: Page, id: string) => getShape(page, id).then((s) => s?.props.color ?? null)

/** The notes on the page with their text, sorted by text. */
async function notes(page: Page) {
  return (await pageShapes(page))
    .filter((s) => s.type === 'note')
    .map((s) => ({ id: s.id, text: plainText(s.props.richText), x: s.x, y: s.y, parentId: s.parentId }))
    .sort((a, b) => a.text.localeCompare(b.text))
}

const frameRows = (page: Page) => page.locator('[data-testid="frame-row"]:not([data-nested])')
const frameRowIds = (page: Page) =>
  frameRows(page).evaluateAll((rows) => rows.map((r) => r.getAttribute('data-frame-id')))
const frameRow = (page: Page, id: string) => page.locator(`[data-testid="frame-row"][data-frame-id="${id}"]`)

// ---------------------------------------------------------------------------------------------------

test('toolbar layout pin: the main tools keep their order at 1440×900 (snapshot), overflow tools take one slot, a viewer gets no Templates', async ({
  session,
}, testInfo) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await a.page.mouse.move(720, 400) // nowhere near a button: no hover state, no tooltip

  await test.step('pinned order: 11 main tools, one overflow slot, the More button', async () => {
    await expect
      .poll(() => visibleToolbarIds(a.page))
      .toEqual([...MAIN_TOOLS, 'tools.eraser', 'tools.more-button'])
    // The tool strip of .tlui-main-toolbar (the full-width bar also spans the minimap and tldraw's
    // licence note, which change with the board and the platform's fonts). One baseline for every
    // platform (icons only, no text): the threshold absorbs anti-aliasing, while a tool that moves,
    // appears or disappears changes far more pixels.
    testInfo.snapshotSuffix = ''
    await expect(a.page.locator('.tlui-main-toolbar .tlui-main-toolbar__tools')).toHaveScreenshot(
      'main-toolbar.png',
      { maxDiffPixelRatio: 0.03, animations: 'disabled' },
    )
  })

  await test.step('an overflow tool, once used, takes the one extra slot; the main tools do not move', async () => {
    await a.page.getByTestId('tools.more-button').click()
    await a.page.getByTestId('tools.more.ellipse').click()
    await expect.poll(() => currentTool(a.page)).toBe('geo')
    await a.page.mouse.move(720, 400)
    await expect
      .poll(() => visibleToolbarIds(a.page))
      .toEqual([...MAIN_TOOLS, 'tools.ellipse', 'tools.more-button'])
    await a.page.keyboard.press('v')
    await expect.poll(() => currentTool(a.page)).toBe('select')
    await expect
      .poll(() => visibleToolbarIds(a.page))
      .toEqual([...MAIN_TOOLS, 'tools.ellipse', 'tools.more-button'])
  })

  await test.step('a viewer has no Templates entry (toolbar or dock)', async () => {
    const b = await session('bob', { role: 'viewer' })
    await expect(b.page.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'viewer')
    await waitForCanvasUx(b.page)
    await expect(b.page.getByTestId('tools.select')).toBeVisible()
    await expect(b.page.getByTestId('tools.dr-templates')).toHaveCount(0)
    await expect(b.page.getByTestId('dock-tab-templates')).toHaveCount(0)
    expect(await visibleToolbarIds(b.page)).not.toContain('tools.note')
  })
})

test('Miro keys: L/P tools, PgUp/PgDn z-order, Ctrl+Shift+L lock keeps the selection, Ctrl+0/Alt+1/Alt+2 zoom, M minimap, Ctrl+Alt+/ lists the keys', async ({
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  const [R1, R2, R3, FAR] = ['shape:key-r1', 'shape:key-r2', 'shape:key-r3', 'shape:key-far']
  await create(a.page, [rect(R1, 300, 200), rect(R2, 360, 250), rect(R3, 420, 300), rect(FAR, 3200, 2200)])
  await clickCanvasAt(a.page, { x: 1000, y: 650 }) // empty canvas: the board has the keyboard
  const stack = async () => (await zOrder(a.page)).filter((id) => id !== FAR)

  await test.step('L = connector (arrow), P = pen (draw)', async () => {
    await a.page.keyboard.press('l')
    await expect.poll(() => currentTool(a.page)).toBe('arrow')
    await a.page.keyboard.press('v')
    await a.page.keyboard.press('p')
    await expect.poll(() => currentTool(a.page)).toBe('draw')
    await a.page.keyboard.press('v')
    await expect.poll(() => currentTool(a.page)).toBe('select')
  })

  await test.step('PageUp / PageDown: front / back; Shift: one step; ] and [ still work', async () => {
    await editEd(a.page, (ed, id) => ed.select(id), R1)
    expect(await stack()).toEqual([R1, R2, R3])
    await a.page.keyboard.press('PageUp')
    await expect.poll(stack).toEqual([R2, R3, R1])
    await a.page.keyboard.press('PageDown')
    await expect.poll(stack).toEqual([R1, R2, R3])
    await a.page.keyboard.press('Shift+PageUp')
    await expect.poll(stack).toEqual([R2, R1, R3])
    await a.page.keyboard.press('Shift+PageDown')
    await expect.poll(stack).toEqual([R1, R2, R3])
    await a.page.keyboard.press(']')
    await expect.poll(stack).toEqual([R2, R3, R1])
    await a.page.keyboard.press('[')
    await expect.poll(stack).toEqual([R1, R2, R3])
  })

  await test.step('Ctrl+Shift+L locks and keeps the selection; Delete does nothing; again unlocks; bare Shift+L does nothing', async () => {
    await editEd(a.page, (ed, id) => ed.select(id), R2)
    await a.page.keyboard.press('Control+Shift+L')
    await expect.poll(() => isLocked(a.page, R2)).toBe(true)
    expect(await selectedIds(a.page)).toEqual([R2])
    await a.page.keyboard.press('Delete')
    await a.page.keyboard.press('Backspace')
    expect(await getShape(a.page, R2)).not.toBeNull()
    await a.page.keyboard.press('Control+Shift+L')
    await expect.poll(() => isLocked(a.page, R2)).toBe(false)
    await editEd(a.page, (ed, id) => ed.select(id), R3)
    await a.page.keyboard.press('Shift+L')
    // Proof the key was handled by now: a later key on the same queue takes effect.
    await a.page.keyboard.press('l')
    await expect.poll(() => currentTool(a.page)).toBe('arrow')
    expect(await isLocked(a.page, R3)).toBe(false)
    await a.page.keyboard.press('v')
  })

  await test.step('Ctrl+0 = 100% (browser zoom untouched); Alt+1 fits all; Alt+2 goes to the selection', async () => {
    await editEd(a.page, (ed) => ed.setCamera({ x: 0, y: 0, z: 0.5 }, { immediate: true }))
    await a.page.keyboard.press('Control+0')
    await expect.poll(() => zoom(a.page)).toBe(1)
    expect(await a.page.evaluate(() => window.devicePixelRatio)).toBe(1)

    await editEd(a.page, (ed) => ed.setCamera({ x: -20_000, y: -20_000, z: 1 }, { immediate: true }))
    expect(await inView(a.page, [R1])).toBe(false)
    await a.page.keyboard.press('Alt+1')
    await expect.poll(() => inView(a.page, [R1, R2, R3, FAR])).toBe(true)
    expect(await zoom(a.page)).toBeLessThan(1)

    await editEd(a.page, (ed, id) => ed.select(id), FAR)
    await a.page.keyboard.press('Alt+2')
    await expect.poll(() => zoom(a.page)).toBe(1)
    await expect
      .poll(async () => {
        const [vp, b] = [await viewport(a.page), await boundsOf(a.page, [FAR])]
        return b
          ? Math.round(Math.hypot(vp.x + vp.w / 2 - (b.x + b.w / 2), vp.y + vp.h / 2 - (b.y + b.h / 2)))
          : -1
      })
      .toBeLessThanOrEqual(1)
    expect(await inView(a.page, [R1])).toBe(false)
    // Already at 100%: Alt+2 again fits the selection itself (zooms in on the one box).
    await a.page.keyboard.press('Alt+2')
    await expect.poll(() => zoom(a.page)).toBeGreaterThan(2)
    expect(await inView(a.page, [FAR])).toBe(true)
  })

  await test.step('M shows and hides the minimap', async () => {
    const minimap = a.page.getByTestId('minimap.canvas')
    await expect(minimap).toBeVisible()
    await a.page.keyboard.press('m')
    await expect(minimap).toHaveCount(0)
    await a.page.keyboard.press('m')
    await expect(minimap).toBeVisible()
  })

  await test.step('Ctrl+Alt+/ opens the shortcuts dialog with the board keys of every feature', async () => {
    await a.page.keyboard.press('Control+Alt+/')
    const dialog = a.page.locator('.tlui-shortcuts-dialog__body')
    await expect(dialog).toBeVisible()
    const rows = await shortcutRows(a.page)
    const kbdOf = (label: string) => rows.find((r) => r.label === label)?.kbd ?? null
    expect(kbdOf('Comment')).toBe('C')
    expect(kbdOf('Show or hide comments')).not.toBeNull()
    expect(kbdOf('Present')).toBe('Ctrl+Alt+Enter')
    expect(rows.find((r) => r.label.startsWith('Export as PDF'))?.kbd).toBe('Ctrl+P')
    expect(kbdOf('Toggle locked')).toBe('Ctrl+⇧+L')
    expect(kbdOf('Bring to front')).toBe('PgUp')
    expect(kbdOf('Send backward')).toBe('⇧+PgDn')
    expect(kbdOf('Zoom to 100%')).toBe('Ctrl+0')
    expect(kbdOf('Zoom to selection')).toBe('Alt+2')
    expect(kbdOf('Search board')).toBe('Ctrl+F')
    expect(kbdOf('Show / hide minimap')).toBe('M')
    expect(kbdOf('Connector')).toBe('L')
    expect(kbdOf('Pen')).toBe('P')
    expect(kbdOf('Zoom to fit')).toBe('Alt+1')
    await a.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})

test('two-browser lock: bob sees alice’s Ctrl+Shift+L within 2 s and cannot drag or delete the note until it is unlocked (her key, Menu → Unlock all, or a canvas right-click → Unlock all)', async ({
  session,
  browser,
  board,
  users,
}) => {
  const N = 'shape:lock-note'
  const a = await session('alice')
  const b = await session('bob')
  await create(a.page, [note(N, 400, 260, 'Final cut')])
  await expect.poll(() => getShape(b.page, N).then((s) => s !== null)).toBe(true)
  const start = await getShape(a.page, N)

  await clickShape(a.page, N)
  expect(await selectedIds(a.page)).toEqual([N])
  await a.page.keyboard.press('Control+Shift+L')
  await expect.poll(() => isLocked(a.page, N)).toBe(true)
  await expect.poll(() => isLocked(b.page, N), { timeout: 2_000 }).toBe(true)

  await test.step('bob drags the locked note: it stays put, for him, alice and the server', async () => {
    const from = await screenOf(b.page, { x: 500, y: 360 })
    await drag(b.page, from, { x: from.x + 260, y: from.y + 140 })
    await editEd(b.page, (ed, id) => ed.select(id), N)
    await b.page.keyboard.press('Delete')
    const after = await getShape(b.page, N)
    expect({ x: after?.x, y: after?.y }).toEqual({ x: start?.x, y: start?.y })
    await users.grant(board, 'carol', 'editor')
    const probe = await openPath(browser, await users.get('carol'), `/b/${board}`)
    try {
      const fresh = await getShape(probe.page, N)
      expect({ x: fresh?.x, y: fresh?.y, isLocked: fresh?.isLocked }).toEqual({
        x: start?.x,
        y: start?.y,
        isLocked: true,
      })
    } finally {
      await probe.context.close()
    }
  })

  await test.step('alice unlocks (the selection was kept, so the same key works); bob can drag it now', async () => {
    expect(await selectedIds(a.page)).toEqual([N])
    await a.page.keyboard.press('Control+Shift+L')
    await expect.poll(() => isLocked(b.page, N), { timeout: 2_000 }).toBe(false)
    await clickCanvasAt(b.page, { x: 1100, y: 700 })
    const from = await screenOf(b.page, { x: 500, y: 360 })
    await drag(b.page, from, { x: from.x + 260, y: from.y + 140 })
    await expect
      .poll(() => getShape(a.page, N).then((s) => (s?.x ?? 0) - (start?.x ?? 0)))
      .toBeGreaterThan(200)
  })

  await test.step('locked and deselected, it can still be freed: bob’s Menu → Edit → Unlock all', async () => {
    // Still selected on alice's side (a click on a selected note would start editing it).
    expect(await selectedIds(a.page)).toEqual([N])
    await a.page.keyboard.press('Control+Shift+L')
    await expect.poll(() => isLocked(b.page, N), { timeout: 2_000 }).toBe(true)
    await clickCanvasAt(a.page, { x: 900, y: 150 })
    expect(await selectedIds(a.page)).toEqual([])
    // A click on a locked shape does not select it (so Ctrl+Shift+L has nothing to act on).
    await clickShape(b.page, N)
    expect(await selectedIds(b.page)).toEqual([])
    await b.page.getByTestId('main-menu.button').click()
    await b.page.getByTestId('main-menu-sub.edit-button').click()
    await b.page.getByTestId('main-menu.unlock-all').click()
    await expect.poll(() => isLocked(a.page, N), { timeout: 2_000 }).toBe(false)
  })

  await test.step('…and with a right-click on the canvas → Unlock all, shown only while something is locked', async () => {
    await editEd(a.page, (ed, id) => ed.select(id), N)
    await a.page.keyboard.press('Control+Shift+L')
    await expect.poll(() => isLocked(b.page, N), { timeout: 2_000 }).toBe(true)
    await clickCanvasAt(a.page, { x: 900, y: 150 })
    const empty = await screenOf(b.page, { x: 1000, y: 150 })
    await b.page.mouse.click(empty.x, empty.y, { button: 'right' })
    await expect(b.page.getByTestId('context-menu')).toBeVisible()
    await expect(b.page.getByTestId('context-menu.unlock-all')).toBeVisible()
    await b.page.getByTestId('context-menu.unlock-all').click()
    await expect.poll(() => isLocked(a.page, N), { timeout: 2_000 }).toBe(false)
    expect(await isLocked(b.page, N)).toBe(false)
    // Nothing locked: the canvas menu has no Unlock all.
    await b.page.mouse.click(empty.x, empty.y, { button: 'right' })
    await expect(b.page.getByTestId('context-menu')).toBeVisible()
    await expect(b.page.getByTestId('context-menu.unlock-all')).toHaveCount(0)
    await b.page.keyboard.press('Escape')
    await expect(b.page.getByTestId('context-menu')).toHaveCount(0)
  })
})

test('type-to-edit: typing on one selected note appends to it; T and C still pick tools; a viewer’s typing edits nothing', async ({
  session,
}) => {
  const N = 'shape:type-note'
  const G = 'shape:type-box'
  const a = await session('alice')
  const b = await session('bob')
  await create(a.page, [note(N, 300, 220, 'Say'), rect(G, 700, 260)])
  await waitForCanvasUx(a.page)

  await test.step('select the note and type fast: the note ends with the typed text (append), seen by bob', async () => {
    await clickShape(a.page, N)
    expect(await selectedIds(a.page)).toEqual([N])
    await a.page.keyboard.type('Hello') // no delay: the first key starts editing, the rest must not be lost
    await expect.poll(() => getShape(a.page, N).then((s) => plainText(s?.props.richText))).toBe('SayHello')
    expect(await readEd(a.page, (ed) => ed.getEditingShapeId())).toBe(N)
    await a.page.keyboard.press('Escape')
    await expect.poll(() => readEd(a.page, (ed) => ed.getEditingShapeId())).toBeNull()
    await expect.poll(() => getShape(b.page, N).then((s) => plainText(s?.props.richText))).toBe('SayHello')
  })

  await test.step('with a shape that is not a note selected, T picks the text tool', async () => {
    await clickShape(a.page, G)
    expect(await selectedIds(a.page)).toEqual([G])
    await a.page.keyboard.press('t')
    await expect.poll(() => currentTool(a.page)).toBe('text')
    expect(plainText((await getShape(a.page, G))?.props.richText)).toBe('')
    await a.page.keyboard.press('Escape')
    await expect.poll(() => currentTool(a.page)).toBe('select')
  })

  await test.step('with nothing selected, C picks the comment tool', async () => {
    await clickCanvasAt(a.page, { x: 1100, y: 700 })
    expect(await selectedIds(a.page)).toEqual([])
    await a.page.keyboard.press('c')
    await expect.poll(() => currentTool(a.page)).toBe('comment')
    await a.page.keyboard.press('Escape')
  })

  await test.step('a viewer selecting the note and typing does not edit it', async () => {
    const v = await session('carol', { role: 'viewer' })
    await expect(v.page.getByTestId('readonly-pill')).toBeVisible()
    await waitForCanvasUx(v.page)
    await clickShape(v.page, N)
    expect(await selectedIds(v.page)).toEqual([N])
    await v.page.keyboard.type('Oops')
    expect(await readEd(v.page, (ed) => ed.getEditingShapeId())).toBeNull()
    expect(plainText((await getShape(v.page, N))?.props.richText)).toBe('SayHello')
    expect(plainText((await getShape(a.page, N))?.props.richText)).toBe('SayHello')
  })
})

// ---- bulk paste (COL-05) ---------------------------------------------------------------------------

const GRID = [
  ['Hook', 'Beat', 'Payoff'],
  ['Setup', '', 'Twist'],
  ['Open', 'Middle', 'Close'],
]
const TSV = GRID.map((r) => r.join('\t')).join('\n')
const TABLE_HTML = `<table>${GRID.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`

test('bulk paste: a 3×3 spreadsheet selection asks notes-or-text, becomes 8 selected notes in the source layout, one undo, seen by bob', async ({
  session,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await grantClipboard(a.context)
  await waitForCanvasUx(a.page)
  await clickCanvasAt(a.page, { x: 900, y: 500 })
  await writeClipboard(a.page, { 'text/html': TABLE_HTML, 'text/plain': TSV })

  await a.page.keyboard.press('ControlOrMeta+v')
  const prompt = a.page.getByTestId('bulk-paste-prompt')
  await expect(prompt).toBeVisible()
  await expect(prompt).toContainText('Paste 8 items as sticky notes or as text?')
  await expect(a.page.getByTestId('bulk-paste-notes')).toBeFocused()
  await capture('canvas-ux-bulk-paste-prompt.png', a.page, test.info())
  await a.page.getByTestId('bulk-paste-notes').click()
  await expect(prompt).toHaveCount(0)

  const pasted = await notes(a.page)
  expect(pasted.map((n) => n.text).sort()).toEqual(GRID.flat().filter(Boolean).sort())
  expect(await selectedIds(a.page)).toEqual(pasted.map((n) => n.id).sort())
  // Source rows and columns: one x per column, one y per row, in order; the empty cell stays a gap.
  const xs = [...new Set(pasted.map((n) => n.x))].sort((p, q) => p - q)
  const ys = [...new Set(pasted.map((n) => n.y))].sort((p, q) => p - q)
  expect([xs.length, ys.length]).toEqual([3, 3])
  for (const [r, row] of GRID.entries()) {
    for (const [c, text] of row.entries()) {
      const n = pasted.find((p) => p.text === text)
      if (!text) {
        expect(pasted.some((p) => p.x === xs[c] && p.y === ys[r])).toBe(false)
        continue
      }
      expect({ text, col: xs.indexOf(n?.x ?? Number.NaN), row: ys.indexOf(n?.y ?? Number.NaN) }).toEqual({
        text,
        col: c,
        row: r,
      })
    }
  }
  await expect
    .poll(async () => (await notes(b.page)).map((n) => n.id).sort())
    .toEqual(pasted.map((n) => n.id).sort())
  expect(
    await inView(
      a.page,
      pasted.map((n) => n.id),
    ),
  ).toBe(true)

  await a.page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => shapeCount(a.page)).toBe(0)
  await expect.poll(() => shapeCount(b.page)).toBe(0)
})

test('bulk paste: "Text" makes one text shape; a single line and a URL paste as usual, with no prompt', async ({
  session,
}) => {
  const a = await session('alice')
  await grantClipboard(a.context)
  await waitForCanvasUx(a.page)
  await clickCanvasAt(a.page, { x: 900, y: 500 })
  const prompt = a.page.getByTestId('bulk-paste-prompt')

  await test.step('the same cells as text: exactly one text shape', async () => {
    await writeClipboard(a.page, { 'text/html': TABLE_HTML, 'text/plain': TSV })
    await a.page.keyboard.press('ControlOrMeta+v')
    await expect(prompt).toBeVisible()
    await a.page.getByTestId('bulk-paste-text').click()
    await expect.poll(() => shapeCount(a.page)).toBe(1)
    const [only] = await pageShapes(a.page)
    expect(only?.type).toBe('text')
    expect(plainText(only?.props.richText)).toContain('Payoff')
  })

  await test.step('a single line: a text shape straight away', async () => {
    await clickCanvasAt(a.page, { x: 1100, y: 700 })
    await writeClipboard(a.page, { 'text/plain': 'One idea, stated once' })
    await a.page.keyboard.press('ControlOrMeta+v')
    await expect.poll(() => shapeCount(a.page)).toBe(2)
    const texts = (await pageShapes(a.page)).map((s) => plainText(s.props.richText))
    expect(texts).toContain('One idea, stated once')
    await expect(prompt).toHaveCount(0)
  })

  await test.step('a URL: a bookmark, not a prompt', async () => {
    // Keep the bookmark unfurl on this machine (tldraw fetches the page for its title).
    await a.page.route('https://refs.example/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html><head><meta property="og:title" content="Reference board"></head></html>',
      }),
    )
    await clickCanvasAt(a.page, { x: 1100, y: 300 })
    await writeClipboard(a.page, { 'text/plain': 'https://refs.example/lookbook' })
    await a.page.keyboard.press('ControlOrMeta+v')
    await expect.poll(() => shapeCount(a.page, 'bookmark')).toBe(1)
    await expect(prompt).toHaveCount(0)
  })
})

test('bulk paste cap: 620 lines become the first 500 notes and a notice says 120 cells were left out', async ({
  session,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await grantClipboard(a.context)
  await waitForCanvasUx(a.page)
  await clickCanvasAt(a.page, { x: 900, y: 500 })
  const lines = Array.from({ length: 620 }, (_, i) => `Idea ${i + 1}`)
  await writeClipboard(a.page, { 'text/plain': lines.join('\n') })
  await a.page.keyboard.press('ControlOrMeta+v')
  await expect(a.page.getByTestId('bulk-paste-prompt')).toContainText('Only the first 500 become notes.')
  await expect(a.page.getByTestId('bulk-paste-notes')).toHaveText('500 sticky notes')
  await a.page.getByTestId('bulk-paste-notes').click()
  await expect(a.page.getByTestId('bulk-paste-notice')).toContainText('120 more cells were left out')
  await expect.poll(() => shapeCount(a.page, 'note')).toBe(500)
  expect((await selectedIds(a.page)).length).toBe(500)
  const texts = new Set((await notes(a.page)).map((n) => n.text))
  expect(texts.has('Idea 1') && texts.has('Idea 500') && !texts.has('Idea 501')).toBe(true)
  await expect.poll(() => shapeCount(b.page, 'note'), { timeout: 30_000 }).toBe(500)
})

// ---- note palette (COL-06) ---------------------------------------------------------------------------

test('note palette: two selected notes show 13 Draftroom colours, one pick recolours both (rendered fill too), one undo restores each', async ({
  session,
}) => {
  const [N1, N2] = ['shape:palette-1', 'shape:palette-2']
  const a = await session('alice')
  const b = await session('bob')
  await create(a.page, [note(N1, 300, 220, 'Warm', 'yellow'), note(N2, 560, 220, 'Cool', 'green')])
  await waitForCanvasUx(a.page)
  await clickShape(a.page, N1)
  await clickShape(a.page, N2, { shift: true })
  expect(await selectedIds(a.page)).toEqual([N1, N2])

  const palette = a.page.getByTestId('note-palette')
  await expect(palette).toBeVisible()
  await expect(palette.getByTestId('note-color')).toHaveCount(13)
  await palette.locator('[data-testid="note-color"][data-color="blue"]').click()
  await expect.poll(() => Promise.all([colorOf(a.page, N1), colorOf(a.page, N2)])).toEqual(['blue', 'blue'])
  await expect.poll(() => Promise.all([colorOf(b.page, N1), colorOf(b.page, N2)])).toEqual(['blue', 'blue'])
  // Draftroom's "Iris" (#a7b7f6), not tldraw's own blue note fill.
  for (const page of [a.page, b.page]) {
    await expect(page.locator(`[data-shape-id="${N1}"] .tl-note__container`)).toHaveCSS(
      'background-color',
      'rgb(167, 183, 246)',
    )
  }
  await expect(palette.locator('[data-color="blue"]')).toHaveAttribute('aria-pressed', 'true')

  await a.page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(() => Promise.all([colorOf(a.page, N1), colorOf(a.page, N2)]))
    .toEqual(['yellow', 'green'])
  await expect
    .poll(() => Promise.all([colorOf(b.page, N1), colorOf(b.page, N2)]))
    .toEqual(['yellow', 'green'])
})

// ---- templates (PRE-02/03) -------------------------------------------------------------------------

test('templates in a board: storyboard lands selected, in view, clear of existing content; one undo removes it; twice gives unique ids; bound arrows follow a dragged frame', async ({
  session,
}) => {
  test.setTimeout(180_000)
  const EXISTING = 'shape:tpl-existing'
  const a = await session('alice')
  const b = await session('bob')
  await waitForCanvasUx(a.page)
  const vp = await viewport(a.page)
  await create(a.page, [note(EXISTING, vp.x + vp.w / 2 - 100, vp.y + vp.h / 2 - 100, 'Already here')])
  const existing = await boundsOf(a.page, [EXISTING])

  const insertStoryboard = async () => {
    const before = new Set((await pageShapes(a.page)).map((s) => s.id))
    await a.page.getByTestId('tools.dr-templates').click()
    await expect(a.page.getByTestId('template-picker')).toBeVisible()
    await a.page.locator('[data-testid="template-option"][data-template-id="storyboard"]').click()
    await expect(a.page.getByTestId('template-picker')).toHaveCount(0)
    await expect
      .poll(async () => (await selectedIds(a.page)).filter((id) => !before.has(id)).length)
      .toBeGreaterThan(0)
    const all = await pageShapes(a.page)
    return all.filter((s) => !before.has(s.id))
  }

  let first: ShapeLike[] = []
  await test.step('insert: all top-level template shapes selected, inside the viewport, not over the note', async () => {
    first = await insertStoryboard()
    const top = first.filter((s) => s.parentId.startsWith('page:')).map((s) => s.id)
    expect(await selectedIds(a.page)).toEqual([...top].sort())
    expect(first.filter((s) => s.type === 'frame').length).toBeGreaterThanOrEqual(6)
    await expect.poll(() => inView(a.page, top)).toBe(true)
    const tb = await boundsOf(a.page, top)
    expect(tb && existing && overlaps(tb, existing)).toBe(false)
    await expect.poll(() => shapeCount(b.page)).toBe(first.length + 1)
  })

  await test.step('one Ctrl+Z removes the whole template (for bob too), the note stays', async () => {
    await a.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await pageShapes(a.page)).map((s) => s.id)).toEqual([EXISTING])
    await expect.poll(async () => (await pageShapes(b.page)).map((s) => s.id)).toEqual([EXISTING])
  })

  let third: ShapeLike[] = []
  await test.step('inserting twice gives unique ids and non-overlapping copies', async () => {
    const second = await insertStoryboard()
    third = await insertStoryboard()
    expect(third.length).toBe(second.length)
    const ids2 = new Set(second.map((s) => s.id))
    expect(third.filter((s) => ids2.has(s.id))).toEqual([])
    expect(new Set(first.map((s) => s.id)).has(second[0]?.id ?? '')).toBe(false)
    const top = (list: ShapeLike[]) => list.filter((s) => s.parentId.startsWith('page:')).map((s) => s.id)
    const [b2, b3] = [await boundsOf(a.page, top(second)), await boundsOf(a.page, top(third))]
    expect(b2 && b3 && overlaps(b2, b3)).toBe(false)
    await expect.poll(() => shapeCount(b.page)).toBe(1 + second.length + third.length)
  })

  await test.step('dragging the frame an arrow is bound to keeps the arrow attached and moves its end', async () => {
    const arrows = third.filter((s) => s.type === 'arrow')
    expect(arrows.length).toBeGreaterThan(0)
    const arrow = arrows[0] as ShapeLike
    const bindings = await arrowBindings(a.page, arrow.id)
    expect(bindings.length).toBe(2)
    const end = bindings.find((x) => x.props.terminal === 'end')
    const target = end?.toId as string
    expect((await getShape(a.page, target))?.type).toBe('frame')
    const arrowBefore = await boundsOf(a.page, [arrow.id])
    const targetBefore = await getShape(a.page, target)
    // Select the frame and look at it at 100%, then drag it from an empty spot inside its bottom-right
    // corner (clear of its children and of the resize handles).
    await editEd(
      a.page,
      (ed, id) => {
        ed.select(id)
        ed.zoomToSelection()
      },
      target,
    )
    await expect.poll(() => zoom(a.page)).toBe(1)
    const fb = await boundsOf(a.page, [target])
    if (!fb) throw new Error('target frame has no bounds')
    const from = await screenOf(a.page, { x: fb.x + fb.w - 30, y: fb.y + fb.h - 30 })
    await drag(a.page, from, { x: from.x, y: from.y + 240 })
    await expect
      .poll(() => getShape(a.page, target).then((s) => (s?.y ?? 0) - (targetBefore?.y ?? 0)))
      .toBeGreaterThan(100)
    const after = await arrowBindings(a.page, arrow.id)
    expect(after.map((x) => [x.props.terminal, x.toId]).sort()).toEqual(
      bindings.map((x) => [x.props.terminal, x.toId]).sort(),
    )
    const arrowAfter = await boundsOf(a.page, [arrow.id])
    expect(arrowAfter?.h).not.toBeCloseTo(arrowBefore?.h ?? 0, 0)
    await expect
      .poll(async () => (await arrowBindings(b.page, arrow.id)).map((x) => x.toId).sort())
      .toEqual(bindings.map((x) => x.toId).sort())
    await expect
      .poll(() => getShape(b.page, target).then((s) => s?.y))
      .toBe((await getShape(a.page, target))?.y)
  })
})

test('?template= on first open: an empty board gets the template once (not undoable, param removed); reloads and other people get no second copy; a viewer gets nothing', async ({
  session,
  browser,
  board,
  users,
}) => {
  const a = await session('alice')
  expect(await shapeCount(a.page)).toBe(0)

  await test.step('the dashboard hand-off: /b/<id>?template=retrospective inserts its 4 frames', async () => {
    await a.page.goto(`/b/${board}?template=retrospective`)
    await waitForCanvasUx(a.page)
    expect(await startView(a.page)).toBe('template:retrospective')
    expect(await shapeCount(a.page, 'frame')).toBe(4)
    expect(await a.page.evaluate(() => location.search)).toBe('')
    expect(await readEd(a.page, (ed) => ed.getCanUndo())).toBe(false)
    // It opens on the template (not an empty spot) and nothing is left selected.
    expect(await selectedIds(a.page)).toEqual([])
    const frames = (await pageShapes(a.page)).filter((s) => s.type === 'frame').map((s) => s.id)
    const [vp, fb] = [await viewport(a.page), await boundsOf(a.page, frames)]
    expect(fb && overlaps(vp, fb)).toBe(true)
    // "Saved": the server has it (alice is alone, so her client sends once a second).
    await waitForSaved(a.page)
  })
  const total = await shapeCount(a.page)

  await test.step('reload, and opening the same link again, insert nothing more', async () => {
    await a.page.reload()
    await waitForCanvasUx(a.page)
    expect(await startView(a.page)).toBe('restore')
    expect(await shapeCount(a.page)).toBe(total)
    await a.page.goto(`/b/${board}?template=retrospective`)
    await waitForCanvasUx(a.page)
    expect(await startView(a.page)).toBe('restore')
    expect(await a.page.evaluate(() => location.search)).toBe('')
    expect(await shapeCount(a.page)).toBe(total)
  })

  await test.step('bob (editor) following a ?template= link to the now non-empty board adds nothing', async () => {
    await users.grant(board, 'bob', 'editor')
    const bob = await openPath(browser, await users.get('bob'), `/b/${board}?template=brainstorm`)
    try {
      expect(await startView(bob.page)).toBe('fit')
      expect(await bob.page.evaluate(() => location.search)).toBe('')
      expect(await shapeCount(bob.page)).toBe(total)
      await expect.poll(() => shapeCount(a.page)).toBe(total)
    } finally {
      await bob.context.close()
    }
  })

  await test.step('a viewer opening ?template= on an EMPTY board gets nothing', async () => {
    const empty = await users.createBoard('Empty board for a viewer')
    await users.grant(empty, 'carol', 'viewer')
    const carol = await openPath(browser, await users.get('carol'), `/b/${empty}?template=retrospective`)
    try {
      await expect(carol.page.getByTestId('readonly-pill')).toBeVisible()
      expect(await startView(carol.page)).toBe('none')
      expect(await carol.page.evaluate(() => location.search)).toBe('')
      expect(await shapeCount(carol.page)).toBe(0)
    } finally {
      await carol.context.close()
    }
    const owner = await openPath(browser, await users.get('alice'), `/b/${empty}`)
    try {
      expect(await shapeCount(owner.page)).toBe(0)
    } finally {
      await owner.context.close()
    }
  })
})

// ---- frame outline (MAK-13) --------------------------------------------------------------------------

test('frame outline: rows in presentation order, click goes to the frame, drag reorders (bob sees it within 2 s), undo, auto-order, skip, present follows; a viewer cannot reorder', async ({
  session,
}) => {
  const [F1, F2, F3] = ['shape:outline-intro', 'shape:outline-conflict', 'shape:outline-resolution']
  const a = await session('alice')
  const b = await session('bob')
  await create(a.page, [
    frame(F1, 0, 0, 'Intro'),
    frame(F2, 700, 0, 'Conflict'),
    frame(F3, 1400, 0, 'Resolution'),
  ])
  await waitForCanvasUx(a.page)
  for (const s of [a, b]) {
    await s.page.getByTestId('dock-tab-frames').click()
    await expect(s.page.getByTestId('frame-outline')).toBeVisible()
    await expect.poll(() => frameRowIds(s.page)).toEqual([F1, F2, F3])
  }
  const indexes = (page: Page) =>
    Promise.all([F1, F2, F3].map((id) => getShape(page, id).then((s) => s?.meta.presentationIndex ?? null)))

  await test.step('clicking a row selects its frame and brings it into view', async () => {
    await editEd(a.page, (ed) => ed.setCamera({ x: 30_000, y: 30_000, z: 1 }, { immediate: true }))
    expect(await inView(a.page, [F3])).toBe(false)
    await frameRow(a.page, F3).locator('.dr-cux-frame__name').click()
    expect(await selectedIds(a.page)).toEqual([F3])
    await expect.poll(() => inView(a.page, [F3])).toBe(true)
  })

  await test.step('dragging the last row onto the first: explicit indexes on every frame; bob’s panel follows within 2 s', async () => {
    await frameRow(a.page, F3)
      .locator('.dr-cux-frame__handle')
      .dragTo(frameRow(a.page, F1), { targetPosition: { x: 40, y: 3 } })
    await expect.poll(() => frameRowIds(a.page)).toEqual([F3, F1, F2])
    expect(await indexes(a.page)).toEqual([1, 2, 0])
    await expect.poll(() => frameRowIds(b.page), { timeout: 2_000 }).toEqual([F3, F1, F2])
    expect(await indexes(b.page)).toEqual([1, 2, 0])
    await expect(a.page.getByTestId('frames-order-mode')).toHaveText('Custom order')
  })

  await test.step('Ctrl+Z restores the layout order (for bob too)', async () => {
    await a.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => frameRowIds(a.page)).toEqual([F1, F2, F3])
    await expect.poll(() => frameRowIds(b.page)).toEqual([F1, F2, F3])
    expect((await indexes(a.page)).every((i) => typeof i !== 'number')).toBe(true)
  })

  await test.step('Auto-order returns a custom order to the layout order, and one undo brings the custom order back', async () => {
    await a.page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(() => frameRowIds(a.page)).toEqual([F3, F1, F2])
    await a.page.getByTestId('frames-auto-order').click()
    await expect.poll(() => frameRowIds(a.page)).toEqual([F1, F2, F3])
    await expect.poll(() => frameRowIds(b.page)).toEqual([F1, F2, F3])
    expect(await indexes(a.page)).toEqual([null, null, null])
    await a.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => frameRowIds(a.page)).toEqual([F3, F1, F2])
    await expect.poll(() => frameRowIds(b.page)).toEqual([F3, F1, F2])
  })

  await test.step('Skip marks the frame, and the presentation leaves it out (in the custom order)', async () => {
    await frameRow(a.page, F2).getByTestId('frame-skip').click()
    await expect.poll(() => getShape(a.page, F2).then((s) => s?.meta.presentationSkip)).toBe(true)
    await expect.poll(() => getShape(b.page, F2).then((s) => s?.meta.presentationSkip)).toBe(true)
    await expect(frameRow(b.page, F2)).toHaveAttribute('data-skipped', 'true')
    await a.page.getByTestId('present-button').click()
    await expect(a.page.getByTestId('present-counter')).toHaveText('1 / 2')
    await a.page.getByTestId('present-grid-toggle').click()
    await expect
      .poll(() =>
        a.page
          .locator('[data-slide-option]')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-slide-option'))),
      )
      .toEqual([F3, F1])
    await a.page.getByTestId('present-exit').click()
    await expect(a.page.getByTestId('present-counter')).toHaveCount(0)
  })

  await test.step('a viewer sees the order but has no reorder, auto-order or skip controls', async () => {
    const v = await session('carol', { role: 'viewer' })
    await v.page.getByTestId('dock-tab-frames').click()
    await expect.poll(() => frameRowIds(v.page)).toEqual([F3, F1, F2])
    await expect(v.page.getByTestId('frames-auto-order')).toHaveCount(0)
    await expect(v.page.getByTestId('frame-skip')).toHaveCount(0)
    await expect(v.page.locator('.dr-cux-frame__handle')).toHaveCount(0)
    await expect(frameRows(v.page).first()).toHaveAttribute('draggable', 'false')
    await expect(v.page.getByTestId('frame-copy-link')).toHaveCount(3)
  })
})

// ---- board search (MAK-12) ---------------------------------------------------------------------------

test('board search: Ctrl+F (even while editing a note) opens it focused; results and highlights agree; Enter/Enter walk the matches; filters narrow; Esc closes', async ({
  session,
}) => {
  const [WHALE, FOX, SKY, PERIOD] = [
    'shape:find-whale',
    'shape:find-fox',
    'shape:find-sky',
    'shape:find-period',
  ]
  const a = await session('alice')
  await create(a.page, [
    note(WHALE, 200, 200, 'Blue whale sketch'),
    note(FOX, 500, 200, 'Red fox'),
    note(SKY, 4200, 2600, 'Blue sky backdrop'),
    frame(PERIOD, 200, 700, 'Blue period'),
  ])
  await waitForCanvasUx(a.page)

  await test.step('Ctrl+F while a note is being edited opens the panel with the input focused', async () => {
    await clickShape(a.page, FOX)
    await a.page.keyboard.press('Enter')
    await waitForTextEditor(a.page, FOX)
    await a.page.keyboard.press('Control+f')
    await expect(a.page.getByTestId('dock-panel-search')).toBeVisible()
    await expect(a.page.getByTestId('search-input')).toBeFocused()
    expect(plainText((await getShape(a.page, FOX))?.props.richText)).toBe('Red fox')
  })

  const results = () =>
    a.page
      .getByTestId('search-result')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-shape-id') ?? ''))
  let order: string[] = []
  await test.step('"blue" lists the three matches, highlighted and the rest dimmed', async () => {
    await a.page.keyboard.type('blue')
    await expect.poll(async () => (await results()).sort()).toEqual([PERIOD, SKY, WHALE].sort())
    await expect(a.page.getByTestId('search-highlights')).toHaveAttribute('data-match-count', '3')
    await expect(a.page.locator('.dr-cux-search-dim__veil')).toBeAttached()
    await capture('canvas-ux-board-search.png', a.page, test.info())
    order = await results()
  })

  await test.step('Enter selects and zooms to the first match; each Enter goes to the next', async () => {
    expect(await inView(a.page, [SKY])).toBe(false) // far away: reaching it takes a camera move
    for (const [i, id] of order.entries()) {
      await a.page.getByTestId('search-input').press('Enter')
      await expect.poll(() => selectedIds(a.page)).toEqual([id])
      await expect.poll(() => inView(a.page, [id])).toBe(true)
      await expect(a.page.getByTestId('search-status')).toContainText(`${i + 1} of 3`)
    }
  })

  await test.step('the Frames filter narrows the list (and the highlights) to the frame', async () => {
    await a.page.locator('[data-testid="search-filter"][data-filter="frames"]').click()
    await expect.poll(results).toEqual([PERIOD])
    await expect(a.page.getByTestId('search-highlights')).toHaveAttribute('data-match-count', '1')
  })

  await test.step('Escape closes the panel and removes the highlights', async () => {
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('dock-panel-search')).toHaveCount(0)
    await expect(a.page.getByTestId('search-highlights')).toHaveCount(0)
  })
})

// ---- copy link (PRS-04 part) -------------------------------------------------------------------------

test('copy link: the selection bar and a frame row copy /b/<id>?d=…; bob opens them zoomed to that shape with ?d removed; a user without access gets no-access', async ({
  session,
  browser,
  board,
  users,
}) => {
  const N = 'shape:link-note'
  const F = 'shape:link-frame'
  const a = await session('alice')
  await grantClipboard(a.context)
  await create(a.page, [
    note('shape:link-origin', 0, 0, 'Start here'),
    note(N, 5200, 3400, 'Deep in the board'),
    frame(F, -4200, 2600, 'Act two'),
  ])
  await waitForCanvasUx(a.page)
  await waitForSaved(a.page) // alice is alone: her shapes reach the server within a second
  await users.grant(board, 'bob', 'editor')
  const bob = await users.get('bob')

  const opened: { close(): Promise<void> }[] = []
  try {
    let link = ''
    await test.step('Copy link on the selection bar', async () => {
      await editEd(
        a.page,
        (ed, id) => {
          ed.select(id)
          ed.zoomToSelection()
        },
        N,
      )
      await a.page.getByTestId('copy-link-selection').click()
      await expect(a.page.getByTestId('copy-link-notice')).toHaveText('Link to this object copied.')
      link = await readClipboardText(a.page)
      const url = new URL(link)
      expect(url.origin + url.pathname).toBe(`${WEB_URL}/b/${board}`)
      expect(url.searchParams.get('d')).toMatch(/^s/)
      expect(url.searchParams.get('d')).toContain(N.replace('shape:', ''))
    })

    await test.step('bob opens it: the note is selected and in view, and the address bar lost ?d', async () => {
      const b = await openPath(browser, bob, link)
      opened.push(b.context)
      expect(await startView(b.page)).toBe('deep-link')
      expect(await selectedIds(b.page)).toEqual([N])
      expect(await inView(b.page, [N])).toBe(true)
      expect(await inView(b.page, ['shape:link-origin'])).toBe(false)
      expect(await b.page.evaluate(() => location.search)).toBe('')

      await test.step('frame-copy-link in the outline does the same for a frame', async () => {
        await a.page.getByTestId('dock-tab-frames').click()
        await frameRow(a.page, F).getByTestId('frame-copy-link').click()
        await expect(a.page.getByTestId('copy-link-notice')).toHaveText('Link to this frame copied.')
        const frameLink = await readClipboardText(a.page)
        expect(new URL(frameLink).searchParams.get('d')).toContain(F.replace('shape:', ''))
        await b.page.goto(frameLink)
        await waitForCanvasUx(b.page)
        expect(await startView(b.page)).toBe('deep-link')
        await expect.poll(() => selectedIds(b.page)).toEqual([F])
        expect(await inView(b.page, [F])).toBe(true)
        expect(await b.page.evaluate(() => location.search)).toBe('')
      })
    })

    await test.step('dave (signed in, no access) opening the link gets no-access', async () => {
      const d = await openPath(browser, await users.get('dave'), link, { board: false })
      opened.push(d.context)
      await expect(d.page.getByTestId('no-access')).toBeVisible()
    })
  } finally {
    await Promise.all(opened.map((c) => c.close()))
  }
})

// ---- start view (PRE-06) -----------------------------------------------------------------------------

test('start view: a reload returns to the last camera (±1 px); a camera far from content falls back to fit; a first visit fits the content at ≤ 100%', async ({
  session,
  board,
  browser,
  users,
}) => {
  const a = await session('alice')
  await create(a.page, [
    note('shape:sv-1', 0, 0, 'North west'),
    note('shape:sv-2', 2600, 0, 'North east'),
    note('shape:sv-3', 0, 1900, 'South west'),
    note('shape:sv-4', 2600, 1900, 'South east'),
  ])
  await waitForCanvasUx(a.page)
  await waitForSaved(a.page) // alice is alone: reloads below must find the notes on the server
  const all = ['shape:sv-1', 'shape:sv-2', 'shape:sv-3', 'shape:sv-4']
  const near = (c: { x: number; y: number; z: number }, want: { x: number; y: number; z: number }) =>
    Math.abs(c.x - want.x) <= 1 && Math.abs(c.y - want.y) <= 1 && Math.abs(c.z - want.z) < 0.001

  await test.step('alice’s camera comes back after a reload (±1 px)', async () => {
    const cam = { x: -133.4, y: -46.7, z: 0.8 }
    await editEd(a.page, (ed, c) => ed.setCamera(c, { immediate: true }), cam)
    await expect.poll(() => storedCamera(a.page, board, a.id)).toMatchObject(cam)
    await a.page.reload()
    await waitForCanvasUx(a.page)
    expect(await startView(a.page)).toBe('restore')
    expect(near(await camera(a.page), cam)).toBe(true)
    expect(await inView(a.page, all)).toBe(false) // her own zoomed-in view, not a fit
  })

  await test.step('a saved camera that shows nothing falls back to fitting all content', async () => {
    await editEd(a.page, (ed) => ed.setCamera({ x: -60_000, y: -60_000, z: 1 }, { immediate: true }))
    await expect.poll(() => storedCamera(a.page, board, a.id).then((c) => c?.x)).toBe(-60_000)
    await a.page.reload()
    await waitForCanvasUx(a.page)
    expect(await startView(a.page)).toBe('restore+fit')
    expect(await inView(a.page, all)).toBe(true)
    expect(await zoom(a.page)).toBeLessThanOrEqual(1)
  })

  await test.step('bob’s first visit fits the content, at no more than 100%', async () => {
    await users.grant(board, 'bob', 'editor')
    const b = await openPath(browser, await users.get('bob'), `/b/${board}`)
    try {
      expect(await startView(b.page)).toBe('fit')
      expect(await inView(b.page, all)).toBe(true)
      expect(await zoom(b.page)).toBeLessThanOrEqual(1)
      // Fitted, not merely zoomed far out: the content spans most of the viewport.
      const [vp, content] = [await viewport(b.page), await boundsOf(b.page, all)]
      expect(content && content.w / vp.w).toBeGreaterThan(0.6)
      // Cameras are per user: alice's saved views never reach bob's browser.
      expect(await storedCamera(b.page, board, a.id)).toBeNull()
    } finally {
      await b.context.close()
    }
  })

  await test.step('one small note far from the origin: a first visit shows it at exactly 100% (fit never zooms in)', async () => {
    const small = await users.createBoard('One small note')
    await a.page.goto(`/b/${small}`)
    await waitForCanvasUx(a.page)
    await create(a.page, [note('shape:sv-lonely', 8000, 6000, 'Just me')])
    await waitForSaved(a.page)
    const first = await openPath(browser, await users.get('alice'), `/b/${small}`) // a new browser profile
    try {
      expect(await startView(first.page)).toBe('fit')
      expect(await inView(first.page, ['shape:sv-lonely'])).toBe(true)
      expect(await zoom(first.page)).toBe(1)
    } finally {
      await first.context.close()
    }
  })
})

// ---- alignment guides + selection bar (MAK-02/03) ----------------------------------------------------

test('alignment: snapping is on for a fresh profile and a drag snaps to an edge (Ctrl held: no snap); an explicit off survives reload; the selection bar aligns and distributes (one undo)', async ({
  session,
}) => {
  const [R1, R2, R3] = ['shape:align-1', 'shape:align-2', 'shape:align-3']
  const a = await session('alice')
  await create(a.page, [rect(R1, 200, 200), rect(R2, 600, 420), rect(R3, 900, 620)])
  await waitForCanvasUx(a.page)
  expect(await readEd(a.page, (ed) => ed.user.getIsSnapMode())).toBe(true)

  /** Select R2, then drag it from inside its selection so its left edge lands at page x. */
  const dragR2LeftEdgeTo = async (x: number, withCtrl: boolean) => {
    // Selected (a click right before the press would be a double-click: label editing).
    await editEd(a.page, (ed, id) => ed.select(id), R2)
    const s = await getShape(a.page, R2)
    const from = await screenOf(a.page, { x: (s?.x ?? 0) + 100, y: (s?.y ?? 0) + 60 })
    const z = await zoom(a.page)
    const to = { x: from.x + (x - (s?.x ?? 0)) * z, y: from.y }
    await a.page.mouse.move(from.x, from.y)
    await a.page.mouse.down()
    await a.page.mouse.move((from.x + to.x) / 2, from.y, { steps: 8 })
    expect(await readEd(a.page, (ed) => ed.getPath())).toBe('select.translating')
    // Ctrl/Cmd pressed during the drag inverts snapping for the rest of it.
    if (withCtrl) await a.page.keyboard.down('Control')
    await a.page.mouse.move(to.x + 1, to.y, { steps: 8 })
    // tldraw only snaps a slow pointer (velocity < 0.5 px/ms), as when someone lines a box up by eye:
    // let the pointer come to rest, then make the last 1 px move.
    await expect.poll(() => readEd(a.page, (ed) => ed.inputs.getPointerVelocity().len())).toBeLessThan(0.1)
    await a.page.mouse.move(to.x, to.y)
    // Still mid-drag (tldraw applies pointer moves on its next tick): the box at its final spot, and
    // the guides it draws there.
    const sample = () =>
      readEd(
        a.page,
        (ed, id) => ({ x: Math.round(ed.getShape(id)?.x ?? 0), guides: ed.snaps.getIndicators().length }),
        R2,
      )
    let last = await sample()
    await expect
      .poll(async () => {
        last = await sample()
        return last.x
      })
      .toBeLessThanOrEqual(x)
    await a.page.mouse.up()
    if (withCtrl) await a.page.keyboard.up('Control')
    return last
  }

  await test.step('dragging a box to 3 px off another’s left edge snaps it onto the edge, with a guide shown', async () => {
    const mid = await dragR2LeftEdgeTo(203, false)
    expect(mid.x).toBe(200)
    expect(mid.guides).toBeGreaterThan(0)
    await expect.poll(() => getShape(a.page, R2).then((s) => s?.x)).toBe(200)
  })

  await test.step('holding Ctrl while dragging turns the guides off for that drag', async () => {
    await a.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => getShape(a.page, R2).then((s) => s?.x)).toBe(600)
    const mid = await dragR2LeftEdgeTo(203, true)
    expect(mid).toEqual({ x: 203, guides: 0 })
    await expect.poll(() => getShape(a.page, R2).then((s) => Math.round(s?.x ?? 0))).toBe(203)
  })

  await test.step('turning "Always snap" off in Preferences survives a reload', async () => {
    await a.page.getByTestId('main-menu.button').click()
    await a.page.getByTestId('main-menu-sub.preferences-button').click()
    const item = a.page.getByRole('menuitemcheckbox', { name: /snap/i })
    await expect(item).toHaveAttribute('aria-checked', 'true')
    await item.click()
    await expect.poll(() => readEd(a.page, (ed) => ed.user.getIsSnapMode())).toBe(false)
    await a.page.keyboard.press('Escape')
    await waitForSaved(a.page)
    await a.page.reload()
    await waitForCanvasUx(a.page)
    expect(await readEd(a.page, (ed) => ed.user.getIsSnapMode())).toBe(false)
  })

  await test.step('selection bar: two shapes offer align without distribute; three add distribute; align left is one undo', async () => {
    const bar = a.page.getByTestId('selection-bar')
    const aligns = [
      'align-left',
      'align-center-horizontal',
      'align-right',
      'align-top',
      'align-center-vertical',
      'align-bottom',
    ]
    await clickShape(a.page, R1)
    await clickShape(a.page, R2, { shift: true })
    expect(await selectedIds(a.page)).toEqual([R1, R2])
    for (const id of aligns) await expect(bar.getByTestId(id)).toBeVisible()
    await expect(bar.getByTestId('distribute-horizontal')).toHaveCount(0)
    await expect(bar.getByTestId('distribute-vertical')).toHaveCount(0)
    await clickShape(a.page, R3, { shift: true })
    await expect(bar.getByTestId('distribute-horizontal')).toBeVisible()
    await expect(bar.getByTestId('distribute-vertical')).toBeVisible()
    const xs = () =>
      Promise.all([R1, R2, R3].map((id) => getShape(a.page, id).then((s) => Math.round(s?.x ?? 0))))
    const before = await xs()
    await bar.getByTestId('align-left').click()
    await expect.poll(xs).toEqual([200, 200, 200])
    await a.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(xs).toEqual(before)
  })
})

// ---- heavy board (PRF-02) ----------------------------------------------------------------------------

test('heavy board: 500 pasted notes land on a board that already holds 4,500 shapes (5,000 in total, on the server too)', async ({
  session,
  browser,
  board,
  users,
}) => {
  test.setTimeout(300_000)
  const a = await session('alice')
  await grantClipboard(a.context)
  await waitForCanvasUx(a.page)
  // 4,500 small boxes to the right of the viewport, in 9 pushes.
  for (let batch = 0; batch < 9; batch++) {
    await editEd(
      a.page,
      (ed, b) => {
        const shapes = []
        for (let i = 0; i < 500; i++) {
          const n = b * 500 + i
          shapes.push({
            id: `shape:heavy-${n}`,
            type: 'geo',
            x: 3000 + (n % 75) * 60,
            y: Math.floor(n / 75) * 60,
            props: { geo: 'rectangle', w: 40, h: 40 },
          })
        }
        ed.createShapes(shapes)
      },
      batch,
    )
  }
  await expect.poll(() => shapeCount(a.page)).toBe(4_500)
  await clickCanvasAt(a.page, { x: 700, y: 450 })
  await writeClipboard(a.page, {
    'text/plain': Array.from({ length: 500 }, (_, i) => `Heavy ${i + 1}`).join('\n'),
  })
  await a.page.keyboard.press('ControlOrMeta+v')
  await a.page.getByTestId('bulk-paste-notes').click()
  await expect.poll(() => shapeCount(a.page, 'note')).toBe(500)
  expect(await shapeCount(a.page)).toBe(5_000)
  await expect(a.page.getByTestId('bulk-paste-notice')).toHaveCount(0)

  await users.grant(board, 'bob', 'editor')
  const b = await openPath(browser, await users.get('bob'), `/b/${board}`)
  try {
    await expect.poll(() => shapeCount(b.page), { timeout: 60_000 }).toBe(5_000)
    expect(await shapeCount(b.page, 'note')).toBe(500)
  } finally {
    await b.context.close()
  }
})
