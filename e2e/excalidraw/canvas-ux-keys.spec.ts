// canvas-ux (3a) on the Excalidraw board page: the keys. Ported from the tldraw page's specs
// (tests/canvas-ux.spec.ts "Miro keys" and "type-to-edit", tests/canvas-ux.fix.spec.ts RETRO-02, RETRO-09 and
// RETRO-14, tests/a11y-polish.spec.ts A11Y-12, tests/a11y-2.spec.ts A11Y-07, tests/a11y-3.spec.ts A11Y2-07,
// tests/keyboard-safety.spec.ts A11Y2-02). The zoom keys (Alt+1, Alt+2, Ctrl+0) and M are navigation's
// (3b) and are ported with it.
import type { Page } from '@playwright/test'
import {
  clickItem,
  createItem,
  createNote,
  editingId,
  expect,
  expectSaved,
  item,
  items,
  itemText,
  select,
  selectNone,
  setViewport,
  test,
  tool,
  waitForItem,
  waitForTextEditor,
} from '../tests/support/canvas.ts'
import { focusBoard, settled } from './board-kit.ts'
import { boardHasFocus, clickScene, notes, waitForCanvasUx, withCanvas } from './canvas-ux-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

/** Paint order of `ids` (the board's items are in paint order). */
const zOrder = async (page: Page, ids: string[]) =>
  (await items(page)).map((e) => e.id).filter((id) => ids.includes(id))

/** Three overlapping rectangles, bottom to top, and the board's keyboard. */
async function threeRects(page: Page) {
  const r1 = await settled(page, createItem(page, 'rectangle', { x: 300, y: 200, width: 200, height: 120 }))
  const r2 = await settled(page, createItem(page, 'rectangle', { x: 360, y: 250, width: 200, height: 120 }))
  const r3 = await settled(page, createItem(page, 'rectangle', { x: 420, y: 300, width: 200, height: 120 }))
  await focusBoard(page)
  return [r1, r2, r3] as const
}

test('MAK-06: PageUp / PageDown bring to front / send to back, Shift one step, ] and [ too (bob sees the order)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForCanvasUx(a.page)
  const [r1, r2, r3] = await threeRects(a.page)
  const stack = () => zOrder(a.page, [r1, r2, r3])
  await select(a.page, [r1])
  expect(await stack()).toEqual([r1, r2, r3])
  await a.page.keyboard.press('PageUp')
  await expect.poll(stack).toEqual([r2, r3, r1])
  await a.page.keyboard.press('PageDown')
  await expect.poll(stack).toEqual([r1, r2, r3])
  await a.page.keyboard.press('Shift+PageUp')
  await expect.poll(stack).toEqual([r2, r1, r3])
  await a.page.keyboard.press('Shift+PageDown')
  await expect.poll(stack).toEqual([r1, r2, r3])
  await a.page.keyboard.press(']')
  await expect.poll(stack).toEqual([r2, r3, r1])
  await a.page.keyboard.press('[')
  await expect.poll(stack).toEqual([r1, r2, r3])
  await a.page.keyboard.press('PageUp')
  await expect.poll(() => zOrder(b.page, [r1, r2, r3])).toEqual([r2, r3, r1])
})

