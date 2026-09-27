// canvas-ux fixes from the persona reviews (batch "canvas-ux"): each test drives the real UI the way the
// reviewer did and checks the outcome that was wrong. IDs: RETRO-* (facilitation retro persona), F*
// (moodboard persona), PRI-* (reviewer on a phone), PERF-* (performance persona).
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { signInContext } from './support/api.ts'
import {
  getShape,
  insertFiles,
  pageShapes,
  waitForBoard,
  waitForTextEditor,
  waitForValue,
} from './support/board.ts'
import {
  boundsOf,
  camera,
  clickCanvasAt,
  clickShape,
  currentTool,
  drag,
  editEd,
  grantClipboard,
  overlaps,
  readEd,
  screenOf,
  selectedIds,
  shortcutRows,
  waitForCanvasUx,
  writeClipboard,
  zoom,
} from './support/canvas-ux.ts'
import { plainText, richText } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'
import { FIXTURES_DIR } from './support/stack.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const editingId = (page: Page) => readEd(page, (ed) => ed.getEditingShapeId())
const notesOnPage = async (page: Page) =>
  (await pageShapes(page))
    .filter((s) => s.type === 'note')
    .map((s) => ({ id: s.id, text: plainText(s.props.richText), parentId: s.parentId, font: s.props.font }))
const note = (id: string, x: number, y: number, text = '') => ({
  id,
  type: 'note',
  x,
  y,
  props: { richText: richText(text) },
})

// ---- RETRO-02 / RETRO-21a ----------------------------------------------------------------------------

