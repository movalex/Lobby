// canvas-ux (3a) on the Excalidraw board page: what happens on the canvas itself. Ported from the tldraw
// page's specs (tests/canvas-ux.fix.spec.ts RETRO-21b and F8, tests/canvas-ux.spec.ts "alignment",
// tests/a11y-polish.spec.ts A11Y-04's selection toolbar, tests/canvas-ux-2.spec.ts A11Y2-06's narrow bar).
// The snapping of a drag itself is the engine's (objectsSnapModeEnabled); the default that turns it on is
// canvas-ux's and is checked here.
import type { Page } from '@playwright/test'
import {
  clickItem,
  createItem,
  createNote,
  dragItem,
  editingId,
  expect,
  expectConverged,
  item,
  items,
  itemText,
  select,
  test,
  waitForItem,
  waitForTextEditor,
} from '../tests/support/canvas.ts'
import { focusBoard, settled } from './board-kit.ts'
import { boardHasFocus, dblclickScene, notes, undoKey, waitForCanvasUx, withCanvas } from './canvas-ux-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const inFrame = (page: Page, note: string, frame: string) =>
  withCanvas(page, (c, ids) => c.transact('into frame', (tx) => tx.setFrame([ids.note], ids.frame)), {
    note,
    frame,
  })

test('RETRO-21b: a double-click on empty canvas makes a note there (inside the frame under it) and edits it; one on a note edits that note; nothing is made in a locked frame', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  const frame = await settled(
    a.page,
    createItem(a.page, 'frame', { x: 700, y: 100, width: 600, height: 500, name: 'Ideas' }),
  )
  const kept = await settled(a.page, createNote(a.page, { x: 100, y: 500, text: 'Keep me' }))
  await focusBoard(a.page)

  await dblclickScene(a.page, { x: 300, y: 250 })
  const created = await waitForTextEditor(a.page)
  expect(created).not.toBe(kept)
  await a.page.keyboard.type('On the page')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => itemText(a.page, created)).toBe('On the page')
  const onPage = await item(a.page, created)
  expect(onPage?.type).toBe('stickynote')
  expect(onPage?.frameId ?? null).toBeNull()
  const b = await withCanvas(a.page, (c, id) => c.bounds(id), created)
  expect(b && Math.abs(b.x + b.width / 2 - 300) < 2 && Math.abs(b.y + 100 - 250) < 2).toBe(true)
  // no free text (the engine's own double-click) was made
  expect((await items(a.page)).filter((e) => e.type === 'text' && !e.containerId)).toHaveLength(0)

  await dblclickScene(a.page, { x: 1000, y: 400 })
  const framed = await waitForTextEditor(a.page)
  await a.page.keyboard.type('In the frame')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => itemText(a.page, framed)).toBe('In the frame')
  expect((await item(a.page, framed))?.frameId).toBe(frame)

  const count = (await items(a.page)).length
  const nb = await withCanvas(a.page, (c, id) => c.bounds(id), kept)
  if (!nb) throw new Error('no note')
  await dblclickScene(a.page, { x: nb.x + nb.width / 2, y: nb.y + nb.height / 2 })
  await waitForTextEditor(a.page, kept)
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()
  expect((await items(a.page)).length).toBe(count)
  expect(await itemText(a.page, kept)).toBe('Keep me')

  await test.step('inside a locked frame nothing is made', async () => {
    await select(a.page, [frame])
    await a.page.keyboard.press('ControlOrMeta+Shift+L')
    await expect.poll(async () => (await item(a.page, frame))?.locked).toBe(true)
    await dblclickScene(a.page, { x: 1200, y: 500 })
    await a.page.waitForTimeout(400)
    expect(await editingId(a.page)).toBeNull()
    expect((await items(a.page)).length).toBe(count)
  })
})

