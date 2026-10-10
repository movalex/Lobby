// Wave M (W4, M4-2, FTU-5 provenance): provenance you can see, in two browsers against the real api and sync server
// (OpenAI is the local fake of support/ai.ts on this run's own port). Bob only watches: his tab pushes nothing.
//  - Two Action items results; selecting the first one's heading shows the "AI-made" chip, whose card says
//    "Made with AI · Action items · <time>"; its Remove deletes only that result, as one push of alice's that bob
//    receives as one change, and one undo brings it back.
//  - "Show what AI made": the lens banner's count equals the number of AI-made things on the board; Hide turns it off.
//  - Diagram from words and Place on a 2x2, small as they are, show the preview before anything is written: no
//    element of theirs exists until Apply. A diagram then says "Made by AI".
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m4-provenance.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import {
  test as base,
  type CanvasElement,
  createNote,
  expect,
  expectSaved,
  items,
  pushedOps,
  saveState,
  select,
} from '../tests/support/canvas.ts'
import { pressUndo, pushCount } from '../tests/support/excalidraw.ts'
import {
  AI_API_ENV_3H,
  aiMenu,
  aiObjects,
  aiPreviewPanel,
  continueIfAsked,
  FAKE_OPENAI_PORT_3H,
  foreignRequests,
  openAiMenu,
  selectIds,
  showBounds,
} from './ai-kit.ts'
import { sortRun, waitForSort } from './l8-kit.ts'

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

const lobbyOf = (e: CanvasElement) =>
  ((e.customData as { lobby?: Record<string, unknown> } | null | undefined)?.lobby ?? {}) as {
    kind?: string
    ai?: { by?: string; run?: string }
  }
const runOf = (e: CanvasElement) => lobbyOf(e).ai?.run ?? null

/** Three notes in a row at `y`, saved one by one. */
async function threeNotes(page: Page, y: number, tag: string): Promise<string[]> {
  const ids: string[] = []
  for (const [i, text] of ['Book the venue', 'Draft the brief', 'Call the studio'].entries()) {
    ids.push(await createNote(page, { x: i * 260, y, text: `${text} (${tag})` }))
    await expectSaved(page)
  }
  return ids
}

/** AI › Action items on `ids` from the selection bar; resolves once the result is written and saved. */
async function actionItems(page: Page, ids: string[]) {
  await selectIds(page, ids)
  await openAiMenu(page)
  await aiMenu(page).getByTestId('ai-actions').click()
  await continueIfAsked(page)
  await expect(page.getByTestId('ai-done')).toContainText('Added 3 action items.', { timeout: 20_000 })
  await expectSaved(page)
}

/** Records the remote changes `page`'s canvas receives (each one change event), with what each deleted. */
async function watchRemoteChanges(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      __m4Remote?: string[][]
      __lobbyBoard: {
        canvas: { on(e: 'change', l: (c: { source: string; deleted: string[] }) => void): () => void }
      }
    }
    w.__m4Remote = []
    w.__lobbyBoard.canvas.on('change', (c) => {
      if (c.source === 'remote' && c.deleted.length) w.__m4Remote?.push([...c.deleted])
    })
  })
}
const remoteDeletes = (page: Page): Promise<string[][]> =>
  page.evaluate(() => (window as unknown as { __m4Remote?: string[][] }).__m4Remote ?? [])

test('M4-2: the “AI-made” chip says what made a result and when; its Remove deletes only that result, one push bob gets as one change, one undo', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const foreign = [...foreignRequests(a.page), ...foreignRequests(b.page)]
  const first = await threeNotes(a.page, 0, 'A')
  const second = await threeNotes(a.page, 900, 'B')
  await showBounds(a.page, { x: -60, y: -60, w: 860, h: 300 })
  await actionItems(a.page, first)
  await showBounds(a.page, { x: -60, y: 840, w: 860, h: 300 })
  await actionItems(a.page, second)
  const all = (await items(a.page)).filter((e) => runOf(e) !== null)
  const runs = [...new Set(all.map(runOf))]
  expect(runs).toHaveLength(2)
  // the first result is the one whose notes sit beside the first row
  const runA = runOf(
    all.find((e) => lobbyOf(e).kind === 'ai-heading' && e.y < 600) as CanvasElement,
  ) as string
  const ofA = all.filter((e) => runOf(e) === runA && !(e as { containerId?: string }).containerId)
  const ofB = all.filter((e) => runOf(e) !== runA && !(e as { containerId?: string }).containerId)
  expect(ofA).toHaveLength(4)
  expect(ofB).toHaveLength(4)
  await expect.poll(async () => (await aiObjects(b.page)).length).toBe(8)
  const bPushes = await pushCount(b.page)
  await watchRemoteChanges(b.page)

  await test.step('selecting the first result’s heading shows the chip; its card says what and when', async () => {
    const heading = ofA.find((e) => lobbyOf(e).kind === 'ai-heading') as CanvasElement
    await showBounds(a.page, { x: -60, y: -60, w: 860, h: 700 })
    await select(a.page, [heading.id])
    const chip = a.page.getByTestId('ai-provenance-chip')
    await expect(chip).toBeVisible()
    await chip.click()
    const card = a.page.getByTestId('ai-provenance-card')
    await expect(card).toBeVisible()
    await expect(card.getByTestId('ai-provenance-line')).toHaveText(
      /^Made with AI · Action items · \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/,
    )
    await expect(card.getByTestId('ai-provenance-remove')).toHaveText('Remove this AI result')
  })

  await test.step('Remove deletes only that result, in one push, which bob receives as one change', async () => {
    const pushes = (await pushedOps(a.page)).length
    await a.page.getByTestId('ai-provenance-remove').click()
    await expect(a.page.getByTestId('ai-removed')).toContainText('Removed 4 AI-made items.')
    await expectSaved(a.page)
    const recs = (await pushedOps(a.page)).slice(pushes)
    expect(recs).toHaveLength(1)
    const left = await aiObjects(a.page)
    expect(left.map((o) => o.id).sort()).toEqual(ofB.map((e) => e.id).sort())
    await expect
      .poll(async () => (await aiObjects(b.page)).map((o) => o.id).sort())
      .toEqual(ofB.map((e) => e.id).sort())
    const changes = await remoteDeletes(b.page)
    expect(changes).toHaveLength(1)
    for (const e of ofA) expect(changes[0]).toContain(e.id)
    expect((await saveState(a.page)).lastReject).toBeNull()
  })

  await test.step('one undo brings the whole result back; bob pushed nothing', async () => {
    await pressUndo(a.page)
    await expect.poll(async () => (await aiObjects(a.page)).length).toBe(8)
    await expectSaved(a.page)
    await expect.poll(async () => (await aiObjects(b.page)).length).toBe(8)
    expect(await pushCount(b.page)).toBe(bPushes)
    expect(foreign).toEqual([])
  })
})