test('RETRO-02: N, click, type "A", Esc, N, click, type "B" gives two notes "A" and "B"; new notes are sans (RETRO-21a); a re-selected note still takes type-to-edit', async ({
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await clickCanvasAt(a.page, { x: 1000, y: 700 })

  const addNote = async (x: number, y: number, text: string) => {
    await a.page.keyboard.press('n')
    await expect.poll(() => currentTool(a.page)).toBe('note')
    await clickCanvasAt(a.page, { x, y })
    await waitForTextEditor(a.page)
    await a.page.keyboard.type(text)
    await a.page.keyboard.press('Escape')
    await expect.poll(() => editingId(a.page)).toBeNull()
  }
  await addNote(300, 300, 'A')
  // The finished note is still selected: N must pick the note tool, not type "n" into it.
  expect((await selectedIds(a.page)).length).toBe(1)
  await addNote(700, 300, 'B')
  const list = await notesOnPage(a.page)
  expect(list.map((n) => n.text).sort()).toEqual(['A', 'B'])
  for (const n of list) expect(n.font).toBe('sans')

  await test.step('Enter re-edits the note just left (COL-02)', async () => {
    const b = list.find((n) => n.text === 'B')?.id as string
    expect(await selectedIds(a.page)).toEqual([b])
    await a.page.keyboard.press('Enter')
    await expect.poll(() => editingId(a.page)).toBe(b)
    await a.page.keyboard.press('Escape')
    await expect.poll(() => editingId(a.page)).toBeNull()
  })

  await test.step('once another note is clicked (selected again), typing appends to it (COL-04)', async () => {
    const aId = list.find((n) => n.text === 'A')?.id as string
    await clickShape(a.page, aId)
    expect(await selectedIds(a.page)).toEqual([aId])
    await a.page.keyboard.type('x')
    await expect.poll(() => getShape(a.page, aId).then((s) => plainText(s?.props.richText))).toBe('Ax')
    await a.page.keyboard.press('Escape')
  })
})

// ---- F3 ----------------------------------------------------------------------------------------------

test('F3: after clicking zoom in, or closing the Export dialog with the mouse, Space+drag over a selected image pans and never moves the image', async ({
  session,
}) => {
  const IMG = 'shape:f3-image'
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await editEd(
    a.page,
    (ed, id) =>
      ed.createShapes([{ id, type: 'image', x: 300, y: 220, props: { w: 400, h: 300, assetId: null } }]),
    IMG,
  )
  await clickCanvasAt(a.page, { x: 1100, y: 700 })
  // The zoom buttons sit next to the minimap (closed by default, PERF-03).
  await a.page.keyboard.press('m')
  await expect(a.page.getByTestId('minimap.zoom-in')).toBeVisible()

  const spaceDrag = async () => {
    await editEd(a.page, (ed, id) => ed.select(id), IMG)
    const before = { cam: await camera(a.page), shape: await getShape(a.page, IMG), z: await zoom(a.page) }
    const from = await screenOf(a.page, { x: 500, y: 370 })
    await a.page.keyboard.down('Space')
    await drag(a.page, from, { x: from.x + 220, y: from.y + 140 })
    await a.page.keyboard.up('Space')
    const after = { cam: await camera(a.page), shape: await getShape(a.page, IMG), z: await zoom(a.page) }
    expect({ x: after.shape?.x, y: after.shape?.y }).toEqual({ x: before.shape?.x, y: before.shape?.y })
    expect(Math.hypot(after.cam.x - before.cam.x, after.cam.y - before.cam.y)).toBeGreaterThan(50)
    // Space did not press the button either (zoom in would have changed the zoom).
    expect(after.z).toBe(before.z)
    // Panning ended with the key: nothing is stuck.
    expect(await readEd(a.page, (ed) => ed.inputs.getIsPanning())).toBe(false)
  }

  await test.step('zoom in (a button inside the editor) was clicked last', async () => {
    await a.page.getByTestId('minimap.zoom-in').click()
    await expect(a.page.getByTestId('minimap.zoom-in')).toBeFocused()
    // Let the zoom animation finish, so a zoom change after this can only come from the key.
    await expect.poll(() => readEd(a.page, (ed) => ed.getCameraState())).toBe('idle')
    await spaceDrag()
  })

  await test.step('the Export dialog was closed with the mouse (focus back on the top bar button)', async () => {
    await a.page.getByTestId('export-button').click()
    const dialog = a.page.getByTestId('export-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(a.page.getByTestId('export-button')).toBeFocused()
    await spaceDrag()
  })

  await test.step('a keyboard user on a focused button keeps Enter (the dialog opens)', async () => {
    await a.page.getByTestId('export-button').focus()
    await a.page.keyboard.press('Enter')
    await expect(a.page.getByTestId('export-dialog')).toBeVisible()
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('export-dialog')).toHaveCount(0)
  })
})

// ---- RETRO-01 ----------------------------------------------------------------------------------------

test('RETRO-01: a 5×1 spreadsheet column pasted over the empty lower half of "What to improve" becomes 5 notes inside that frame, clear of its notes', async ({
  session,
  board,
}) => {
  const a = await session('alice')
  await grantClipboard(a.context)
  await a.page.goto(`/b/${board}?template=retrospective`)
  await waitForBoard(a.page)
  await waitForCanvasUx(a.page)
  const frame = (await pageShapes(a.page)).find(
    (s) => s.type === 'frame' && s.props.name === '3 · What to improve',
  )
  if (!frame) throw new Error('no "What to improve" frame')
  const fb = await boundsOf(a.page, [frame.id])
  if (!fb) throw new Error('frame has no bounds')
  const before = (await notesOnPage(a.page)).filter((n) => n.parentId === frame.id)
  expect(before.length).toBe(3)
  const existing = await Promise.all(before.map((n) => boundsOf(a.page, [n.id])))
  await editEd(a.page, (ed, b) => ed.zoomToBounds(b, { inset: 80, immediate: true }), fb)

  const cells = [
    'Scope creep',
    'Handoffs were late',
    'Too many meetings',
    'Feedback came late',
    'Unclear owner',
  ]
  await writeClipboard(a.page, { 'text/plain': cells.join('\n') })
  const target = await screenOf(a.page, { x: fb.x + fb.w / 2, y: fb.y + fb.h * 0.72 })
  await a.page.mouse.move(target.x, target.y)
  await a.page.keyboard.press('ControlOrMeta+v')
  const prompt = a.page.getByTestId('bulk-paste-prompt')
  await expect(prompt).toBeVisible()
  // The prompt shows at the pointer.
  const pb = await prompt.boundingBox()
  expect(pb && Math.hypot(pb.x + pb.width / 2 - target.x, pb.y + pb.height / 2 - target.y)).toBeLessThan(80)
  await a.page.getByTestId('bulk-paste-notes').click()
  await expect(prompt).toHaveCount(0)

  const pasted = (await notesOnPage(a.page)).filter((n) => cells.includes(n.text))
  expect(pasted.map((n) => n.text).sort()).toEqual([...cells].sort())
  for (const n of pasted) {
    expect(n.parentId).toBe(frame.id)
    const nb = await boundsOf(a.page, [n.id])
    if (!nb) throw new Error('note has no bounds')
    expect(nb.x >= fb.x && nb.y >= fb.y && nb.x + nb.w <= fb.x + fb.w && nb.y + nb.h <= fb.y + fb.h).toBe(
      true,
    )
    for (const e of existing) expect(e && overlaps(nb, e)).toBe(false)
  }
  // A compact grid (3 + 2), not one tall column.
  const xs = new Set(
    await Promise.all(pasted.map(async (n) => Math.round((await getShape(a.page, n.id))?.x ?? 0))),
  )
  expect(xs.size).toBe(3)
})

// ---- RETRO-09 ----------------------------------------------------------------------------------------

test('RETRO-09: typing straight after Tab goes into the new note, in order (5 runs)', async ({ session }) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await clickCanvasAt(a.page, { x: 900, y: 600 }) // the board has the keyboard
  for (let run = 0; run < 5; run++) {
    // Each run on its own row, in view.
    await editEd(a.page, (ed, y) => ed.setCamera({ x: 0, y: -y, z: 1 }, { immediate: true }), run * 260)
    await a.page.keyboard.press('Escape') // nothing selected
    await expect.poll(() => selectedIds(a.page)).toEqual([])
    await a.page.keyboard.press('n')
    await expect.poll(() => currentTool(a.page)).toBe('note')
    await clickCanvasAt(a.page, { x: 200, y: 100 + run * 260 })
    const first = await waitForTextEditor(a.page)
    await a.page.keyboard.type('Alpha')
    await a.page.keyboard.press('Tab')
    await a.page.keyboard.type('Scope creep')
    await expect
      .poll(async () => {
        const id = await editingId(a.page)
        return id && id !== first ? plainText((await getShape(a.page, id))?.props.richText) : null
      })
      .toBe('Scope creep')
    await a.page.keyboard.press('Escape')
    await expect.poll(() => editingId(a.page)).toBeNull()
    expect(plainText((await getShape(a.page, first))?.props.richText)).toBe('Alpha')
  }
  const texts = (await notesOnPage(a.page)).map((n) => n.text)
  expect(texts.filter((t) => t === 'Scope creep')).toHaveLength(5)
  expect(texts.filter((t) => t === 'Alpha')).toHaveLength(5)
})

