// K2-2 (wave K, UXD-06): the text tool goes back to Select after one placement, as the note tool does, so the
// next click on empty canvas opens no text and a stray key leaves nothing on a colleague's board. With the tool
// lock on (Q) T stays armed. The editor still opens only through the lease (the session asks `requestEdit`
// after the tool switch): no text editor is ever writable without a lease this tab holds.
import type { Page } from '@playwright/test'
import {
  canvasCall,
  clickItem,
  editingId,
  expect,
  expectSaved,
  items,
  leaseHolder,
  TEXT_EDITOR,
  test,
  tool,
  typeText,
  waitForTextEditor,
} from '../tests/support/canvas.ts'
import { focusBoard } from './board-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

/** A point on empty canvas, as a share of the canvas region (right side: away from the dock and the panel). */
async function canvasPoint(page: Page, fx: number, fy: number) {
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no canvas')
  return { x: box.x + box.width * fx, y: box.y + box.height * fy }
}

/** No text editor is open, or any that is in the DOM is read-only (the lease guard's rule). */
async function noWritableEditor(page: Page) {
  return page.evaluate((sel) => {
    const tas = [...document.querySelectorAll<HTMLTextAreaElement>(sel)]
    return tas.every((t) => t.readOnly || !t.isConnected)
  }, TEXT_EDITOR)
}

/** The editor that is open is this tab's and it holds the lease on it. */
async function expectLeasedEditor(page: Page, id: string) {
  const me = await canvasCall(page, 'me')
  await expect.poll(async () => (await leaseHolder(page, id)) as unknown).toMatchObject({ uid: me?.uid })
}

const texts = async (page: Page) => (await items(page)).filter((e) => e.type === 'text' && !e.containerId)

test('K2-2: T, click, type, Escape, then a click on empty canvas: back on Select, no new text, no editor', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await focusBoard(a.page)
  await a.page.keyboard.press('t')
  await expect.poll(() => tool(a.page)).toBe('text')

  const p1 = await canvasPoint(a.page, 0.55, 0.35)
  await a.page.mouse.click(p1.x, p1.y)
  const id = await waitForTextEditor(a.page)
  await expectLeasedEditor(a.page, id)
  // one placement: the tool is Select again while the text is being typed
  await expect.poll(() => tool(a.page)).toBe('select')
  await typeText(a.page, 'Agenda')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()
  await expectSaved(a.page)
  const before = (await items(a.page)).length
  expect((await texts(a.page)).map((t) => t.originalText)).toEqual(['Agenda'])

  const p2 = await canvasPoint(a.page, 0.7, 0.65)
  await a.page.mouse.click(p2.x, p2.y)
  // a stray key after the click types nothing onto the board
  await a.page.keyboard.press('x')
  await a.page.waitForTimeout(400)
  expect(await tool(a.page)).toBe('select')
  expect(await editingId(a.page)).toBeNull()
  await expect(a.page.locator(TEXT_EDITOR)).toHaveCount(0)
  expect(await noWritableEditor(a.page)).toBe(true)
  await expectSaved(a.page)
  expect((await items(a.page)).length).toBe(before)
})

test('K2-2: with the tool lock on (Q) T stays armed: the next click opens a new text, through the lease', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await focusBoard(a.page)
  await a.page.keyboard.press('q')
  await expect(a.page.getByTestId('tool-lock-notice')).toBeVisible()
  await a.page.keyboard.press('t')
  await expect.poll(() => tool(a.page)).toBe('text')
  await expect(a.page.getByTestId('tools.text')).toHaveAttribute('data-locked', 'true')

  const p1 = await canvasPoint(a.page, 0.55, 0.35)
  await a.page.mouse.click(p1.x, p1.y)
  const first = await waitForTextEditor(a.page)
  await expectLeasedEditor(a.page, first)
  await typeText(a.page, 'One')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()
  expect(await tool(a.page)).toBe('text')

  const p2 = await canvasPoint(a.page, 0.7, 0.65)
  await a.page.mouse.click(p2.x, p2.y)
  const second = await waitForTextEditor(a.page)
  expect(second).not.toBe(first)
  await expectLeasedEditor(a.page, second)
  await typeText(a.page, 'Two')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()
  await expectSaved(a.page)
  expect((await texts(a.page)).map((t) => t.originalText).sort()).toEqual(['One', 'Two'])

  await test.step('Q again: the lock is off, and the text tool goes back to Select after its next text', async () => {
    await a.page.keyboard.press('q')
    await expect(a.page.getByTestId('tools.text')).not.toHaveAttribute('data-locked', 'true')
    const p3 = await canvasPoint(a.page, 0.6, 0.8)
    await a.page.mouse.click(p3.x, p3.y)
    await waitForTextEditor(a.page)
    await expect.poll(() => tool(a.page)).toBe('select')
    await typeText(a.page, 'Three')
    await a.page.keyboard.press('Escape')
    await expect.poll(() => editingId(a.page)).toBeNull()
    expect(await noWritableEditor(a.page)).toBe(true)
  })
})