test('Miro keys: Ctrl+Shift+L locks and keeps the selection (Delete does nothing), again unlocks; ?, Ctrl+/ and Ctrl+Alt+/ list the keys and nothing flips the theme', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  const [, r2, r3] = await threeRects(a.page)

  await test.step('Ctrl+Shift+L locks and keeps the selection; Delete does nothing; again unlocks', async () => {
    await select(a.page, [r2])
    await a.page.keyboard.press('ControlOrMeta+Shift+L')
    await expect.poll(async () => (await item(a.page, r2))?.locked).toBe(true)
    await expect.poll(() => withCanvas(a.page, (c) => c.selection, null)).toEqual([r2])
    // one selection kept, no group made (Excalidraw's own lock groups a locked multi-selection)
    expect((await item(a.page, r2))?.groupIds).toEqual([])
    await a.page.keyboard.press('Delete')
    await a.page.keyboard.press('Backspace')
    await a.page.waitForTimeout(200)
    expect((await item(a.page, r2))?.isDeleted).toBe(false)
    await a.page.keyboard.press('ControlOrMeta+Shift+L')
    await expect.poll(async () => (await item(a.page, r2))?.locked).toBe(false)
    // a bare Shift+L does nothing; a later L proves the key was handled
    await select(a.page, [r3])
    await a.page.keyboard.press('Shift+L')
    await a.page.keyboard.press('l')
    await expect.poll(() => tool(a.page)).toBe('arrow')
    expect((await item(a.page, r3))?.locked).toBe(false)
    await a.page.keyboard.press('v')
  })

  await test.step('?, Ctrl+/ and Ctrl+Alt+/ open the shortcuts, which list the board keys; the theme stays', async () => {
    const theme = () => a.page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    const before = await theme()
    const dialog = a.page.getByTestId('shortcuts-dialog')
    for (const chord of ['Shift+?', 'ControlOrMeta+/', 'ControlOrMeta+Alt+/']) {
      await focusBoard(a.page)
      await a.page.keyboard.press(chord)
      await expect(dialog, chord).toBeVisible()
      expect(await theme()).toBe(before)
      await a.page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    }
    await focusBoard(a.page)
    await a.page.keyboard.press('Shift+?')
    const rows = await dialog.getByTestId('shortcut-row').evaluateAll((els) =>
      els.map((e) => ({
        label: e.querySelector('.cux-shortcuts__label')?.textContent ?? '',
        kbd: [...e.querySelectorAll('.cux-shortcuts__kbd')].map((k) => k.textContent ?? ''),
      })),
    )
    const kbdOf = (label: string) => rows.find((r) => r.label === label)?.kbd[0] ?? null
    expect(kbdOf('Toggle locked')).toMatch(/^(Ctrl\+Shift\+L|⇧⌘L)$/)
    expect(kbdOf('Bring to front')).toBe('PgUp')
    expect(kbdOf('Send backward')).toMatch(/^(Shift\+PgDn|⇧PgDn)$/)
    expect(kbdOf('Connector')).toBe('L')
    expect(kbdOf('Pen')).toBe('P')
    expect(kbdOf('Keyboard shortcuts')).not.toBeNull()
    await expect(dialog).toContainText('Place the picked note, shape or text in the middle of the view')
    await expect(dialog).toContainText('New note beside (while editing a note)')
    await a.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  })
})

test('type-to-edit: typing on one selected note appends to it; T and C still pick tools; a viewer’s typing edits nothing', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForCanvasUx(a.page)
  const n = await settled(a.page, createNote(a.page, { x: 300, y: 220, text: 'Say' }))
  // a filled shape (Excalidraw picks a transparent one by its outline only)
  const g = await settled(
    a.page,
    createItem(a.page, 'rectangle', {
      x: 700,
      y: 260,
      width: 200,
      height: 120,
      backgroundColor: '#dce1f8',
      fillStyle: 'solid',
    }),
  )
  await waitForItem(b.page, g)

  await test.step('select the note and type fast: the note ends with the typed text, seen by bob', async () => {
    await clickItem(a.page, n)
    await expect.poll(() => withCanvas(a.page, (c) => c.selection, null)).toEqual([n])
    await a.page.keyboard.type('Hello') // no delay: the first key asks for the lease, the rest wait for it
    await expect.poll(() => itemText(a.page, n)).toBe('SayHello')
    expect(await editingId(a.page)).toBe(n)
    await a.page.keyboard.press('Escape')
    await expect.poll(() => editingId(a.page)).toBeNull()
    await expect.poll(() => itemText(b.page, n)).toBe('SayHello')
  })

  await test.step('with a shape that is not a note selected, T picks the text tool', async () => {
    await clickItem(a.page, g)
    await expect.poll(() => withCanvas(a.page, (c) => c.selection, null)).toEqual([g])
    await a.page.keyboard.press('t')
    await expect.poll(() => tool(a.page)).toBe('text')
    expect(await itemText(a.page, g)).toBe('')
    await a.page.keyboard.press('v')
  })

  await test.step('with nothing selected, C picks the comment tool', async () => {
    await selectNone(a.page)
    await focusBoard(a.page)
    await a.page.keyboard.press('c')
    await expect.poll(() => tool(a.page)).toBe('comment')
    await a.page.keyboard.press('v')
    await expect.poll(() => tool(a.page)).toBe('select')
  })

  await test.step('a viewer selecting the note and typing does not edit it', async () => {
    const v = await canvasSession('carol', { role: 'viewer' })
    await waitForCanvasUx(v.page)
    await select(v.page, [n])
    await focusBoard(v.page)
    await select(v.page, [n])
    await v.page.keyboard.type('Oops')
    await v.page.waitForTimeout(300)
    expect(await editingId(v.page)).toBeNull()
    expect(await itemText(v.page, n)).toBe('SayHello')
    expect(await itemText(a.page, n)).toBe('SayHello')
  })
})