// ---- RETRO-14 / PRI-20c ------------------------------------------------------------------------------

test('RETRO-14: F-drag a frame, Enter, type its name: the name is set, and no key reached the tool shortcuts; a double-click on the heading renames too', async ({
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await clickCanvasAt(a.page, { x: 1100, y: 700 })
  const minimapShown = () => a.page.getByTestId('minimap.canvas').count()
  const minimapBefore = await minimapShown()
  await a.page.keyboard.press('f')
  await expect.poll(() => currentTool(a.page)).toBe('frame')
  const from = await screenOf(a.page, { x: 200, y: 200 })
  await drag(a.page, from, { x: from.x + 420, y: from.y + 300 })
  await expect.poll(() => currentTool(a.page)).toBe('select')
  const frameId = await readEd(a.page, (ed) => ed.getOnlySelectedShape()?.id ?? null)
  expect((await getShape(a.page, frameId as string))?.type).toBe('frame')

  const name = 'Theme: Process & planning'
  await a.page.keyboard.press('Enter')
  await a.page.keyboard.type(name) // no delay, straight after Enter
  await a.page.keyboard.press('Enter')
  await expect.poll(() => getShape(a.page, frameId as string).then((s) => s?.props.name)).toBe(name)
  await expect.poll(() => editingId(a.page)).toBeNull()
  expect(await currentTool(a.page)).toBe('select')
  expect(await minimapShown()).toBe(minimapBefore)
  expect(await readEd(a.page, (ed) => ed.getInstanceState().isToolLocked)).toBe(false)
  expect((await pageShapes(a.page)).length).toBe(1)

  await test.step('double-click the heading and type at once', async () => {
    const heading = a.page.locator(`[data-shape-id="${frameId}"] .tl-frame-heading-hit-area`)
    const box = await heading.boundingBox()
    if (!box) throw new Error('no heading')
    await a.page.mouse.dblclick(box.x + 30, box.y + box.height / 2)
    await a.page.keyboard.type('Retro themes')
    await a.page.keyboard.press('Enter')
    await expect
      .poll(() => getShape(a.page, frameId as string).then((s) => s?.props.name))
      .toBe('Retro themes')
    expect(await currentTool(a.page)).toBe('select')
    expect(await minimapShown()).toBe(minimapBefore)
    expect((await pageShapes(a.page)).length).toBe(1)
  })
})

// ---- RETRO-21b ---------------------------------------------------------------------------------------

test('RETRO-21b: double-clicking empty canvas makes a note there (inside the frame under it) and edits it; double-clicking a note still edits that note', async ({
  session,
}) => {
  const F = 'shape:dbl-frame'
  const N = 'shape:dbl-note'
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await editEd(a.page, (ed, list) => ed.createShapes(list), [
    { id: F, type: 'frame', x: 700, y: 100, props: { w: 600, h: 500, name: 'Ideas' } },
    note(N, 100, 500, 'Keep me'),
  ])

  const dbl = async (p: { x: number; y: number }) => {
    const s = await screenOf(a.page, p)
    await a.page.mouse.dblclick(s.x, s.y)
  }
  await dbl({ x: 300, y: 250 })
  const created = await waitForTextEditor(a.page)
  expect(created).not.toBe(N)
  await a.page.keyboard.type('On the page')
  await a.page.keyboard.press('Escape')
  const onPage = await getShape(a.page, created)
  expect(onPage?.type).toBe('note')
  expect(onPage?.parentId.startsWith('page:')).toBe(true)
  const b = await boundsOf(a.page, [created])
  expect(b && Math.abs(b.x + b.w / 2 - 300) < 2 && Math.abs(b.y + b.h / 2 - 250) < 2).toBe(true)
  expect((await pageShapes(a.page)).filter((s) => s.type === 'text')).toHaveLength(0)

  await dbl({ x: 1000, y: 400 })
  const inFrame = await waitForTextEditor(a.page)
  await a.page.keyboard.type('In the frame')
  await a.page.keyboard.press('Escape')
  expect((await getShape(a.page, inFrame))?.parentId).toBe(F)

  const count = (await pageShapes(a.page)).length
  const nb = await boundsOf(a.page, [N])
  if (!nb) throw new Error('no note')
  await dbl({ x: nb.x + nb.w / 2, y: nb.y + nb.h / 2 })
  await waitForTextEditor(a.page, N)
  await a.page.keyboard.press('Escape')
  expect((await pageShapes(a.page)).length).toBe(count)
  expect(plainText((await getShape(a.page, N))?.props.richText)).toBe('Keep me')

  await test.step('the shortcuts dialog lists the double-click and Enter-to-rename gestures', async () => {
    await clickCanvasAt(a.page, { x: 300, y: 800 })
    await a.page.keyboard.press('Control+Alt+/')
    await expect(a.page.locator('.tlui-shortcuts-dialog__body')).toBeVisible()
    const rows = await shortcutRows(a.page)
    const kbdOf = (label: string) => rows.find((r) => r.label === label)?.kbd ?? null
    expect(kbdOf('New sticky note (double-click empty canvas)')).toBe('Double-click')
    expect(kbdOf('Rename the selected frame')).toBe('Enter')
    await a.page.keyboard.press('Escape')
  })
})

// ---- RETRO-20 / F20 copy ------------------------------------------------------------------------------

test('RETRO-20: the style panel shows only for a selection or a creation tool; F20: US copy, plain Arrange labels, no Debug mode', async ({
  session,
}) => {
  const [N1, N2] = ['shape:sp-1', 'shape:sp-2']
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await editEd(a.page, (ed, list) => ed.createShapes(list), [
    note(N1, 200, 200, 'One'),
    note(N2, 500, 200, 'Two'),
  ])
  const panel = a.page.getByTestId('style.panel')
  await clickCanvasAt(a.page, { x: 1100, y: 700 })
  await expect(panel).toHaveCount(0)
  await clickShape(a.page, N1)
  await expect(panel).toBeVisible()
  await expect(a.page.locator('.dr-note-palette__legend')).toHaveText('Note color')
  await clickCanvasAt(a.page, { x: 1100, y: 700 })
  await expect(panel).toHaveCount(0)
  await a.page.keyboard.press('n')
  await expect(panel).toBeVisible()
  await a.page.keyboard.press('Escape')
  await expect.poll(() => currentTool(a.page)).toBe('select')
  await expect(panel).toHaveCount(0)

  await test.step('selection bar and Arrange menu say "Align center", "Align horizontally"… (no "Align H")', async () => {
    await clickShape(a.page, N1)
    await clickShape(a.page, N2, { shift: true })
    await expect(a.page.getByTestId('align-center-horizontal')).toHaveAttribute('aria-label', 'Align center')
    const c = await screenOf(a.page, { x: 300, y: 300 })
    await a.page.mouse.click(c.x, c.y, { button: 'right' })
    await a.page.getByTestId('context-menu-sub.arrange-button').click()
    const menu = a.page.locator('.tlui-menu').last()
    await expect(menu.getByText('Align horizontally', { exact: true })).toBeVisible()
    await expect(menu.getByText('Align H', { exact: true })).toHaveCount(0)
    await a.page.keyboard.press('Escape')
    await a.page.keyboard.press('Escape')
  })

  await test.step('Preferences has no Debug mode (production build)', async () => {
    await a.page.getByTestId('main-menu.button').click()
    await a.page.getByTestId('main-menu-sub.preferences-button').click()
    await expect(a.page.getByRole('menuitemcheckbox', { name: /snap/i })).toBeVisible()
    await expect(a.page.getByRole('menuitemcheckbox', { name: /debug/i })).toHaveCount(0)
    await a.page.keyboard.press('Escape')
  })
})

// ---- PRI-10 / F12 / F20 (Frames panel) ----------------------------------------------------------------

test('Frames panel: no doubled numbers (F20); "go to frame" shows its heading and bottom clear of the UI, at most 100% (PRI-10); Shift-click selects several frames (F12)', async ({
  session,
  board,
}) => {
  const a = await session('alice')
  await a.page.goto(`/b/${board}?template=retrospective`)
  await waitForBoard(a.page)
  await waitForCanvasUx(a.page)
  await a.page.getByTestId('dock-tab-frames').click()
  const rows = a.page.locator('[data-testid="frame-row"]:not([data-nested])')
  await expect(rows.first()).toBeVisible()
  const names = await rows.locator('.dr-cux-frame__name').allTextContents()
  // The retro's frames are "1 · Check-in", "2 · What went well"…: no second number in front of them.
  expect(names.length).toBe(4)
  for (const n of names) expect(n).toMatch(/^\d · /)
  await expect(rows.locator('.dr-cux-frame__num')).toHaveCount(0)

  await test.step('go to frame: heading below the page bar, bottom above the toolbar, zoom <= 100%', async () => {
    // 0: the wide check-in strip; 2: the tall "What to improve" column (zoomed out to fit).
    for (const i of [0, 2]) {
      const row = rows.nth(i)
      const id = (await row.getAttribute('data-frame-id')) as string
      await row.locator('.dr-cux-frame__name').click()
      await a.page.waitForTimeout(400) // the 280 ms camera animation
      await expect.poll(() => readEd(a.page, (ed) => ed.getCameraState())).toBe('idle')
      expect(await zoom(a.page)).toBeLessThanOrEqual(1)
      const heading = await a.page.locator(`[data-shape-id="${id}"] .tl-frame-heading-hit-area`).boundingBox()
      const bar = await a.page.locator('.tlui-menu-zone').boundingBox()
      const toolbar = await a.page.locator('.tlui-main-toolbar').boundingBox()
      const fb = await boundsOf(a.page, [id])
      if (!heading || !bar || !toolbar || !fb) throw new Error('missing boxes')
      const bottom = await screenOf(a.page, { x: fb.x + fb.w / 2, y: fb.y + fb.h })
      expect(heading.y).toBeGreaterThanOrEqual(bar.y + bar.height)
      expect(bottom.y).toBeLessThanOrEqual(toolbar.y)
      const dock = await a.page.getByTestId('feature-dock').boundingBox()
      const left = await screenOf(a.page, { x: fb.x, y: fb.y })
      expect(left.x).toBeGreaterThanOrEqual((dock?.x ?? 0) + (dock?.width ?? 0))
    }
  })

  await test.step('click one frame, then Shift-click two more: 3 frames selected', async () => {
    const ids = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-frame-id') as string))
    await rows.nth(0).locator('.dr-cux-frame__name').click()
    await rows
      .nth(1)
      .locator('.dr-cux-frame__name')
      .click({ modifiers: ['Shift'] })
    await rows
      .nth(2)
      .locator('.dr-cux-frame__name')
      .click({ modifiers: ['Shift'] })
    expect(await selectedIds(a.page)).toEqual(ids.slice(0, 3).sort())
    await expect(rows.nth(2)).toHaveAttribute('data-selected', 'true')
    // Ctrl-click takes one out again.
    await rows
      .nth(1)
      .locator('.dr-cux-frame__name')
      .click({ modifiers: ['Control'] })
    expect(await selectedIds(a.page)).toEqual([ids[0], ids[2]].sort())
  })
})

// ---- F8 ----------------------------------------------------------------------------------------------

test('F8: clicking a shape inside a locked frame says why nothing happens, and can unlock; locked frames show a lock on their heading', async ({
  session,
}) => {
  const F = 'shape:lk-frame'
  const N = 'shape:lk-note'
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await editEd(
    a.page,
    (ed, ids) => {
      ed.createShapes([
        { id: ids.F, type: 'frame', x: 200, y: 150, props: { w: 600, h: 450, name: '3 · Imagery' } },
        { id: ids.N, type: 'note', parentId: ids.F, x: 60, y: 80, props: {} },
      ])
      ed.toggleLock([ids.F])
    },
    { F, N },
  )
  expect((await getShape(a.page, F))?.isLocked).toBe(true)
  const hint = a.page.getByTestId('locked-hint')
  await expect(hint).toHaveCount(0)
  const badge = await a.page
    .locator(`[data-shape-id="${F}"] .tl-frame-heading-hit-area`)
    .evaluate((el) => getComputedStyle(el, '::before').getPropertyValue('content'))
  expect(badge).toBe('""')

  const nb = await boundsOf(a.page, [N])
  if (!nb) throw new Error('no note')
  const from = await screenOf(a.page, { x: nb.x + nb.w / 2, y: nb.y + nb.h / 2 })
  await drag(a.page, from, { x: from.x + 150, y: from.y + 80 })
  await expect(hint).toBeVisible()
  await expect(hint).toContainText('Locked. Inside locked frame "3 · Imagery".')
  await expect(hint).toContainText('Ctrl+Shift+L or right-click → Unlock all')
  expect((await getShape(a.page, N))?.x).toBe(60)

  await hint.getByTestId('locked-hint-unlock').click()
  await expect(hint).toHaveCount(0)
  await expect.poll(() => getShape(a.page, F).then((s) => s?.isLocked)).toBe(false)
  const after = await a.page
    .locator(`[data-shape-id="${F}"] .tl-frame-heading-hit-area`)
    .evaluate((el) => getComputedStyle(el, '::before').getPropertyValue('content'))
  expect(after).not.toBe('""')
  // Unlocked: a click on the note selects it, and no hint shows.
  await clickShape(a.page, N)
  expect(await selectedIds(a.page)).toEqual([N])
  await expect(hint).toHaveCount(0)
})

// ---- PRI-13 ------------------------------------------------------------------------------------------

test('PRI-13: on a phone (390×844, touch), a commenter starts on the Hand tool, a one-finger drag pans, and Zoom to fit stays', async ({
  browser,
  board,
  session,
  users,
}) => {
  const a = await session('alice')
  await editEd(a.page, (ed, n) => ed.createShapes([n]), note('shape:phone-note', 100, 100, 'Look here'))
  const carol = await users.grant(board, 'carol', 'commenter')
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  })
  try {
    const page = await context.newPage()
    await signInContext(context, carol.handle, carol.name)
    await page.goto(`/b/${board}`)
    await waitForBoard(page)
    await waitForCanvasUx(page)
    await expect(page.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'commenter')
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
    await expect.poll(() => currentTool(page)).toBe('hand')
    await expect(page.getByTestId('navigation.zoom-to-fit')).toBeVisible()

    const before = await camera(page)
    const cdp = await context.newCDPSession(page)
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', at?: { x: number; y: number }) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: at ? [{ x: at.x, y: at.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] : [],
      })
    await touch('touchStart', { x: 200, y: 420 })
    for (let i = 1; i <= 10; i++) await touch('touchMove', { x: 200 - i * 12, y: 420 - i * 16 })
    await touch('touchEnd')
    await expect
      .poll(async () => {
        const c = await camera(page)
        return Math.round(Math.hypot(c.x - before.x, c.y - before.y))
      })
      .toBeGreaterThan(60)

    await editEd(page, (ed) => ed.setCamera({ x: 5000, y: 5000, z: 1 }, { immediate: true }))
    await page.getByTestId('navigation.zoom-to-fit').click()
    await expect.poll(async () => (await camera(page)).x).not.toBe(5000)
  } finally {
    await context.close()
  }
})

