// Wave L (W2, L2-2): Ask this board, in the browser, against the real api and sync server with the e2e AI fake
// (ai-kit `fakeAiRuns`: the canned answer cites the notes whose words match the question, on any api).
//  - On a 3-frame board, the answer's numbered sources select the expected notes and move the camera to them;
//    the click pushes nothing; no /ai/run is made while the board opens.
//  - A viewer can ask but gets no "Add answer as a note"; an editor adds it as one undo step.
//  - A name-only guest sees no Ask entry (no AI at all).
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l2-ask.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import {
  test as base,
  createItem,
  createNote,
  expect,
  expectSaved,
  items,
  selection,
  setViewport,
  viewport,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { pressUndo, pushCount } from '../tests/support/excalidraw.ts'
import {
  AI_API_ENV_3H,
  aiObjects,
  aiRunRequests,
  cannedAiResult,
  cannedItems,
  FAKE_OPENAI_PORT_3H,
  fakeAiRuns,
  foreignRequests,
  hasShell,
} from './ai-kit.ts'

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

const FRAMES = [
  { name: 'Summer', notes: ['Summer beach screenings', 'A solstice trailer drop in summer'] },
  { name: 'Winter', notes: ['Snow teaser', 'Ski lodge premiere'] },
  { name: 'Creators', notes: ['Creator reaction videos', 'Live co-op premiere'] },
]

/** Three frames with two notes each (members of their frame), saved; returns the note ids by frame. */
async function threeFrames(page: Page): Promise<string[][]> {
  const out: string[][] = []
  for (const [i, f] of FRAMES.entries()) {
    const frameId = await createItem(page, 'frame', {
      x: i * 700,
      y: 0,
      width: 600,
      height: 400,
      name: f.name,
    })
    await expectSaved(page)
    const ids: string[] = []
    for (const [j, text] of f.notes.entries()) {
      ids.push(await createNote(page, { x: i * 700 + 40 + j * 260, y: 80, text }))
      await expectSaved(page)
    }
    await page.evaluate(
      ({ ids, frameId }) =>
        (
          window as unknown as {
            __lobbyBoard: {
              canvas: {
                transact(l: string, fn: (tx: { setFrame(ids: string[], f: string): void }) => void): void
              }
            }
          }
        ).__lobbyBoard.canvas.transact('e2e: frame', (tx) => tx.setFrame(ids, frameId)),
      { ids, frameId },
    )
    await expectSaved(page)
    out.push(ids)
  }
  return out
}

/** Right-click on empty canvas (nothing selected) → AI › Ask this board… → the question → Ask. */
async function ask(page: Page, question: string) {
  expect(await hasShell(page, 'contextMenu')).toBe(true)
  await page.evaluate(() =>
    (
      window as unknown as { __lobbyBoard: { canvas: { select(ids: string[]): void } } }
    ).__lobbyBoard.canvas.select([]),
  )
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no canvas')
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.85, { button: 'right' })
  await page.getByRole('menuitem', { name: 'AI' }).click()
  await page.getByRole('menuitem', { name: 'Ask this board…' }).click()
  await page.getByTestId('ai-ask-input').fill(question)
  await page.getByTestId('ai-ask-go').click()
  const cont = page.getByTestId('ai-notice-continue')
  const panel = page.getByTestId('ai-answer-panel')
  await expect(
    cont.or(panel.and(page.locator('[data-found]:not([data-found="pending"])'))).first(),
  ).toBeVisible({
    timeout: 20_000,
  })
  if (await cont.isVisible()) await cont.click()
  await expect(panel).not.toHaveAttribute('data-found', 'pending', { timeout: 20_000 })
  return panel
}

/** The answer comes from the fake: the canned answer for this board (the same on the foundation's and W1's api). */
async function cannedAsk(page: Page) {
  const fake = await fakeAiRuns(page)
  const board = await cannedItems(page)
  fake.next('ask', (input) => cannedAiResult(input, { items: board }))
  return fake
}

