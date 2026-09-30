// The accessible content list on the Excalidraw board page (docs/EXCALIDRAW-MIGRATION.md §4.8 (3); owner 3i):
// the "Contents" dock panel lists every note, frame and text in reading order, frames with what is inside
// them; one Tab stop with ↑/↓, Home and End; Enter selects the item on the board (the live region says it)
// and keeps the keyboard in the list; it follows other people's edits; a viewer has it too.
import { expect, itemText, select, test, zoomToFit } from '../tests/support/canvas.ts'
import {
  announcer,
  boardHasFocus,
  focusOf,
  frame,
  intoFrame,
  note,
  selected,
  textItem,
  waitForA11y,
} from './a11y-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const rows = (page: import('@playwright/test').Page) =>
  page
    .getByTestId('board-contents')
    .getByTestId('contents-item')
    .evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''))

test('Contents lists notes, frames and text in reading order; the keyboard moves through it and Enter selects on the board', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const agenda = await textItem(a.page, 0, -200, 'Agenda')
  const retro = await frame(a.page, 0, 0, 800, 500, 'Retro')
  const keep = await note(a.page, 100, 100, 'Keep')
  const stop = await note(a.page, 450, 100, 'Stop')
  await intoFrame(a.page, [keep, stop], retro)
  const loose = await note(a.page, 1000, 100, 'Loose idea')
  await zoomToFit(a.page)

  const tab = a.page.getByTestId('dock-tab-contents')
  await expect(tab).toHaveAccessibleName('Contents')
  await tab.focus()
  await a.page.keyboard.press('Enter')
  const panel = a.page.getByTestId('dock-panel-contents')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('contents-summary')).toHaveText('3 notes, 1 frame, 1 text')
  await expect
    .poll(() => rows(a.page))
    .toEqual([
      'Text: Agenda',
      'Frame: Retro (2 items)',
      'Sticky note: Keep',
      'Sticky note: Stop',
      'Sticky note: Loose idea',
    ])
  await expect(panel.getByRole('list', { name: 'Inside Frame: Retro' })).toBeVisible()
  await a.page.screenshot({ path: testInfo.outputPath('contents-panel.png') })

  // one Tab stop: from the panel's heading, Tab reaches the close button, then the list's first row
  await panel.getByTestId('dock-panel-close').focus()
  await a.page.keyboard.press('Tab')
  const first = panel.locator(`[data-a11y-row="${agenda}"]`)
  await expect(first).toBeFocused()
  await a.page.keyboard.press('ArrowDown')
  await a.page.keyboard.press('ArrowDown')
  await expect(panel.locator(`[data-a11y-row="${keep}"]`)).toBeFocused()
  await a.page.keyboard.press('Enter')
  await expect.poll(() => selected(a.page)).toEqual([keep])
  await expect(announcer(a.page)).toHaveText('Sticky note: Keep. 1 of 2 in Retro')
  // the keyboard stays in the list, and the selected row says so
  await expect(panel.locator(`[data-a11y-row="${keep}"]`)).toBeFocused()
  await expect(panel.locator(`[data-a11y-row="${keep}"]`)).toHaveAttribute('aria-current', 'true')
  await a.page.keyboard.press('End')
  await expect(panel.locator(`[data-a11y-row="${loose}"]`)).toBeFocused()
  await a.page.keyboard.press('Home')
  await expect(first).toBeFocused()
  // Tab leaves the list (the rows are one stop)
  await a.page.keyboard.press('Tab')
  expect(await focusOf(a.page)).not.toBe('contents-item')

  // F6 from the panel goes to the board with the chosen item still selected; Enter edits it
  await panel.locator(`[data-a11y-row="${stop}"]`).focus()
  await a.page.keyboard.press('Enter')
  await expect.poll(() => selected(a.page)).toEqual([stop])
  await a.page.keyboard.press('F6')
  await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  expect(await selected(a.page)).toEqual([stop])
  expect(await itemText(a.page, stop)).toBe('Stop')

  // selecting on the board marks the row
  await select(a.page, [loose])
  await expect(panel.locator(`[data-a11y-row="${loose}"]`)).toHaveAttribute('aria-current', 'true')

  // Escape in the list closes the panel and gives the keyboard back to its rail button
  await panel.locator(`[data-a11y-row="${loose}"]`).focus()
  await a.page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(tab).toBeFocused()
})

test("Contents follows other people's edits; a viewer has it; an empty board says so", async ({
  canvasSession,
}) => {
  const v = await canvasSession('carol', { role: 'viewer' })
  await waitForA11y(v.page)
  await v.page.getByTestId('dock-tab-contents').click()
  const panel = v.page.getByTestId('dock-panel-contents')
  await expect(panel.getByTestId('contents-summary')).toHaveText(
    'No notes, frames or text on this board yet.',
  )
  await expect(v.page.getByTestId('dock-add-note')).toHaveCount(0)

  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await note(a.page, 0, 0, 'From alice')
  await expect(panel.getByTestId('contents-summary')).toHaveText('1 note')
  await expect.poll(() => rows(v.page)).toEqual(['Sticky note: From alice'])
  await note(a.page, 400, 0, 'Second')
  await expect.poll(() => rows(v.page)).toEqual(['Sticky note: From alice', 'Sticky note: Second'])
  // the viewer selects from the list (selection only)
  await panel.getByTestId('contents-item').last().click()
  await expect(announcer(v.page)).toHaveText('Sticky note: Second. 2 of 2')
})
