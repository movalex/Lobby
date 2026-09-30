// The live region on the Excalidraw board page (docs/EXCALIDRAW-MIGRATION.md §4.8 (1); owner 3i): the
// `liveRegion` host slot says what is selected ("Sticky note: <text>", "Frame: <name>", with its place in
// reading order), for a click, a keyboard move or a selection from code, as tldraw's announcer did; it
// stays quiet while a note is typed in, and stays on the page in present (focus) mode.
import {
  clickItem,
  expect,
  select,
  selectNone,
  startTextEditing,
  stopTextEditing,
  test,
  typeText,
  zoomToFit,
} from '../tests/support/canvas.ts'
import { announcer, frame, intoFrame, note, textItem, waitForA11y, withCanvas } from './a11y-kit.ts'

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
  // leaving the editor with the same note selected says nothing new either
  await a.page.waitForTimeout(200)
  await expect(say).toHaveText('Sticky note: Lone. 2 of 2')

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
