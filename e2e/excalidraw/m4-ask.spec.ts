// Wave M (W4, M4-6, FTU-9 pieces and L-AI-8's web half), in a real browser against the real api:
//  - Pieces in the dark theme: no card is a white block in the dark panel (its preview is drawn on the panel's own
//    surface, in its ink tokens), measured in the rendered pixels.
//  - The Ask panel's "This board / All boards" switch: absent while asking all boards is not offered (W8's client says
//    so: no context, or the api's 404); with the ai-kit's canned answer across boards, its chips open the cited board
//    at its elements (`?el=`) and "Add answer to board" follows the answer's exportAllowed. W8's api route is stood in
//    for by ai-kit fakeWorkspaceAsk, and its availability by forceWorkspaceAsk (the dev-auth hook), until W8 lands.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m4-ask.spec.ts --project=chromium --workers=1
import type { Locator, Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import {
  test as base,
  createNote,
  expect,
  expectSaved,
  items,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { capture } from '../tests/support/screenshots.ts'
import {
  AI_API_ENV_3H,
  aiMenu,
  cannedWorkspaceAsk,
  FAKE_OPENAI_PORT_3H,
  fakeWorkspaceAsk,
  forceWorkspaceAsk,
  foreignRequests,
  workspaceAskAvailable,
} from './ai-kit.ts'
import { sortRun, waitForSort, withShapesPanel } from './l8-kit.ts'

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

/** The rendered pixels of `target`: the share of near-white ones and the mean relative luminance. */
async function pixels(page: Page, target: Locator): Promise<{ white: number; mean: number }> {
  const png = (await target.screenshot({ animations: 'disabled' })).toString('base64')
  return page.evaluate(async (data) => {
    const img = new Image()
    img.src = `data:image/png;base64,${data}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(0, 0, c.width, c.height).data
    const lin = (v: number) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    let white = 0
    let sum = 0
    const n = px.length / 4
    for (let i = 0; i < px.length; i += 4) {
      const l =
        0.2126 * lin(px[i] as number) + 0.7152 * lin(px[i + 1] as number) + 0.0722 * lin(px[i + 2] as number)
      sum += l
      if (l > 0.8) white++
    }
    return { white: white / n, mean: sum / n }
  }, png)
}

test('M4-6: in the dark theme the Pieces cards are not white blocks: their previews are drawn on the panel’s surface', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await a.page.emulateMedia({ colorScheme: 'dark' })
  await expect(a.page.locator('html')).toHaveAttribute('data-theme', 'dark')
  // wave Q: the Shapes panel is the switch-off fallback (l8-kit.ts withShapesPanel)
  await withShapesPanel(a.page)
  await a.page.getByTestId('dock-tab-pieces').click()
  const panel = a.page.getByTestId('pieces-panel')
  await expect(panel).toBeVisible()
  // the drawings are in (the builders load on first open)
  await expect(a.page.locator('[data-piece-preview="decision"] polygon')).toHaveCount(1, { timeout: 15_000 })
  const cards = a.page.getByTestId('piece-option')
  await expect(cards.first()).toBeVisible()
  await capture('m4-pieces-dark.png', panel, testInfo)
  for (const i of [0, 1, 2, 3]) {
    const preview = cards.nth(i).locator('.dr-pieces__preview')
    const got = await pixels(a.page, preview)
    expect(got.white, `card ${i}: near-white share of its preview`).toBeLessThan(0.03)
    expect(got.mean, `card ${i}: its preview's mean luminance`).toBeLessThan(0.2)
  }
  // and in the light theme they keep the pieces' own light paper
  await a.page.emulateMedia({ colorScheme: 'light' })
  await expect(a.page.locator('html')).toHaveAttribute('data-theme', 'light')
  const light = await pixels(a.page, cards.first().locator('.dr-pieces__preview'))
  expect(light.mean).toBeGreaterThan(0.6)
})

/** Opens the AI popover's Ask view (the palette's command, with nothing selected). */
async function openAsk(page: Page) {
  expect(await sortRun(page, 'ai.ask')).toBe(true)
  await expect(aiMenu(page)).toHaveAttribute('data-view', 'ask')
}

/** Asks `question` from the open Ask view; continues the notice when it shows. */
async function ask(page: Page, question: string) {
  await aiMenu(page).getByTestId('ai-ask-input').fill(question)
  await aiMenu(page).getByTestId('ai-ask-go').click()
  const cont = page.getByTestId('ai-notice-continue')
  const answered = page.getByTestId('ai-workspace-answer-panel').or(page.getByTestId('ai-answer-panel'))
  await expect(cont.or(answered).first()).toBeVisible({ timeout: 20_000 })
  if (await cont.isVisible()) await cont.click()
}

test('M4-6: no “This board / All boards” switch while asking all boards is not offered; a 404 takes it away and this board answers', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  await createNote(a.page, { x: 0, y: 0, text: 'We decided the budget is 40k' })
  await expectSaved(a.page)
  await waitForSort(a.page)
  const fake = await fakeWorkspaceAsk(a.page, { unavailable: true })

  // since the wave M integration W8 sets the board's context, so with AI on for alice asking all boards is offered;
  // 'not offered' is forced off here (as W8's rule says for a guest, a viewer without AI or AI off)
  await test.step('not offered (forced off; W8’s stub saying unavailable): no switch', async () => {
    await forceWorkspaceAsk(a.page, false)
    expect(await workspaceAskAvailable(a.page)).toBe(false)
    await openAsk(a.page)
    await expect(aiMenu(a.page).getByTestId('ai-ask-input')).toBeVisible()
    await expect(aiMenu(a.page).getByTestId('ai-ask-scope')).toHaveCount(0)
    await a.page.keyboard.press('Escape')
    await expect(aiMenu(a.page)).toHaveCount(0)
  })

  await test.step('offered, then the api answers 404: the switch goes and this board answers', async () => {
    await forceWorkspaceAsk(a.page, true)
    await openAsk(a.page)
    const scope = aiMenu(a.page).getByTestId('ai-ask-scope')
    await expect(scope).toBeVisible()
    await expect(aiMenu(a.page).getByTestId('ai-ask-scope-board')).toBeChecked()
    await aiMenu(a.page).getByTestId('ai-ask-scope-all').click()
    await expect(aiMenu(a.page)).toContainText('Ask all boards')
    await ask(a.page, 'What did we decide about the budget?')
    await expect(a.page.getByTestId('ai-ask-fallback')).toBeVisible()
    await expect(a.page.getByTestId('ai-answer-panel')).toBeVisible({ timeout: 20_000 })
    expect(fake.calls.map((c) => c.status)).toEqual([404])
    expect(await workspaceAskAvailable(a.page)).toBe(false)
    await a.page.getByTestId('ai-answer-panel').getByRole('button', { name: 'Close answer' }).click()
    await openAsk(a.page)
    await expect(aiMenu(a.page).getByTestId('ai-ask-scope')).toHaveCount(0)
  })
  expect(foreign).toEqual([])
})

test('M4-6: with the canned answer across boards, “Add answer” follows exportAllowed and a chip opens the cited board at its elements', async ({
  canvasSession,
  users,
}) => {
  const a = await canvasSession('alice')
  const other = await users.createBoard('M4-6 cited board')
  await createNote(a.page, { x: 0, y: 0, text: 'The launch moves to May' })
  await expectSaved(a.page)
  await waitForSort(a.page)
  const cited = [{ boardId: other, boardTitle: 'M4-6 cited board', elementIds: ['note-1', 'note-2'] }]
  const fake = await fakeWorkspaceAsk(a.page, { answer: cannedWorkspaceAsk(cited, { exportAllowed: false }) })
  await forceWorkspaceAsk(a.page, true)
  const panel = a.page.getByTestId('ai-workspace-answer-panel')

  await test.step('a cited board that does not allow copying: Add answer is disabled, and says why', async () => {
    await openAsk(a.page)
    await aiMenu(a.page).getByTestId('ai-ask-scope-all').click()
    await ask(a.page, 'When is the launch?')
    await expect(panel).toBeVisible()
    await expect(panel).toHaveAttribute('data-found', 'yes')
    await expect(panel.getByTestId('ai-workspace-answer-add')).toBeDisabled()
    await expect(panel.getByTestId('ai-workspace-answer-reason')).toHaveText(
      'A board it cites doesn’t allow copying out of it.',
    )
    await expect(panel.getByTestId('ai-workspace-answer-copy')).toHaveCount(0)
    expect(fake.calls.at(-1)).toMatchObject({ status: 200, body: { question: 'When is the launch?' } })
  })

  await test.step('every cited board allows it: Add answer puts it on this board as one note', async () => {
    fake.next(cannedWorkspaceAsk(cited, { exportAllowed: true }))
    await openAsk(a.page)
    await aiMenu(a.page).getByTestId('ai-ask-scope-all').click()
    await ask(a.page, 'When is the launch?')
    await expect(panel.getByTestId('ai-workspace-answer-add')).toBeEnabled()
    const before = (await items(a.page)).length
    await panel.getByTestId('ai-workspace-answer-add').click()
    await expect(panel).toHaveCount(0)
    await expect.poll(async () => (await items(a.page)).length).toBeGreaterThan(before)
    await expectSaved(a.page)
  })

  await test.step('a chip opens the cited board at its elements (?el=)', async () => {
    fake.next(cannedWorkspaceAsk(cited))
    await openAsk(a.page)
    await aiMenu(a.page).getByTestId('ai-ask-scope-all').click()
    await ask(a.page, 'When is the launch?')
    const chip = panel.getByTestId('ai-workspace-cite').first()
    await expect(chip).toHaveAttribute('href', `/b/${other}?el=note-1,note-2`)
    await chip.click()
    await expect(a.page).toHaveURL(new RegExp(`/b/${other}\\?el=note-1,note-2$`))
    await waitForCanvas(a.page)
  })
})
