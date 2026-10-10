// Wave M (W4, M4-5, FTU-11): one consistent AI entry, against the real api (OpenAI is the local fake).
//  - Right-click on empty canvas: "Diagram from words…" is under AI › (not beside it), and the AI items that cannot
//    run there say what they need; Summarize runs on the whole board (as Ask), its answer opening as "the whole board".
//  - Diagram from words is the AI popover's shell: the sparkle header with a ×, and a segmented control for the
//    direction; the line about OpenAI names "the selected text" only while the selection goes along.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m4-entry.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import {
  test as base,
  createNote,
  expect,
  expectSaved,
  itemCenterOnScreen,
  select,
  setViewport,
} from '../tests/support/canvas.ts'
import { AI_API_ENV_3H, FAKE_OPENAI_PORT_3H, fakeAiRuns, foreignRequests, hasShell } from './ai-kit.ts'
import { focusBoard } from './board-kit.ts'

const test = base.extend<object, { openai: FakeOpenAi }>({
  openai: [
    async ({ stack: _ }, use) => {
      const fake = await startFakeOpenAi(FAKE_OPENAI_PORT_3H)
      await use(fake)
      await fake.close()
    },
    { scope: 'worker' },
  ],
})

test.use({ viewport: { width: 1440, height: 900 }, apiEnv: AI_API_ENV_3H })
test.beforeEach(({ openai }) => openai.reset())

/** Two notes at the board's top left, the view at 100% from (-100, -100): the right half of the view is empty. */
async function twoNotes(page: Page): Promise<string[]> {
  const ids: string[] = []
  for (const [i, text] of ['Book the venue', 'Call the studio'].entries()) {
    ids.push(await createNote(page, { x: i * 240, y: 0, text }))
    await expectSaved(page)
  }
  await setViewport(page, { x: -100, y: -100, zoom: 1 })
  return ids
}

/** Right-click on empty canvas (the view's right half) and open AI ›. */
async function aiSubmenuOnEmptyCanvas(page: Page) {
  expect(await hasShell(page, 'contextMenu')).toBe(true)
  await focusBoard(page)
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no canvas')
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.6, { button: 'right' })
  await expect(page.getByTestId('context-menu-root')).toBeVisible()
}

test('M4-5: on empty canvas Diagram is under AI ›, the items that cannot run say why, and Summarize reads the whole board', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  const ids = await twoNotes(a.page)
  const runs = await fakeAiRuns(a.page)
  await aiSubmenuOnEmptyCanvas(a.page)

  await test.step('Diagram from words is not beside AI ›, it is inside it', async () => {
    await expect(a.page.getByRole('menuitem', { name: /Diagram from words/ })).toHaveCount(0)
    await a.page.getByRole('menuitem', { name: 'AI', exact: true }).click()
    await expect(a.page.getByRole('menuitem', { name: /Diagram from words/ })).toBeVisible()
  })

  await test.step('the items that cannot run on empty canvas say what they need', async () => {
    const themes = a.page.getByRole('menuitem', { name: /^Group into themes/ })
    await expect(themes).toHaveText(/Group into themes \(select two or more sticky notes first\)/)
    await expect(themes).toHaveAttribute('aria-disabled', 'true')
    await expect(a.page.getByRole('menuitem', { name: /^Action items/ })).toHaveText(
      /Action items \(select notes or text first\)/,
    )
    const summarize = a.page.getByRole('menuitem', { name: 'Summarize', exact: true })
    await expect(summarize).not.toHaveAttribute('aria-disabled', 'true')
  })

  await test.step('Summarize with nothing selected runs on the whole board', async () => {
    await a.page.getByRole('menuitem', { name: 'Summarize', exact: true }).click()
    const notice = a.page.getByTestId('ai-notice')
    const panel = a.page.getByTestId('ai-summary-panel')
    await expect(notice.or(panel).first()).toBeVisible({ timeout: 20_000 })
    if (await notice.isVisible()) {
      // what leaves the board is its text, not "the selected text"
      await expect(a.page.getByTestId('ai-menu')).toContainText('Sends the board’s text to OpenAI')
      await expect(notice).toContainText('the text on the board')
      await a.page.getByTestId('ai-notice-continue').click()
    }
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await expect(panel).toContainText('the whole board')
    await expect(panel.getByTestId('ai-summary-text')).not.toBeEmpty()
    const call = runs.of('summarize').at(-1)
    expect((call?.body.shapeIds as string[] | undefined)?.sort()).toEqual(
      ids.map((id) => `shape:${id}`).sort(),
    )
    expect(foreign).toEqual([])
  })
})

test('M4-5: Diagram from words is the AI popover’s shell: a ×, a segmented direction, and its OpenAI line follows the selection', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const [first] = await twoNotes(a.page)
  const prompt = a.page.getByTestId('diagram-prompt')
  const note = prompt.getByTestId('diagram-prompt-note')

  await test.step('nothing selected: only the description is sent', async () => {
    await aiSubmenuOnEmptyCanvas(a.page)
    await a.page.getByRole('menuitem', { name: 'AI', exact: true }).click()
    await a.page.getByRole('menuitem', { name: /Diagram from words/ }).click()
    await expect(prompt).toBeVisible()
    await expect(prompt.locator('.dr-ai-pop__head .dr-ai-pop__badge')).toBeVisible()
    await expect(prompt.getByTestId('diagram-prompt-text')).toBeFocused()
    await expect(note).toHaveText('Sends the description to OpenAI.')
    await expect(prompt.getByTestId('diagram-prompt-selection')).toHaveCount(0)
  })

  await test.step('the direction is a segmented control: two joined choices, one checked', async () => {
    const seg = prompt.getByTestId('diagram-prompt-direction')
    await expect(seg.getByRole('radio')).toHaveCount(2)
    await expect(prompt.getByTestId('diagram-prompt-down')).toBeChecked()
    await prompt.getByTestId('diagram-prompt-right').click()
    await expect(prompt.getByTestId('diagram-prompt-right')).toBeChecked()
    await expect(prompt.getByTestId('diagram-prompt-down')).not.toBeChecked()
  })

  await test.step('its × closes it', async () => {
    await prompt.getByTestId('diagram-prompt-close').click()
    await expect(prompt).toHaveCount(0)
  })

  await test.step('a note selected: the selected text goes along, and says so until it is left out', async () => {
    await select(a.page, [first as string])
    await focusBoard(a.page)
    // on the note itself, so the selection stays
    const at = await itemCenterOnScreen(a.page, first as string)
    await a.page.mouse.click(at.x, at.y, { button: 'right' })
    await a.page.getByRole('menuitem', { name: 'AI', exact: true }).click()
    await a.page.getByRole('menuitem', { name: /Diagram from words/ }).click()
    await expect(prompt).toBeVisible()
    const use = prompt.getByTestId('diagram-prompt-selection')
    await expect(use).toBeChecked()
    await expect(note).toHaveText('Sends the description and the selected text to OpenAI.')
    await use.uncheck()
    await expect(note).toHaveText('Sends the description to OpenAI.')
    await prompt.getByTestId('diagram-prompt-cancel').click()
    await expect(prompt).toHaveCount(0)
  })
})