test('F8: a press on a note inside a locked frame says why nothing happens and can unlock the frame; locked frames show a lock before their name', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  const frame = await settled(
    a.page,
    createItem(a.page, 'frame', { x: 200, y: 150, width: 600, height: 450, name: '3 · Imagery' }),
  )
  const note = await settled(a.page, createNote(a.page, { x: 260, y: 230 }))
  await settled(a.page, inFrame(a.page, note, frame))
  const hint = a.page.getByTestId('locked-hint')
  const badge = a.page.locator(`[data-testid="locked-frame-badge"][data-frame-id="${frame}"]`)
  await expect(badge).toHaveCount(0)
  await focusBoard(a.page)
  await select(a.page, [frame])
  await a.page.keyboard.press('ControlOrMeta+Shift+L')
  // locking a frame locks what is inside it
  await expect
    .poll(async () => [(await item(a.page, frame))?.locked, (await item(a.page, note))?.locked])
    .toEqual([true, true])
  await expect(badge).toBeVisible()
  await expect(hint).toHaveCount(0)
  await focusBoard(a.page)

  const start = await item(a.page, note)
  await dragItem(a.page, note, { x: 150, y: 80 })
  await expect(hint).toBeVisible()
  await expect(hint).toContainText('Locked. Inside locked frame "3 · Imagery".')
  await expect(hint).toContainText('Ctrl+Shift+L or right-click → Unlock all')
  await expect(hint).toHaveAttribute('data-source-id', frame)
  expect((await item(a.page, note))?.x).toBe(start?.x)

  await hint.getByTestId('locked-hint-unlock').click()
  await expect(hint).toHaveCount(0)
  await expect
    .poll(async () => [(await item(a.page, frame))?.locked, (await item(a.page, note))?.locked])
    .toEqual([false, false])
  await expect(badge).toHaveCount(0)
  // unlocked: a click on the note selects it, and no hint shows
  await clickItem(a.page, note)
  await expect.poll(() => withCanvas(a.page, (c) => c.selection, null)).toEqual([note])
  await expect(hint).toHaveCount(0)

  await test.step('a note locked on its own says only "Locked."; a press elsewhere or Escape dismisses it', async () => {
    await a.page.keyboard.press('ControlOrMeta+Shift+L')
    await expect.poll(async () => (await item(a.page, note))?.locked).toBe(true)
    await focusBoard(a.page)
    await clickItem(a.page, note)
    await expect(hint).toBeVisible()
    await expect(hint).toHaveAttribute('data-source-id', note)
    await expect(hint).toContainText(/^Locked\. (Ctrl\+Shift\+L|⌘⇧L) or right-click/)
    await expect(hint.getByTestId('locked-hint-unlock')).toHaveText('Unlock')
    await a.page.keyboard.press('Escape')
    await expect(hint).toHaveCount(0)
    await clickItem(a.page, note)
    await expect(hint).toBeVisible()
    await focusBoard(a.page)
    await expect(hint).toHaveCount(0)
  })
})