test('RETRO-02: N, click, type "A", Esc, N, click, type "B" gives two notes "A" and "B" in sans; Enter re-edits the note just left; a clicked note takes type-to-edit again', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  await focusBoard(a.page)
  const addNote = async (at: { x: number; y: number }, text: string) => {
    await a.page.keyboard.press('n')
    await expect.poll(() => tool(a.page)).toBe('note')
    await clickScene(a.page, at)
    const id = await waitForTextEditor(a.page)
    // spike B's open O2 race: the new note's own ack can overtake the first keys (board-kit `settled`)
    await expectSaved(a.page)
    await a.page.keyboard.type(text)
    await expect.poll(() => itemText(a.page, id)).toBe(text)
    await a.page.keyboard.press('Escape')
    await expect.poll(() => editingId(a.page)).toBeNull()
  }
  await addNote({ x: 300, y: 300 }, 'A')
  // the finished note is still selected: N must pick the note tool, not type "n" into it
  await expect.poll(() => withCanvas(a.page, (c) => c.selection.length, null)).toBe(1)
  await addNote({ x: 700, y: 300 }, 'B')
  const list = await notes(a.page)
  expect(list.map((x) => x.text)).toEqual(['A', 'B'])
  for (const x of list) {
    const note = await item(a.page, x.id)
    const labelId = (
      (note as { boundElements?: { id: string; type: string }[] } | null)?.boundElements ?? []
    ).find((e) => e.type === 'text')?.id as string
    expect((await item(a.page, labelId))?.fontFamily, 'RETRO-21a: sans').toBe(6)
  }
  const bId = list[1]?.id as string
  const aId = list[0]?.id as string

  await test.step('other letters do not type into the note just left', async () => {
    await expect.poll(() => withCanvas(a.page, (c) => c.selection, null)).toEqual([bId])
    await a.page.keyboard.press('x')
    await a.page.waitForTimeout(200)
    expect(await editingId(a.page)).toBeNull()
    expect(await itemText(a.page, bId)).toBe('B')
  })

  await test.step('Enter re-edits the note just left (COL-02)', async () => {
    await a.page.keyboard.press('Enter')
    await expect.poll(() => editingId(a.page)).toBe(bId)
    await a.page.keyboard.press('Escape')
    await expect.poll(() => editingId(a.page)).toBeNull()
  })

  await test.step('once another note is clicked, typing appends to it (COL-04)', async () => {
    await clickItem(a.page, aId)
    await expect.poll(() => withCanvas(a.page, (c) => c.selection, null)).toEqual([aId])
    await a.page.keyboard.type('x')
    await expect.poll(() => itemText(a.page, aId)).toBe('Ax')
    await a.page.keyboard.press('Escape')
  })
})

test('A11Y-12: Enter on a selected note puts the caret at the end, so typing appends', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  const n = await settled(a.page, createNote(a.page, { x: 300, y: 220, text: 'Keep me' }))
  await focusBoard(a.page)
  await select(a.page, [n])
  await a.page.keyboard.press('Enter')
  await waitForTextEditor(a.page, n)
  await a.page.keyboard.type(' too')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => itemText(a.page, n)).toBe('Keep me too')
})

test('RETRO-09: Tab while editing a note makes the next note beside it, and typing straight after Tab goes into it, in order (5 runs)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  await focusBoard(a.page)
  for (let run = 0; run < 5; run++) {
    await setViewport(a.page, { x: 0, y: run * 300, zoom: 1 })
    await selectNone(a.page)
    await focusBoard(a.page)
    await a.page.keyboard.press('n')
    await expect.poll(() => tool(a.page)).toBe('note')
    await clickScene(a.page, { x: 200, y: 200 + run * 300 })
    const first = await waitForTextEditor(a.page)
    // spike B's open O2 race (board-kit `settled`): a server frame that overtakes a local edit before the
    // engine reports it loses the edit. Saved before and after the first note's words, so this checks the
    // Tab and the keys typed straight after it, not that race.
    await expectSaved(a.page)
    await a.page.keyboard.type('Alpha')
    await expect.poll(() => itemText(a.page, first)).toBe('Alpha')
    await expectSaved(a.page)
    await a.page.keyboard.press('Tab')
    await a.page.keyboard.type('Scope creep')
    await expect
      .poll(async () => {
        const id = await editingId(a.page)
        return id && id !== first ? itemText(a.page, id) : null
      })
      .toBe('Scope creep')
    const second = (await editingId(a.page)) as string
    await a.page.keyboard.press('Escape')
    await expect.poll(() => editingId(a.page)).toBeNull()
    expect(await itemText(a.page, first)).toBe('Alpha')
    const [f, s] = [await item(a.page, first), await item(a.page, second)]
    expect(s && f ? Math.round(s.x - (f.x + f.width)) : null, 'beside it, 20 apart').toBe(20)
    expect(s?.y).toBe(f?.y)
  }
  const texts = (await notes(a.page)).map((n) => n.text)
  expect(texts.filter((t) => t === 'Scope creep')).toHaveLength(5)
  expect(texts.filter((t) => t === 'Alpha')).toHaveLength(5)
})