test('on a 3-frame board the numbered sources select the summer notes and bring them into view; the click pushes nothing; no AI run while the board opens', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  const notes = await threeFrames(a.page)
  const summer = notes[0] as string[]

  await test.step('no /ai/run while the board opens (a reload is an open)', async () => {
    const runs = aiRunRequests(a.page)
    await a.page.reload()
    await waitForCanvas(a.page)
    await a.page.waitForTimeout(3_000)
    expect(runs).toEqual([])
  })

  const fake = await cannedAsk(a.page)
  // far away from everything, so the camera move is plain to see
  await setViewport(a.page, { x: 6000, y: 4000, zoom: 1 })
  const panel = await ask(a.page, 'Which concepts mention summer?')
  expect(fake.of('ask')[0]?.body).toMatchObject({ action: 'ask', shapeIds: [] })
  await expect(panel.getByTestId('ai-answer-text')).toContainText('The board mentions it')
  await test.step('P-044: the answer is clear of the board menu: its button, and the menu once it opens', async () => {
    const clear = (p: { x: number; y: number; width: number; height: number } | null, q: typeof p) =>
      !!p &&
      !!q &&
      (p.x + p.width <= q.x || q.x + q.width <= p.x || p.y + p.height <= q.y || q.y + q.height <= p.y)
    const menuButton = a.page.getByTestId('main-menu.button')
    expect(clear(await panel.boundingBox(), await menuButton.boundingBox())).toBe(true)
    await menuButton.click()
    const menu = a.page.getByTestId('main-menu-root')
    await expect(menu).toBeVisible()
    expect(clear(await panel.boundingBox(), await menu.boundingBox())).toBe(true)
    await a.page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(panel).toBeVisible()
  })
  const before = await pushCount(a.page)
  await panel.getByTestId('ai-answer-cite').first().click()
  await test.step('the sources: selected and in view, nothing written', async () => {
    await expect.poll(async () => (await selection(a.page)).sort()).toEqual([...summer].sort())
    await expect
      .poll(async () => {
        const v = await viewport(a.page)
        const all = await items(a.page)
        return summer.every((id) => {
          const e = all.find((x) => x.id === id)
          return (
            !!e &&
            e.x >= v.x &&
            e.y >= v.y &&
            e.x + e.width <= v.x + v.width &&
            e.y + e.height <= v.y + v.height
          )
        })
      })
      .toBe(true)
    expect(await pushCount(a.page)).toBe(before)
  })
  await test.step('a question the board does not answer: “The board doesn’t say”', async () => {
    fake.next('ask', (input) => cannedAiResult(input, { items: [] }))
    const none = await ask(a.page, 'What about the octopus?')
    await expect(none.getByTestId('ai-answer-none')).toHaveText('The board doesn’t say.')
    await expect(none.getByTestId('ai-answer-add')).toHaveCount(0)
  })
  expect(foreign).toEqual([])
})

test('a viewer can ask but has no “Add answer as a note”; an editor adds it as one undo step', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await threeFrames(a.page)
  const v = await canvasSession('vera', { role: 'viewer' })
  await expect.poll(async () => (await items(v.page)).filter((e) => e.type === 'stickynote').length).toBe(6)

  await test.step('the viewer asks, sees the answer and its sources, and cannot add it', async () => {
    const fake = await cannedAsk(v.page)
    const vPushes = await pushCount(v.page)
    const panel = await ask(v.page, 'Which concepts mention summer?')
    await expect(panel.getByTestId('ai-answer-cite')).toHaveCount(1)
    await expect(panel.getByTestId('ai-answer-add')).toHaveCount(0)
    await panel.getByTestId('ai-answer-source').first().click()
    expect(await pushCount(v.page)).toBe(vPushes)
    expect(fake.of('ask')).toHaveLength(1)
  })

  await test.step('the editor adds the answer as a note (kind ai-answer, the run’s provenance); one Ctrl+Z removes it', async () => {
    const fake = await cannedAsk(a.page)
    const panel = await ask(a.page, 'Which concepts mention summer?')
    const runId = fake.of('ask')[0]?.runId
    await panel.getByTestId('ai-answer-add').click()
    await expect(panel).toHaveCount(0)
    await expect.poll(async () => (await aiObjects(a.page)).filter((o) => o.kind === 'answer').length).toBe(1)
    await expectSaved(a.page)
    const run = await a.page.evaluate(() => {
      const c = (
        window as unknown as {
          __lobbyBoard: {
            canvas: { items(): { customData?: { lobby?: { ai?: { run?: string }; kind?: string } } }[] }
          }
        }
      ).__lobbyBoard.canvas
      return c.items().find((e) => e.customData?.lobby?.kind === 'ai-answer')?.customData?.lobby?.ai?.run
    })
    expect(run).toBe(runId)
    await pressUndo(a.page)
    await expect.poll(async () => (await aiObjects(a.page)).length).toBe(0)
  })
})

test('a name-only guest sees no Ask entry: no AI button, no AI in the context menu', async ({
  canvasSession,
  board,
  browser,
  users,
}) => {
  const a = await canvasSession('alice')
  await threeFrames(a.page)
  const aliceApi = await users.api('alice')
  const made = await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, {
    role: 'editor',
    allowGuests: true,
    expiresInHours: 3,
  })
  expect(made.status()).toBe(201)
  const link = ((await made.json()) as { url: string }).url
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  try {
    const g = await context.newPage()
    await g.goto(link)
    await g.getByTestId('invite-guest-name').fill('Sam')
    await g.getByTestId('invite-guest-join').click()
    await expect(g).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
    await waitForCanvas(g)
    await expect.poll(async () => (await items(g)).filter((e) => e.type === 'stickynote').length).toBe(6)
    await g.waitForTimeout(3_000) // the AI status read waits for an idle moment after the board is live
    await expect(g.getByTestId('selection-ai')).toHaveCount(0)
    const box = await g.locator('[data-lobby-board-canvas]').boundingBox()
    if (!box) throw new Error('no canvas')
    await g.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.85, { button: 'right' })
    await expect(g.getByRole('menu').first()).toBeVisible()
    await expect(g.getByRole('menuitem', { name: 'AI' })).toHaveCount(0)
    await expect(g.getByRole('menuitem', { name: 'Ask this board…' })).toHaveCount(0)
  } finally {
    await context.close()
  }
})