test('MAK-03 selection bar: align and distribute are one undo step each and reach bob; the lock button toggles; Alt+F10 reaches the bar, arrows move along it, Escape gives the keyboard back', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForCanvasUx(a.page)
  const n1 = await settled(a.page, createNote(a.page, { x: 100, y: 100, text: 'one' }))
  const n2 = await settled(a.page, createNote(a.page, { x: 400, y: 160, text: 'two' }))
  const n3 = await settled(a.page, createNote(a.page, { x: 900, y: 60, text: 'three' }))
  await waitForItem(b.page, n3)
  await select(a.page, [n1, n2, n3])
  const bar = a.page.getByTestId('selection-bar')
  await expect(bar).toBeVisible()

  await test.step('Align top: every note on the top edge, labels too, one undo', async () => {
    await bar.getByTestId('align-top').click()
    await expect
      .poll(async () => [
        (await item(a.page, n1))?.y,
        (await item(a.page, n2))?.y,
        (await item(a.page, n3))?.y,
      ])
      .toEqual([60, 60, 60])
    await expect.poll(async () => (await item(b.page, n2))?.y).toBe(60)
    // the label moved with its note
    const label = (
      (await item(a.page, n2)) as { boundElements?: { id: string; type: string }[] } | null
    )?.boundElements?.find((e) => e.type === 'text')?.id as string
    const lb = await item(a.page, label)
    expect(lb && lb.y >= 60 && lb.y < 260).toBe(true)
    await undoKey(a.page)
    await expect
      .poll(async () => [(await item(a.page, n1))?.y, (await item(a.page, n2))?.y])
      .toEqual([100, 160])
  })

  await test.step('Distribute horizontally: equal gaps, the outer notes stay', async () => {
    await select(a.page, [n1, n2, n3])
    await bar.getByTestId('distribute-horizontal').click()
    // n1 [100, 300], n3 [900, 1100]: the gap is (1000 - 600) / 2 = 200, so n2 goes to 500
    await expect.poll(async () => (await item(a.page, n2))?.x).toBe(500)
    expect((await item(a.page, n1))?.x).toBe(100)
    expect((await item(a.page, n3))?.x).toBe(900)
    await expectConverged(a.page, [b.page])
  })

  await test.step('Lock from the bar, and back', async () => {
    await select(a.page, [n1])
    await bar.getByTestId('selection-lock').click()
    await expect.poll(async () => (await item(a.page, n1))?.locked).toBe(true)
    await expect(bar.getByTestId('selection-lock')).toHaveAttribute('aria-pressed', 'true')
    await bar.getByTestId('selection-lock').click()
    await expect.poll(async () => (await item(a.page, n1))?.locked).toBe(false)
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  })

  await test.step('A11Y-04: Alt+F10 reaches the bar; arrows move; Escape returns to the board', async () => {
    await select(a.page, [n1, n2])
    await a.page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
    await a.page.keyboard.press('Alt+F10')
    const buttons = bar.locator('button')
    await expect(buttons.first()).toBeFocused()
    await a.page.keyboard.press('ArrowRight')
    await expect(buttons.nth(1)).toBeFocused()
    await a.page.keyboard.press('End')
    await expect(buttons.last()).toBeFocused()
    await a.page.keyboard.press('Escape')
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
    expect(await withCanvas(a.page, (c) => c.selection.length, null)).toBe(2)
  })

  await test.step('hidden while an editor is open', async () => {
    await select(a.page, [n1])
    await a.page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
    await a.page.keyboard.press('Enter')
    await waitForTextEditor(a.page, n1)
    await expect(bar).toHaveCount(0)
    await a.page.keyboard.press('Escape')
    await expect(bar).toBeVisible()
  })
})

test('A11Y2-06: on a phone-width canvas the selection bar folds align and distribute into More', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await a.page.setViewportSize({ width: 520, height: 800 })
  await waitForCanvasUx(a.page)
  const n1 = await settled(a.page, createNote(a.page, { x: 20, y: 100, text: 'one' }))
  const n2 = await settled(a.page, createNote(a.page, { x: 240, y: 140, text: 'two' }))
  await select(a.page, [n1, n2])
  const bar = a.page.getByTestId('selection-bar')
  await expect(bar).toHaveAttribute('data-compact', 'true')
  await expect(bar.getByTestId('align-left')).toHaveCount(0)
  await bar.getByTestId('selection-more').click()
  await expect(a.page.getByTestId('selection-more-row').getByTestId('align-left')).toBeVisible()
  const box = await bar.boundingBox()
  expect(box && box.x >= 0 && box.x + box.width <= 520).toBe(true)
})

test('MAK-02: snapping is on for a fresh browser, and an explicit off survives a reload', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  const snap = () => withCanvas(a.page, (c) => c.settings.get().snap, null)
  await expect.poll(snap).toBe(true)
  await withCanvas(a.page, (c) => c.settings.set({ snap: false }), null)
  await a.page.reload()
  await waitForCanvasUx(a.page)
  await a.page.waitForTimeout(300)
  expect(await snap()).toBe(false)
  // the note tool's notes and the next text are sans (RETRO-21a)
  expect(await withCanvas(a.page, (c) => c.styles.next().fontFamily, null)).toBe(6)
  expect((await notes(a.page)).length).toBe(0)
})
