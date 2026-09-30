// Keyboard traversal on the Excalidraw board page (docs/EXCALIDRAW-MIGRATION.md §4.8 (2); owner 3i): F6
// enters the canvas from anywhere, Alt+Arrow walks the board in reading order, Ctrl/Cmd+Shift+↓/↑ go inside
// a frame and back out, Enter edits the selected note through the lease; "Skip to canvas" enters the
// canvas the same way; the canvas the keyboard lands on is named after the board (A11Y2-09). The live
// region says each step. Replaces the traversal half of tldraw's own keyboard navigation (Tab with a
// selection), which the key allowlist gives back to the browser on the new canvas.
import {
  expect,
  items,
  itemText,
  pushedOps,
  setViewport,
  test,
  typeText,
  viewport,
  waitForTextEditor,
  zoomToFit,
} from '../tests/support/canvas.ts'
import {
  announcer,
  boardHasFocus,
  focusCanvas,
  focusOf,
  frame,
  intoFrame,
  note,
  selected,
  textItem,
  waitForA11y,
} from './a11y-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

/** A text "Agenda" on top, a frame "Retro" holding one note, and a loose note to its right. */
async function seed(page: import('@playwright/test').Page) {
  const agenda = await textItem(page, 0, -200, 'Agenda')
  const retro = await frame(page, 0, 0, 800, 500, 'Retro')
  const inner = await note(page, 100, 100, 'Keep me')
  await intoFrame(page, [inner], retro)
  const loose = await note(page, 1000, 100, 'Loose note')
  await zoomToFit(page)
  return { agenda, retro, inner, loose }
}

test('F6 from the top bar enters the board on the first item; Alt+Arrow walks the reading order, into a frame and out; the live region says each step', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const { agenda, retro, inner, loose } = await seed(a.page)
  const say = announcer(a.page)

  await test.step('F6 from the Share button: the board has the keyboard and the first item is selected', async () => {
    await a.page.getByTestId('share-button').focus()
    await a.page.keyboard.press('F6')
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
    expect(await selected(a.page)).toEqual([agenda])
    await expect(say).toHaveText('Text: Agenda. 1 of 3')
  })

  await test.step('Alt+→ and Alt+↓ move on, Alt+← and Alt+↑ back, wrapping at both ends', async () => {
    await a.page.keyboard.press('Alt+ArrowRight')
    await expect.poll(() => selected(a.page)).toEqual([retro])
    await expect(say).toHaveText('Frame: Retro. 2 of 3')
    await a.page.keyboard.press('Alt+ArrowDown')
    await expect.poll(() => selected(a.page)).toEqual([loose])
    await expect(say).toHaveText('Sticky note: Loose note. 3 of 3')
    await a.page.keyboard.press('Alt+ArrowRight')
    await expect.poll(() => selected(a.page)).toEqual([agenda])
    await a.page.keyboard.press('Alt+ArrowLeft')
    await expect.poll(() => selected(a.page)).toEqual([loose])
    await a.page.keyboard.press('Alt+ArrowUp')
    await expect.poll(() => selected(a.page)).toEqual([retro])
    await a.page.screenshot({ path: testInfo.outputPath('traversal-frame-selected.png') })
  })

  await test.step('Ctrl/Cmd+Shift+↓ goes inside the frame, Alt+Arrow stays inside, Ctrl/Cmd+Shift+↑ comes out', async () => {
    await a.page.keyboard.press('ControlOrMeta+Shift+ArrowDown')
    await expect.poll(() => selected(a.page)).toEqual([inner])
    await expect(say).toHaveText('Sticky note: Keep me. 1 of 1 in Retro')
    await a.page.keyboard.press('Alt+ArrowRight')
    await expect.poll(() => selected(a.page)).toEqual([inner])
    await a.page.keyboard.press('ControlOrMeta+Shift+ArrowUp')
    await expect.poll(() => selected(a.page)).toEqual([retro])
    await expect(say).toHaveText('Frame: Retro. 2 of 3')
  })

  await test.step('Alt+R says the selection again', async () => {
    await expect(say).toHaveText('Frame: Retro. 2 of 3')
    const heard: string[] = []
    await a.page.exposeFunction('__heard', (t: string) => heard.push(t))
    await a.page.evaluate(() => {
      const region = document.querySelector('[data-testid="canvas-announcer"]') as HTMLElement
      new MutationObserver(() =>
        (window as unknown as { __heard(t: string): void }).__heard(region.textContent ?? ''),
      ).observe(region, { childList: true, characterData: true, subtree: true })
    })
    await a.page.keyboard.press('Alt+r')
    await expect.poll(() => heard.at(-1)).toBe('Frame: Retro. 2 of 3')
    expect(heard).toContain('')
  })

  await test.step('Enter on a note reached with the keyboard edits it through the lease, caret at the end', async () => {
    await a.page.keyboard.press('Alt+ArrowRight')
    await expect.poll(() => selected(a.page)).toEqual([loose])
    await a.page.keyboard.press('Enter')
    await waitForTextEditor(a.page, loose)
    await typeText(a.page, ' (kbd)')
    await a.page.keyboard.press('Escape')
    await expect.poll(() => itemText(a.page, loose)).toBe('Loose note (kbd)')
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  })

  await test.step('an item off screen is brought into view', async () => {
    await setViewport(a.page, { x: 5000, y: 5000, zoom: 1 })
    await focusCanvas(a.page)
    await a.page.keyboard.press('Alt+ArrowRight')
    await expect.poll(() => selected(a.page)).toEqual([agenda])
    const inView = async () => {
      const v = await viewport(a.page)
      return v.x <= 0 && v.y <= -200 && v.x + v.width >= 60 && v.y + v.height >= -170
    }
    await expect.poll(inView).toBe(true)
  })
})

