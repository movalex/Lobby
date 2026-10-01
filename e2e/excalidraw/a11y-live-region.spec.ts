// The live region on the Excalidraw board page (docs/EXCALIDRAW-MIGRATION.md §4.8 (1); owner 3i): the
// `liveRegion` host slot says what is selected ("Sticky note: <text>", "Frame: <name>", with its place in
// reading order), for a click, a keyboard move or a selection from code, as tldraw's announcer did; it
// stays quiet while a note is typed in, and stays on the page in present (focus) mode.
// The early wave-5 review (docs/research/excalidraw/REVIEW-W5-EARLY.md): W5-43, a tool change is said
// politely and an edit that ends says the selection again; W5-58, opening a board from a template says
// nothing about the template's elements (its insert selects them for a moment, then the first view clears
// the selection).
import {
  clickItem,
  expect,
  itemText,
  select,
  selectNone,
  startTextEditing,
  stopTextEditing,
  test,
  typeText,
  zoomToFit,
} from '../tests/support/canvas.ts'
import {
  announcer,
  focusCanvas,
  frame,
  intoFrame,
  note,
  textItem,
  waitForA11y,
  withCanvas,
} from './a11y-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

test('the live region is a status region that says what a click or code selects', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const say = announcer(a.page)
  await expect(say).toHaveAttribute('role', 'status')
  await expect(say).toHaveAttribute('aria-live', 'assertive')
  await expect(say).toHaveText('')

  const retro = await frame(a.page, 0, 0, 800, 500, 'Retro')
  const inner = await note(a.page, 100, 100, 'Keep me')
  await intoFrame(a.page, [inner], retro)
  const loose = await note(a.page, 1000, 100, 'Faster builds')
  const agenda = await textItem(a.page, 1000, 600, 'Agenda')
  await zoomToFit(a.page)

  // a real click on a note
  await clickItem(a.page, loose)
  await expect(say).toHaveText('Sticky note: Faster builds. 2 of 3')
  // a selection from code (the content list, a search result, an api select)
  await select(a.page, [agenda])
  await expect(say).toHaveText('Text: Agenda. 3 of 3')
  await select(a.page, [retro])
  await expect(say).toHaveText('Frame: Retro. 1 of 3')
  await select(a.page, [inner])
  await expect(say).toHaveText('Sticky note: Keep me. 1 of 1 in Retro')
  await select(a.page, [loose, agenda])
  await expect(say).toHaveText('2 shapes selected')
  // nothing selected: the last words stay (nothing new is said)
  await selectNone(a.page)
  await a.page.waitForTimeout(200)
  await expect(say).toHaveText('2 shapes selected')
})

test('a group is one item; typing into a note says nothing; the region stays in focus mode', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const say = announcer(a.page)
  const one = await note(a.page, 0, 0, 'One')
  const two = await note(a.page, 300, 0, 'Two')
  const lone = await note(a.page, 0, 400, 'Lone')
  await withCanvas(a.page, (c, ids) => c.transact('group', (tx) => tx.group(ids)), [one, two])
  await zoomToFit(a.page)

  await select(a.page, [one, two])
  await expect(say).toHaveText('Group of 2 shapes. 1 of 2')

  await select(a.page, [lone])
  await expect(say).toHaveText('Sticky note: Lone. 2 of 2')
  await startTextEditing(a.page, lone)
  await typeText(a.page, ' wolf')
  await a.page.waitForTimeout(200)
  await expect(say).toHaveText('Sticky note: Lone. 2 of 2')
  await stopTextEditing(a.page)
  // W5-43: leaving the editor says the selection again, with the words just typed (where the double-click
  // put the caret)
  const words = (await itemText(a.page, lone)).trim()
  expect(words).toContain('wolf')
  await expect(say).toHaveText(`Sticky note: ${words}. 2 of 2`)

  // present mode's focus mode hides the chrome, not the live region
  await withCanvas(a.page, (c) => c.settings.set({ focusMode: true }), null)
  await expect(a.page.getByTestId('lobby-board')).toHaveAttribute('data-focus-mode', 'true')
  await expect(say).toBeAttached()
  await select(a.page, [one, two])
  await expect(say).toHaveText('Group of 2 shapes. 1 of 2')
  await withCanvas(a.page, (c) => c.settings.set({ focusMode: false }), null)
})