test('A11Y-07: with the keyboard only, N or R then Enter puts the shape in the middle of the view, clear of the others, ready to type in', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  await focusBoard(a.page)
  await a.page.keyboard.press('n')
  await expect.poll(() => tool(a.page)).toBe('note')
  await a.page.keyboard.press('Enter')
  const first = await waitForTextEditor(a.page)
  await expectSaved(a.page) // spike B's O2 race (see RETRO-02)
  const view = await withCanvas(a.page, (c) => c.viewport.get(), null)
  const b1 = await withCanvas(a.page, (c, id) => c.bounds(id), first)
  expect(b1 && Math.abs(b1.x + b1.width / 2 - (view.x + view.width / 2)) < 2).toBe(true)
  await a.page.keyboard.type('First idea')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => itemText(a.page, first)).toBe('First idea')
  await a.page.keyboard.press('n')
  await a.page.keyboard.press('Enter')
  await expect.poll(async () => ((await editingId(a.page)) ?? first) !== first).toBe(true)
  const second = (await editingId(a.page)) as string
  const b2 = await withCanvas(a.page, (c, id) => c.bounds(id), second)
  const apart =
    !!b1 &&
    !!b2 &&
    (b2.x >= b1.x + b1.width ||
      b1.x >= b2.x + b2.width ||
      b2.y >= b1.y + b1.height ||
      b1.y >= b2.y + b2.height)
  expect(apart).toBe(true)
  await waitForTextEditor(a.page, second)
  await expectSaved(a.page)
  await a.page.keyboard.type('Second')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => itemText(a.page, second)).toBe('Second')
  await a.page.keyboard.press('r')
  await expect.poll(() => tool(a.page)).toBe('rectangle')
  await a.page.keyboard.press('Enter')
  await expect.poll(async () => (await items(a.page)).filter((e) => e.type === 'rectangle').length).toBe(1)
  const rect = (await items(a.page)).find((e) => e.type === 'rectangle')?.id as string
  await waitForTextEditor(a.page, rect)
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()
})

test('RETRO-14: Enter renames the selected frame (typing at once replaces the name; no key reaches the tools); a double-click on its name renames too', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  const frame = await settled(
    a.page,
    createItem(a.page, 'frame', { x: 200, y: 200, width: 420, height: 300, name: 'Frame' }),
  )
  await focusBoard(a.page)
  await select(a.page, [frame])
  const name = 'Theme: Process & planning'
  await a.page.keyboard.press('Enter')
  await expect(a.page.getByTestId('frame-rename')).toBeFocused()
  await a.page.keyboard.type(name)
  await a.page.keyboard.press('Enter')
  await expect.poll(async () => (await item(a.page, frame))?.name).toBe(name)
  await expect(a.page.getByTestId('frame-rename')).toHaveCount(0)
  expect(await tool(a.page)).toBe('select')
  expect((await items(a.page)).length).toBe(1)

  await test.step('double-click the name and type at once', async () => {
    await clickScene(a.page, { x: 900, y: 700 })
    await a.page.mouse.dblclick(
      ...(await withCanvas(
        a.page,
        (c, id) => {
          const f = c.get(id)
          const p = c.sceneToScreen({ x: (f?.x ?? 0) + 30, y: (f?.y ?? 0) - 8 / c.viewport.get().zoom })
          return [p.x, p.y] as [number, number]
        },
        frame,
      )),
    )
    await expect(a.page.getByTestId('frame-rename')).toBeFocused()
    await a.page.keyboard.type('Retro themes')
    await a.page.keyboard.press('Enter')
    await expect.poll(async () => (await item(a.page, frame))?.name).toBe('Retro themes')
    expect((await items(a.page)).length).toBe(1)
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  })

  await test.step('Escape keeps the old name', async () => {
    await select(a.page, [frame])
    await a.page.keyboard.press('Enter')
    await a.page.keyboard.type('Nope')
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('frame-rename')).toHaveCount(0)
    expect((await item(a.page, frame))?.name).toBe('Retro themes')
  })
})

test('A11Y2-02: tool letters, Delete and Backspace do nothing to the board while the keyboard is in the top bar or the board menu button; Ctrl+X and Ctrl+V there leave the board alone', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  const n = await settled(a.page, createNote(a.page, { x: 300, y: 220, text: 'Stay' }))
  await select(a.page, [n])
  const count = async () => (await items(a.page)).length
  const before = await count()
  for (const target of [a.page.getByTestId('share-button'), a.page.getByTestId('main-menu.button')]) {
    await target.focus()
    for (const key of ['t', 'r', 'n', 'Delete', 'Backspace', 'ControlOrMeta+x', 'ControlOrMeta+v']) {
      await a.page.keyboard.press(key)
    }
    await a.page.waitForTimeout(200)
    expect(await tool(a.page)).toBe('select')
    expect((await item(a.page, n))?.isDeleted).toBe(false)
    expect(await count()).toBe(before)
    expect(await editingId(a.page)).toBeNull()
  }
})