test('"Skip to canvas" enters the board like F6; the keyboard lands on a canvas named "<title> board" that says its keys, and keeps the name through a rename', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const first = await note(a.page, 0, 0, 'First idea')
  await note(a.page, 300, 0, 'Second idea')
  await zoomToFit(a.page)
  const title = ((await a.page.getByTestId('board-title').textContent()) ?? '').trim()

  // from the top of the page, the first Tab is the skip link
  await a.page.evaluate(() => {
    document.body.tabIndex = -1
    document.body.focus()
  })
  await a.page.keyboard.press('Tab')
  expect(await focusOf(a.page)).toBe('skip-to-canvas')
  await a.page.keyboard.press('Enter')
  await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  expect(await selected(a.page)).toEqual([first])
  await expect(announcer(a.page)).toHaveText('Sticky note: First idea. 1 of 2')

  const named = () =>
    a.page.evaluate(() => {
      const el = document.activeElement as HTMLElement
      const hint = document.getElementById(el.getAttribute('aria-describedby') ?? '')
      return {
        name: el.getAttribute('aria-label'),
        role: el.getAttribute('role'),
        hint: hint?.textContent ?? '',
      }
    })
  const n = await named()
  expect(n.name).toBe(`${title} board`)
  expect(n.role).toBe('application')
  expect(n.hint).toContain('Alt with the arrow keys moves between items')
  await expect(a.page.getByRole('application', { name: `${title} board` })).toBeVisible()

  // a rename: the canvas follows the new title
  await a.page.getByTestId('board-title').click()
  const input = a.page.getByTestId('board-title-input')
  await input.fill('Sprint review')
  await input.press('Enter')
  await expect(a.page.getByRole('application', { name: 'Sprint review board' })).toBeAttached()

  // F6 from the dock's rail: back on the board, the selection kept and said again
  await a.page.getByTestId('dock-tab-contents').focus()
  await a.page.keyboard.press('F6')
  await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  expect(await selected(a.page)).toEqual([first])
  await expect(announcer(a.page)).toHaveText('Sticky note: First idea. 1 of 2')
})

test('a viewer walks the board with the keyboard too (selection only, nothing is written)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const one = await note(a.page, 0, 0, 'One')
  const two = await note(a.page, 300, 0, 'Two')
  const v = await canvasSession('carol', { role: 'viewer' })
  await waitForA11y(v.page)
  await expect.poll(async () => (await items(v.page)).length).toBeGreaterThanOrEqual(4)
  await zoomToFit(v.page)
  await v.page.getByTestId('share-button').focus()
  await v.page.keyboard.press('F6')
  await expect.poll(() => selected(v.page)).toEqual([one])
  await v.page.keyboard.press('Alt+ArrowRight')
  await expect.poll(() => selected(v.page)).toEqual([two])
  await expect(announcer(v.page)).toHaveText('Sticky note: Two. 2 of 2')
  expect(await pushedOps(v.page)).toEqual([])
})

test('F6 on an empty board gives the board the keyboard and says there is nothing on it', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await a.page.getByTestId('share-button').focus()
  await a.page.keyboard.press('F6')
  await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  await expect(announcer(a.page)).toHaveText('Nothing on this board yet.')
  expect(await selected(a.page)).toEqual([])
})