test("another person's edits are not announced; only this tab's selection is", async ({ canvasSession }) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForA11y(a.page)
  await waitForA11y(b.page)
  const mine = await note(a.page, 0, 0, 'Mine')
  await select(a.page, [mine])
  await expect(announcer(a.page)).toHaveText('Sticky note: Mine. 1 of 1')
  // bob adds and selects notes: alice's region is unchanged
  const bobs = await note(b.page, 400, 0, 'Bob was here')
  await select(b.page, [bobs])
  await expect(announcer(b.page)).toHaveText('Sticky note: Bob was here. 2 of 2')
  await a.page.waitForTimeout(500)
  await expect(announcer(a.page)).toHaveText('Sticky note: Mine. 1 of 1')
})

test('W5-43: a tool change is said politely ("Note tool"), from a key or the toolbar; placing a note says nothing about tools', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const tools = a.page.getByTestId('canvas-announcer-tool')
  await expect(tools).toHaveAttribute('role', 'status')
  await expect(tools).toHaveAttribute('aria-live', 'polite')
  await expect(tools).toHaveText('')
  await focusCanvas(a.page)
  await a.page.keyboard.press('n')
  await expect(tools).toHaveText('Note tool')
  await a.page.keyboard.press('v')
  await expect(tools).toHaveText('Select tool')
  await a.page.getByTestId('tools.hand').click()
  await expect(tools).toHaveText('Hand tool')
  await a.page.getByTestId('tools.select').click()
  await expect(tools).toHaveText('Select tool')
  // a feature's tool says its own name
  await focusCanvas(a.page)
  await a.page.keyboard.press('c')
  await expect(tools).toHaveText('Comment tool')
  await a.page.keyboard.press('Escape')
  await expect(tools).toHaveText('Select tool')
  // N and a click place a note and open its editor: the board's return to Select is not said over it
  await a.page.keyboard.press('n')
  await expect(tools).toHaveText('Note tool')
  const c = await a.page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!c) throw new Error('no canvas')
  await a.page.mouse.click(c.x + c.width / 2, c.y + c.height / 2)
  await expect.poll(() => withCanvas(a.page, (cv) => cv.editingId(), null)).not.toBeNull()
  await a.page.waitForTimeout(300)
  await expect(tools).toHaveText('Note tool')
  // the edit ends: the selection is said again (the note, empty)
  await a.page.keyboard.type('Placed')
  await a.page.keyboard.press('Escape')
  await expect(announcer(a.page)).toHaveText(/^Sticky note: Placed\. 1 of 1$/)
})

test('W5-58: opening a board from a template says nothing about the template it placed', async ({
  canvasSession,
  board,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  // every message the region shows, from the first paint of the next page on
  await a.context.addInitScript(() => {
    const w = window as unknown as { __said: string[] }
    w.__said = []
    new MutationObserver(() => {
      const t = document.querySelector('[data-testid="canvas-announcer"]')?.textContent ?? ''
      if (t && w.__said[w.__said.length - 1] !== t) w.__said.push(t)
    }).observe(document, { subtree: true, childList: true, characterData: true })
  })
  await a.page.goto(`/b/${board}?template=lobby-tour`)
  await waitForA11y(a.page)
  await expect
    .poll(() => withCanvas(a.page, (c) => c.items().filter((e) => e.type === 'frame').length, null))
    .toBeGreaterThan(0)
  await expect.poll(() => withCanvas(a.page, (c) => c.selection.length, null)).toBe(0)
  // longer than the region's settle time and a few frames
  await a.page.waitForTimeout(1_000)
  const said = await a.page.evaluate(() => (window as unknown as { __said: string[] }).__said)
  expect(said).toEqual([])
  await expect(announcer(a.page)).toHaveText('')
})