// ---- F15 ---------------------------------------------------------------------------------------------

test('F15: board search finds an uploaded image by its file name', async ({ session }, testInfo) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  const file = testInfo.outputPath('ref-01.png')
  copyFileSync(join(FIXTURES_DIR, 'image.png'), file)
  await clickCanvasAt(a.page, { x: 700, y: 400 })
  await insertFiles(a.page, [file])
  const imageId = await waitForValue(
    async () => (await pageShapes(a.page)).find((s) => s.type === 'image')?.id,
  )
  await clickCanvasAt(a.page, { x: 1200, y: 750 })
  await a.page.keyboard.press('Control+f')
  await expect(a.page.getByTestId('search-input')).toBeFocused()
  await a.page.keyboard.type('ref-01')
  const result = a.page.locator(`[data-testid="search-result"][data-shape-id="${imageId}"]`)
  await expect(result).toBeVisible()
  await expect(result).toContainText('ref-01.png')
})

// ---- PERF-03 -----------------------------------------------------------------------------------------

test('PERF-03: the minimap starts closed and is not mounted; M opens it and that choice survives a reload', async ({
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  const minimap = a.page.getByTestId('minimap.canvas')
  await expect(minimap).toHaveCount(0)
  expect(await a.page.locator('.tlui-minimap').count()).toBe(0)
  await clickCanvasAt(a.page, { x: 900, y: 500 })
  await a.page.keyboard.press('m')
  await expect(minimap).toBeVisible()
  await a.page.reload()
  await waitForCanvasUx(a.page)
  await expect(minimap).toBeVisible()
  await clickCanvasAt(a.page, { x: 900, y: 500 })
  await a.page.keyboard.press('m')
  await expect(minimap).toHaveCount(0)
})