test('M4-2: the lens banner’s count equals the number of AI-made things; Hide turns the lens off', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForSort(a.page)
  const ids = await threeNotes(a.page, 0, 'L')
  await showBounds(a.page, { x: -60, y: -60, w: 860, h: 300 })
  await actionItems(a.page, ids)
  const made = (await aiObjects(a.page)).length
  expect(made).toBe(4)
  expect(await sortRun(a.page, 'ai.lens')).toBe(true)
  const banner = a.page.getByTestId('ai-lens-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toHaveAttribute('data-count', String(made))
  await expect(banner.getByTestId('ai-lens-banner-text')).toHaveText(`Showing ${made} things AI made`)
  await expect(a.page.getByTestId('ai-lens-box')).toHaveCount(made)
  await banner.getByTestId('ai-lens-hide').click()
  await expect(banner).toHaveCount(0)
  await expect(a.page.getByTestId('ai-lens')).toHaveCount(0)
})

const kinds = async (page: Page, kind: string) =>
  (await items(page)).filter((e) => lobbyOf(e).kind === kind).length

test('M4-2: Diagram from words (4 shapes) shows the preview before any write, then says AI made it; bob pushes nothing', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForSort(a.page)
  const bPushes = await pushCount(b.page)

  await test.step('Diagram from words (4 shapes): the preview first, no diagram element until Apply', async () => {
    expect(await sortRun(a.page, 'flow.diagram')).toBe(true)
    await a.page.getByTestId('diagram-prompt-text').fill('Start, write the brief, approved?, ship')
    await a.page.getByTestId('diagram-prompt-create').click()
    await continueIfAsked(a.page)
    const panel = aiPreviewPanel(a.page)
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await expect(panel.getByTestId('ai-preview-summary')).toContainText(
      /^Adds \d+ shapes? and \d+ connectors?$/,
    )
    expect(await kinds(a.page, 'ai-diagram-node')).toBe(0)
    await panel.getByTestId('ai-preview-apply').click()
    await expect.poll(() => kinds(a.page, 'ai-diagram-node')).toBeGreaterThanOrEqual(2)
    await expect(a.page.getByTestId('ai-done')).toContainText(/^Made by AI: \d+ shapes and \d+ connectors\./)
    await expectSaved(a.page)
    expect((await saveState(a.page)).lastReject).toBeNull()
  })

  await test.step('bob, who only watched, pushed nothing', async () => {
    await expect.poll(() => kinds(b.page, 'ai-diagram-node')).toBeGreaterThanOrEqual(2)
    expect(await pushCount(b.page)).toBe(bPushes)
  })
})

test('M4-2: Place on a new 2x2 (4 notes) shows the preview before any write; bob pushes nothing', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForSort(a.page)
  const bPushes = await pushCount(b.page)

  await test.step('Place on a new 2x2 (4 notes): the preview first, no 2x2 frame until Apply', async () => {
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      ids.push(
        await createNote(a.page, { x: 2000 + (i % 2) * 230, y: Math.floor(i / 2) * 230, text: `Idea ${i}` }),
      )
      await expectSaved(a.page)
    }
    await showBounds(a.page, { x: 1940, y: -60, w: 560, h: 560 })
    await select(a.page, ids)
    const axes = [
      { name: 'Effort', low: 'Low', high: 'High' },
      { name: 'Impact', low: 'Low', high: 'High' },
    ]
    const ran = sortRun(a.page, 'sort.place', { axes })
    const notice = a.page.getByTestId('ai-notice-continue')
    const panel = aiPreviewPanel(a.page)
    await expect(notice.or(panel).first()).toBeVisible({ timeout: 20_000 })
    if (await notice.isVisible()) await notice.click()
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await expect(panel.getByTestId('ai-preview-groups')).toBeVisible()
    expect(await kinds(a.page, 'sort-matrix')).toBe(0)
    await panel.getByTestId('ai-preview-apply').click()
    expect(await ran).toBe(true)
    await expect.poll(() => kinds(a.page, 'sort-matrix')).toBeGreaterThan(0)
    await expectSaved(a.page)
    expect((await saveState(a.page)).lastReject).toBeNull()
  })

  await test.step('bob, who only watched, pushed nothing', async () => {
    await expect.poll(() => kinds(b.page, 'sort-matrix')).toBeGreaterThan(0)
    expect(await pushCount(b.page)).toBe(bPushes)
  })
})