test('K2-2: a double-click on the Note tool keeps it; Q on a selected note types into it instead', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await focusBoard(a.page)
  await a.page.getByTestId('tools.note').dblclick()
  await expect.poll(() => tool(a.page)).toBe('note')
  await expect(a.page.getByTestId('tools.note')).toHaveAttribute('data-locked', 'true')
  const p1 = await canvasPoint(a.page, 0.5, 0.4)
  await a.page.mouse.click(p1.x, p1.y)
  const note = await waitForTextEditor(a.page)
  await typeText(a.page, 'Kept')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()
  expect(await tool(a.page)).toBe('note')
  await a.page.keyboard.press('q')
  await expect(a.page.getByTestId('tools.note')).not.toHaveAttribute('data-locked', 'true')

  // with one note selected (clicked: type-to-edit applies to it), Q is a letter for that note, not the lock
  await a.page.keyboard.press('v')
  await expect.poll(() => tool(a.page)).toBe('select')
  await clickItem(a.page, note)
  await expect.poll(() => canvasCall(a.page, 'selection')).toEqual([note])
  await a.page.keyboard.press('q')
  await waitForTextEditor(a.page, note)
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()
  expect(await canvasCall(a.page, 'text', note)).toBe('Keptq')
  await expect(a.page.getByTestId('tools.note')).not.toHaveAttribute('data-locked', 'true')
  expect(await tool(a.page)).toBe('select')
})

// Wave K.1 (a K2 reviewer's nit): with the tool lock on, the keyboard's Enter placement (A11Y-07: a shape in the
// middle of the view) keeps the tool, as a click does; with it off Enter goes back to Select (W5-20).
test('K.1: with the tool lock on (Q) Enter places a note and the Note tool stays; the next Enter places another', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await focusBoard(a.page)
  await a.page.keyboard.press('q')
  await expect(a.page.getByTestId('tool-lock-notice')).toBeVisible()
  await a.page.keyboard.press('n')
  await expect.poll(() => tool(a.page)).toBe('note')
  await a.page.keyboard.press('Enter')
  const first = await waitForTextEditor(a.page)
  await expectLeasedEditor(a.page, first)
  await typeText(a.page, 'One')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()
  expect(await tool(a.page)).toBe('note')
  await expect(a.page.getByTestId('tools.note')).toHaveAttribute('data-locked', 'true')
  // the lock keeps placing: Enter again is a second note, not an edit of the first
  await focusBoard(a.page)
  await a.page.keyboard.press('Enter')
  const second = await waitForTextEditor(a.page)
  expect(second).not.toBe(first)
  await typeText(a.page, 'Two')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()
  expect(await tool(a.page)).toBe('note')
  await expectSaved(a.page)
  const notes = (await items(a.page)).filter((e) => e.type === 'stickynote')
  expect(notes.map((n) => n.id).sort()).toEqual([first, second].sort())

  await test.step('lock off: Enter places one note and goes back to Select (W5-20)', async () => {
    await a.page.keyboard.press('q')
    await a.page.keyboard.press('n')
    await expect.poll(() => tool(a.page)).toBe('note')
    await a.page.keyboard.press('Enter')
    await waitForTextEditor(a.page)
    await expect.poll(() => tool(a.page)).toBe('select')
    await a.page.keyboard.press('Escape')
    await expect.poll(() => editingId(a.page)).toBeNull()
  })
})
